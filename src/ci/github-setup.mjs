// Connects GitHub to the site's Cloudflare CI Worker. GitHub stays the home of the code, issues and PRs; this
// wires its pushes into CI:
//
//   1. GITHUB_WEBHOOK_SECRET in Sigillo `staging` (generated once)
//   2. GITHUB_CI_TOKEN in Sigillo `staging`: a fine-grained token you create
//      on GitHub (prompted for once, then validated on every run)
//   3. gq.ops.json `github.repository`'s push webhook → the CI Worker's
//      /github/webhook (created or updated through your `gh` login; needs
//      repo admin)
//
// With --app (gq-platform ADR 0012) there is no token to paste: step 2 is
//
//   2. the repository in the GETQUICK CI App's installation (read as the App;
//      added through your `gh` login only when it's missing, which GitHub may
//      refuse: then an organization owner adds it in the browser), and the
//      Site's broker credential (derived from GQ Platform `ops`' broker key) and the
//      broker's URL in Sigillo `staging` as GQ_CI_BROKER_TOKEN and
//      GQ_CI_BROKER_URL. The CI Worker then asks the broker for a token for
//      each run instead of holding GITHUB_CI_TOKEN.
//
// Idempotent. Values go to sigillo/gh over stdin, never printed or put in
// argv. Then deploy the Worker with the new secrets: gq ci deploy
//
// An Artifacts-only site (no `github.repository`) has nothing to connect.
//
//   gq github setup [--app] [--dry-run]

import { randomBytes } from "node:crypto";

import { createCloudflareAccountClient } from "../cloudflare/account-client.mjs";
import { SECRETS_ENVIRONMENT } from "../cloudflare/tokens.mjs";
import { createReporter } from "../cli/reporter.mjs";
import { sigilloSecrets } from "../sigillo/commands.mjs";
import { brokerCredential } from "./broker/broker.mjs";
import { ciDeployToken } from "./deploy.mjs";
import {
  APP_NAME,
  APP_OWNER,
  APP_SECRETS,
  brokerUrl,
  installationHasRepository,
  platformSecrets,
  SITE_BROKER_SECRETS,
} from "./github-app.mjs";

export function webhookUrl(worker, subdomain) {
  return `https://${worker}.${subdomain}.workers.dev/github/webhook`;
}

export function webhookConfig(url, secret) {
  return {
    active: true,
    events: ["push"],
    config: { url, secret, content_type: "json", insecure_ssl: "0" },
  };
}

// Checks the token can see the repository (what the mirror needs). A missing
// Commit statuses permission only shows when CI posts one (Worker logs).
async function validateToken(fetch, { token, repository, project }) {
  const response = await fetch(`https://api.github.com/repos/${repository}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": `${project}-github-setup`,
    },
  });
  return response.status === 200 ? null : `GitHub answered ${response.status} for ${repository}`;
}

function ghRunner(exec, env) {
  return async (args, input) => {
    const result = await exec("gh", args, {
      env,
      input: input === undefined ? undefined : JSON.stringify(input),
    });
    if (result.code !== 0) throw new Error(`gh ${args.join(" ")} failed: ${result.stderr.trim()}`);
    return result.stdout ? JSON.parse(result.stdout) : null;
  };
}

// Asks the broker for a token with the credential, as the CI Worker will.
// Resolves to null when it minted one (discarded), or the problem.
export async function brokerProblem(fetch, { url, credential, repository }) {
  try {
    const response = await fetch(`${url}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      body: JSON.stringify({ repository }),
    });
    if (response.ok) {
      const { token } = await response.json();
      return typeof token === "string" && token ? null : "the broker answered without a token";
    }
    const { error } = await response.json().catch(() => ({}));
    return `the broker answered ${response.status}${error ? `: ${error}` : ""}`;
  } catch (error) {
    return `the broker is unreachable (${error.message})`;
  }
}

// `gq github setup [--app] [--dry-run]`. Resolves to an exit code.
export async function runGithubSetup({ context, parsed, env, fetch, exec, io, interactive }) {
  const ops = context.config;
  const repository = ops.github?.repository;
  const worker = ops.ci?.worker;
  const accountId = ops.cloudflare?.accountId;
  if (!repository) {
    io.out(
      "gq.ops.json has no github.repository: this site's code lives in Cloudflare Artifacts, " +
        "and pushes to it start CI without GitHub. Nothing to set up.",
    );
    return 0;
  }
  if (!worker || !accountId) {
    throw new Error("gq.ops.json ci.worker and cloudflare.accountId are required.");
  }
  const deployToken = ciDeployToken(context);
  const secrets = await sigilloSecrets({ context, env, exec }, SECRETS_ENVIRONMENT);
  const gh = ghRunner(exec, env);

  const ui = createReporter(io, interactive);
  ui.intro(`GitHub → Cloudflare CI · ${repository}${parsed.app ? ` · ${APP_NAME} App` : ""}`);

  const request = createCloudflareAccountClient({
    token: deployToken,
    accountId,
    fetch,
  });
  const { subdomain } = await request("GET", "/workers/subdomain");
  const url = webhookUrl(worker, subdomain);

  const credentials = parsed.app
    ? await appCredentials({ context, env, exec, fetch, gh, repository, subdomain })
    : await tokenCredentials({ context, fetch, ui, secrets, repository, project: ops.project });

  let secret = context.env.GITHUB_WEBHOOK_SECRET;
  const hooks = await gh(["api", `repos/${repository}/hooks`]);
  const hook = hooks.find((candidate) => candidate.config?.url === url);

  ui.note(
    [
      secret ? "✓ webhook secret in Sigillo" : "+ generate the webhook secret, store it in Sigillo",
      ...credentials.plan,
      hook ? `~ update webhook ${hook.id} (${url})` : `+ create webhook ${url}`,
    ].join("\n"),
    "Plan",
  );
  if (parsed.dryRun) {
    ui.outro("Dry run: nothing changed.");
    return 0;
  }

  // Credentials first: a step GitHub refuses (adding the repository to the
  // App) then stops the run before anything else is written.
  await credentials.apply();

  if (!secret) {
    secret = randomBytes(32).toString("hex");
    await secrets.set("GITHUB_WEBHOOK_SECRET", secret);
    ui.success("Webhook secret stored in Sigillo");
  }

  // Always (re)send the config: GitHub never returns the secret, so this is
  // the only way to be sure the webhook signs with the one in Sigillo.
  const config = webhookConfig(url, secret);
  if (hook) {
    await gh(
      ["api", "-X", "PATCH", `repos/${repository}/hooks/${hook.id}`, "--input", "-"],
      config,
    );
  } else {
    await gh(["api", "-X", "POST", `repos/${repository}/hooks`, "--input", "-"], {
      name: "web",
      ...config,
    });
  }
  ui.success(`Webhook ${hook ? "updated" : "created"}: ${url}`);
  await credentials.verify?.();
  ui.outro(credentials.next);
  return 0;
}

// The fine-grained token path: validate the stored one, or prompt for a new one.
async function tokenCredentials({ context, fetch, ui, secrets, repository, project }) {
  const token = context.env.GITHUB_CI_TOKEN;
  const tokenProblem = token
    ? await validateToken(fetch, { token, repository, project })
    : `not in Sigillo ${secrets.name}`;
  return {
    plan: [
      tokenProblem
        ? `+ GitHub token: ${tokenProblem} — you'll paste a new one`
        : "✓ GitHub token in Sigillo is valid",
    ],
    async apply() {
      if (!tokenProblem) return;
      ui.info(
        [
          "Create a fine-grained token at https://github.com/settings/personal-access-tokens/new",
          `  Resource owner: ${repository.split("/")[0]} · Repository access: only ${repository}`,
          "  Permissions: Contents → Read-only, Commit statuses → Read and write",
          "  (Or skip pasting entirely: gq github setup --app)",
        ].join("\n"),
      );
      const pasted = (await ui.password("Paste the token"))?.trim();
      if (!pasted) throw new Error("Cancelled.");
      const problem = await validateToken(fetch, { token: pasted, repository, project });
      if (problem) throw new Error(`That token doesn't work: ${problem}.`);
      await secrets.set("GITHUB_CI_TOKEN", pasted);
      ui.success("GitHub token stored in Sigillo");
    },
    next: "Now deploy the Worker with the new secrets: gq ci deploy",
  };
}

// Where an organization owner changes the installation's repositories.
export function installationSettingsUrl(installationId) {
  return `https://github.com/organizations/${APP_OWNER}/settings/installations/${installationId}`;
}

// What to do when GitHub refuses to add the repository through gh.
export function membershipRemedy({ repository, installationId, reason }) {
  return [
    `GitHub refused to add ${repository} to the ${APP_NAME} installation ${installationId} through your gh login (${reason}).`,
    "PUT /user/installations/{id}/repositories/{repo} is documented for fine-grained personal access tokens " +
      '(repository permission "GitHub App installation repository access": write) and GitHub App user access tokens. ' +
      "gh's own login is an OAuth app token (gho_), which GitHub can refuse here even for an organization owner.",
    "To fix it, an organization owner either:",
    `  - adds ${repository} at ${installationSettingsUrl(installationId)} (Repository access → Only select repositories → Select repositories → Save), or`,
    '  - switches that installation to "All repositories". Each Site\'s broker credential still binds to its one repository, ' +
      "but the App then reaches every Quick-Release repository, and gq ci broker deploy refuses such an installation " +
      "until gq-platform ADR 0012 allows it.",
    "Then re-run: gq sigillo run staging -- gq github setup --app",
  ].join("\n");
}

// The App path: the repository in the App's installation, and the Site's
// broker credential and URL in Sigillo staging.
async function appCredentials({ context, env, exec, fetch, gh, repository, subdomain }) {
  const platform = await platformSecrets({ context, env, exec });
  const names = await platform.names();
  const required = [
    APP_SECRETS.appId,
    APP_SECRETS.privateKey,
    APP_SECRETS.installationId,
    APP_SECRETS.brokerKey,
  ];
  const missing = required.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(
      `The ${APP_NAME} App isn't ready: Sigillo ${platform.name} lacks ${missing.join(", ")}. ` +
        "Create and install it first: gq github app create (an organization owner).",
    );
  }
  const installationId = await platform.get(APP_SECRETS.installationId);
  const credential = await brokerCredential(await platform.get(APP_SECRETS.brokerKey), repository);
  const url = brokerUrl(subdomain);
  const site = await sigilloSecrets({ context, env, exec }, SECRETS_ENVIRONMENT);
  const repo = await gh(["api", `repos/${repository}`]);
  if (repo?.permissions && !repo.permissions.admin) {
    throw new Error(`Your gh login isn't an admin of ${repository}: its webhook needs one.`);
  }
  let member;
  try {
    member = await installationHasRepository({
      fetch,
      appId: await platform.get(APP_SECRETS.appId),
      privateKey: await platform.get(APP_SECRETS.privateKey),
      installationId,
      repository,
    });
  } catch (error) {
    throw new Error(
      `Couldn't read the ${APP_NAME} installation ${installationId}'s repositories as the App: ${error.message}. ` +
        "Is the App's key in Sigillo GQ Platform ops current (gq ci broker deploy proves it)?",
      { cause: error },
    );
  }
  const stored = {
    token: context.env[SITE_BROKER_SECRETS.token] === credential,
    url: context.env[SITE_BROKER_SECRETS.url] === url,
  };
  return {
    plan: [
      member
        ? `✓ ${repository} in the ${APP_NAME} installation ${installationId}`
        : `+ add ${repository} to the ${APP_NAME} installation ${installationId} (through gh; GitHub may ask for an organization owner)`,
      stored.token
        ? `✓ broker credential in Sigillo ${site.name}`
        : `+ store the broker credential in Sigillo ${site.name} (${SITE_BROKER_SECRETS.token})`,
      stored.url
        ? `✓ broker URL in Sigillo ${site.name}`
        : `+ store the broker URL ${url} in Sigillo ${site.name} (${SITE_BROKER_SECRETS.url})`,
      context.env.GITHUB_CI_TOKEN
        ? "· GITHUB_CI_TOKEN stays in Sigillo; gq ci deploy stops sending it and removes it from the Worker"
        : "· no GITHUB_CI_TOKEN to retire",
    ],
    async apply() {
      if (!member) {
        try {
          await gh([
            "api",
            "-X",
            "PUT",
            `user/installations/${installationId}/repositories/${repo.id}`,
          ]);
        } catch (error) {
          if (!/\(HTTP 40[34]\)/u.test(error.message)) throw error;
          const reason = error.message.replace(/^gh .*? failed: (gh: )?/u, "").trim();
          throw new Error(membershipRemedy({ repository, installationId, reason }), {
            cause: error,
          });
        }
      }
      if (!stored.token) await site.set(SITE_BROKER_SECRETS.token, credential);
      if (!stored.url) await site.set(SITE_BROKER_SECRETS.url, url);
    },
    async verify() {
      const problem = await brokerProblem(fetch, { url, credential, repository });
      if (problem) {
        throw new Error(
          `${repository} is set up, but ${problem}. Is the broker deployed (gq ci broker deploy)?`,
        );
      }
    },
    next:
      "The broker minted a token for this repository. Now deploy the Worker: gq ci deploy" +
      (context.env.GITHUB_CI_TOKEN
        ? ", then delete GITHUB_CI_TOKEN from Sigillo staging and revoke it on GitHub"
        : ""),
  };
}

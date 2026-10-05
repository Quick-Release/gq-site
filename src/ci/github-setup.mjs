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
// Idempotent. Values go to sigillo/gh over stdin, never printed or put in
// argv. Then deploy the Worker with the new secrets: gq ci deploy
//
// An Artifacts-only site (no `github.repository`) has nothing to connect.
//
//   gq github setup [--dry-run]

import { randomBytes } from "node:crypto";

import { createCloudflareAccountClient } from "../cloudflare/account-client.mjs";
import { SECRETS_ENVIRONMENT } from "../cloudflare/tokens.mjs";
import { createReporter } from "../cli/reporter.mjs";
import { sigilloSecrets } from "../sigillo/commands.mjs";
import { ciDeployToken } from "./deploy.mjs";

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

// `gq github setup [--dry-run]`. Resolves to an exit code.
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
  ui.intro(`GitHub → Cloudflare CI · ${repository}`);

  const request = createCloudflareAccountClient({
    token: deployToken,
    accountId,
    fetch,
  });
  const { subdomain } = await request("GET", "/workers/subdomain");
  const url = webhookUrl(worker, subdomain);

  let secret = context.env.GITHUB_WEBHOOK_SECRET;
  const token = context.env.GITHUB_CI_TOKEN;
  const tokenProblem = token
    ? await validateToken(fetch, { token, repository, project: ops.project })
    : `not in Sigillo ${secrets.name}`;
  const hooks = await gh(["api", `repos/${repository}/hooks`]);
  const hook = hooks.find((candidate) => candidate.config?.url === url);

  ui.note(
    [
      secret ? "✓ webhook secret in Sigillo" : "+ generate the webhook secret, store it in Sigillo",
      tokenProblem
        ? `+ GitHub token: ${tokenProblem} — you'll paste a new one`
        : "✓ GitHub token in Sigillo is valid",
      hook ? `~ update webhook ${hook.id} (${url})` : `+ create webhook ${url}`,
    ].join("\n"),
    "Plan",
  );
  if (parsed.dryRun) {
    ui.outro("Dry run: nothing changed.");
    return 0;
  }

  if (!secret) {
    secret = randomBytes(32).toString("hex");
    await secrets.set("GITHUB_WEBHOOK_SECRET", secret);
    ui.success("Webhook secret stored in Sigillo");
  }

  if (tokenProblem) {
    ui.info(
      [
        "Create a fine-grained token at https://github.com/settings/personal-access-tokens/new",
        `  Resource owner: ${repository.split("/")[0]} · Repository access: only ${repository}`,
        "  Permissions: Contents → Read-only, Commit statuses → Read and write",
      ].join("\n"),
    );
    const pasted = (await ui.password("Paste the token"))?.trim();
    if (!pasted) throw new Error("Cancelled.");
    const problem = await validateToken(fetch, { token: pasted, repository, project: ops.project });
    if (problem) throw new Error(`That token doesn't work: ${problem}.`);
    await secrets.set("GITHUB_CI_TOKEN", pasted);
    ui.success("GitHub token stored in Sigillo");
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
  ui.outro("Now deploy the Worker with the new secrets: gq ci deploy");
  return 0;
}

// The site's Cloudflare CI commands (`gq ci deploy|runs`, `gq github setup`,
// `gq git artifacts …`) at the run() seam: a fixture content site's
// `cloudflare`, `ci`, `artifacts` and `github` blocks, a recording exec
// standing in for Wrangler, gh, git and Sigillo, and a recording fetch for
// Cloudflare and GitHub. Nothing here reaches the network.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { githubWorkerSecrets, secretsPayload, workerSecrets } from "../../src/ci/deploy.mjs";
import { helperCommand } from "../../src/ci/git-artifacts.mjs";
import { webhookConfig, webhookUrl } from "../../src/ci/github-setup.mjs";
import { createFixtureSite, recordingExec, recordingFetch } from "../support/fixture-site.mjs";

const OPS = Object.freeze({
  schemaVersion: 1,
  project: "fixture",
  variant: "content",
  sigillo: {
    apiUrl: "https://secrets.example.test",
    projectId: "PROJECT123",
    environments: { operations: "ops", staging: "stage" },
  },
  cloudflare: { accountId: "account-1" },
  artifacts: { namespace: "fixture-ns", repo: "fixture-repo" },
  ci: { worker: "fixture-ci", backupBucket: "fixture-ci-backups" },
  github: { repository: "example/fixture" },
});

const SIGILLO_BIN = "node_modules/.bin/sigillo";

function site({ ops = OPS } = {}) {
  return createFixtureSite({
    ops,
    files: {
      "package.json": `${JSON.stringify({ devDependencies: { sigillo: "0.13.0" } })}\n`,
      [SIGILLO_BIN]: "#!/bin/sh\n",
    },
  });
}

// Every secret the Worker gets, as the secret store would inject it.
const STORE = Object.freeze(
  Object.fromEntries(
    Object.values({ ...workerSecrets, ...githubWorkerSecrets }).map((name) => [
      name,
      `value-of-${name}`,
    ]),
  ),
);

// An Artifacts-only site: no github.repository, and no GitHub secrets.
const ARTIFACTS_ONLY_OPS = Object.freeze({ ...OPS, github: undefined });
const ARTIFACTS_ONLY_STORE = Object.freeze(
  Object.fromEntries(Object.entries(STORE).filter(([name]) => !name.startsWith("GITHUB_"))),
);
const DEPLOY_ENV = Object.freeze({ ...STORE, CI_DEPLOY_API_TOKEN: "ci-deploy", PATH: "/usr/bin" });

// --- the Worker's secrets ----------------------------------------------------

test("maps secret-store secrets to the CI Worker's names", () => {
  const payload = JSON.parse(secretsPayload(STORE));
  assert.equal(payload.CF_TOKEN, "value-of-CLOUDFLARE_API_TOKEN");
  assert.equal(payload.R2_ACCESS_KEY_ID, "value-of-CI_BACKUP_R2_ACCESS_KEY_ID");
  assert.equal(payload.RELEASES_R2_ACCESS_KEY_ID, "value-of-R2_ACCESS_KEY_ID");
  assert.equal(payload.COMPOSER_AUTH, "value-of-COMPOSER_AUTH");
});

test("adds the Frontend's refresh token and event secret when the secret store has them", () => {
  const without = JSON.parse(secretsPayload(STORE));
  const withThem = JSON.parse(
    secretsPayload({
      ...STORE,
      FRONTEND_REFRESH_TOKEN: "value-of-refresh",
      PUBLICATION_EVENT_SECRET: "value-of-events",
    }),
  );

  assert.equal(without.FRONTEND_REFRESH_TOKEN, undefined);
  assert.equal(without.PUBLICATION_EVENT_SECRET, undefined);
  assert.equal(withThem.FRONTEND_REFRESH_TOKEN, "value-of-refresh");
  assert.equal(withThem.PUBLICATION_EVENT_SECRET, "value-of-events");
});

test("refuses to deploy with missing secrets", () => {
  assert.throws(() => secretsPayload({}), /Missing in the secret store: CLOUDFLARE_API_TOKEN/u);
});

test("needs the GitHub secrets only for a site on GitHub", () => {
  assert.throws(
    () => secretsPayload(ARTIFACTS_ONLY_STORE),
    /Missing in the secret store: GITHUB_CI_TOKEN, GITHUB_WEBHOOK_SECRET/u,
  );
  const payload = JSON.parse(secretsPayload(ARTIFACTS_ONLY_STORE, { github: false }));
  assert.deepEqual(Object.keys(payload).sort(), Object.keys(workerSecrets).sort());
});

// --- gq ci deploy / runs -----------------------------------------------------

test("ci deploy deploys the Worker with its own Wrangler, then pipes its secrets over stdin", async () => {
  const fixture = await site();
  const exec = recordingExec();

  const result = await fixture.run(["ci", "deploy"], { env: DEPLOY_ENV, exec });

  assert.equal(result.code, 0, result.stderr);
  const wrangler = fixture.path("infra/ci/node_modules/.bin/wrangler");
  assert.deepEqual(
    exec.calls.map(({ command, args, cwd }) => [command, args.join(" "), cwd]),
    [
      [wrangler, "deploy", fixture.path("infra/ci")],
      [wrangler, "secret bulk", fixture.path("infra/ci")],
    ],
  );
  const [deploy, bulk] = exec.calls;
  for (const call of [deploy, bulk]) {
    // Wrangler authenticates with the CI deploy token only.
    assert.equal(call.env.CLOUDFLARE_API_TOKEN, "ci-deploy");
    assert.equal(call.env.CLOUDFLARE_ACCOUNT_ID, "account-1");
    assert.equal(call.env.PATH, "/usr/bin");
  }
  assert.equal(exec.options[0].stdio, "inherit");
  assert.deepEqual(JSON.parse(bulk.input), JSON.parse(secretsPayload(STORE)));
  assert.ok(!bulk.args.some((argument) => argument.includes("value-of-")), "never in argv");
  assert.match(result.stdout, /Deployed fixture-ci with 9 secrets\./u);
});

test("ci deploy deploys an Artifacts-only site's Worker without GitHub secrets", async () => {
  const fixture = await site({ ops: ARTIFACTS_ONLY_OPS });
  const exec = recordingExec();
  const env = { ...ARTIFACTS_ONLY_STORE, CI_DEPLOY_API_TOKEN: "ci-deploy" };

  const result = await fixture.run(["ci", "deploy"], { env, exec });

  assert.equal(result.code, 0, result.stderr);
  const secrets = JSON.parse(exec.calls[1].input);
  assert.equal(secrets.GITHUB_CI_TOKEN, undefined);
  assert.equal(secrets.GITHUB_WEBHOOK_SECRET, undefined);
  assert.match(result.stdout, /Deployed fixture-ci with 7 secrets\./u);
});

test("ci deploy uses gq.ops.json ci.directory for the Worker", async () => {
  const fixture = await site({
    ops: { ...OPS, ci: { ...OPS.ci, directory: "apps/cloudflare-ci" } },
  });
  const exec = recordingExec();

  const result = await fixture.run(["ci", "deploy"], { env: DEPLOY_ENV, exec });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    exec.calls[0].command,
    fixture.path("apps/cloudflare-ci/node_modules/.bin/wrangler"),
  );
  assert.equal(exec.calls[0].cwd, fixture.path("apps/cloudflare-ci"));
});

test("ci deploy refuses before Wrangler runs when a secret is missing", async () => {
  const fixture = await site();
  const exec = recordingExec();
  const env = { ...DEPLOY_ENV, GITHUB_CI_TOKEN: "" };

  const result = await fixture.run(["ci", "deploy"], { env, exec });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Missing in the secret store: GITHUB_CI_TOKEN/u);
  assert.deepEqual(exec.calls, []);
});

test("ci deploy needs the CI deploy token", async () => {
  const fixture = await site();
  const env = { ...DEPLOY_ENV, CI_DEPLOY_API_TOKEN: "" };

  const result = await fixture.run(["ci", "deploy"], { env });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /CI_DEPLOY_API_TOKEN is missing; create it with gq cloudflare ci/u);
});

test("ci deploy fails when Wrangler does", async () => {
  const fixture = await site();
  const exec = recordingExec(() => ({ code: 1 }));

  const result = await fixture.run(["ci", "deploy"], { env: DEPLOY_ENV, exec });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /wrangler deploy failed/u);
  assert.equal(exec.calls.length, 1, "the secrets are not sent after a failed deploy");
});

test("ci runs lists the configured Worker's CI Workflow runs", async () => {
  const fixture = await site();
  const exec = recordingExec();

  const result = await fixture.run(["ci", "runs"], {
    env: { CI_DEPLOY_API_TOKEN: "ci-deploy" },
    exec,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    exec.calls.map(({ args }) => args.join(" ")),
    ["workflows instances list fixture-ci"],
  );
  assert.equal(exec.calls[0].env.CLOUDFLARE_API_TOKEN, "ci-deploy");
  assert.equal(exec.options[0].stdio, "inherit");
});

// --- gq github setup ---------------------------------------------------------

test("the GitHub webhook targets the CI Worker and only sends pushes", () => {
  const url = webhookUrl("larkspur-ci", "tipme");
  assert.equal(url, "https://larkspur-ci.tipme.workers.dev/github/webhook");
  assert.deepEqual(webhookConfig(url, "s"), {
    active: true,
    events: ["push"],
    config: { url, secret: "s", content_type: "json", insecure_ssl: "0" },
  });
});

const WEBHOOK = "https://fixture-ci.fixture-sub.workers.dev/github/webhook";

// Cloudflare's workers subdomain and GitHub's repository check (200 for
// `validToken`, 401 otherwise).
function githubFetch({ validToken = "good-token" } = {}) {
  return recordingFetch(({ url, headers }) => {
    if (url.endsWith("/accounts/account-1/workers/subdomain")) {
      return { success: true, result: { subdomain: "fixture-sub" } };
    }
    if (url === "https://api.github.com/repos/example/fixture") {
      assert.equal(headers["User-Agent"], "fixture-github-setup");
      return new Response("{}", {
        status: headers.Authorization === `Bearer ${validToken}` ? 200 : 401,
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

// gh answers the hook listing with `hooks`; sigillo stores what it is given.
function githubExec({ hooks = [] } = {}) {
  const stored = {};
  const exec = recordingExec(({ command, args, input }) => {
    if (command === "gh" && args.join(" ") === "api repos/example/fixture/hooks") {
      return { stdout: JSON.stringify(hooks) };
    }
    if (command === "gh") return { stdout: "{}" };
    if (command.endsWith(SIGILLO_BIN) && args[1] === "set") {
      stored[args[2]] = input;
      return {};
    }
    return { code: 1, stderr: `unexpected ${command} ${args.join(" ")}` };
  });
  return { exec, stored };
}

test("github setup generates the webhook secret and creates the push webhook", async () => {
  const fixture = await site();
  const fetch = githubFetch();
  const { exec, stored } = githubExec();

  const result = await fixture.run(["github", "setup"], {
    env: { CI_DEPLOY_API_TOKEN: "ci-deploy", GITHUB_CI_TOKEN: "good-token" },
    fetch,
    exec,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(stored.GITHUB_WEBHOOK_SECRET, /^[0-9a-f]{64}$/u);
  const create = exec.calls.find(({ args }) => args.includes("POST"));
  assert.deepEqual(create.args, [
    "api",
    "-X",
    "POST",
    "repos/example/fixture/hooks",
    "--input",
    "-",
  ]);
  assert.deepEqual(JSON.parse(create.input), {
    name: "web",
    ...webhookConfig(WEBHOOK, stored.GITHUB_WEBHOOK_SECRET),
  });
  const sigilloSet = exec.calls.find(({ args }) => args[1] === "set");
  assert.deepEqual(sigilloSet.args.slice(-2), ["--env", "stage"]);
  assert.doesNotMatch(result.stdout, new RegExp(stored.GITHUB_WEBHOOK_SECRET, "u"));
});

test("github setup re-sends the stored secret to an existing webhook", async () => {
  const fixture = await site();
  const { exec, stored } = githubExec({ hooks: [{ id: 7, config: { url: WEBHOOK } }] });

  const result = await fixture.run(["github", "setup"], {
    env: {
      CI_DEPLOY_API_TOKEN: "ci-deploy",
      GITHUB_CI_TOKEN: "good-token",
      GITHUB_WEBHOOK_SECRET: "kept-secret",
    },
    fetch: githubFetch(),
    exec,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(stored, {});
  const patch = exec.calls.find(({ args }) => args.includes("PATCH"));
  assert.equal(patch.args[3], "repos/example/fixture/hooks/7");
  assert.equal(JSON.parse(patch.input).config.secret, "kept-secret");
});

test("github setup --dry-run reports the plan without writing anything", async () => {
  const fixture = await site();
  const { exec, stored } = githubExec();

  const result = await fixture.run(["github", "setup", "--dry-run"], {
    env: { CI_DEPLOY_API_TOKEN: "ci-deploy", GITHUB_CI_TOKEN: "stale-token" },
    fetch: githubFetch(),
    exec,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\+ generate the webhook secret/u);
  assert.match(result.stdout, /\+ GitHub token: GitHub answered 401 for example\/fixture/u);
  assert.match(result.stdout, new RegExp(`\\+ create webhook ${WEBHOOK}`, "u"));
  assert.deepEqual(stored, {});
  assert.ok(exec.calls.every(({ args }) => !args.includes("-X")));
});

test("github setup can't ask for a new GitHub token without a terminal", async () => {
  const fixture = await site();
  const { exec } = githubExec();

  const result = await fixture.run(["github", "setup"], {
    env: { CI_DEPLOY_API_TOKEN: "ci-deploy", GITHUB_WEBHOOK_SECRET: "kept" },
    fetch: githubFetch(),
    exec,
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Cannot ask for a secret without a terminal/u);
  assert.ok(
    exec.calls.every(({ args }) => !args.includes("-X")),
    "no webhook without a token",
  );
});

test("github setup has nothing to connect for an Artifacts-only site", async () => {
  const fixture = await site({ ops: ARTIFACTS_ONLY_OPS });
  const exec = recordingExec();

  const result = await fixture.run(["github", "setup"], { env: {}, exec });

  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stdout,
    /no github\.repository: this site's code lives in Cloudflare Artifacts/u,
  );
  assert.deepEqual(exec.calls, []);
});

// --- gq git artifacts --------------------------------------------------------

const ARTIFACTS_HOST = "account-1.artifacts.cloudflare.net";

test("git artifacts setup registers gq as the Artifacts host's only credential helper", async () => {
  const fixture = await site();
  const exec = recordingExec(({ args }) =>
    args[0] === "remote" ? { stdout: "git@github.com:example/fixture.git\n" } : {},
  );

  const result = await fixture.run(["git", "artifacts", "setup"], { exec });

  assert.equal(result.code, 0, result.stderr);
  const key = `credential.https://${ARTIFACTS_HOST}.helper`;
  const helper = helperCommand(fixture.root);
  assert.deepEqual(
    exec.calls.filter(({ args }) => args[0] === "config").map(({ args }) => args),
    [
      ["config", "--local", "--unset-all", key],
      ["config", "--local", "--add", key, ""],
      ["config", "--local", "--add", key, helper],
    ],
  );
  const gq = JSON.stringify(fixture.path("node_modules/.bin/gq"));
  assert.equal(helper, `!${gq} sigillo run staging -- ${gq} git artifacts`);
  assert.ok(exec.calls.every(({ command, cwd }) => command === "git" && cwd === fixture.root));
  assert.match(result.stdout, /origin pushes to: git@github\.com:example\/fixture\.git/u);
});

test("git artifacts setup drops the Artifacts push URL older setups added", async () => {
  const fixture = await site();
  const artifacts = `https://${ARTIFACTS_HOST}/git/fixture-ns/fixture-repo.git`;
  const github = "git@github.com:example/fixture.git";
  let pushUrls = `${github}\n${artifacts}\n`;
  const exec = recordingExec(({ args }) => {
    const joined = args.join(" ");
    if (joined === "remote get-url --push --all origin") return { stdout: pushUrls };
    if (joined === "remote get-url origin") return { stdout: `${github}\n` };
    if (joined === "config --local --unset-all remote.origin.pushurl") pushUrls = `${github}\n`;
    return {};
  });

  const result = await fixture.run(["git", "artifacts", "setup"], { exec });

  assert.equal(result.code, 0, result.stderr);
  assert.ok(
    exec.calls.some(
      ({ args }) => args.join(" ") === "config --local --unset-all remote.origin.pushurl",
    ),
  );
  assert.ok(!exec.calls.some(({ args }) => args.includes("set-url")), "only GitHub is left");
  assert.match(result.stdout, /origin pushes to: git@github\.com:example\/fixture\.git\n/u);
});

test("git artifacts setup makes Artifacts the origin of an Artifacts-only site", async () => {
  const fixture = await site({ ops: ARTIFACTS_ONLY_OPS });
  const artifacts = `https://${ARTIFACTS_HOST}/git/fixture-ns/fixture-repo.git`;
  let origin;
  const exec = recordingExec(({ args }) => {
    const joined = args.join(" ");
    if (joined.startsWith("remote get-url"))
      return origin ? { stdout: `${origin}\n` } : { code: 2 };
    if (joined === `remote add origin ${artifacts}`) origin = artifacts;
    return {};
  });

  const result = await fixture.run(["git", "artifacts", "setup"], { exec });

  assert.equal(result.code, 0, result.stderr);
  const key = `credential.https://${ARTIFACTS_HOST}.helper`;
  assert.ok(
    exec.calls.some(
      ({ args }) => args.join(" ") === `config --local --add ${key} ${helperCommand(fixture.root)}`,
    ),
  );
  assert.match(result.stdout, new RegExp(`Added origin: ${artifacts.replaceAll(".", "\\.")}`, "u"));
  assert.match(
    result.stdout,
    /origin pushes to: https:\/\/account-1\.artifacts\.cloudflare\.net\//u,
  );

  // Run again: origin is already Artifacts, so nothing is added.
  const again = await fixture.run(["git", "artifacts", "setup"], { exec });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(exec.calls.filter(({ args }) => args[1] === "add").length, 1);
});

test("git artifacts setup leaves an Artifacts-only site's other origin alone, and says so", async () => {
  const fixture = await site({ ops: ARTIFACTS_ONLY_OPS });
  const exec = recordingExec(({ args }) =>
    args[0] === "remote" ? { stdout: "git@github.com:example/fixture.git\n" } : {},
  );

  const result = await fixture.run(["git", "artifacts", "setup"], { exec });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /origin is git@github\.com:example\/fixture\.git, not the Artifacts repository/u,
  );
  assert.match(result.stderr, /run git remote set-url origin https:\/\/account-1\.artifacts/u);
  assert.ok(
    !exec.calls.some(
      ({ args }) => args.includes("set-url") || (args.includes("add") && args[0] === "remote"),
    ),
  );
});

const credentialRequest = (host) => Readable.from([`protocol=https\nhost=${host}\n\n`]);

test("git artifacts get answers the Artifacts host with a read-only, one-hour git token", async () => {
  const fixture = await site();
  const fetch = recordingFetch(({ url, body, headers }) => {
    assert.equal(
      url,
      "https://api.cloudflare.com/client/v4/accounts/account-1/artifacts/namespaces/fixture-ns/tokens",
    );
    assert.equal(headers.Authorization, "Bearer artifacts-api");
    assert.deepEqual(JSON.parse(body), { repo: "fixture-repo", scope: "read", ttl: 3600 });
    return { success: true, result: { plaintext: "git-token" } };
  });

  const result = await fixture.run(["git", "artifacts", "get"], {
    env: { ARTIFACTS_API_TOKEN: "artifacts-api" },
    fetch,
    stdin: credentialRequest(ARTIFACTS_HOST),
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "username=x\npassword=git-token\n");
});

test("git artifacts get answers an Artifacts-only site with a token that can push", async () => {
  const fixture = await site({ ops: ARTIFACTS_ONLY_OPS });
  const fetch = recordingFetch(({ body }) => {
    assert.deepEqual(JSON.parse(body), { repo: "fixture-repo", scope: "write", ttl: 3600 });
    return { success: true, result: { plaintext: "git-token" } };
  });

  const result = await fixture.run(["git", "artifacts", "get"], {
    env: { ARTIFACTS_API_TOKEN: "artifacts-api" },
    fetch,
    stdin: credentialRequest(ARTIFACTS_HOST),
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "username=x\npassword=git-token\n");
});

test("git artifacts leaves other hosts, store and erase to git", async () => {
  const fixture = await site();
  const other = await fixture.run(["git", "artifacts", "get"], {
    env: { ARTIFACTS_API_TOKEN: "artifacts-api" },
    stdin: credentialRequest("github.com"),
  });
  assert.equal(other.code, 0, other.stderr);
  assert.equal(other.stdout, "");
  assert.deepEqual(other.fetch.requests, []);

  for (const operation of ["store", "erase"]) {
    const result = await fixture.run(["git", "artifacts", operation], {
      stdin: credentialRequest(ARTIFACTS_HOST),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "");
  }
});

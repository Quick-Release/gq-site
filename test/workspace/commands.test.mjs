// gq setup, gq doctor and gq verify: the shared workspace runners, driven
// through run() against a content fixture site (the content variant's checks
// and required files), with a recording exec standing in for sh,
// node, pnpm, git, ddev, composer and sigillo.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename } from "node:path";
import test from "node:test";

import { VERSION } from "../../src/version.mjs";
import {
  createFixtureSite,
  json,
  recordingExec,
  recordingFetch,
} from "../support/fixture-site.mjs";
import { CONTENT_CHECKS } from "../support/site-settings.mjs";

const LOCAL_CHECKS = CONTENT_CHECKS.filter((line) => !line.startsWith("composer "));

const OPS = {
  schemaVersion: 1,
  project: "fixture",
  variant: "content",
  sigillo: {
    apiUrl: "https://secrets.example.test",
    projectId: "PROJECT1",
    environments: { local: "dev" },
  },
  cloudflare: { accountId: "account-1" },
  artifacts: { namespace: "fixture-ns", repo: "fixture" },
  github: { repository: "example/fixture" },
};

const ARTIFACTS_REMOTE = "https://account-1.artifacts.cloudflare.net/git/fixture-ns/fixture.git";
const GITHUB_REMOTE = "git@github.com:example/fixture.git";

const MANIFEST = {
  name: "fixture",
  private: true,
  devDependencies: { "@getquick/site": VERSION },
  engines: { node: ">=22.12.0" },
  packageManager: "pnpm@12.6.0",
};

// `overrides` replaces files; null leaves one out.
function siteFiles(overrides = {}) {
  const files = {
    "package.json": JSON.stringify(MANIFEST),
    ".mise.toml": '[tools]\nnode = "24.21.0"\n',
    "apps/cms/composer.json": "{}",
    "apps/cms/.ddev/config.yaml": "name: fixture-admin\ntype: wordpress\n",
    "apps/cms/.env.example": "WP_ENV='local'\n",
    "apps/frontend/package.json": "{}",
    "apps/frontend/astro.config.mjs": "export default {};\n",
    "apps/frontend/.env.example": "PUBLIC_GRAPHQL_URL=''\n",
    ...overrides,
  };
  return Object.fromEntries(Object.entries(files).filter(([, content]) => content !== null));
}

async function site({ ops = OPS, files = {} } = {}) {
  return createFixtureSite({ ops, files: siteFiles(files) });
}

// A machine with every tool, a running DDEV project and a logged-in Sigillo,
// unless told otherwise. `installed` names what `command -v` finds; `codes`
// maps a command line (sigillo by its basename) to its exit code; `stdout`
// to its output.
function machine({
  installed = ["pnpm", "git", "ddev", "composer"],
  node = "v24.21.0",
  pnpm = "12.6.0",
  ddev = "running",
  pushUrls = [GITHUB_REMOTE],
  codes = {},
  stdout = {},
} = {}) {
  const outputs = {
    "node --version": `${node}\n`,
    "pnpm --version": `${pnpm}\n`,
    "git --version": "git version 2.50.0\n",
    "git remote get-url --push --all origin": `${pushUrls.join("\n")}\n`,
    ...stdout,
  };
  return recordingExec((call) => {
    if (isLookup(call)) return { code: installed.includes(call.args.at(-1)) ? 0 : 1 };
    const line = commandLine(call);
    if (line === "ddev describe -j") {
      return ddev ? { stdout: JSON.stringify({ raw: { status: ddev } }) } : { code: 1 };
    }
    return { code: codes[line] ?? 0, stdout: outputs[line] ?? "" };
  });
}

function isLookup({ command, args }) {
  return command === "sh" && args[1]?.startsWith("command -v");
}

function commandLine({ command, args }) {
  return [basename(command) === "sigillo" ? "sigillo" : command, ...args].join(" ");
}

// The calls that do something: everything except `command -v` lookups.
const actions = (exec) => exec.calls.filter((call) => !isLookup(call)).map(commandLine);

// --- gq verify ---------------------------------------------------------------

test("gq verify runs the site's checks in order, in the site root, on the terminal", async () => {
  const fixture = await site({ files: { "apps/cms/vendor/autoload.php": "" } });
  const exec = machine();
  const result = await fixture.run(["verify"], {
    cwd: fixture.path("apps/cms"),
    env: { A: "1" },
    exec,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(actions(exec), CONTENT_CHECKS);
  const checks = exec.calls.filter((call) => !isLookup(call));
  const options = exec.options.filter((_, index) => !isLookup(exec.calls[index]));
  for (const [index, call] of checks.entries()) {
    assert.equal(call.cwd, fixture.root);
    assert.equal(call.env.A, "1");
    // The caller installed dependencies; no `pnpm run` re-verifies them.
    assert.equal(call.env.pnpm_config_verify_deps_before_run, "false");
    assert.equal(options[index].stdio, "inherit");
  }
  assert.match(result.stdout, /✓ pnpm run check \(\d+\.\ds\)/u);
  assert.match(result.stdout, /All 9 checks passed in \d+\.\ds\./u);
  assert.equal(result.stderr, "");
});

test("gq verify stops at the first failing check with its exit code", async () => {
  const fixture = await site();
  const exec = machine({ codes: { "pnpm run check": 3 } });
  const result = await fixture.run(["verify", "--ci"], { exec });
  assert.equal(result.code, 3);
  assert.deepEqual(actions(exec), ["pnpm run check"]);
  assert.match(result.stderr, /✗ pnpm run check failed/u);
  assert.doesNotMatch(result.stdout, /checks passed/u);
});

test("gq verify skips (and reports) the Composer checks locally without PHP", async () => {
  for (const [label, installed, files] of [
    ["no Composer", ["pnpm"], { "apps/cms/vendor/autoload.php": "" }],
    ["no apps/cms/vendor", ["pnpm", "composer"], {}],
  ]) {
    const fixture = await site({ files });
    const exec = machine({ installed });
    const result = await fixture.run(["verify"], { exec });
    assert.equal(result.code, 0, `${label}: ${result.stderr}`);
    assert.deepEqual(actions(exec), LOCAL_CHECKS, label);
    assert.match(
      result.stderr,
      /⚠ skipped composer --working-dir=apps\/cms validate — install Composer and run: pnpm cms:composer/u,
      label,
    );
    assert.match(result.stdout, /All 6 checks passed in \d+\.\ds \(3 skipped\)\./u, label);
  }
});

test("gq verify --ci runs every check, PHP or not, without looking for Composer", async () => {
  const fixture = await site();
  const exec = machine({ installed: [] });
  const result = await fixture.run(["verify", "--ci"], { exec });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(exec.calls.filter(isLookup).length, 0);
  assert.deepEqual(actions(exec), CONTENT_CHECKS);
  assert.match(result.stdout, /All 9 checks passed/u);
});

test("gq verify honours the requirements a site declares on its checks", async () => {
  // A commerce site has no default checks: these are all it runs.
  const ops = {
    ...OPS,
    variant: "commerce",
    verify: {
      checks: [
        { cmd: "pnpm", args: ["run", "test"] },
        { cmd: "pnpm", args: ["run", "cms:test"], requires: ["php"] },
        { cmd: "pnpm", args: ["run", "e2e"], requires: ["ddev"] },
        { cmd: "composer", args: ["audit"], requires: [] },
      ],
    },
  };

  const stopped = await site({ ops });
  const withoutDdev = machine({ installed: ["pnpm", "ddev"], ddev: "stopped" });
  const skipped = await stopped.run(["verify"], { exec: withoutDdev });
  assert.equal(skipped.code, 0, skipped.stderr);
  assert.deepEqual(
    actions(withoutDdev).filter((line) => !line.startsWith("ddev")),
    ["pnpm run test", "composer audit"],
  );
  assert.match(skipped.stderr, /⚠ skipped pnpm run cms:test — install Composer/u);
  assert.match(skipped.stderr, /⚠ skipped pnpm run e2e — start DDEV: pnpm cms:dev/u);

  const running = await site({ ops, files: { "apps/cms/vendor/autoload.php": "" } });
  const everything = machine();
  const all = await running.run(["verify"], { exec: everything });
  assert.equal(all.code, 0, all.stderr);
  assert.deepEqual(
    actions(everything).filter((line) => !line.startsWith("ddev")),
    ["pnpm run test", "pnpm run cms:test", "pnpm run e2e", "composer audit"],
  );
});

test("gq verify refuses a check requirement it doesn't know", async () => {
  const fixture = await site({
    ops: { ...OPS, verify: { checks: [{ cmd: "pnpm", args: ["x"], requires: ["docker"] }] } },
  });
  const exec = machine();
  const result = await fixture.run(["verify"], { exec });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /verify\.checks\[0\]\.requires\[0\] must be "php" or "ddev"/u);
  assert.deepEqual(actions(exec), []);
});

test("gq verify takes its own options only", async () => {
  const fixture = await site();
  const unknown = await fixture.run(["verify", "--fast"], { exec: machine() });
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Usage: gq verify \[--ci\]/u);
});

// --- gq doctor ---------------------------------------------------------------

async function healthySite(files = {}, ops = OPS) {
  const fixture = await site({
    ops,
    files: {
      "apps/cms/vendor/autoload.php": "",
      "apps/cms/.env": "",
      "apps/frontend/.env": "",
      "node_modules/.bin/sigillo": "",
      ...files,
    },
  });
  return fixture;
}

test("gq doctor reports the toolchain pins, the gq version and a healthy site", async () => {
  const fixture = await healthySite();
  const exec = machine();
  const result = await fixture.run(["doctor"], { exec });
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /^Fixture workspace doctor/u);
  assert.match(
    result.stdout,
    new RegExp(`✓ @getquick/site ${VERSION.replaceAll(".", "\\.")}`, "u"),
  );
  assert.match(result.stdout, /✓ Node\.js 24\.21\.0 \(matches the \.mise\.toml pin\)/u);
  assert.match(result.stdout, /✓ pnpm 12\.6\.0 \(matches the packageManager pin\)/u);
  assert.match(result.stdout, /✓ git git version 2\.50\.0/u);
  assert.match(result.stdout, /✓ apps\/cms Composer dependencies installed/u);
  assert.match(result.stdout, /✓ origin pushes to GitHub only/u);
  assert.match(result.stdout, /✓ Sigillo project PROJECT1/u);
  assert.match(result.stdout, /✓ Sigillo is logged in/u);
  assert.match(result.stdout, /✓ DDEV is running for fixture-admin/u);
  assert.match(result.stdout, /All required checks passed\./u);
  assert.doesNotMatch(result.stdout, /[⚠✗]/u);
  assert.ok(actions(exec).includes("sigillo me --api-url https://secrets.example.test"));
});

test("gq doctor fails when Node is below the site's engines minimum", async () => {
  const fixture = await healthySite();
  const result = await fixture.run(["doctor"], { exec: machine({ node: "v20.11.0" }) });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /✗ Node\.js 20\.11\.0 found; Fixture needs >= 22\.12\.0/u);
  assert.match(result.stdout, /Some required checks need attention\./u);
});

test("gq doctor fails when a file the site requires is missing", async () => {
  const fixture = await healthySite({ "apps/frontend/astro.config.mjs": null });
  const result = await fixture.run(["doctor"], { exec: machine() });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /✗ apps\/frontend\/astro\.config\.mjs is missing/u);
});

test("gq doctor fails without node_modules", async () => {
  const fixture = await site();
  const result = await fixture.run(["doctor"], { exec: machine() });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /✗ node_modules is missing — run: pnpm run setup --no-ddev/u);
});

test("gq doctor warns, without failing, about drift from the pins", async () => {
  const fixture = await healthySite({
    "package.json": JSON.stringify({
      ...MANIFEST,
      devDependencies: { "@getquick/site": "0.0.1" },
    }),
  });
  const result = await fixture.run(["doctor"], {
    exec: machine({ node: "v24.1.0", pnpm: "11.0.0", pushUrls: [GITHUB_REMOTE, ARTIFACTS_REMOTE] }),
  });
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /⚠ @getquick\/site .+ is running, but package\.json pins 0\.0\.1/u);
  assert.match(result.stdout, /⚠ Node\.js 24\.1\.0 is running but \.mise\.toml pins 24\.21\.0/u);
  assert.match(result.stdout, /⚠ pnpm 11\.0\.0 is running but package\.json pins 12\.6\.0/u);
  assert.match(result.stdout, /⚠ origin still pushes to Cloudflare Artifacts too/u);
});

test("gq doctor wants an Artifacts-only site to push to Artifacts through gq's helper", async () => {
  const fixture = await healthySite({}, { ...OPS, github: undefined });
  const helper = `credential.https://account-1.artifacts.cloudflare.net.helper !"${fixture.path("node_modules/.bin/gq")}" sigillo run staging -- "${fixture.path("node_modules/.bin/gq")}" git artifacts`;
  const helpers = { "git config --local --get-regexp ^credential\\..*\\.helper$": `${helper}\n` };

  const pushing = await fixture.run(["doctor"], {
    exec: machine({ pushUrls: [ARTIFACTS_REMOTE], stdout: helpers }),
  });
  assert.match(pushing.stdout, /✓ origin pushes to Cloudflare Artifacts \(no GitHub repository\)/u);

  const onGithub = await fixture.run(["doctor"], { exec: machine({ stdout: helpers }) });
  const noHelper = await fixture.run(["doctor"], {
    exec: machine({ pushUrls: [ARTIFACTS_REMOTE] }),
  });
  for (const result of [onGithub, noHelper]) {
    assert.equal(result.code, 0, result.stdout);
    assert.match(
      result.stdout,
      /⚠ origin doesn't push to Cloudflare Artifacts through gq's credential helper .+ run: pnpm git:artifacts setup/u,
    );
  }
});

test("gq doctor reads the Node pin from .nvmrc when there is no .mise.toml", async () => {
  const fixture = await healthySite({ ".mise.toml": "[tools]\n", ".nvmrc": "v24.21.0\n" });
  const result = await fixture.run(["doctor"], { exec: machine() });
  assert.match(result.stdout, /✓ Node\.js 24\.21\.0 \(matches the \.nvmrc pin\)/u);
});

test("gq doctor reports stopped DDEV, missing env files and a logged-out Sigillo", async () => {
  const fixture = await site({
    files: { "apps/cms/vendor/autoload.php": "", "node_modules/.bin/sigillo": "" },
  });
  const exec = machine({
    ddev: null,
    codes: { "sigillo me --api-url https://secrets.example.test": 1 },
  });
  const result = await fixture.run(["doctor"], { exec });
  assert.equal(result.code, 0, result.stdout);
  assert.match(
    result.stdout,
    /⚠ apps\/frontend\/\.env is missing — run: pnpm run setup --no-ddev \(it creates it from \.env\.example\)/u,
  );
  assert.match(
    result.stdout,
    /⚠ apps\/cms\/\.env is missing — run: pnpm run setup --no-ddev \(it creates it from \.env\.example; gq cms start points it at DDEV\)/u,
  );
  assert.doesNotMatch(result.stdout, /copy \.env\.example|set local credentials/u);
  assert.match(result.stdout, /⚠ Sigillo is not logged in — run: pnpm sigillo:login/u);
  assert.match(
    result.stdout,
    /⚠ DDEV is installed but fixture-admin is not running — run: pnpm cms:dev/u,
  );
});

test("gq doctor checks local media only, and fails when the local CMS would write to the live bucket", async () => {
  const healthy = await healthySite();
  const ready = await healthy.run(["doctor"], { exec: machine() });
  assert.match(
    ready.stdout,
    /Media \(local development\):\n {2}✓ the local CMS keeps uploads on disk in apps\/cms\/web\/app\/uploads/u,
  );

  const live = await healthySite({ "apps/cms/.env": "S3_UPLOADS_SECRET='live-secret'\n" });
  const result = await live.run(["doctor"], { exec: machine() });
  assert.equal(result.code, 1, result.stdout);
  assert.match(
    result.stdout,
    /✗ apps\/cms\/\.env sets S3_UPLOADS_SECRET: the local CMS would write uploads to the live bucket — remove/u,
  );
  assert.ok(!result.stdout.includes("live-secret"));
});

const LOCAL_LISTING =
  "sigillo secrets --api-url https://secrets.example.test --project PROJECT1 --env dev";

test("gq doctor fails when an app's env file sets a secret Sigillo holds, naming it but not its value", async () => {
  const fixture = await healthySite({
    "apps/cms/.env": "WP_ENV='local'\nPLOI_API_TOKEN='ploi-value'\n",
    "apps/frontend/.dev.vars": "FRONTEND_REFRESH_TOKEN=refresh-value\nPUBLIC_URL=x\n",
  });
  const exec = machine({
    stdout: { [LOCAL_LISTING]: "NAME\nPLOI_API_TOKEN\nFRONTEND_REFRESH_TOKEN\nCOMPOSER_AUTH\n" },
  });

  const result = await fixture.run(["doctor"], { exec });

  assert.equal(result.code, 1, result.stdout);
  assert.match(
    result.stdout,
    /✗ apps\/cms\/\.env sets PLOI_API_TOKEN, a secret Sigillo dev holds — remove it: gq sigillo run injects it/u,
  );
  assert.match(
    result.stdout,
    /✗ apps\/frontend\/\.dev\.vars sets FRONTEND_REFRESH_TOKEN, a secret Sigillo dev holds/u,
  );
  assert.doesNotMatch(result.stdout, /WP_ENV|PUBLIC_URL|COMPOSER_AUTH/u);
  assert.ok(!result.stdout.includes("ploi-value"));
  assert.ok(!result.stdout.includes("refresh-value"));
  assert.ok(!actions(exec).some((line) => /secrets get/u.test(line)));
});

test("gq doctor checks every app's .env, .env.local and .dev.vars against every Sigillo environment", async () => {
  const ops = {
    ...OPS,
    sigillo: { ...OPS.sigillo, environments: { local: "dev", staging: "stage" } },
  };
  const fixture = await healthySite(
    {
      "apps/frontend/.env.local": "CLOUDFLARE_API_TOKEN=x\n",
      "apps/docs/.env": "DOCS_TOKEN=y\n",
    },
    ops,
  );
  const exec = machine({
    stdout: {
      [LOCAL_LISTING]: "CLOUDFLARE_API_TOKEN\n",
      [LOCAL_LISTING.replace("--env dev", "--env stage")]: "DOCS_TOKEN\n",
    },
  });

  const result = await fixture.run(["doctor"], { exec });

  assert.equal(result.code, 1, result.stdout);
  assert.match(
    result.stdout,
    /✗ apps\/frontend\/\.env\.local sets CLOUDFLARE_API_TOKEN, a secret Sigillo dev holds/u,
  );
  assert.match(result.stdout, /✗ apps\/docs\/\.env sets DOCS_TOKEN, a secret Sigillo stage holds/u);
});

test("gq doctor confirms the env files hold no Sigillo secret, and says when it can't check", async () => {
  const healthy = await healthySite({ "apps/cms/.env": "WP_ENV='local'\n" });
  const clean = await healthy.run(["doctor"], {
    exec: machine({ stdout: { [LOCAL_LISTING]: "PLOI_API_TOKEN\n" } }),
  });
  assert.equal(clean.code, 0, clean.stdout);
  assert.match(clean.stdout, /✓ no app's env file sets a secret Sigillo holds/u);

  const unlisted = await healthy.run(["doctor"], {
    exec: machine({ codes: { [LOCAL_LISTING]: 1 } }),
  });
  assert.equal(unlisted.code, 0, unlisted.stdout);
  assert.match(unlisted.stdout, /⚠ could not list Sigillo dev's secret names/u);

  const loggedOut = await healthy.run(["doctor"], {
    exec: machine({ codes: { "sigillo me --api-url https://secrets.example.test": 1 } }),
  });
  assert.match(
    loggedOut.stdout,
    /· env files not checked for Sigillo secrets: Sigillo isn't ready/u,
  );
});

test("gq doctor skips the Artifacts check for a site without an Artifacts mirror", async () => {
  const ops = { ...OPS, artifacts: undefined };
  const fixture = await createFixtureSite({
    ops,
    files: siteFiles({ "node_modules/.bin/sigillo": "" }),
  });
  const exec = machine();
  const result = await fixture.run(["doctor"], { exec });
  assert.doesNotMatch(result.stdout, /Artifacts/u);
  assert.ok(!actions(exec).some((line) => line.startsWith("git remote")));
});

// The Artifacts API's namespace listing, holding `namespaces`; `status`
// fails it instead.
function artifactsApi({ namespaces = [], status = 200 } = {}) {
  return recordingFetch(({ method, url }) => {
    assert.equal(method, "GET");
    assert.equal(
      url,
      "https://api.cloudflare.com/client/v4/accounts/account-1/artifacts/namespaces",
    );
    if (status !== 200) return json({ success: false, errors: [{ message: "nope" }] }, status);
    return { success: true, result: namespaces };
  });
}

const STAGING_OPS = {
  ...OPS,
  sigillo: { ...OPS.sigillo, environments: { local: "dev", staging: "stage" } },
};
const STAGING_TOKEN =
  "sigillo secrets get ARTIFACTS_API_TOKEN --api-url https://secrets.example.test " +
  "--project PROJECT1 --env stage --raw --force";

test("gq doctor fails when the Artifacts namespace is in another jurisdiction than gq.ops.json's", async () => {
  const fixture = await healthySite({}, STAGING_OPS);
  const exec = machine({ stdout: { [STAGING_TOKEN]: "staging-artifacts\n" } });
  const fetch = artifactsApi({
    namespaces: [{ namespace: "fixture-ns", jurisdiction: "unrestricted" }],
  });

  const result = await fixture.run(["doctor"], { exec, fetch });

  assert.equal(result.code, 1, result.stdout);
  assert.match(
    result.stdout,
    /✗ Artifacts namespace fixture-ns is unrestricted, but gq\.ops\.json artifacts\.jurisdiction is eu \(the default\)/u,
  );
  assert.equal(fetch.requests[0].headers.Authorization, "Bearer staging-artifacts");
  assert.ok(!result.stdout.includes("staging-artifacts"));
});

test("gq doctor confirms the namespace's jurisdiction with ARTIFACTS_API_TOKEN from the environment", async () => {
  const fixture = await healthySite(
    {},
    {
      ...STAGING_OPS,
      artifacts: { ...OPS.artifacts, jurisdiction: "us" },
    },
  );
  const exec = machine();
  const fetch = artifactsApi({ namespaces: [{ namespace: "fixture-ns", jurisdiction: "us" }] });

  const result = await fixture.run(["doctor"], {
    env: { ARTIFACTS_API_TOKEN: "env-artifacts" },
    exec,
    fetch,
  });

  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /✓ Artifacts namespace fixture-ns is in us, as gq\.ops\.json says/u);
  assert.equal(fetch.requests[0].headers.Authorization, "Bearer env-artifacts");
  assert.ok(!actions(exec).some((line) => line.startsWith("sigillo secrets get")));
});

test("gq doctor only warns when it can't check the namespace's jurisdiction", async () => {
  const fixture = await healthySite({}, STAGING_OPS);
  const env = { ARTIFACTS_API_TOKEN: "env-artifacts" };

  const missing = await fixture.run(["doctor"], { env, exec: machine(), fetch: artifactsApi() });
  assert.equal(missing.code, 0, missing.stdout);
  assert.match(
    missing.stdout,
    /⚠ Artifacts namespace fixture-ns doesn't exist yet — run: gq cloudflare ci/u,
  );

  const failing = await fixture.run(["doctor"], {
    env,
    exec: machine(),
    fetch: artifactsApi({ status: 403 }),
  });
  assert.equal(failing.code, 0, failing.stdout);
  assert.match(
    failing.stdout,
    /⚠ could not read Artifacts namespace fixture-ns's jurisdiction: .*nope/u,
  );
});

test("gq doctor skips the jurisdiction check without the Artifacts token", async () => {
  // No Sigillo staging environment and no ARTIFACTS_API_TOKEN: nothing to ask with.
  const fixture = await healthySite();
  const result = await fixture.run(["doctor"], { exec: machine() });
  assert.equal(result.code, 0, result.stdout);
  assert.match(
    result.stdout,
    /· Artifacts namespace fixture-ns's jurisdiction not checked: no ARTIFACTS_API_TOKEN/u,
  );
});

// --- gq setup ----------------------------------------------------------------

test("gq setup --no-ddev installs, creates the .env files and skips DDEV and Composer", async () => {
  const fixture = await site();
  const exec = machine();
  const result = await fixture.run(["setup", "--no-ddev"], { cwd: fixture.path("apps"), exec });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(actions(exec), ["pnpm install --frozen-lockfile"]);
  assert.equal(exec.calls.find((call) => !isLookup(call)).cwd, fixture.root);
  assert.equal(await readFile(fixture.path("apps/cms/.env"), "utf8"), "WP_ENV='local'\n");
  assert.equal(
    await readFile(fixture.path("apps/frontend/.env"), "utf8"),
    "PUBLIC_GRAPHQL_URL=''\n",
  );
  assert.match(result.stdout, /--no-ddev: skipping DDEV and Composer/u);
  assert.match(result.stdout, /pnpm deploy:frontend/u);
});

test("gq setup keeps an existing .env and copes without an .env.example", async () => {
  const fixture = await site({
    files: { "apps/cms/.env": "KEEP=1\n", "apps/frontend/.env.example": null },
  });
  const result = await fixture.run(["setup", "--no-ddev"], { exec: machine() });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(fixture.path("apps/cms/.env"), "utf8"), "KEEP=1\n");
  assert.equal(existsSync(fixture.path("apps/frontend/.env")), false);
  assert.match(result.stdout, /apps\/cms\/\.env already exists — skipping/u);
  assert.match(result.stderr, /No apps\/frontend\/\.env\.example — skipping env copy/u);
});

test("gq setup starts DDEV and installs Composer through the site's scripts", async () => {
  const fixture = await site();
  const exec = machine();
  const result = await fixture.run(["setup"], { exec });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(actions(exec), [
    "pnpm install --frozen-lockfile",
    "pnpm cms:dev:raw --foreground",
    "pnpm cms:composer",
  ]);
  for (const call of exec.calls.filter((call) => !isLookup(call))) {
    assert.equal(call.cwd, fixture.root);
  }
});

test("gq setup skips WordPress without DDEV, and stops at a failing step", async () => {
  const noDdev = await site();
  const withoutDdev = machine({ installed: ["pnpm"] });
  const skipped = await noDdev.run(["setup"], { exec: withoutDdev });
  assert.equal(skipped.code, 0, skipped.stderr);
  assert.deepEqual(actions(withoutDdev), ["pnpm install --frozen-lockfile"]);
  assert.match(skipped.stderr, /ddev not found — skipping WordPress bootstrap/u);

  const failing = await site();
  const exec = machine({ codes: { "pnpm cms:dev:raw --foreground": 5 } });
  const failed = await failing.run(["setup"], { exec });
  assert.equal(failed.code, 5);
  assert.deepEqual(actions(exec), [
    "pnpm install --frozen-lockfile",
    "pnpm cms:dev:raw --foreground",
  ]);
});

test("gq setup needs pnpm", async () => {
  const fixture = await site();
  const exec = machine({ installed: [] });
  const result = await fixture.run(["setup", "--no-ddev"], { exec });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\[setup\] pnpm is required/u);
  assert.deepEqual(actions(exec), []);
});

test("gq setup and gq doctor take no options of their own beyond --no-ddev", async () => {
  const fixture = await site();
  await mkdir(fixture.path("node_modules"), { recursive: true });
  for (const argv of [
    ["setup", "--ci"],
    ["doctor", "--fix"],
  ]) {
    const result = await fixture.run(argv, { exec: machine() });
    assert.equal(result.code, 1, argv.join(" "));
    assert.match(result.stderr, /Usage: gq (setup \[--no-ddev\]|doctor)/u);
  }
});

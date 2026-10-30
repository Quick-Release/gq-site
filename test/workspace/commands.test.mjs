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
  // A site's own checks run after the variant's defaults (ADR 0017 gave
  // commerce the same ones as content, plus its Frontend's build).
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
    actions(withoutDdev)
      .filter((line) => !line.startsWith("ddev"))
      .slice(-2),
    ["pnpm run test", "composer audit"],
  );
  assert.match(skipped.stderr, /⚠ skipped pnpm run cms:test — install Composer/u);
  assert.match(skipped.stderr, /⚠ skipped pnpm run e2e — start DDEV: pnpm cms:dev/u);

  const running = await site({ ops, files: { "apps/cms/vendor/autoload.php": "" } });
  const everything = machine();
  const all = await running.run(["verify"], { exec: everything });
  assert.equal(all.code, 0, all.stderr);
  assert.deepEqual(
    actions(everything)
      .filter((line) => !line.startsWith("ddev"))
      .slice(-4),
    ["pnpm run test", "pnpm run cms:test", "pnpm run e2e", "composer audit"],
  );
});

test("a commerce site's default checks are content's, with its Frontend's build", async () => {
  const fixture = await site({ ops: { ...OPS, variant: "commerce" } });
  const exec = machine({ installed: [] });
  const result = await fixture.run(["verify", "--ci"], { exec });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(actions(exec), [
    ...CONTENT_CHECKS.slice(0, 3),
    "pnpm run build",
    ...CONTENT_CHECKS.slice(3),
  ]);
  assert.match(result.stdout, /All 10 checks passed/u);
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

test("gq doctor rejects assignments from every Sigillo environment across apps without exposing values", async () => {
  const ops = {
    ...OPS,
    artifacts: undefined,
    sigillo: {
      ...OPS.sigillo,
      environments: { local: "dev", staging: "stage", operations: "ops", release: "stage" },
    },
    doctor: { requiredFiles: { "tools/worker": [] } },
  };
  const files = {
    "apps/cms/.env": "export LOCAL_TOKEN='local-value-must-stay-private'\n",
    "apps/frontend/.env.local": "STAGE_TOKEN=\n",
    "apps/worker/.dev.vars": "OperationsToken=ops-value-must-stay-private\n",
    "tools/worker/.env": "STAGE_TOKEN=another-private-value\n",
    "apps/worker/node_modules/dependency/.env": "LOCAL_TOKEN=ignored\n",
    "apps/node_modules/.env": "LOCAL_TOKEN=ignored\n",
  };
  const fixture = await healthySite(files, ops);
  const stdout = Object.fromEntries(
    Object.entries({ dev: "LOCAL_TOKEN", stage: "STAGE_TOKEN", ops: "OperationsToken" }).map(
      ([environment, name]) => [
        `sigillo secrets --api-url https://secrets.example.test --project PROJECT1 --env ${environment}`,
        `${name}\n`,
      ],
    ),
  );
  const exec = machine({ stdout });
  const result = await fixture.run(["doctor"], { exec });
  assert.equal(result.code, 1, result.stdout);
  for (const [path, name] of [
    ["apps/cms/.env", "LOCAL_TOKEN"],
    ["apps/frontend/.env.local", "STAGE_TOKEN"],
    ["apps/worker/.dev.vars", "OperationsToken"],
    ["tools/worker/.env", "STAGE_TOKEN"],
  ]) {
    assert.ok(result.stdout.includes(`${path} sets ${name}`), result.stdout);
    assert.equal(await readFile(fixture.path(path), "utf8"), files[path]);
  }
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /must-stay-private|another-private-value|node_modules.*sets/u,
  );
  // Listing reads names only; the one value read is the consent check's
  // Cloudflare token, never a listed assignment's.
  const calls = actions(exec).filter((line) => line.startsWith("sigillo secrets"));
  assert.equal(calls.filter((line) => !line.includes(" get ")).length, 3);
  assert.deepEqual(
    calls.filter((line) => line.includes(" get ")).map((line) => line.split(" ")[3]),
    ["CLOUDFLARE_API_TOKEN"],
  );
});

test("gq doctor allows only the blueprint's exact CMS local stand-ins, even when examples are edited", async () => {
  const standIns = {
    DB_PASSWORD: "db",
    AUTH_KEY: "fixture-local-auth-key",
    SECURE_AUTH_KEY: "fixture-local-secure-auth-key",
    LOGGED_IN_KEY: "fixture-local-logged-in-key",
    NONCE_KEY: "fixture-local-nonce-key",
    AUTH_SALT: "fixture-local-auth-salt",
    SECURE_AUTH_SALT: "fixture-local-secure-auth-salt",
    LOGGED_IN_SALT: "fixture-local-logged-in-salt",
    NONCE_SALT: "fixture-local-nonce-salt",
  };
  const source = Object.entries(standIns)
    .map(([name, value]) => `export ${name}='${value}' # public local value`)
    .join("\n");
  const exec = () =>
    machine({
      stdout: {
        "sigillo secrets --api-url https://secrets.example.test --project PROJECT1 --env dev":
          Object.keys(standIns).join("\n"),
      },
    });
  const healthy = await healthySite({ "apps/cms/.env": source });
  const clean = await healthy.run(["doctor"], { exec: exec() });
  assert.equal(clean.code, 0, clean.stdout);

  for (const [path, content] of [
    ["apps/cms/.env", "AUTH_KEY=private-key\n"],
    ["apps/cms/.env", "AUTH_KEY=private-key\nAUTH_KEY=fixture-local-auth-key\n"],
    ["apps/cms/.env", "DB_PASSWORD=\n"],
    ["apps/cms/.env.local", source],
    ["apps/frontend/.env", source],
  ]) {
    const fixture = await healthySite({ [path]: content, "apps/cms/.env.example": content });
    const result = await fixture.run(["doctor"], { exec: exec() });
    assert.equal(result.code, 1, `${path}: ${result.stdout}`);
    assert.ok(result.stdout.includes(`${path} sets `));
    assert.doesNotMatch(result.stdout + result.stderr, /private-key/u);
  }
});

test("gq doctor fails if any configured Sigillo environment cannot be listed without echoing process errors", async () => {
  const ops = {
    ...OPS,
    artifacts: undefined,
    sigillo: { ...OPS.sigillo, environments: { local: "dev", staging: "stage" } },
  };
  const fixture = await healthySite({}, ops);
  const exec = recordingExec(async (call) => {
    if (
      basename(call.command) === "sigillo" &&
      call.args[0] === "secrets" &&
      call.args.at(-1) === "stage"
    ) {
      return { code: 1, stderr: "network diagnostic containing private-token-value" };
    }
    return machine()(call.command, call.args, { cwd: call.cwd, env: call.env });
  });
  const result = await fixture.run(["doctor"], { exec });
  assert.equal(result.code, 1, result.stdout);
  assert.match(
    result.stdout,
    /✗ could not list Sigillo stage variable names.*gq sigillo secrets staging/u,
  );
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /private-token-value|no disallowed assignments/u,
  );
});

test("gq doctor requires configured Sigillo to be installed, provisioned, and mapped", async () => {
  for (const [files, sigillo, message] of [
    [{ "node_modules/.bin/sigillo": null }, OPS.sigillo, /Sigillo CLI is missing/u],
    [
      {},
      { ...OPS.sigillo, projectId: "REPLACE_WITH_PROJECT_ID" },
      /projectId is still a placeholder/u,
    ],
    [{}, { ...OPS.sigillo, environments: {} }, /configure gq\.ops\.json sigillo\.environments/u],
    [
      {},
      { ...OPS.sigillo, environments: undefined },
      /configure gq\.ops\.json sigillo\.environments/u,
    ],
  ]) {
    const fixture = await healthySite(files, { ...OPS, sigillo });
    const result = await fixture.run(["doctor"], { exec: machine() });
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, message);
    assert.doesNotMatch(result.stdout, /no disallowed assignments/u);
  }
});

test("gq doctor retains the R2 check without Sigillo and leaves local configuration alone", async () => {
  const ops = { ...OPS, sigillo: undefined };
  const clean = await healthySite(
    {
      "apps/cms/.env": "DB_PASSWORD=db\n",
      "apps/frontend/.env": "PUBLIC_WORDPRESS_GRAPHQL_URL=http://cms.test/graphql\n",
    },
    ops,
  );
  const ready = await clean.run(["doctor"], { exec: machine() });
  assert.equal(ready.code, 0, ready.stdout);
  assert.doesNotMatch(ready.stdout, /Secrets \(Sigillo\)/u);
  const unsafe = await healthySite({ "apps/cms/.env": "S3_UPLOADS_KEY=private-r2-key\n" }, ops);
  const failed = await unsafe.run(["doctor"], { exec: machine() });
  assert.equal(failed.code, 1, failed.stdout);
  assert.match(failed.stdout, /apps\/cms\/\.env sets S3_UPLOADS_KEY/u);
  assert.doesNotMatch(failed.stdout + failed.stderr, /private-r2-key/u);
});

test("gq doctor does not print a rejected value through its local media diagnostics", async () => {
  const fixture = await healthySite({
    "apps/cms/.env": "S3_UPLOADS_BUCKET_URL=private-bucket-value\n",
  });
  const exec = machine({
    stdout: {
      "sigillo secrets --api-url https://secrets.example.test --project PROJECT1 --env dev":
        "S3_UPLOADS_BUCKET_URL\n",
    },
  });
  const result = await fixture.run(["doctor"], { exec });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /apps\/cms\/\.env sets S3_UPLOADS_BUCKET_URL/u);
  assert.doesNotMatch(result.stdout + result.stderr, /private-bucket-value/u);
});

test("gq doctor detects secret names that collide with JavaScript object properties", async () => {
  const fixture = await healthySite({
    "apps/frontend/.env": "export __proto__=private-prototype-value\n",
  });
  const exec = machine({
    stdout: {
      "sigillo secrets --api-url https://secrets.example.test --project PROJECT1 --env dev":
        "__proto__\n",
    },
  });
  const result = await fixture.run(["doctor"], { exec });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /apps\/frontend\/\.env sets __proto__/u);
  assert.doesNotMatch(result.stdout + result.stderr, /private-prototype-value/u);
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

test("gq doctor fails for logged-out Sigillo and names commands to generate missing env files", async () => {
  const fixture = await site({
    files: { "apps/cms/vendor/autoload.php": "", "node_modules/.bin/sigillo": "" },
  });
  const exec = machine({
    ddev: null,
    codes: { "sigillo me --api-url https://secrets.example.test": 1 },
  });
  const result = await fixture.run(["doctor"], { exec });
  assert.equal(result.code, 1, result.stdout);
  assert.match(result.stdout, /apps\/frontend\/\.env is missing — run: gq setup --no-ddev/u);
  assert.match(result.stdout, /apps\/cms\/\.env is missing — run: gq cms start/u);
  assert.match(result.stdout, /✗ Sigillo is not logged in — run: pnpm sigillo:login/u);
  assert.doesNotMatch(result.stdout, /copy \.env\.example/u);
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
  assert.ok(!actions(exec).some((line) => line.startsWith("sigillo secrets get ARTIFACTS")));
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

// The D1 listing for the consent databases (ADR 0019), holding `databases`;
// the Artifacts listing answers as artifactsApi's does.
function consentApi({ databases = [], status = 200, namespaces = [], details = {} } = {}) {
  return recordingFetch(({ method, url }) => {
    assert.equal(method, "GET");
    const { pathname, searchParams } = new URL(url);
    if (pathname.endsWith("/artifacts/namespaces")) return { success: true, result: namespaces };
    const detail = /\/d1\/database\/([^/]+)$/u.exec(pathname)?.[1];
    if (detail) return { success: true, result: details[detail] };
    assert.equal(pathname, "/client/v4/accounts/account-1/d1/database");
    assert.equal(searchParams.get("name"), "fixture-fe-consent");
    if (status !== 200) return json({ success: false, errors: [{ message: "denied" }] }, status);
    const page = Number(searchParams.get("page") ?? 1);
    return {
      success: true,
      result: page === 1 ? databases : [],
      result_info: { page, per_page: 50, total_pages: 1 },
    };
  });
}

const CONSENT_TOKEN =
  "sigillo secrets get CLOUDFLARE_API_TOKEN --api-url https://secrets.example.test " +
  "--project PROJECT1 --env stage --raw --force";

test("gq doctor fails when a consent database isn't in the eu jurisdiction", async () => {
  const fixture = await healthySite({}, STAGING_OPS);
  const exec = machine({ stdout: { [CONSENT_TOKEN]: "staging-deploy\n" } });
  const fetch = consentApi({
    databases: [
      { uuid: "a", name: "fixture-fe-consent", jurisdiction: "eu" },
      { uuid: "b", name: "fixture-fe-consent-preview", jurisdiction: null },
      // Another Site's, which the name filter can match too.
      { uuid: "c", name: "fixture-fe-consent2", jurisdiction: null },
    ],
  });

  const result = await fixture.run(["doctor"], { exec, fetch });

  assert.equal(result.code, 1, result.stdout);
  assert.match(
    result.stdout,
    /✗ consent database fixture-fe-consent-preview is in the default jurisdiction, not eu: Cloudflare can't move it/u,
  );
  assert.match(result.stdout, /✓ consent database fixture-fe-consent is in the eu jurisdiction/u);
  assert.doesNotMatch(result.stdout, /fixture-fe-consent2/u);
  const d1 = fetch.requests.find(({ url }) => url.includes("/d1/"));
  assert.equal(d1.headers.Authorization, "Bearer staging-deploy");
  assert.ok(!result.stdout.includes("staging-deploy"));
});

test("gq doctor passes consent databases in eu, with CLOUDFLARE_API_TOKEN from the environment", async () => {
  const fixture = await healthySite();
  const fetch = consentApi({
    databases: [{ uuid: "a", name: "fixture-fe-consent", jurisdiction: "eu" }],
  });

  const result = await fixture.run(["doctor"], {
    env: { CLOUDFLARE_API_TOKEN: "env-deploy" },
    exec: machine(),
    fetch,
  });

  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /✓ consent database fixture-fe-consent is in the eu jurisdiction/u);
});

test("gq doctor reads a database's jurisdiction itself when the listing leaves it out", async () => {
  const fixture = await healthySite();
  const fetch = consentApi({
    databases: [{ uuid: "a", name: "fixture-fe-consent" }],
    details: { a: { uuid: "a", name: "fixture-fe-consent", jurisdiction: "eu" } },
  });

  const result = await fixture.run(["doctor"], {
    env: { CLOUDFLARE_API_TOKEN: "env-deploy" },
    exec: machine(),
    fetch,
  });

  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /✓ consent database fixture-fe-consent is in the eu jurisdiction/u);
  assert.ok(fetch.requests.some(({ url }) => url.endsWith("/d1/database/a")));
});

test("gq doctor reports a Site without a consent database, and skips without a token", async () => {
  const fixture = await healthySite();
  const none = await fixture.run(["doctor"], {
    env: { CLOUDFLARE_API_TOKEN: "env-deploy" },
    exec: machine(),
    fetch: consentApi(),
  });
  assert.equal(none.code, 0, none.stdout);
  assert.match(none.stdout, /· no consent database yet: a Frontend deploy creates it in eu/u);

  const denied = await fixture.run(["doctor"], {
    env: { CLOUDFLARE_API_TOKEN: "env-deploy" },
    exec: machine(),
    fetch: consentApi({ status: 403 }),
  });
  assert.equal(denied.code, 0, denied.stdout);
  assert.match(denied.stdout, /⚠ could not list the consent databases: .*denied/u);

  const skipped = await fixture.run(["doctor"], { exec: machine() });
  assert.match(
    skipped.stdout,
    /· consent database jurisdiction not checked: no CLOUDFLARE_API_TOKEN/u,
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

// --- gq doctor: headless forms -------------------------------------------------

const FORMS_ROUTE = "apps/frontend/src/pages/gq/forms/[...rest].ts";
const STAGE_NAMES =
  "sigillo secrets --api-url https://secrets.example.test --project PROJECT1 --env stage";

function formsSite({ spam = ["honeypot"], files = {} } = {}) {
  return healthySite(files, {
    ...OPS,
    contentRuntime: "package",
    wordpress: { plugins: ["gravityforms"] },
    forms: { provider: "gravityforms", spam },
    sigillo: { ...OPS.sigillo, environments: { local: "dev", staging: "stage" } },
  });
}

test("gq doctor checks a Site's forms wiring: its route, its runtime opt-in and Turnstile's keys", async () => {
  const wired = {
    [FORMS_ROUTE]: "// managed\n",
    "apps/frontend/src/lib/content.ts": "createContentRuntime({ forms: true });\n",
  };
  const honeypot = await (await formsSite({ files: wired })).run(["doctor"], { exec: machine() });
  assert.equal(honeypot.code, 0, honeypot.stdout);
  assert.match(
    honeypot.stdout,
    /\nForms:\n {2}✓ apps\/frontend\/src\/pages\/gq\/forms\/\[\.\.\.rest\]\.ts handles form posts\n {2}✓ src\/lib\/content\.ts passes forms to the content runtime\n/u,
  );

  const unwired = await (await formsSite()).run(["doctor"], { exec: machine() });
  assert.equal(unwired.code, 1);
  assert.match(
    unwired.stdout,
    /✗ apps\/frontend\/src\/pages\/gq\/forms\/\[\.\.\.rest\]\.ts is missing — run: gq sync/u,
  );
  assert.match(
    unwired.stdout,
    /⚠ apps\/frontend\/src\/lib\/content\.ts doesn't pass forms to createContentRuntime/u,
  );

  const turnstile = await formsSite({ spam: ["honeypot", "turnstile"], files: wired });
  const without = await turnstile.run(["doctor"], {
    exec: machine({ stdout: { [STAGE_NAMES]: "TURNSTILE_SITE_KEY\n" } }),
  });
  assert.equal(without.code, 1);
  assert.match(
    without.stdout,
    /✗ gq\.ops\.json forms\.spam chooses Turnstile, but Sigillo staging lacks TURNSTILE_SECRET_KEY/u,
  );
  const withKeys = await turnstile.run(["doctor"], {
    exec: machine({ stdout: { [STAGE_NAMES]: "TURNSTILE_SITE_KEY\nTURNSTILE_SECRET_KEY\n" } }),
  });
  assert.equal(withKeys.code, 0, withKeys.stdout);
  assert.match(withKeys.stdout, /✓ Sigillo staging has Turnstile's keys/u);
});

test("gq doctor fails a Site with forms whose CMS REST gate still closes submissions", async () => {
  const CONTENT_API = "apps/cms/web/app/mu-plugins/content-api.php";
  const wired = {
    [FORMS_ROUTE]: "// managed\n",
    "apps/frontend/src/lib/content.ts": "createContentRuntime({ forms: true });\n",
  };
  const before = await formsSite({
    files: {
      ...wired,
      [CONTENT_API]: "<?php add_filter('rest_authentication_errors', $closed);\n",
    },
  });
  const closed = await before.run(["doctor"], { exec: machine() });
  assert.equal(closed.code, 1);
  assert.match(
    closed.stdout,
    /✗ apps\/cms\/web\/app\/mu-plugins\/content-api\.php closes the REST API to anonymous form submissions, so every post fails with 401: add the submissions exception \(docs\/guides\/forms\.md#the-cmss-rest-gate\)/u,
  );

  const template = await readFile(
    new URL(`../../blueprint/templates/${CONTENT_API}`, import.meta.url),
    "utf8",
  );
  const after = await formsSite({ files: { ...wired, [CONTENT_API]: template } });
  const open = await after.run(["doctor"], { exec: machine() });
  assert.equal(open.code, 0, open.stdout);
  assert.match(open.stdout, /✓ the CMS's REST gate lets form submissions through/u);

  // A mention of the route isn't the exception.
  const mentioned = await formsSite({
    files: {
      ...wired,
      [CONTENT_API]:
        "<?php // TODO /gf/v2/forms/\nadd_filter('rest_authentication_errors', $closed);\n",
    },
  });
  assert.equal((await mentioned.run(["doctor"], { exec: machine() })).code, 1);

  const missing = await (await formsSite({ files: wired })).run(["doctor"], { exec: machine() });
  assert.match(
    missing.stdout,
    /· apps\/cms\/web\/app\/mu-plugins\/content-api\.php not found: its REST gate isn't checked/u,
  );
});

test("gq doctor has no forms section for a Site without forms", async () => {
  const result = await (await healthySite()).run(["doctor"], { exec: machine() });
  assert.doesNotMatch(result.stdout, /Forms:/u);
});

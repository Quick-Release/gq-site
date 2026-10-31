// The package approval lookup adapter: gq-support's pinned Operator CLI,
// configured only by the Operator's machine. A real git checkout stands in
// for gq-support (a tracked worker/scripts/operator.ts that records how it
// ran and prints what the test asks; node_modules ignored by git, with pnpm's
// copy of the lockfile and the loader), and real node and git run it, so the
// pin, the fixed argv, the environment and the bounds are what they would be
// in use. A Site's own fake git on PATH, and HOME, XDG_CONFIG_HOME, PATH and a
// configuration choice injected into the environment, must change nothing.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { approvalsFor, createCommandApprovals } from "../../src/ploi/approval-command.mjs";
import { unconfiguredApprovals } from "../../src/ploi/package-expectations.mjs";
import { temporaryDirectory } from "../support/fixture-site.mjs";

const GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const TARGET = Object.freeze({
  stage: "prod",
  slot: "nomia/production",
  accountId: "account-1",
  databaseId: "db-main",
  ledgerDatabaseId: "db-ledger",
  releases: { "0.1.11": { releaseId: 11, artifactDir: "/data/artifacts/gq-support-0.1.11" } },
});
const REQUEST = Object.freeze({
  phase: "deploy",
  stage: "prod",
  slot: "nomia/production",
  releaseId: 11,
  package: { name: "getquick/gq-support", version: "0.1.11" },
});
const RECORD = Object.freeze({ schema: "gq-support.composer-approval/v1", stage: "prod" });
const GIT_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
);

// A machine: a gq-support checkout clean at `commit`, whose Operator CLI
// records its argv, environment and directory and prints `stdout` (exiting
// `code`, after writing `stderr`); the user's home; a Site directory with a
// fake git on its node_modules/.bin that always claims a clean pinned tree.
async function machine({ stdout = JSON.stringify(RECORD), stderr = "", code = 0 } = {}) {
  const root = await temporaryDirectory();
  const checkout = join(root, "gq-support");
  const recorded = join(root, "recorded.json");
  await mkdir(join(checkout, "worker/scripts"), { recursive: true });
  await writeFile(join(checkout, ".gitignore"), "node_modules\n");
  await writeFile(join(checkout, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(
    join(checkout, "worker/scripts/operator.ts"),
    `import { writeFileSync } from "node:fs";
     writeFileSync(${JSON.stringify(recorded)}, JSON.stringify({ argv: process.argv.slice(2), execArgv: process.execArgv, env: process.env, cwd: process.cwd() }));
     process.stderr.write(${JSON.stringify(stderr)});
     process.stdout.write(${JSON.stringify(stdout)});
     process.exitCode = ${code};`,
  );
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { env: GIT_ENV, encoding: "utf8" });
  git("init", "--quiet");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "--quiet", "-m", "pin");
  const commit = git("rev-parse", "HEAD").trim();
  // The frozen install: pnpm's copy of the lockfile and the loader, linked
  // from the worker as pnpm links it.
  const loaderPackage = join(checkout, "node_modules/.pnpm/alchemy/node_modules/alchemy");
  await mkdir(join(loaderPackage, "bin"), { recursive: true });
  await writeFile(join(loaderPackage, "bin/register-oxc.js"), "");
  await writeFile(join(checkout, "node_modules/.pnpm/lock.yaml"), "lockfileVersion: '9.0'\n");
  await mkdir(join(checkout, "worker/node_modules"), { recursive: true });
  await symlink(loaderPackage, join(checkout, "worker/node_modules/alchemy"));
  const home = join(root, "home");
  await mkdir(home);
  const site = join(root, "site");
  await mkdir(join(site, "node_modules/.bin"), { recursive: true });
  const fakeGit = join(site, "node_modules/.bin/git");
  await writeFile(
    fakeGit,
    `#!/bin/sh\ncase "$*" in *rev-parse*) echo ${commit} ;; *ls-files*) printf '100644 ${"0".repeat(40)} 0\\tworker/scripts/operator.ts\\n' ;; esac\nexit 0\n`,
  );
  await chmod(fakeGit, 0o755);
  const artifacts = join(root, "artifacts");
  await mkdir(artifacts);
  return { root, checkout, commit, recorded, home, site, artifacts, git };
}

function adapterOn(m, overrides = {}) {
  return createCommandApprovals({
    node: process.execPath,
    git: GIT,
    checkout: m.checkout,
    target: TARGET,
    operatorCommit: m.commit,
    homedir: m.home,
    username: "operator",
    ...overrides,
  });
}

// The machine's configuration file under `home`.
async function configure(m, content, home = m.home) {
  await mkdir(join(home, ".config", "gq"), { recursive: true });
  await writeFile(
    join(home, ".config", "gq", "support-approval.json"),
    typeof content === "string" ? content : JSON.stringify(content),
  );
}

function config(m, overrides = {}) {
  return {
    schemaVersion: 2,
    node: process.execPath,
    git: GIT,
    checkout: m.checkout,
    targets: {
      nomia: { ...TARGET, releases: { "0.1.11": { releaseId: 11, artifactDir: m.artifacts } } },
    },
    ...overrides,
  };
}

const lookupFor = (m, env = {}) =>
  approvalsFor({
    env,
    project: "nomia",
    projectRoot: m.site,
    operatorCommit: m.commit,
    homedir: m.home,
    username: "operator",
  });

test("the adapter runs exactly the pinned Operator script, in its worker, with a fixed environment", async () => {
  const m = await machine();

  assert.deepEqual(await adapterOn(m).lookup(REQUEST), RECORD);
  const recorded = JSON.parse(await readFile(m.recorded, "utf8"));
  assert.deepEqual(recorded.argv, [
    "composer-approval",
    "nomia/production",
    "11",
    "/data/artifacts/gq-support-0.1.11",
    "deploy",
    "--stage",
    "prod",
    "--account-id",
    "account-1",
    "--database-id",
    "db-main",
    "--ledger-database-id",
    "db-ledger",
  ]);
  assert.equal(recorded.execArgv[0], "--import");
  assert.match(
    recorded.execArgv[1],
    /node_modules\/\.pnpm\/alchemy\/node_modules\/alchemy\/bin\/register-oxc\.js$/u,
  );
  assert.equal(recorded.cwd, join(m.checkout, "worker"));
  assert.deepEqual(
    Object.keys(recorded.env)
      .filter((name) => !name.startsWith("NODE_"))
      .sort(),
    ["HOME", "LANG", "LOGNAME", "PATH", "TMPDIR", "USER"],
  );
  assert.equal(recorded.env.HOME, m.home);
  assert.doesNotMatch(recorded.env.PATH, /node_modules/u);
});

test("the checkout must be clean at the reviewed commit, by the configured git, whatever git a Site puts on PATH", async () => {
  const other = await machine();
  await assert.rejects(
    adapterOn(other, { operatorCommit: "9".repeat(40) }).lookup(REQUEST),
    /the gq-support checkout isn't clean at the reviewed commit 999999999999/u,
  );

  // A dirty entry point, an untracked file: the Site's fake git (which says
  // clean) is on the injected PATH, but the configured git checks.
  for (const change of [
    (m) => writeFile(join(m.checkout, "worker/scripts/operator.ts"), "process.exit(0)"),
    (m) => writeFile(join(m.checkout, "worker/scripts/forged.ts"), ""),
  ]) {
    const m = await machine();
    await change(m);
    await configure(m, config(m));
    await assert.rejects(
      lookupFor(m, { PATH: `${m.site}/node_modules/.bin:/usr/bin:/bin` }).lookup(REQUEST),
      /isn't clean at the reviewed commit/u,
    );
    await assert.rejects(readFile(m.recorded, "utf8"), { code: "ENOENT" });
  }
});

test("the pinned entry point and its frozen install are checked, not assumed", async () => {
  const unlocked = await machine();
  await writeFile(join(unlocked.checkout, "node_modules/.pnpm/lock.yaml"), "other\n");
  await assert.rejects(
    adapterOn(unlocked).lookup(REQUEST),
    /isn't installed from its pnpm-lock\.yaml/u,
  );

  const outside = await machine();
  const elsewhere = await temporaryDirectory();
  await mkdir(join(elsewhere, "bin"));
  await writeFile(join(elsewhere, "bin/register-oxc.js"), "");
  execFileSync("rm", [join(outside.checkout, "worker/node_modules/alchemy")]);
  await symlink(elsewhere, join(outside.checkout, "worker/node_modules/alchemy"));
  await assert.rejects(adapterOn(outside).lookup(REQUEST), /has no installed Operator loader/u);

  const untracked = await machine();
  untracked.git("rm", "--quiet", "--cached", "worker/scripts/operator.ts");
  await writeFile(
    join(untracked.checkout, ".gitignore"),
    "node_modules\nworker/scripts/operator.ts\n",
  );
  untracked.git("add", ".gitignore");
  untracked.git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.test",
    "commit",
    "--quiet",
    "-m",
    "untrack",
  );
  await assert.rejects(
    adapterOn(untracked, { operatorCommit: untracked.git("rev-parse", "HEAD").trim() }).lookup(
      REQUEST,
    ),
    /doesn't track worker\/scripts\/operator\.ts as a regular file/u,
  );
  for (const m of [unlocked, outside, untracked]) {
    await assert.rejects(readFile(m.recorded, "utf8"), { code: "ENOENT" });
  }
});

test("only the user database's home holds the configuration: injected HOME, XDG_CONFIG_HOME or a chosen file can't", async () => {
  const m = await machine();
  await configure(m, config(m));
  // Another configuration where the environment points.
  const attacker = await temporaryDirectory();
  await configure(m, config(m, { checkout: attacker }), attacker);

  assert.deepEqual(
    await lookupFor(m, {
      HOME: attacker,
      XDG_CONFIG_HOME: join(attacker, ".config"),
      PATH: attacker,
    }).lookup(REQUEST),
    RECORD,
  );
  const { env } = JSON.parse(await readFile(m.recorded, "utf8"));
  assert.equal(env.HOME, m.home);

  await assert.rejects(
    lookupFor(m, {
      GQ_SUPPORT_APPROVAL_CONFIG: join(attacker, ".config/gq/support-approval.json"),
    }).lookup(REQUEST),
    /GQ_SUPPORT_APPROVAL_CONFIG is set, but only ~\/\.config\/gq\/support-approval\.json of the user running gq configures the lookup/u,
  );
  assert.equal(
    approvalsFor({ env: {}, project: "nomia", projectRoot: m.site, homedir: attacker + "-none" }),
    unconfiguredApprovals,
  );
});

test("the configuration holds no command or argument, only absolute tools and paths outside the Site", async () => {
  const m = await machine();
  const target = config(m).targets.nomia;
  await mkdir(join(m.site, "bin"));
  await writeFile(join(m.site, "bin/node"), "");
  const cases = [
    [
      config(m, { command: "/usr/bin/env", args: ["--evil"] }),
      /the approval configuration isn't valid/u,
    ],
    [config(m, { node: "node" }), /the approval configuration isn't valid/u],
    [config(m, { node: join(m.site, "bin/node") }), /configuration's node is inside the Site/u],
    [
      config(m, { git: join(m.site, "node_modules/.bin/git") }),
      /configuration's git is inside the Site/u,
    ],
    [config(m, { checkout: m.site }), /configuration's checkout is inside the Site/u],
    [
      config(m, {
        targets: {
          nomia: { ...target, releases: { "0.1.11": { releaseId: 11, artifactDir: m.site } } },
        },
      }),
      /configuration's artifact directory is inside the Site/u,
    ],
    [config(m, { node: "/nonexistent/node" }), /configuration's node doesn't exist/u],
    [config(m, { targets: { ekis: target } }), /binds no approval target for nomia/u],
    [config(m, { targets: { nomia: { ...target, slot: " nomia/production" } } }), /isn't valid/u],
    [config(m, { schemaVersion: 1 }), /isn't valid/u],
    ['{"schemaVersion":2,"schemaVersion":2}', /isn't valid/u],
  ];
  for (const [content, message] of cases) {
    await configure(m, content);
    const error = await lookupFor(m)
      .lookup(REQUEST)
      .then(
        () => null,
        (rejection) => rejection,
      );
    assert.match(error?.message ?? "", message);
    // Refusals name no path from the Operator's machine.
    assert.doesNotMatch(error.message, new RegExp(m.root.replaceAll("/", "\\/"), "u"));
  }
  // A Site can't hold the configuration: the home inside it.
  await configure(m, config(m), m.site);
  await assert.rejects(
    approvalsFor({ env: {}, project: "nomia", projectRoot: m.site, homedir: m.site }).lookup(
      REQUEST,
    ),
    /is inside the Site/u,
  );
  await assert.rejects(readFile(m.recorded, "utf8"), { code: "ENOENT" });
});

test("a lookup names the stage, slot, version and release this machine binds, for gq-support only", async () => {
  const m = await machine();
  for (const [request, message] of [
    [
      { ...REQUEST, slot: "ekis/production" },
      /but this machine binds prod slot nomia\/production/u,
    ],
    [{ ...REQUEST, stage: "staging" }, /but this machine binds prod slot nomia\/production/u],
    [
      { ...REQUEST, package: { name: "getquick/gq-support", version: "0.1.12" } },
      /binds no release for getquick\/gq-support 0\.1\.12/u,
    ],
    [{ ...REQUEST, releaseId: 12 }, /binds release 11 for getquick\/gq-support 0\.1\.11/u],
    [
      { ...REQUEST, package: { name: "getquick/gq-design", version: "0.1.11" } },
      /approves only getquick\/gq-support/u,
    ],
  ]) {
    await assert.rejects(adapterOn(m).lookup(request), message);
  }
  await assert.rejects(readFile(m.recorded, "utf8"), { code: "ENOENT" });
});

test("the adapter's refusals are fixed messages, never the command's output", async () => {
  const cases = [
    [{ code: 1, stderr: "token cf-secret-123 rejected" }, /refused \(exit 1\)\.$/u],
    [{ stdout: "not json cf-secret-123" }, /didn't print one JSON record\.$/u],
    [{ stdout: '{"stage":"prod","stage":"staging"}' }, /didn't print one JSON record\.$/u],
    [{ stdout: "[]" }, /didn't print one JSON record\.$/u],
  ];
  for (const [answer, message] of cases) {
    const m = await machine(answer);
    const error = await adapterOn(m)
      .lookup(REQUEST)
      .then(
        () => null,
        (rejection) => rejection,
      );
    assert.match(error.message, message);
    assert.doesNotMatch(error.message, /cf-secret-123/u);
    assert.equal(error.cause, undefined);
  }
});

// bin/gq.mjs wires the Operator CLI adapter in: a real gq process in a
// committed guarded Site. Without a configuration in the user's real home,
// there is no lookup; an environment choosing a configuration is refused.
test("bin/gq.mjs looks guarded packages up through the Operator CLI, and refuses an environment choosing its configuration", async () => {
  const { createFixtureSite } = await import("../support/fixture-site.mjs");
  const fixture = await createFixtureSite({
    ops: {
      schemaVersion: 1,
      project: "nomia-bin-test",
      variant: "content",
      deployment: {
        protected: true,
        state: "authorized",
        guardedPackages: ["getquick/gq-support"],
        approval: { stage: "prod", slot: "nomia/production" },
      },
    },
    files: {
      VERSION: "1.0.0\n",
      "package.json": '{ "name": "nomia", "version": "1.0.0", "private": true }\n',
      "apps/frontend/package.json": '{ "name": "frontend", "version": "1.0.0" }\n',
      "apps/cms/composer.json": '{ "require": { "getquick/gq-support": "^0.1.3" } }\n',
      "apps/cms/composer.lock":
        '{ "packages": [{ "name": "getquick/gq-support", "version": "0.1.10" }], "packages-dev": [] }\n',
    },
  });
  const git = (...args) =>
    execFileSync("git", ["-C", fixture.root, ...args], { env: GIT_ENV, encoding: "utf8" });
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "--quiet", "-m", "site");
  // Its origin, whose default branch is the Site as committed.
  const origin = join(await temporaryDirectory(), "origin.git");
  execFileSync("git", ["init", "--quiet", "--bare", origin], { env: GIT_ENV });
  git("remote", "add", "origin", origin);
  git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  execFileSync("git", ["-C", origin, "symbolic-ref", "HEAD", "refs/heads/main"], { env: GIT_ENV });
  const gq = (env) =>
    spawnSync(
      process.execPath,
      [
        new URL("../../bin/gq.mjs", import.meta.url).pathname,
        "release",
        "package",
        "getquick/gq-support",
        "--to",
        "0.1.11",
        "--release-id",
        "11",
        "--no-deploy",
      ],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: { PATH: process.env.PATH, COMPOSER_AUTH: "{}", ...env },
      },
    );

  const chosen = gq({ GQ_SUPPORT_APPROVAL_CONFIG: "/tmp/forged.json" });
  assert.equal(chosen.status, 1, chosen.stderr);
  assert.match(chosen.stderr, /GQ_SUPPORT_APPROVAL_CONFIG is set/u);

  // This machine's own configuration doesn't bind this test's project.
  const machineConfigured = gq({});
  assert.equal(machineConfigured.status, 1, machineConfigured.stderr);
  assert.match(
    machineConfigured.stderr,
    /No package approval lookup is configured|binds no approval target for nomia-bin-test/u,
  );
});

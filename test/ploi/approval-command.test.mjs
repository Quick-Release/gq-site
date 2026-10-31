// The package approval lookup adapter: gq-support's Operator CLI from a
// reviewed checkout, configured only by the Operator's machine. Real
// processes stand in for the CLI (a node script) and the checkout (a git
// repository), so the bounds, the pin and the environment are what they
// would be in use.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { approvalsFor, createCommandApprovals } from "../../src/ploi/approval-command.mjs";
import { unconfiguredApprovals } from "../../src/ploi/package-expectations.mjs";
import { temporaryDirectory } from "../support/fixture-site.mjs";

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

// A machine with a gq-support checkout (a clean git repository; `commit` is
// its HEAD), an Operator CLI stand-in that records its argv and environment
// and prints `stdout` (exiting `code`, after writing `stderr`), and the
// Site's directory.
async function machine({ stdout = JSON.stringify(RECORD), stderr = "", code = 0 } = {}) {
  const root = await temporaryDirectory();
  const checkout = join(root, "gq-support");
  await mkdir(checkout);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], { env: GIT_ENV, encoding: "utf8" });
  git("init", "--quiet");
  await writeFile(join(checkout, "package.json"), "{}\n");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "--quiet", "-m", "pin");
  const commit = git("rev-parse", "HEAD").trim();
  const recorded = join(root, "recorded.json");
  const operator = join(root, "operator.mjs");
  await writeFile(
    operator,
    `import { writeFileSync } from "node:fs";
     writeFileSync(${JSON.stringify(recorded)}, JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env).sort(), cwd: process.cwd() }));
     process.stderr.write(${JSON.stringify(stderr)});
     process.stdout.write(${JSON.stringify(stdout)});
     process.exitCode = ${code};`,
  );
  const site = join(root, "site");
  await mkdir(site);
  const artifacts = join(root, "artifacts");
  await mkdir(artifacts);
  return { root, checkout, commit, operator, recorded, site, git, artifacts };
}

function adapterOn(m, overrides = {}) {
  return createCommandApprovals({
    command: process.execPath,
    args: [m.operator],
    checkout: m.checkout,
    target: TARGET,
    operatorCommit: m.commit,
    env: { PATH: process.env.PATH },
    ...overrides,
  });
}

test("the adapter runs the Operator CLI in the pinned checkout with exact argv and returns its one record", async () => {
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
  assert.equal(recorded.cwd, m.checkout);
});

test("the adapter refuses a checkout that isn't clean at the reviewed commit, before running the CLI", async () => {
  const other = await machine();
  await assert.rejects(
    adapterOn(other, { operatorCommit: "9".repeat(40) }).lookup(REQUEST),
    /the gq-support checkout isn't clean at the reviewed commit 999999999999/u,
  );
  await assert.rejects(readFile(other.recorded, "utf8"), { code: "ENOENT" });

  const dirty = await machine();
  await writeFile(join(dirty.checkout, "package.json"), '{"scripts":{"operator":"forged"}}\n');
  await assert.rejects(adapterOn(dirty).lookup(REQUEST), /isn't clean at the reviewed commit/u);

  const untracked = await machine();
  await writeFile(join(untracked.checkout, "forged.mjs"), "");
  await assert.rejects(adapterOn(untracked).lookup(REQUEST), /isn't clean at the reviewed commit/u);
});

test("the adapter refuses another stage or slot than this machine binds, before running anything", async () => {
  const m = await machine();
  for (const request of [
    { ...REQUEST, slot: "ekis/production" },
    { ...REQUEST, stage: "staging" },
  ]) {
    await assert.rejects(
      adapterOn(m).lookup(request),
      /but this machine binds prod slot nomia\/production/u,
    );
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

test("the CLI gets only the environment its logins need, never deploy credentials", async () => {
  const home = await temporaryDirectory();
  const m = await machine();
  await mkdir(join(home, ".config", "gq"), { recursive: true });
  await writeFile(
    join(home, ".config", "gq", "support-approval.json"),
    JSON.stringify({
      schemaVersion: 1,
      command: process.execPath,
      args: [m.operator],
      checkout: m.checkout,
      targets: {
        nomia: { ...TARGET, releases: { "0.1.11": { releaseId: 11, artifactDir: m.artifacts } } },
      },
    }),
  );
  const approvals = approvalsFor({
    env: {
      PATH: process.env.PATH,
      HOME: home,
      COMPOSER_AUTH: "registry-login",
      PLOI_API_TOKEN: "ploi",
      R2_SECRET_ACCESS_KEY: "r2",
      RELEASES_R2_SECRET_ACCESS_KEY: "r2",
      CLOUDFLARE_API_TOKEN: "site-token",
      GITHUB_TOKEN: "site-token",
    },
    project: "nomia",
    projectRoot: m.site,
    operatorCommit: m.commit,
  });

  assert.deepEqual(await approvals.lookup(REQUEST), RECORD);
  const { env } = JSON.parse(await readFile(m.recorded, "utf8"));
  for (const name of [
    "COMPOSER_AUTH",
    "PLOI_API_TOKEN",
    "R2_SECRET_ACCESS_KEY",
    "RELEASES_R2_SECRET_ACCESS_KEY",
    "CLOUDFLARE_API_TOKEN",
    "GITHUB_TOKEN",
  ]) {
    assert.ok(!env.includes(name), name);
  }
  assert.ok(env.includes("HOME") && env.includes("PATH"));
});

test("only the Operator's machine configures a lookup: never one inside the Site, relative, or for another project", async () => {
  const m = await machine();
  const target = { ...TARGET, releases: { "0.1.11": { releaseId: 11, artifactDir: m.artifacts } } };
  const config = (overrides = {}) => ({
    schemaVersion: 1,
    command: process.execPath,
    args: [m.operator],
    checkout: m.checkout,
    targets: { nomia: target },
    ...overrides,
  });
  async function lookupWith(content, { home } = {}) {
    home ??= await temporaryDirectory();
    await mkdir(join(home, ".config", "gq"), { recursive: true });
    await writeFile(
      join(home, ".config", "gq", "support-approval.json"),
      typeof content === "string" ? content : JSON.stringify(content),
    );
    return approvalsFor({
      env: { PATH: process.env.PATH, HOME: home },
      project: "nomia",
      projectRoot: m.site,
      operatorCommit: m.commit,
    }).lookup(REQUEST);
  }

  assert.equal(
    approvalsFor({
      env: { HOME: await temporaryDirectory() },
      project: "nomia",
      projectRoot: m.site,
    }),
    unconfiguredApprovals,
  );
  await mkdir(join(m.site, "bin"));
  await writeFile(join(m.site, "bin", "operator"), "");
  const cases = [
    [config({ command: "operator" }), /the approval configuration isn't valid/u],
    [
      config({ command: join(m.site, "bin", "operator") }),
      /configuration's command is inside the Site/u,
    ],
    [config({ checkout: m.site }), /configuration's checkout is inside the Site/u],
    [
      config({
        targets: {
          nomia: { ...target, releases: { "0.1.11": { releaseId: 11, artifactDir: m.site } } },
        },
      }),
      /configuration's artifact directory is inside the Site/u,
    ],
    [config({ command: "/nonexistent/pnpm" }), /configuration's command doesn't exist/u],
    [config({ targets: { ekis: target } }), /binds no approval target for nomia/u],
    [config({ approved: true }), /the approval configuration isn't valid/u],
    [config({ artifactDir: m.artifacts }), /the approval configuration isn't valid/u],
    ['{"schemaVersion":1,"schemaVersion":1}', /the approval configuration isn't valid/u],
  ];
  for (const [content, message] of cases) {
    const error = await lookupWith(content).then(
      () => null,
      (rejection) => rejection,
    );
    assert.match(error?.message ?? "", message);
    // Refusals name no path from the Operator's machine.
    assert.doesNotMatch(error.message, new RegExp(m.root.replaceAll("/", "\\/"), "u"));
  }
  // A Site can't hold the configuration: HOME inside it.
  await assert.rejects(lookupWith(config(), { home: m.site }), /is inside the Site/u);
  await assert.rejects(readFile(m.recorded, "utf8"), { code: "ENOENT" });
});

test("a lookup names the version and release this machine binds, for gq-support only", async () => {
  const m = await machine();
  for (const [request, message] of [
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

test("an explicit configuration location wins, must be absolute, and must exist", async () => {
  const m = await machine();
  const explicit = join(m.root, "operator-approval.json");
  await writeFile(
    explicit,
    JSON.stringify({
      schemaVersion: 1,
      command: process.execPath,
      args: [m.operator],
      checkout: m.checkout,
      targets: {
        nomia: { ...TARGET, releases: { "0.1.11": { releaseId: 11, artifactDir: m.artifacts } } },
      },
    }),
  );
  const lookup = (env) =>
    approvalsFor({
      env: { PATH: process.env.PATH, HOME: "/nonexistent", ...env },
      project: "nomia",
      projectRoot: m.site,
      operatorCommit: m.commit,
    }).lookup(REQUEST);

  assert.deepEqual(await lookup({ GQ_SUPPORT_APPROVAL_CONFIG: explicit }), RECORD);
  await assert.rejects(
    lookup({ GQ_SUPPORT_APPROVAL_CONFIG: "operator-approval.json" }),
    /GQ_SUPPORT_APPROVAL_CONFIG isn't an absolute path/u,
  );
  await assert.rejects(
    lookup({ GQ_SUPPORT_APPROVAL_CONFIG: join(m.root, "missing.json") }),
    /the approval configuration can't be read/u,
  );
});

// bin/gq.mjs wires the Operator CLI adapter in from its own environment: a
// real gq process, in a committed guarded Site, with no configuration (no
// lookup), and with one whose checkout isn't the reviewed commit (refused
// before Composer).
test("bin/gq.mjs looks guarded packages up through the Operator CLI its environment configures", async () => {
  const { createFixtureSite } = await import("../support/fixture-site.mjs");
  const m = await machine();
  const fixture = await createFixtureSite({
    ops: {
      schemaVersion: 1,
      project: "nomia",
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
  const config = join(m.root, "operator-approval.json");
  await writeFile(
    config,
    JSON.stringify({
      schemaVersion: 1,
      command: process.execPath,
      args: [m.operator],
      checkout: m.checkout,
      targets: {
        nomia: { ...TARGET, releases: { "0.1.11": { releaseId: 11, artifactDir: m.artifacts } } },
      },
    }),
  );
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
        env: { PATH: process.env.PATH, HOME: m.root, COMPOSER_AUTH: "{}", ...env },
      },
    );

  const unconfigured = gq({});
  assert.equal(unconfigured.status, 1, unconfigured.stderr);
  assert.match(unconfigured.stderr, /No package approval lookup is configured/u);

  const unpinned = gq({ GQ_SUPPORT_APPROVAL_CONFIG: config });
  assert.equal(unpinned.status, 1, unpinned.stderr);
  assert.match(
    unpinned.stderr,
    /the gq-support checkout isn't clean at the reviewed commit 29de3c7ec66a/u,
  );
  assert.doesNotMatch(unpinned.stderr, new RegExp(m.root.replaceAll("/", "\\/"), "u"));
  // The CLI never ran.
  await assert.rejects(readFile(m.recorded, "utf8"), { code: "ENOENT" });
});

// The package approval lookup adapter: gq-support's Operator CLI from a
// reviewed checkout, configured only by the Operator's machine. Real
// processes stand in for the CLI (a node script) and the checkout (a git
// repository), so the bounds, the pin and the environment are what they
// would be in use.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  return { root, checkout, commit, operator, recorded, site, git };
}

function adapterOn(m, overrides = {}) {
  return createCommandApprovals({
    command: process.execPath,
    args: [m.operator],
    checkout: m.checkout,
    artifactDir: "/data/artifacts/gq-support-0.1.11",
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
      artifactDir: "/data/artifacts/gq-support-0.1.11",
      targets: { nomia: TARGET },
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
  const config = (overrides = {}) => ({
    schemaVersion: 1,
    command: process.execPath,
    args: [m.operator],
    checkout: m.checkout,
    artifactDir: "/data/artifacts",
    targets: { nomia: TARGET },
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
    [config({ command: "operator" }), /isn't a valid approval configuration/u],
    [config({ command: join(m.site, "bin", "operator") }), /'s command is inside the Site/u],
    [config({ checkout: m.site }), /'s checkout is inside the Site/u],
    [config({ command: "/nonexistent/pnpm" }), /'s command doesn't exist/u],
    [config({ targets: { ekis: TARGET } }), /binds no approval target for nomia/u],
    [config({ approved: true }), /isn't a valid approval configuration/u],
    ['{"schemaVersion":1,"schemaVersion":1}', /isn't a valid approval configuration/u],
  ];
  for (const [content, message] of cases) {
    await assert.rejects(lookupWith(content), message);
  }
  // A Site can't hold the configuration: HOME inside it.
  await assert.rejects(lookupWith(config(), { home: m.site }), /is inside the Site/u);
  await assert.rejects(readFile(m.recorded, "utf8"), { code: "ENOENT" });
});

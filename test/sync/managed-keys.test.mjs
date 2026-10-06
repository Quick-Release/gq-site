// gq new and gq sync on package.json managed keys: every other key
// belongs to the site and is never touched.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { VERSION } from "../../src/version.mjs";
import { createFixtureSite } from "../support/fixture-site.mjs";
import { hash, newSite, readSite, snapshot } from "../support/generated-site.mjs";

// The root scripts that wrap gq or run the generated deploy files (the
// release step and the checks gq verify runs).
const GQ_SCRIPTS = {
  setup: "gq setup",
  doctor: "gq doctor",
  verify: "gq verify",
  "test:scripts": "node --test scripts/*.test.mjs",
  "cms:dev": "gq sigillo run local -- gq cms start",
  "cms:dev:raw": "gq cms start",
  "cms:dev:foreground": "gq sigillo run local -- gq cms start --foreground",
  "cms:dev:status": "gq cms status",
  "cms:stop": "gq cms stop",
  "cms:describe": "gq cms describe",
  "cms:composer": "gq sigillo run local -- gq cms composer install",
  "cms:composer:update": "gq sigillo run local -- gq cms composer update",
  "cms:composer:reinstall": "gq sigillo run local -- gq cms composer reinstall",
  "cms:test": "gq cms composer test",
  "cms:lint": "gq cms composer lint",
  "db:sync": "gq sigillo run staging -- gq db sync",
  "db:backup": "gq sigillo run staging -- gq db backup",
  "deploy:frontend": "gq sigillo run staging -- pnpm --dir infra run deploy:frontend",
  "deploy:frontend:raw": "pnpm --dir infra run deploy:frontend",
  "plan:frontend": "pnpm --dir infra run plan:frontend",
  "infra:check": "pnpm --dir infra run check",
  push: "gq release push",
  release: "gq release prepare",
  "release:prepare": "gq release prepare",
  "release:tag": "gq release tag",
  "version:check": "gq version check",
  "version:sync": "gq version sync",
  prepare: "vp config --no-agent --hooks-dir .vite-hooks",
  ops: "gq sigillo run staging -- gq",
  "ploi:status": "gq sigillo run staging -- gq ploi provision --dry-run",
  "ploi:provision": "gq sigillo run staging -- gq ploi provision",
  "ploi:release": "gq sigillo run staging -- gq ploi release",
  "cf:releases": "gq sigillo run operations -- gq cloudflare releases",
  "cf:media": "gq sigillo run operations -- gq cloudflare media",
  "ploi:media": "gq sigillo run staging -- gq ploi media",
  "ploi:events": "gq sigillo run staging -- gq ploi events",
  "media:check": "gq sigillo run staging -- gq media check",
  "media:check:upload": "gq sigillo run staging -- gq media check --upload",
  "media:check:local": "gq media check --local",
  "frontend:secrets": "gq sigillo run staging -- gq frontend secrets",
  "frontend:refresh": "gq sigillo run staging -- gq frontend refresh",
  "frontend:events:check": "gq sigillo run staging -- gq frontend events check",
  "site:check": "gq sigillo run staging -- gq site check",
  "site:check:local": "gq site check --local",
  "git:artifacts": "gq git artifacts",
  "ci:deploy": "gq sigillo run staging -- gq ci deploy",
  "ci:runs": "gq sigillo run staging -- gq ci runs",
  "ci:check": "pnpm --dir infra/ci run check",
  "cf:ci": "gq sigillo run operations -- gq cloudflare ci",
  "cf:deploy-token": "gq sigillo run operations -- gq cloudflare deploy-token",
  "github:setup": "gq sigillo run staging -- gq github setup",
  offboard: "gq sigillo run operations -- gq offboard",
  "offboard:restore": "gq sigillo run operations -- gq offboard --restore",
  "offboard:archive": "gq sigillo run operations -- gq offboard --archive",
  "ploi:log": "gq sigillo run staging -- gq ploi api sites.log-site --per-page 5",
  "sigillo:login": "gq sigillo login",
  "sigillo:setup": "gq sigillo setup local",
  "sigillo:list:local": "gq sigillo secrets local",
  "sigillo:list:ops": "gq sigillo secrets operations",
  "sigillo:list:staging": "gq sigillo secrets staging",
};
const MANAGED_KEYS = [
  ...Object.keys(GQ_SCRIPTS).map((name) => `scripts.${name}`),
  "engines.node",
  "packageManager",
];

// The site's lock, parsed.
async function readLock(root) {
  return JSON.parse(await readSite(root, "gq.lock.json"));
}

async function writeLock(root, lock) {
  await writeFile(join(root, "gq.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
}

async function readPackage(root) {
  return JSON.parse(await readSite(root, "package.json"));
}

test("gq new writes package.json with the managed keys, each hashed in the lock", async () => {
  const site = await newSite();

  const pkg = await readPackage(site.root);
  // The site's own keys it starts with, then the managed ones.
  assert.deepEqual(pkg, {
    name: "acme",
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: {
      dev: "pnpm frontend:dev",
      "frontend:dev": "pnpm --filter @acme/frontend dev",
      build: "pnpm --filter @acme/frontend build",
      check: "pnpm --filter @acme/frontend check",
      lint: "pnpm --filter @acme/frontend lint",
      format: "pnpm --filter @acme/frontend format",
      test: "pnpm --filter @acme/frontend test",
      ...GQ_SCRIPTS,
    },
    devDependencies: {
      "@getquick/site": VERSION,
      sigillo: "0.13.0",
      vite: "catalog:",
      "vite-plus": "catalog:",
    },
    engines: { node: ">=22.12.0" },
    packageManager: "pnpm@12.6.0",
  });
  assert.equal(await readSite(site.root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  const lock = await readLock(site.root);
  assert.deepEqual(Object.keys(lock.keys), ["package.json"]);
  assert.deepEqual(Object.keys(lock.keys["package.json"]), MANAGED_KEYS);
  assert.equal(lock.keys["package.json"]["scripts.verify"], hash('"gq verify"'));
  assert.equal(lock.keys["package.json"].packageManager, hash('"pnpm@12.6.0"'));
});

test("an edit to a managed package key stops gq sync with a diff, and nothing is written", async () => {
  const site = await newSite();
  const pkg = await readPackage(site.root);
  pkg.scripts.verify = "gq verify --skip php";
  await writeFile(join(site.root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  const before = await snapshot(site.root);

  for (const argv of [["sync"], ["sync", "--check"]]) {
    const result = await site.run(argv);
    assert.equal(result.code, 1);
    assert.equal(
      result.stdout,
      [
        "gq.ops.json: up to date (schema v1).",
        "package.json (managed keys scripts.verify): edited since gq last wrote it (gq.lock.json); gq sync would write:",
        "--- package.json",
        "+++ package.json (gq sync)",
        "@@ -13,7 +13,7 @@",
        '     "test": "pnpm --filter @acme/frontend test",',
        '     "setup": "gq setup",',
        '     "doctor": "gq doctor",',
        '-    "verify": "gq verify --skip php",',
        '+    "verify": "gq verify",',
        '     "test:scripts": "node --test scripts/*.test.mjs",',
        '     "cms:dev": "gq sigillo run local -- gq cms start",',
        '     "cms:dev:raw": "gq cms start",',
        "",
      ].join("\n"),
    );
    assert.equal(
      result.stderr,
      "gq: Local edits to managed files: package.json. gq sync writes nothing until each is " +
        "reverted, or deleted to be regenerated.\n",
    );
    assert.deepEqual(await snapshot(site.root), before);
  }
});

test("a template change to an unedited package key is applied, leaving every other key as it was", async () => {
  const site = await newSite();
  // As an older gq wrote it (before gq new started a site with its own keys):
  // an older pnpm pin, no ploi:log script yet, and two scripts the blueprint
  // has since retired, one the site has edited.
  const pkg = await readPackage(site.root);
  delete pkg.devDependencies;
  pkg.scripts = Object.fromEntries(
    Object.entries(pkg.scripts).filter(([name]) => Object.hasOwn(GQ_SCRIPTS, name)),
  );
  delete pkg.scripts["ploi:log"];
  pkg.scripts = {
    dev: "pnpm --filter @acme/frontend dev",
    "ploi:legacy": "gq ploi legacy",
    ...pkg.scripts,
    "cf:old": "gq cloudflare old --mine",
    lint: "vp lint",
  };
  pkg.engines = { pnpm: ">=12", ...pkg.engines };
  // The site's own keys, formatted its own way.
  const old = `${JSON.stringify(pkg, null, 2)}\n`
    .replace('"pnpm@12.6.0"', '"pnpm@12.5.0"')
    .replace(
      '  "type": "module",\n',
      '  "type": "module",\n  "description": "Acme\\u2019s site",\n  "files": ["dist", "src"],\n',
    )
    .replace(
      /\n\}\n$/u,
      ',\n  "devDependencies": { "@getquick/site": "0.11.0", "vite-plus": "catalog:" }\n}\n',
    );
  await writeFile(join(site.root, "package.json"), old);
  const lock = await readLock(site.root);
  lock.gq = "0.11.0";
  lock.keys["package.json"].packageManager = hash('"pnpm@12.5.0"');
  delete lock.keys["package.json"]["scripts.ploi:log"];
  lock.keys["package.json"]["scripts.ploi:legacy"] = hash('"gq ploi legacy"');
  lock.keys["package.json"]["scripts.cf:old"] = hash('"gq cloudflare old"');
  await writeLock(site.root, lock);
  const before = await snapshot(site.root);

  const check = await site.run(["sync", "--check"]);
  assert.equal(check.code, 1);
  assert.equal(
    check.stdout,
    [
      "gq.ops.json: up to date (schema v1).",
      "package.json: pending, gq sync would update its managed keys scripts.ploi:log, " +
        "packageManager, scripts.ploi:legacy.",
      "gq.lock.json: pending, gq sync would update it.",
      "",
    ].join("\n"),
  );
  assert.deepEqual(await snapshot(site.root), before);

  const sync = await site.run(["sync"]);
  assert.equal(sync.code, 0, sync.stderr);
  assert.equal(
    sync.stdout,
    [
      "gq.ops.json: up to date (schema v1).",
      "package.json: updated (managed keys scripts.ploi:log, packageManager, scripts.ploi:legacy).",
      "gq.lock.json: updated.",
      "",
    ].join("\n"),
  );
  const expected = old
    .replace('"pnpm@12.5.0"', '"pnpm@12.6.0"')
    .replace('\n    "ploi:legacy": "gq ploi legacy",', "")
    .replace(
      '    "lint": "vp lint"\n',
      '    "lint": "vp lint",\n    "ploi:log": "gq sigillo run staging -- gq ploi api sites.log-site --per-page 5"\n',
    );
  assert.equal(await readSite(site.root, "package.json"), expected);
  assert.deepEqual(Object.keys((await readLock(site.root)).keys["package.json"]), MANAGED_KEYS);
  assert.equal((await site.run(["sync", "--check"])).code, 0);
  for (const { fetch, exec } of [check, sync]) {
    assert.deepEqual(fetch.requests, []);
    assert.deepEqual(exec.calls, []);
  }
});

test("gq sync adds the managed keys to a package.json without them, keeping its indentation", async () => {
  const own = { name: "acme", version: "1.2.3", dependencies: { astro: "^5.0.0" } };
  const site = await createFixtureSite({
    ops: { schemaVersion: 1, project: "acme", variant: "content" },
    files: { "package.json": `${JSON.stringify(own, null, "\t")}\n` },
  });

  const result = await site.run(["sync"]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^package\.json: updated \(managed keys scripts\.setup, /mu);
  const written = await readSite(site.root, "package.json");
  const expected = {
    ...own,
    scripts: GQ_SCRIPTS,
    engines: { node: ">=22.12.0" },
    packageManager: "pnpm@12.6.0",
  };
  assert.equal(written, `${JSON.stringify(expected, null, "\t")}\n`);
  assert.equal((await site.run(["sync", "--check"])).code, 0);
});

test("gq sync refuses a package.json that isn't a JSON object", async () => {
  const site = await newSite();
  await writeFile(join(site.root, "package.json"), '{ "name": "acme", }\n');
  const before = await snapshot(site.root);

  const result = await site.run(["sync"]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /^gq: package\.json is not a valid JSON object: /u);
  assert.deepEqual(await snapshot(site.root), before);
});

// gq new and gq sync on pnpm-workspace.yaml's managed keys: the Alchemy and
// Effect pins the managed infra needs. The rest of the file is the Site's.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { hash, newSite, readSite, snapshot } from "../support/generated-site.mjs";

const KEYS = {
  "overrides.@effect/platform-node-shared": "4.0.7",
  "catalog.@alchemy.run/cloudflare": "2.0.0-beta.84",
  "catalog.@alchemy.run/frontend-frameworks": "2.0.0-beta.84",
  "catalog.@effect/platform-node": "4.0.7",
  "catalog.alchemy": "2.0.0-beta.84",
  "catalog.effect": "4.0.7",
  "peerDependencyRules.allowedVersions.effect": "4.0.7",
};

// pnpm-workspace.yaml as an Astro content Site generated before these keys
// were managed has it (Southside's, from @getquick/site 0.40.0): Alchemy
// beta.79 from alchemy/Cloudflare, Effect 4.0.0-rc.115.
const BEFORE = `packages:
  - "apps/*"
  - "infra"
  - "infra/ci"

allowBuilds:
  esbuild: true
  msgpackr-extract: true
  workerd: true
# GETQUICK's own packages may be installed the day they are released:
# @getquick/site, and the consent Runtime it and the Frontend use
# (@getquick/content; the storefront's adapter on commerce).
minimumReleaseAgeExclude:
  - "@getquick/site"
  - "@getquick/content"
  - "@quick-release/storefront"
overrides:
  # astro2tsx uses emnapi core 1.x; wasm-runtime must use the matching ABI.
  "@napi-rs/wasm-runtime>@emnapi/runtime": 1.11.3
  "@effect/platform-node-shared": 4.0.0-rc.115
  vite: npm:@voidzero-dev/vite-plus-core@0.3.0
  vitest: 4.1.11
catalog:
  # Alchemy/Effect: shared by infra (deploy) and apps/frontend (the Astro build
  # resolves the Alchemy server entrypoint from apps/frontend).
  "@alchemy.run/frontend-frameworks": 2.0.0-beta.79
  "@effect/platform-node": 4.0.0-rc.115
  alchemy: 2.0.0-beta.79
  effect: 4.0.0-rc.115
  vite: npm:@voidzero-dev/vite-plus-core@0.3.0
  vitest: 4.1.11
  vite-plus: 0.3.0
peerDependencyRules:
  allowedVersions:
    effect: 4.0.0-rc.115
    vite: 0.3.0
`;

// The same file after gq sync: only the managed values change, and
// @alchemy.run/cloudflare joins the catalog in order.
const AFTER = BEFORE.replace(
  '"@effect/platform-node-shared": 4.0.0-rc.115',
  '"@effect/platform-node-shared": 4.0.7',
)
  .replace(
    '  "@alchemy.run/frontend-frameworks": 2.0.0-beta.79',
    '  "@alchemy.run/cloudflare": 2.0.0-beta.84\n  "@alchemy.run/frontend-frameworks": 2.0.0-beta.84',
  )
  .replace('"@effect/platform-node": 4.0.0-rc.115', '"@effect/platform-node": 4.0.7')
  .replace("alchemy: 2.0.0-beta.79", "alchemy: 2.0.0-beta.84")
  .replace("  effect: 4.0.0-rc.115\n  vite:", "  effect: 4.0.7\n  vite:")
  .replace("    effect: 4.0.0-rc.115", "    effect: 4.0.7");

async function readLock(root) {
  return JSON.parse(await readSite(root, "gq.lock.json"));
}

// A generated Site turned back into one an older gq wrote: its
// pnpm-workspace.yaml as BEFORE, and a lock that records none of its keys.
async function olderSite() {
  const site = await newSite();
  await writeFile(join(site.root, "pnpm-workspace.yaml"), BEFORE);
  const lock = await readLock(site.root);
  delete lock.keys["pnpm-workspace.yaml"];
  await writeFile(join(site.root, "gq.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  return site;
}

test("gq new writes the workspace's Alchemy and Effect pins, each hashed in the lock", async () => {
  for (const framework of ["astro", "tanstack"]) {
    const site = await newSite("acme", framework);
    const text = await readSite(site.root, "pnpm-workspace.yaml");
    assert.match(text, /^ {2}"@alchemy\.run\/cloudflare": 2\.0\.0-beta\.84$/mu);
    assert.match(text, /^ {2}alchemy: 2\.0\.0-beta\.84$/mu);
    const lock = await readLock(site.root);
    assert.deepEqual(
      lock.keys["pnpm-workspace.yaml"],
      Object.fromEntries(
        Object.entries(KEYS).map(([key, value]) => [key, hash(JSON.stringify(value))]),
      ),
    );
    const infra = JSON.parse(await readSite(site.root, "infra/package.json"));
    assert.equal(infra.dependencies["@alchemy.run/cloudflare"], "catalog:");
    for (const path of ["infra/frontend.run.ts", "infra/consent.ts"]) {
      const source = await readSite(site.root, path);
      assert.match(source, /from "@alchemy\.run\/cloudflare"/u);
      assert.doesNotMatch(source, /alchemy\/Cloudflare/u);
    }
    const check = await site.run(["sync", "--check"]);
    assert.equal(check.code, 0, check.stdout);
  }
});

test("gq sync moves an older Site's catalog with its infra, and nothing else in the file", async () => {
  const site = await olderSite();

  const pending = await site.run(["sync", "--check"]);
  assert.equal(pending.code, 1);
  assert.match(
    pending.stdout,
    /^pnpm-workspace\.yaml: pending, gq sync would update its managed keys overrides\.@effect\/platform-node-shared, catalog\.@alchemy\.run\/cloudflare, /mu,
  );

  const synced = await site.run(["sync"]);
  assert.equal(synced.code, 0, synced.stderr);
  assert.equal(await readSite(site.root, "pnpm-workspace.yaml"), AFTER);
  assert.deepEqual(
    Object.keys((await readLock(site.root)).keys["pnpm-workspace.yaml"]),
    Object.keys(KEYS),
  );

  const again = await site.run(["sync", "--check"]);
  assert.equal(again.code, 0, again.stdout);
});

test("a recorded workspace key the Site changed stops gq sync with a diff", async () => {
  const site = await newSite();
  const path = join(site.root, "pnpm-workspace.yaml");
  const text = await readFile(path, "utf8");
  await writeFile(path, text.replace("  alchemy: 2.0.0-beta.84", "  alchemy: 2.0.0-beta.86"));
  const before = await snapshot(site.root);

  const result = await site.run(["sync"]);
  assert.equal(result.code, 1);
  assert.match(
    result.stdout,
    /^pnpm-workspace\.yaml \(managed keys catalog\.alchemy\): edited since gq last wrote it/mu,
  );
  assert.match(result.stdout, /^- {2}alchemy: 2\.0\.0-beta\.86$/mu);
  assert.match(result.stdout, /^\+ {2}alchemy: 2\.0\.0-beta\.84$/mu);
  assert.deepEqual(await snapshot(site.root), before);
});

test("a workspace key gq sync can't place is refused, and nothing is written", async () => {
  const site = await newSite();
  const path = join(site.root, "pnpm-workspace.yaml");
  await writeFile(path, `packages:\n  - "apps/*"\ncatalog: { alchemy: 2.0.0-beta.79 }\n`);
  const before = await snapshot(site.root);

  const result = await site.run(["sync"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /pnpm-workspace\.yaml: catalog must be a map: gq sync manages/u);
  assert.deepEqual(await snapshot(site.root), before);
});

test("the workspace editor keeps every other byte, whatever the file's shape", async () => {
  const { editYamlKeys } = await import("../../src/sync/workspace-keys.mjs");
  const key = (path, value) => ({ key: path.join("."), segments: path, value });
  const cases = [
    // No final newline: the added key gets a line of its own.
    [
      "peerDependencyRules:\n  allowedVersions:\n    astro: 1",
      [key(["peerDependencyRules", "allowedVersions", "effect"], "4.0.7")],
      "peerDependencyRules:\n  allowedVersions:\n    astro: 1\n    effect: 4.0.7\n",
    ],
    // An empty map at the end of the file.
    [
      "packages: []\ncatalog:",
      [key(["catalog", "alchemy"], "1.0.0")],
      "packages: []\ncatalog:\n  alchemy: 1.0.0\n",
    ],
    // A map key's comment, and a null value's.
    [
      "overrides: # pins\n  x: 1\n",
      [key(["overrides", "y"], "2.0.0")],
      "overrides: # pins\n  x: 1\n  y: 2.0.0\n",
    ],
    [
      "catalog:\n  effect: # soon\n",
      [key(["catalog", "effect"], "4.0.7")],
      "catalog:\n  effect: 4.0.7 # soon\n",
    ],
    // A quoted value holding a #, and CRLF.
    [
      'catalog:\r\n  alchemy: "a #b" # c\r\n',
      [key(["catalog", "alchemy"], "2.0.0")],
      "catalog:\r\n  alchemy: 2.0.0 # c\r\n",
    ],
    // A value YAML would misread plain is quoted.
    [
      "catalog:\n  vite: x\n",
      [key(["catalog", "vite"], "catalog:")],
      'catalog:\n  vite: "catalog:"\n',
    ],
  ];
  for (const [text, managed, expected] of cases) {
    const { content } = editYamlKeys("pnpm-workspace.yaml", text, managed);
    assert.equal(content, expected, text);
    assert.deepEqual(editYamlKeys("pnpm-workspace.yaml", content, managed).changes, [], text);
  }
  for (const text of ["catalog:\n  alchemy: >-\n    1\n", "catalog:\n  alchemy: &a 1\n"]) {
    assert.throws(
      () => editYamlKeys("pnpm-workspace.yaml", text, [key(["catalog", "alchemy"], "2")]),
      /catalog\.alchemy isn't a plain or quoted value gq sync can edit/u,
    );
  }
});

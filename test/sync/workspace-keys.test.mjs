// gq new and gq sync on pnpm-workspace.yaml's managed keys: the Alchemy and
// Effect pins of the catalog, the platform-node-shared override and the
// effect peer rule. Every other key, comment and blank line is the Site's and
// keeps its bytes.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { editYamlKeys, keyPath, keySegments } from "../../src/sync/yaml-keys.mjs";
import { hash, newSite, readSite, snapshot } from "../support/generated-site.mjs";

const WORKSPACE = "pnpm-workspace.yaml";
const PINS = {
  'catalog["@alchemy.run/cloudflare"]': "2.0.0-beta.86",
  'catalog["@alchemy.run/frontend-frameworks"]': "2.0.0-beta.86",
  "catalog.@effect/platform-node": "4.1.4",
  "catalog.alchemy": "2.0.0-beta.86",
  "catalog.effect": "4.1.4",
  "overrides.@effect/platform-node-shared": "4.1.4",
  "peerDependencyRules.allowedVersions.effect": "4.1.4",
};

// The content Astro Site's pnpm-workspace.yaml as gq 0.40.0 created it
// (Alchemy beta.79, Effect 4.0.0-rc.115), the fleet's catalog before hop 1.
const RELEASED_0_40_0 = await readFile(
  new URL("../fixtures/workspace/pnpm-workspace.0.40.0.yaml", import.meta.url),
  "utf8",
);

async function readLock(root) {
  return JSON.parse(await readSite(root, "gq.lock.json"));
}

async function writeLock(root, lock) {
  await writeFile(join(root, "gq.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
}

// A gq new Site whose pnpm-workspace.yaml and lock are as an older gq left
// them: `text`, and no hash for the workspace keys gq didn't manage yet.
async function siteBefore(text, { keys } = {}) {
  const site = await newSite();
  await writeFile(join(site.root, WORKSPACE), text);
  const lock = await readLock(site.root);
  if (keys === undefined) delete lock.keys[WORKSPACE];
  else lock.keys[WORKSPACE] = keys;
  lock.gq = "0.40.0";
  await writeLock(site.root, lock);
  return site;
}

test("gq new writes pnpm-workspace.yaml with the pins, each hashed in the lock", async () => {
  for (const framework of ["astro", "tanstack"]) {
    const site = await newSite("acme", framework);
    const workspace = await readSite(site.root, WORKSPACE);
    assert.match(workspace, /^ {2}"@alchemy\.run\/cloudflare": 2\.0\.0-beta\.86$/mu);
    assert.match(workspace, /^ {2}"@alchemy\.run\/frontend-frameworks": 2\.0\.0-beta\.86$/mu);
    assert.match(workspace, /^ {2}alchemy: 2\.0\.0-beta\.86$/mu);
    const lock = await readLock(site.root);
    assert.deepEqual(
      lock.keys[WORKSPACE],
      Object.fromEntries(
        Object.entries(PINS).map(([key, value]) => [key, hash(JSON.stringify(value))]),
      ),
    );
    assert.equal((await site.run(["sync", "--check"])).code, 0, framework);
  }
});

test("gq sync moves a 0.40.0 Site's pins, keeping every other byte of the file", async () => {
  const site = await siteBefore(RELEASED_0_40_0);
  const before = await snapshot(site.root);

  const check = await site.run(["sync", "--check"]);
  assert.equal(check.code, 1);
  assert.match(
    check.stdout,
    new RegExp(
      `^pnpm-workspace\\.yaml: pending, gq sync would update its managed keys ${Object.keys(PINS)
        .map((key) => key.replaceAll(/[.[\]]/gu, "\\$&"))
        .join(", ")}\\.$`,
      "mu",
    ),
  );
  assert.deepEqual(await snapshot(site.root), before);

  const sync = await site.run(["sync"]);
  assert.equal(sync.code, 0, sync.stderr);
  assert.equal(
    await readSite(site.root, WORKSPACE),
    RELEASED_0_40_0.replace(
      '"@effect/platform-node-shared": 4.0.0-rc.115',
      '"@effect/platform-node-shared": 4.1.4',
    )
      .replace(
        '  "@alchemy.run/frontend-frameworks": 2.0.0-beta.79\n',
        '  "@alchemy.run/cloudflare": 2.0.0-beta.86\n' +
          '  "@alchemy.run/frontend-frameworks": 2.0.0-beta.86\n',
      )
      .replace('"@effect/platform-node": 4.0.0-rc.115', '"@effect/platform-node": 4.1.4')
      .replace("alchemy: 2.0.0-beta.79", "alchemy: 2.0.0-beta.86")
      .replace("  effect: 4.0.0-rc.115", "  effect: 4.1.4")
      .replace("    effect: 4.0.0-rc.115", "    effect: 4.1.4"),
  );
  // The Site's own catalog entries (vite, vitest, vite-plus) are left alone.
  assert.match(await readSite(site.root, WORKSPACE), /^ {2}vite-plus: 0\.3\.0$/mu);
  assert.deepEqual(Object.keys((await readLock(site.root)).keys[WORKSPACE]), Object.keys(PINS));
  assert.equal((await site.run(["sync", "--check"])).code, 0);
});

test("a pin the Site chose itself stops gq sync with a diff, and nothing is written", async () => {
  // Before gq managed it: a value no earlier blueprint wrote.
  const chosen = await siteBefore(
    RELEASED_0_40_0.replace("alchemy: 2.0.0-beta.79", "alchemy: 2.0.0-beta.80"),
  );
  // After gq wrote it: changed since.
  const site = await newSite();
  const edited = (await readSite(site.root, WORKSPACE)).replace(
    "  effect: 4.1.4",
    "  effect: 4.1.5",
  );
  await writeFile(join(site.root, WORKSPACE), edited);

  for (const [fixture, key, line] of [
    [chosen, "catalog.alchemy", "alchemy: 2.0.0-beta.80"],
    [site, "catalog.effect", "effect: 4.1.5"],
  ]) {
    const before = await snapshot(fixture.root);
    for (const argv of [["sync"], ["sync", "--check"]]) {
      const result = await fixture.run(argv);
      assert.equal(result.code, 1);
      assert.match(
        result.stdout,
        new RegExp(
          `^pnpm-workspace\\.yaml \\(managed keys ${key.replace(".", "\\.")}\\): edited since gq last wrote it`,
          "mu",
        ),
      );
      assert.match(result.stdout, new RegExp(`^- {2}${line}$`, "mu"));
      assert.match(result.stderr, /Local edits to managed files: pnpm-workspace\.yaml\./u);
      assert.deepEqual(await snapshot(fixture.root), before);
    }
  }
});

test("gq sync adds the mappings a workspace file lacks, and removes a key it retired", async () => {
  const own = [
    "packages:",
    '  - "apps/*"',
    "",
    "# The Site's own pins.",
    "catalog:",
    "  # Shared by the Frontend.",
    "  astro: ^7.4.11",
    "  zod: 4.6.5",
    "",
  ].join("\n");
  const site = await siteBefore(`${own.trimEnd()}\n  legacy: 1.0.0\n`, {
    keys: { "catalog.legacy": hash(JSON.stringify("1.0.0")) },
  });

  const sync = await site.run(["sync"]);

  assert.equal(sync.code, 0, sync.stderr);
  assert.equal(
    await readSite(site.root, WORKSPACE),
    [
      "packages:",
      '  - "apps/*"',
      "",
      "# The Site's own pins.",
      "catalog:",
      "  # Shared by the Frontend.",
      '  "@alchemy.run/cloudflare": 2.0.0-beta.86',
      '  "@alchemy.run/frontend-frameworks": 2.0.0-beta.86',
      '  "@effect/platform-node": 4.1.4',
      "  alchemy: 2.0.0-beta.86",
      "  astro: ^7.4.11",
      "  effect: 4.1.4",
      "  zod: 4.6.5",
      "overrides:",
      '  "@effect/platform-node-shared": 4.1.4',
      "peerDependencyRules:",
      "  allowedVersions:",
      "    effect: 4.1.4",
      "",
    ].join("\n"),
  );
  assert.equal((await site.run(["sync", "--check"])).code, 0);
});

test("gq sync refuses a workspace file it can't edit without rewriting it", async () => {
  for (const [text, message] of [
    ["packages: [\n", /^gq: pnpm-workspace\.yaml is not valid YAML: /u],
    ["- apps/*\n", /^gq: pnpm-workspace\.yaml is not a YAML mapping\.\n$/u],
    [
      'packages:\n  - "apps/*"\ncatalog: { alchemy: 2.0.0-beta.79 }\n',
      /^gq: pnpm-workspace\.yaml catalog must be a block mapping: gq sync manages catalog\["@alchemy\.run\/cloudflare"\] in it\.\n$/u,
    ],
  ]) {
    const site = await siteBefore(text);
    const before = await snapshot(site.root);
    const result = await site.run(["sync"]);
    assert.equal(result.code, 1, text);
    assert.match(result.stderr, message);
    assert.deepEqual(await snapshot(site.root), before);
  }
});

test("a key with no value yet gets its keys under it, and quoting follows YAML", () => {
  assert.equal(
    editYamlKeys(WORKSPACE, "catalog:\noverrides:\n  a: 1\n", {
      set: [
        { segments: ["catalog", "@alchemy.run/cloudflare"], value: "2.0.0-beta.84" },
        { segments: ["catalog", "effect"], value: "4.1" },
        { segments: ["overrides", "a"], value: "true" },
      ],
    }),
    'catalog:\n  "@alchemy.run/cloudflare": 2.0.0-beta.84\n  effect: "4.1"\noverrides:\n  a: "true"\n',
  );
  // A file without a final newline, and one with a four-space indent.
  assert.equal(
    editYamlKeys(WORKSPACE, "catalog:\n    zod: 4.6.5", {
      set: [{ segments: ["peerDependencyRules", "allowedVersions", "effect"], value: "4.1.4" }],
    }),
    "catalog:\n    zod: 4.6.5\npeerDependencyRules:\n    allowedVersions:\n        effect: 4.1.4\n",
  );
});

test("a key path names a segment with a dot in brackets, and reads back", () => {
  for (const [segments, path] of [
    [["catalog", "@alchemy.run/cloudflare"], 'catalog["@alchemy.run/cloudflare"]'],
    [
      ["peerDependencyRules", "allowedVersions", "effect"],
      "peerDependencyRules.allowedVersions.effect",
    ],
    [["scripts", "cf:old"], "scripts.cf:old"],
    [["a.b"], '["a.b"]'],
  ]) {
    assert.equal(keyPath(segments), path);
    assert.deepEqual(keySegments(path), segments);
  }
});

test("the earlier values name only managed keys", async () => {
  const earlier = JSON.parse(
    await readFile(
      new URL("../../blueprint/templates/fragments/pnpm-workspace.earlier.json", import.meta.url),
      "utf8",
    ),
  );
  for (const [key, values] of Object.entries(earlier)) {
    assert.ok(Object.hasOwn(PINS, key), key);
    assert.ok(Array.isArray(values) && values.length > 0, key);
  }
});

test("edge cases keep the file's meaning: an empty last key, comments, CRLF, block scalars", () => {
  const pins = [
    { segments: ["catalog", "alchemy"], value: "2.0.0-beta.84" },
    { segments: ["peerDependencyRules", "allowedVersions", "effect"], value: "4.1.4" },
  ];
  // The empty last key gets its pins before the mapping appended after it.
  assert.equal(
    editYamlKeys(WORKSPACE, "overrides:\n  x: 1\ncatalog: # pins go here\n", { set: pins }),
    "overrides:\n  x: 1\ncatalog: # pins go here\n  alchemy: 2.0.0-beta.84\n" +
      "peerDependencyRules:\n  allowedVersions:\n    effect: 4.1.4\n",
  );
  // A value filled in before a comment leaves the comment a comment.
  assert.equal(
    editYamlKeys(WORKSPACE, "catalog:\n  alchemy: # pin\n", { set: pins.slice(0, 1) }),
    "catalog:\n  alchemy: 2.0.0-beta.84 # pin\n",
  );
  // A CRLF file stays CRLF.
  assert.equal(
    editYamlKeys(WORKSPACE, "catalog:\r\n  zod: 1.0.0\r\n", { set: pins.slice(0, 1) }),
    "catalog:\r\n  alchemy: 2.0.0-beta.84\r\n  zod: 1.0.0\r\n",
  );
  // A block scalar, or a value other keys alias, is refused, not rewritten.
  assert.throws(
    () => editYamlKeys(WORKSPACE, "catalog:\n  alchemy: |\n    1.0.0\n", { set: pins.slice(0, 1) }),
    /catalog\.alchemy must be a single value/u,
  );
  assert.throws(
    () =>
      editYamlKeys(WORKSPACE, "catalog:\n  effect: &e 4.1.4\noverrides:\n  x: *e\n", {
        remove: [["catalog", "effect"]],
      }),
    /has an anchor/u,
  );
});

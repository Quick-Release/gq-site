// What a Site that adopted the blueprint over its own root files can still
// lack (src/sync/adoption.mjs): a pnpm-workspace.yaml with no packages, and
// the initial package.json keys, with gq sync --recreate package.json adding
// only the missing ones.
import assert from "node:assert/strict";
import test from "node:test";

import { adoptionGaps, listsPackages } from "../../src/sync/adoption.mjs";
import { createFixtureSite } from "../support/fixture-site.mjs";
import { newSite, readSite } from "../support/generated-site.mjs";

const OPS = { schemaVersion: 1, project: "acme", variant: "content" };

test("a pnpm-workspace.yaml lists packages only with a glob under a top-level packages", () => {
  for (const text of [
    'packages:\n  - "apps/*"\n',
    "packages:\n\n  # the apps\n  - apps/*\n  - infra\n",
    "packages:\n- apps/*\n",
    'packages: ["apps/*", infra]\n',
    'allowBuilds:\n  esbuild: true\npackages:\n  - "apps/*"\n',
  ]) {
    assert.equal(listsPackages(text), true, text);
  }
  for (const text of [
    "",
    "allowBuilds:\n  esbuild: true\n  sharp: true\n",
    "packages: []\n",
    "packages: [ ]\n",
    "packages:\nallowBuilds:\n  esbuild: true\n",
    "packages:\n",
    "catalog:\n  packages:\n    - apps/*\n",
  ]) {
    assert.equal(listsPackages(text), false, text);
  }
});

test("a Site gq new generated has no adoption gaps", async () => {
  const site = await newSite();
  assert.deepEqual(
    await adoptionGaps(site.root, JSON.parse(await readSite(site.root, "gq.ops.json"))),
    [],
  );
});

test("a missing pnpm-workspace.yaml or package.json is no gap: gq sync creates it", async () => {
  const fixture = await createFixtureSite({ ops: OPS });
  assert.deepEqual(await adoptionGaps(fixture.root, OPS), []);
});

test("a dependency in any dependency map counts as present, and keys the file has stay", async () => {
  const fixture = await createFixtureSite({
    ops: OPS,
    files: {
      "package.json": `${JSON.stringify(
        {
          name: "acme",
          version: "1.0.0",
          private: true,
          type: "module",
          scripts: {
            dev: "x",
            "frontend:dev": "x",
            build: "x",
            check: "x",
            lint: "x",
            format: "x",
            test: "x",
          },
          dependencies: { "@getquick/site": "0.29.3", sigillo: "0.13.0" },
          devDependencies: { vite: "catalog:" },
        },
        null,
        2,
      )}\n`,
    },
  });
  const [gap, ...more] = await adoptionGaps(fixture.root, OPS);
  assert.deepEqual(more, []);
  assert.deepEqual(gap.keys, ["devDependencies.vite-plus"]);

  const synced = await fixture.run(["sync", "--recreate", "package.json"]);
  assert.equal(synced.code, 0, synced.stderr);
  const merged = JSON.parse(await readSite(fixture.root, "package.json"));
  assert.deepEqual(merged.dependencies, { "@getquick/site": "0.29.3", sigillo: "0.13.0" });
  assert.deepEqual(merged.devDependencies, { vite: "catalog:", "vite-plus": "catalog:" });
  assert.equal(merged.version, "1.0.0");
  assert.deepEqual(await adoptionGaps(fixture.root, OPS), []);
});

test("gq sync --check --recreate package.json reports the initial keys it would add", async () => {
  const fixture = await createFixtureSite({
    ops: OPS,
    files: { "package.json": '{\n  "name": "acme",\n  "scripts": {}\n}\n' },
  });
  const before = await readSite(fixture.root, "package.json");
  const result = await fixture.run(["sync", "--check", "--recreate", "package.json"]);
  assert.equal(result.code, 1, result.stderr);
  assert.match(
    result.stdout,
    /^package\.json: pending, gq sync would update its managed keys .*; initial keys version, private, type, scripts\.dev, /mu,
  );
  assert.equal(await readSite(fixture.root, "package.json"), before);
});

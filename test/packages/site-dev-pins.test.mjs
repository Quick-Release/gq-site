// A Site may require a GETQUICK package from a branch rather than a release
// (`"getquick/gq-design": "dev-main as 0.5.99"`, with composer.lock pinning a
// commit). Its CMS composer.json and composer.lock are site-owned: gq sync,
// the release commands and the package discovery never rewrite either back to
// a tagged version, nor reject a dev pin.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { planPackages } from "../../src/packages/plan.mjs";
import { newSite, readSite, snapshot } from "../support/generated-site.mjs";

const DEV_CONSTRAINT = "dev-main as 0.5.99";
const DEV_COMMIT = "b18a61aa565ac77618c772f1e50f4c42155cafa7";

// The Site's composer.json requiring gq-design from main, and a lock pinning
// one of its commits under the alias, as `composer update` writes them.
async function pinDevMain(root) {
  const composerPath = join(root, "apps/cms/composer.json");
  const composer = JSON.parse(await readSite(root, "apps/cms/composer.json"));
  composer.require["getquick/gq-design"] = DEV_CONSTRAINT;
  await writeFile(composerPath, `${JSON.stringify(composer, null, 4)}\n`);
  const lock = {
    "content-hash": "0123456789abcdef0123456789abcdef",
    packages: [
      {
        name: "getquick/gq-design",
        version: "dev-main",
        source: {
          type: "git",
          url: "git@github.com:Quick-Release/gq-design.git",
          reference: DEV_COMMIT,
        },
        dist: {
          type: "zip",
          url: `https://proxy.composer.getquick.io/dist/getquick/gq-design/${DEV_COMMIT}.zip`,
          reference: DEV_COMMIT,
        },
        type: "wordpress-plugin",
      },
    ],
    "packages-dev": [],
    aliases: [
      {
        package: "getquick/gq-design",
        version: "dev-main",
        alias: "0.5.99",
        alias_normalized: "0.5.99.0",
      },
    ],
    "minimum-stability": "dev",
    "stability-flags": { "getquick/gq-design": 20 },
    "prefer-stable": true,
  };
  await writeFile(join(root, "apps/cms/composer.lock"), `${JSON.stringify(lock, null, 4)}\n`);
  return {
    composer: await readSite(root, "apps/cms/composer.json"),
    lock: await readSite(root, "apps/cms/composer.lock"),
  };
}

test("gq sync leaves a dev-main requirement and its dev composer.lock alone", async () => {
  const site = await newSite();
  const pinned = await pinDevMain(site.root);

  const check = await site.run(["sync", "--check"]);
  assert.equal(check.code, 0, check.stdout + check.stderr);
  const before = await snapshot(site.root);
  const synced = await site.run(["sync"]);

  assert.equal(synced.code, 0, synced.stderr);
  assert.deepEqual(await snapshot(site.root), before);
  assert.equal(await readSite(site.root, "apps/cms/composer.json"), pinned.composer);
  assert.equal(await readSite(site.root, "apps/cms/composer.lock"), pinned.lock);
});

test("gq release prepare and version check leave a dev pin alone", async () => {
  const site = await newSite();
  const pinned = await pinDevMain(site.root);

  const prepared = await site.run(["release", "prepare", "0.2.0"]);
  assert.equal(prepared.code, 0, prepared.stderr);
  const checked = await site.run(["version", "check"]);
  assert.equal(checked.code, 0, checked.stderr);

  assert.equal(await readSite(site.root, "apps/cms/composer.json"), pinned.composer);
  assert.equal(await readSite(site.root, "apps/cms/composer.lock"), pinned.lock);
});

test("package discovery reports a dev requirement for review and never proposes over it", () => {
  const catalogue = {
    packages: [
      {
        name: "getquick/gq-design",
        upstream: { repository: "Quick-Release/gq-design", discovery: "tags" },
        install: { registry: "getquick" },
        variants: ["content"],
        requirement: "blueprint",
        policy: "caret",
      },
    ],
  };
  const composer = { require: { php: ">=8.4.1", "getquick/gq-design": DEV_CONSTRAINT } };
  const release = { version: "0.5.0", reference: "c".repeat(40), php: ">=8.3" };
  const discoveries = [
    {
      upstream: { status: "ok", versions: ["0.5.0"], latest: null },
      registry: {
        status: "ok",
        versions: ["0.5.0"],
        releases: [release],
        latest: release,
        declaredNames: ["getquick/gq-design"],
      },
    },
  ];

  const [row] = planPackages(catalogue, composer, discoveries);

  assert.equal(row.current, DEV_CONSTRAINT);
  assert.equal(row.action, "blocked");
  assert.equal(row.proposed, null);
  assert.deepEqual(
    row.blockers.map(({ code }) => code),
    ["unsupported-constraint"],
  );
});

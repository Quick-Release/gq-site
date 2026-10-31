// gq new and gq sync on create-once files: once written, they belong
// to the site and are never restored unless --recreate asks for them.
import assert from "node:assert/strict";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createFixtureSite } from "../support/fixture-site.mjs";
import { newSite, readSite, snapshot } from "../support/generated-site.mjs";

// What a new site's lock records as created, outside its app skeletons.
const CREATED_OUTSIDE_APPS = [
  "GLOSSARY.md",
  "README.md",
  "VERSION",
  "deploy/ploi/admin.d/10-theme.sh",
  "deploy/ploi/admin.d/README.md",
  "gq.ops.json",
  "pnpm-workspace.yaml",
];

// The site's lock, parsed.
async function readLock(root) {
  return JSON.parse(await readSite(root, "gq.lock.json"));
}

async function writeLock(root, lock) {
  await writeFile(join(root, "gq.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
}

test("gq new writes the create-once glossary and README, recorded in the lock as created", async () => {
  const site = await newSite();

  const glossary = await readSite(site.root, "GLOSSARY.md");
  assert.match(glossary, /^# acme$/mu);
  assert.match(glossary, /^## Language$/mu);
  assert.doesNotMatch(glossary, /\{\{/u);
  const readme = await readSite(site.root, "README.md");
  assert.match(readme, /^# acme$/mu);
  assert.doesNotMatch(readme, /\{\{/u);
  const created = (await readLock(site.root)).created;
  assert.deepEqual(
    created.filter((path) => !path.startsWith("apps/")),
    CREATED_OUTSIDE_APPS,
  );
  for (const path of ["apps/cms/composer.json", "apps/frontend/package.json"]) {
    assert.ok(created.includes(path), path);
  }
});

test("the site glossary is GLOSSARY.md: neither the blueprint nor a new site names CONTEXT.md", async () => {
  const blueprint = fileURLToPath(new URL("../../blueprint", import.meta.url));
  const site = await newSite();

  for (const files of [await snapshot(blueprint), await snapshot(site.root)]) {
    for (const [path, file] of Object.entries(files)) {
      assert.doesNotMatch(path, /CONTEXT\.md/u);
      assert.doesNotMatch(file.content ?? "", /CONTEXT\.md/u, path);
    }
  }
});

test("a site that renames its 0.12 CONTEXT.md to GLOSSARY.md keeps it through gq sync", async () => {
  const site = await newSite();
  const lock = await readLock(site.root);
  lock.created = lock.created.map((path) => (path === "GLOSSARY.md" ? "CONTEXT.md" : path));
  await writeLock(site.root, lock);
  await writeFile(join(site.root, "GLOSSARY.md"), "# Acme\n\nOur terms.\n");

  const result = await site.run(["sync"]);

  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /GLOSSARY\.md/u);
  assert.equal(await readSite(site.root, "GLOSSARY.md"), "# Acme\n\nOur terms.\n");
  const created = (await readLock(site.root)).created;
  assert.ok(created.includes("GLOSSARY.md"));
  assert.ok(!created.includes("CONTEXT.md"));
});

test("a site that syncs its 0.12 CONTEXT.md without renaming it gets a fresh GLOSSARY.md beside it", async () => {
  const site = await newSite();
  const glossary = await readSite(site.root, "GLOSSARY.md");
  const lock = await readLock(site.root);
  lock.created = lock.created.map((path) => (path === "GLOSSARY.md" ? "CONTEXT.md" : path));
  await writeLock(site.root, lock);
  await rm(join(site.root, "GLOSSARY.md"));
  await writeFile(join(site.root, "CONTEXT.md"), "# Acme\n\nOur terms.\n");

  const result = await site.run(["sync"]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^GLOSSARY\.md: created\.$/mu);
  assert.equal(await readSite(site.root, "GLOSSARY.md"), glossary);
  assert.equal(await readSite(site.root, "CONTEXT.md"), "# Acme\n\nOur terms.\n");
  assert.ok(!(await readLock(site.root)).created.includes("CONTEXT.md"));
});

test("gq sync leaves an edited or deleted create-once file alone", async () => {
  const site = await newSite();
  await writeFile(join(site.root, "README.md"), "# Acme\n\nOur site.\n");
  await rm(join(site.root, "GLOSSARY.md"));
  const before = await snapshot(site.root);

  for (const argv of [["sync", "--check"], ["sync"]]) {
    const result = await site.run(argv);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.stdout,
      "gq.ops.json: up to date (schema v1).\nManaged files: up to date.\n",
    );
    assert.deepEqual(await snapshot(site.root), before);
  }
});

test("gq sync never overwrites a Site's custom layout", async () => {
  const site = await newSite();
  const layout = join(site.root, "apps/frontend/src/layouts/Layout.astro");
  const custom =
    "---\n// The Site's own layout, with its consent UI composed by hand.\n---\n<slot />\n";
  await writeFile(layout, custom);

  for (const argv of [["sync", "--check"], ["sync"]]) {
    const result = await site.run(argv);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Layout\.astro/u);
  }
  assert.equal(await readFile(layout, "utf8"), custom);
});

test("gq sync --recreate restores an edited or deleted create-once file", async () => {
  const site = await newSite();
  const [glossary, readme] = await Promise.all(
    ["GLOSSARY.md", "README.md"].map((path) => readSite(site.root, path)),
  );
  await writeFile(join(site.root, "README.md"), "# Acme\n\nOur site.\n");
  await rm(join(site.root, "GLOSSARY.md"));
  const lock = await readSite(site.root, "gq.lock.json");
  const before = await snapshot(site.root);
  const argv = ["sync", "--recreate", "README.md", "--recreate", "GLOSSARY.md"];

  const check = await site.run([...argv, "--check"]);
  assert.equal(check.code, 1);
  assert.equal(
    check.stdout,
    [
      "gq.ops.json: up to date (schema v1).",
      "GLOSSARY.md: pending, gq sync would create it.",
      "README.md: pending, gq sync would update it.",
      "",
    ].join("\n"),
  );
  assert.deepEqual(await snapshot(site.root), before);

  const sync = await site.run(argv);
  assert.equal(sync.code, 0, sync.stderr);
  assert.equal(
    sync.stdout,
    "gq.ops.json: up to date (schema v1).\nGLOSSARY.md: created.\nREADME.md: updated.\n",
  );
  assert.equal(await readSite(site.root, "GLOSSARY.md"), glossary);
  assert.equal(await readSite(site.root, "README.md"), readme);
  assert.equal(await readSite(site.root, "gq.lock.json"), lock);
});

test("gq sync --recreate refuses a path the blueprint doesn't create once", async () => {
  const site = await newSite();
  const before = await snapshot(site.root);

  for (const path of [".mise.toml", "gq.ops.json", "docs/adr/0001-use-astro.md"]) {
    const result = await site.run(["sync", "--recreate", path]);
    assert.equal(result.code, 1);
    assert.equal(
      result.stderr,
      `gq: gq sync can't recreate ${path}: --recreate takes a file the blueprint creates once ` +
        "(GLOSSARY.md, README.md, VERSION, deploy/ploi/admin.d/README.md, pnpm-workspace.yaml, " +
        "or a file of the apps/cms or apps/frontend skeleton), " +
        "or package.json, to add the keys a new one starts with.\n",
    );
  }
  const manifestOnly = await site.run(["sync", "--manifest", "--recreate", "README.md"]);
  assert.equal(manifestOnly.code, 1);
  assert.equal(
    manifestOnly.stderr,
    "gq: gq sync --manifest syncs only gq.ops.json; drop --recreate or --manifest.\n",
  );
  assert.deepEqual(await snapshot(site.root), before);
});

test("gq sync creates a missing create-once file the lock doesn't record", async () => {
  const site = await createFixtureSite({
    ops: { schemaVersion: 1, project: "acme", variant: "content" },
    files: { "README.md": "# Acme\n" },
  });

  const result = await site.run(["sync"]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^GLOSSARY\.md: created\.$/mu);
  assert.doesNotMatch(result.stdout, /^README\.md/mu);
  assert.equal(await readSite(site.root, "README.md"), "# Acme\n");
  // Without a CMS or Frontend, the site gets their skeletons too.
  const created = (await readLock(site.root)).created;
  assert.deepEqual(
    created.filter((path) => !path.startsWith("apps/")),
    CREATED_OUTSIDE_APPS,
  );
  assert.ok(created.includes("apps/cms/composer.json"));
  assert.ok(created.includes("apps/frontend/package.json"));
  assert.match(await readSite(site.root, "GLOSSARY.md"), /^# acme$/mu);
});

test("an app the site already has gains no skeleton files, now or on a later sync", async () => {
  const site = await createFixtureSite({
    ops: { schemaVersion: 1, project: "acme", variant: "content" },
    files: {
      "apps/cms/composer.json": '{ "name": "acme/cms" }\n',
      "apps/frontend/package.json": '{ "name": "@acme/frontend" }\n',
    },
  });

  const result = await site.run(["sync"]);

  assert.equal(result.code, 0, result.stderr);
  // Only managed files, which every Site gets: the CMS dependency patch and
  // the consent purge's entry (ADR 0019).
  assert.deepEqual(result.stdout.match(/^apps\/.*$/gmu), [
    "apps/cms/patches/wpgraphql-blocks/2.2.0-quiet-unsafe-access.patch: created.",
    "apps/cms/scripts/patch-dependencies.php: created.",
    "apps/frontend/workers/consent-purge.ts: created.",
  ]);
  assert.doesNotMatch(result.stdout, /^deploy\/ploi\/admin\.d\/10-theme\.sh/mu);
  const files = Object.keys(await snapshot(site.root));
  assert.deepEqual(
    files.filter((path) => path.startsWith("apps/")),
    [
      "apps/cms/composer.json",
      "apps/cms/patches/wpgraphql-blocks/2.2.0-quiet-unsafe-access.patch",
      "apps/cms/scripts/patch-dependencies.php",
      "apps/frontend/package.json",
      "apps/frontend/workers/consent-purge.ts",
    ],
  );
  assert.ok(!files.includes("deploy/ploi/admin.d/10-theme.sh"));
  const created = (await readLock(site.root)).created;
  assert.deepEqual(
    created.filter((path) => path.startsWith("apps/")),
    ["apps/cms/composer.json", "apps/frontend/package.json"],
  );
  assert.equal(await readSite(site.root, "apps/cms/composer.json"), '{ "name": "acme/cms" }\n');
  const check = await site.run(["sync", "--check"]);
  assert.equal(check.code, 0, check.stdout);
});

test("a deleted skeleton file stays deleted until --recreate, which restores its mode", async () => {
  const site = await newSite();
  const extension = "deploy/ploi/admin.d/10-theme.sh";
  const written = await readSite(site.root, extension);
  await rm(join(site.root, extension));
  await rm(join(site.root, "apps/frontend/src/pages/index.astro"));

  const sync = await site.run(["sync"]);
  assert.equal(sync.code, 0, sync.stderr);
  assert.equal(sync.stdout, "gq.ops.json: up to date (schema v1).\nManaged files: up to date.\n");
  const files = Object.keys(await snapshot(site.root));
  assert.ok(!files.includes(extension));
  assert.ok(!files.includes("apps/frontend/src/pages/index.astro"));

  const recreate = await site.run(["sync", "--recreate", extension]);
  assert.equal(recreate.code, 0, recreate.stderr);
  assert.match(recreate.stdout, /^deploy\/ploi\/admin\.d\/10-theme\.sh: created\.$/mu);
  assert.equal(await readSite(site.root, extension), written);
  assert.equal((await lstat(join(site.root, extension))).mode & 0o777, 0o755);
});

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { validateManifest } from "../../src/manifest/manifest.mjs";
import { frontendFramework } from "../../src/manifest/schema.mjs";
import { siteSettings } from "../../src/manifest/site-settings.mjs";
import { planManagedFiles } from "../../src/sync/managed-files.mjs";
import { runGq, temporaryDirectory } from "../support/fixture-site.mjs";
import { readSite, snapshot } from "../support/generated-site.mjs";

const legacy = { schemaVersion: 1, project: "nomia-bnq", variant: "content" };
test("framework is independent of variant and omission preserves Astro", () => {
  for (const variant of ["content", "commerce"]) {
    assert.equal(frontendFramework(validateManifest({ ...legacy, variant })), "astro");
    for (const framework of ["astro", "tanstack"]) {
      assert.equal(validateManifest({ ...legacy, variant, framework }).framework, framework);
    }
  }
  assert.throws(() => validateManifest({ ...legacy, framework: "react" }), /framework/u);
});

test("an omitted framework generates byte-identical Astro files and lock", async () => {
  const root = await temporaryDirectory();
  const before = await planManagedFiles(root, legacy);
  const explicit = await planManagedFiles(root, { ...legacy, framework: "astro" });
  assert.deepEqual(explicit, before);
  assert.match(
    before.files.find(({ path }) => path === "infra/frontend.run.ts").content.toString(),
    /Website.Astro/u,
  );
});

test("new defaults to Start with managed Runtime endpoints, no copied runtime, and stable sync", async () => {
  const root = await temporaryDirectory();
  const created = await runGq(["new", ".", "--project", "cesam-bnq", "--variant", "content"], {
    cwd: root,
  });
  assert.equal(created.code, 0, created.stderr);
  const ops = JSON.parse(await readSite(root, "gq.ops.json"));
  assert.equal(ops.framework, "tanstack");
  const files = await snapshot(root);
  assert.equal(files["apps/frontend/astro.config.mjs"], undefined);
  assert.equal(files["apps/frontend/src/lib/publications.ts"], undefined);
  assert.equal(files["apps/frontend/migrations/0001_publications.sql"], undefined);
  for (const name of ["publication-events", "settings-events", "delivery-retries"]) {
    assert.equal(files[`apps/cms/web/app/mu-plugins/${name}.php`], undefined);
  }
  const composer = JSON.parse(files["apps/cms/composer.json"].content);
  assert.equal(composer.require["getquick/gq-content"], "0.4.0");
  assert.equal(composer.require["getquick/gq-config"], "0.5.0");
  assert.match(
    files["apps/cms/config/application.php"].content,
    /Config::define\('GQ_CONTENT_SITE_ID', 'cesam-bnq'\)/u,
  );
  const pkg = JSON.parse(files["apps/frontend/package.json"].content);
  assert.equal(pkg.dependencies["@getquick/content"], "0.4.0");
  assert.equal(pkg.dependencies.astro, undefined);
  const deploy = files["infra/frontend.run.ts"].content;
  assert.match(deploy, /Website.Vite/u);
  for (const identity of [
    '"CesamBnqFrontend"',
    '"CesamBnqPublications"',
    '"cesam-bnq-fe-publications"',
  ])
    assert.ok(deploy.includes(identity));
  assert.match(deploy, /CONSENT_DB/u);
  assert.match(deploy, /RemovalPolicy.retain\(production\)/u);
  const lock = JSON.parse(files["gq.lock.json"].content);
  for (const name of ["gq.events.ts", "gq.refresh.ts", "gq.consent.ts", "gq.consent.$.ts"]) {
    assert.ok(lock.files[`apps/frontend/src/routes/${name}`]);
  }
  assert.deepEqual(siteSettings(ops).requiredFiles["apps/frontend"], [
    "package.json",
    "vite.config.ts",
    "src/router.tsx",
  ]);
  const check = await runGq(["sync", "--check"], { cwd: root });
  assert.equal(check.code, 0, check.stderr);
  assert.deepEqual(await snapshot(root), files);
  const managed = join(root, "apps/frontend/src/routes/gq.events.ts");
  await writeFile(managed, "// Site edit\n");
  const edited = await snapshot(root);
  const refused = await runGq(["sync"], { cwd: root });
  assert.equal(refused.code, 1);
  assert.deepEqual(await snapshot(root), edited);
});

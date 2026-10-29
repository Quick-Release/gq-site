// Headless forms (gq-platform ADR 0009) in a Site's managed files: gq.ops.json
// `forms` is optional and validated; while a Site declares it, gq sync writes
// and keeps the managed /gq/forms/ route adapter, binding @getquick/content's
// createFormsServer; without it, gq sync writes none, and removes one it wrote
// once the key goes. gq.ops.json's `forms` is validated in
// test/manifest/schema-and-migrations.test.mjs.
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { hash, newSite, readSite, snapshot } from "../support/generated-site.mjs";

const ROUTE = "apps/frontend/src/pages/gq/forms/[...rest].ts";
const FORMS = { provider: "gravityforms", spam: ["honeypot"] };

async function readJson(root, path) {
  return JSON.parse(await readSite(root, path));
}

// A gq new Site that then declares `forms` (and the plugin its deploy activates).
async function siteWithForms(forms = FORMS) {
  const site = await newSite();
  await declareForms(site.root, forms);
  return site;
}

async function declareForms(root, forms) {
  const ops = await readJson(root, "gq.ops.json");
  if (forms === undefined) delete ops.forms;
  else {
    ops.wordpress = { ...ops.wordpress, plugins: [...ops.wordpress.plugins, "gravityforms"] };
    ops.forms = forms;
  }
  await writeFile(join(root, "gq.ops.json"), `${JSON.stringify(ops, null, 2)}\n`);
}

test("a Site without forms gets no form route from gq new or gq sync", async () => {
  const { root, run } = await newSite();
  const sync = await run(["sync"]);
  assert.equal(sync.code, 0, sync.stderr);

  await assert.rejects(readSite(root, ROUTE), { code: "ENOENT" });
  assert.equal((await readJson(root, "gq.lock.json")).files[ROUTE], undefined);
});

test("gq sync writes the managed form route for a Site with forms, binding createFormsServer", async () => {
  const { root, run } = await siteWithForms();

  const check = await run(["sync", "--check"]);
  assert.equal(check.code, 1);
  assert.match(check.stdout, /gq\/forms\/\[\.\.\.rest\]\.ts: pending, gq sync would create it\./u);
  const sync = await run(["sync"]);
  assert.equal(sync.code, 0, sync.stderr);
  assert.match(sync.stdout, /gq\/forms\/\[\.\.\.rest\]\.ts: created\./u);

  const route = await readSite(root, ROUTE);
  assert.equal((await readJson(root, "gq.lock.json")).files[ROUTE], hash(route));
  assert.match(route, /^\/\/ Managed by gq sync while gq\.ops\.json declares `forms`/u);
  assert.match(route, /from "@getquick\/content\/forms\/server";/u);
  assert.match(route, /forms \?\?= createFormsServer\(\{/u);
  // The descriptor is the one published with the page the form was posted from.
  assert.match(
    route,
    /descriptor: \(\{ formId, source \}\) => content\(\)\.publishedForm\(source, formId, site\?\.origin\),/u,
  );
  assert.match(
    route,
    /spam: \{ turnstile: manifest\.forms\.spam\?\.includes\("turnstile"\) \?\? false \},/u,
  );
  // Behind an external proxy, posts from the public host are the Site's own,
  // and the proxy's addresses (GQ_TRUSTED_PROXIES) may forward the visitor's.
  assert.match(
    route,
    /const siteOrigins = \[manifest\.domains\?\.frontend, manifest\.domains\?\.frontendTarget\]/u,
  );
  assert.match(route, /cmsOrigin,\s*siteOrigins,/u);
  assert.match(route, /const \{ GQ_TRUSTED_PROXIES: proxies \} = await bindings\(\);/u);
  assert.match(route, /\.\.\.trustedProxies\(proxies\),\n {2}\}\);/u);
  assert.match(route, /import ops from "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/gq\.ops\.json";/u);
  assert.match(route, /const ddevProject = "acme-admin";/u);
  // No form logic: validation, spam and submission are the package's.
  assert.doesNotMatch(route, /validateSubmission|siteverify|gf\/v2|formData\(/u);
  // New Sites read the forms' descriptors with their pages.
  assert.match(
    await readSite(root, "apps/frontend/src/lib/content.ts"),
    /^ {4}forms: Boolean\(manifest\.forms\),$/mu,
  );

  const again = await run(["sync", "--check"]);
  assert.equal(again.code, 0, again.stdout);
});

test("gq sync removes the form route it wrote once the Site drops forms, but never an edited one", async () => {
  const { root, run } = await siteWithForms();
  assert.equal((await run(["sync"])).code, 0);

  await declareForms(root, undefined);
  const check = await run(["sync", "--check"]);
  assert.equal(check.code, 1);
  assert.match(check.stdout, /gq\/forms\/\[\.\.\.rest\]\.ts: pending, gq sync would remove it\./u);
  const removed = await run(["sync"]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.match(removed.stdout, /gq\/forms\/\[\.\.\.rest\]\.ts: removed\./u);
  await assert.rejects(readSite(root, ROUTE), { code: "ENOENT" });
  assert.equal((await readJson(root, "gq.lock.json")).files[ROUTE], undefined);
  assert.equal((await run(["sync", "--check"])).code, 0);

  // An edited route is the Site's once forms goes: kept, and no longer recorded.
  await declareForms(root, FORMS);
  assert.equal((await run(["sync"])).code, 0);
  await writeFile(join(root, ROUTE), `${await readSite(root, ROUTE)}// the Site's\n`);
  await declareForms(root, undefined);
  const kept = await run(["sync"]);
  assert.equal(kept.code, 0, kept.stderr);
  assert.match(await readSite(root, ROUTE), /\/\/ the Site's\n$/u);
  assert.equal((await readJson(root, "gq.lock.json")).files[ROUTE], undefined);
});

test("an edited form route stops gq sync while the Site has forms; a deleted one is written again", async () => {
  const { root, run } = await siteWithForms();
  assert.equal((await run(["sync"])).code, 0);
  await writeFile(join(root, ROUTE), "// hand-written\n");
  const before = await snapshot(root);

  const refused = await run(["sync"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Local edits to managed files: .*gq\/forms\/\[\.\.\.rest\]\.ts/u);
  assert.deepEqual(await snapshot(root), before);

  await rm(join(root, ROUTE));
  assert.equal((await run(["sync"])).code, 0);
  assert.match(await readSite(root, ROUTE), /createFormsServer/u);
});

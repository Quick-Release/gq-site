// Headless forms (gq-platform ADR 0009) in a Site's managed files: gq.ops.json
// `forms` is optional and validated; while a Site declares it, gq sync writes
// and keeps the managed /gq/forms/ route adapter, binding @getquick/content's
// createFormsServer; without it, gq sync writes none, and removes one it wrote
// once the key goes. The pair it binds is pinned at 0.4.0, the first with forms.
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { CONTENT_PAIR } from "../../src/sync/content-pair.mjs";
import { createFixtureSite } from "../support/fixture-site.mjs";
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

test("the managed pins are exactly @getquick/content and getquick/gq-content 0.4.0", async () => {
  assert.deepEqual(CONTENT_PAIR, {
    composer: "getquick/gq-content",
    npm: "@getquick/content",
    version: "0.4.0",
  });
  const { root } = await siteWithForms();
  assert.equal(
    (await readJson(root, "apps/cms/composer.json")).require["getquick/gq-content"],
    "0.4.0",
  );
  assert.equal(
    (await readJson(root, "apps/frontend/package.json")).dependencies["@getquick/content"],
    "0.4.0",
  );
  // gq-site itself resolves the forms readiness from the same release.
  const own = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(own.dependencies["@getquick/content"], "0.4.0");
});

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

// --- gq.ops.json `forms` -----------------------------------------------------------

const SITE = {
  schemaVersion: 1,
  project: "fixture",
  variant: "content",
  contentRuntime: "package",
  wordpress: { plugins: ["gravityforms"] },
};

async function validate(ops) {
  const fixture = await createFixtureSite({ ops });
  return fixture.run(["context", "show"]);
}

test("forms names its provider and the spam controls the Site relies on", async () => {
  for (const forms of [
    { provider: "gravityforms" },
    { provider: "gravityforms", spam: [] },
    { provider: "gravityforms", spam: ["honeypot"] },
    { provider: "gravityforms", spam: ["honeypot", "turnstile"] },
    { provider: "gravityforms", spam: ["turnstile"] },
  ]) {
    const result = await validate({ ...SITE, forms });
    assert.equal(result.code, 0, `${JSON.stringify(forms)}: ${result.stderr}`);
  }
  for (const [ops, problem] of [
    [{ ...SITE, forms: {} }, 'forms.provider must be "gravityforms"'],
    [{ ...SITE, forms: { provider: "wpforms" } }, 'forms.provider must be "gravityforms"'],
    [
      { ...SITE, forms: { provider: "gravityforms", spam: ["recaptcha"] } },
      'forms.spam[0] must be "honeypot" or "turnstile"',
    ],
    [
      { ...SITE, forms: { provider: "gravityforms", spam: ["honeypot", "honeypot"] } },
      "forms.spam repeats a control",
    ],
    [
      { ...SITE, forms: { provider: "gravityforms", turnstile: true } },
      "forms.turnstile is not a known key",
    ],
    [
      { ...SITE, wordpress: { plugins: [] }, forms: FORMS },
      "forms needs gravityforms in wordpress.plugins, so the CMS deploy activates it",
    ],
    [
      { ...SITE, contentRuntime: undefined, forms: FORMS },
      'forms needs a content Site on the package pair (variant "content", contentRuntime "package")',
    ],
  ]) {
    const result = await validate(ops);
    assert.equal(result.code, 1, JSON.stringify(ops));
    assert.equal(result.stderr, `gq: gq.ops.json is invalid: ${problem}.\n`);
  }
});

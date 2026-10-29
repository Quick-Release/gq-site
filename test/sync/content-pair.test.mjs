// The content runtime as a pinned package pair (ADR 0020): a Site gq new
// generates adopts getquick/gq-content and @getquick/content at one version,
// with the route adapters and both pins managed by gq sync. A Site generated
// before keeps its copied runtime: gq sync neither adds the pair to it nor
// rewrites or deletes what it copied.
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import cmsKeys from "../../blueprint/templates/fragments/cms-composer.keys.json" with { type: "json" };
import frontendKeys from "../../blueprint/templates/fragments/frontend-package.keys.json" with { type: "json" };
import cmsTemplate from "../../blueprint/templates/apps/cms/composer.json" with { type: "json" };
import frontendTemplate from "../../blueprint/templates/apps/frontend/package.json" with { type: "json" };
import ownPackage from "../../package.json" with { type: "json" };
import { CONTENT_PAIR } from "../../src/sync/content-pair.mjs";
import { hash, newSite, readSite, snapshot } from "../support/generated-site.mjs";

const ROUTES = ["apps/frontend/src/pages/gq/events.ts", "apps/frontend/src/pages/gq/refresh.ts"];
// The consent Runtime's endpoints (CONSENT-1; ADR 0019): records and their
// authenticated reads, handed to @getquick/content/consent/server.
const CONSENT_ROUTES = [
  "apps/frontend/src/pages/gq/consent.ts",
  "apps/frontend/src/pages/gq/consent/[...rest].ts",
];
const COMPOSER = "apps/cms/composer.json";
const FRONTEND_PACKAGE = "apps/frontend/package.json";

async function readJson(root, path) {
  return JSON.parse(await readSite(root, path));
}

async function writeSiteFile(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

test("both halves of the pair are pinned to the same exact version", () => {
  assert.equal(CONTENT_PAIR.version, "0.4.2");
  assert.deepEqual(cmsKeys, { require: { [CONTENT_PAIR.composer]: CONTENT_PAIR.version } });
  assert.deepEqual(frontendKeys, { dependencies: { [CONTENT_PAIR.npm]: CONTENT_PAIR.version } });
  // The skeletons start with the same pins, where their formatters keep them
  // (and gq packages reads the CMS's from its template's require).
  assert.equal(cmsTemplate.require[CONTENT_PAIR.composer], CONTENT_PAIR.version);
  assert.equal(frontendTemplate.dependencies[CONTENT_PAIR.npm], CONTENT_PAIR.version);
  // gq-site's own readiness (consent, forms) resolves the same release.
  assert.equal(ownPackage.dependencies[CONTENT_PAIR.npm], CONTENT_PAIR.version);
});

test("gq new wires a Site to the pinned pair: keys, routes, migrations and identity", async () => {
  const { root, run } = await newSite();

  const ops = await readJson(root, "gq.ops.json");
  assert.equal(ops.contentRuntime, "package");
  assert.equal((await readJson(root, COMPOSER)).require["getquick/gq-content"], "0.4.2");
  assert.equal((await readJson(root, FRONTEND_PACKAGE)).dependencies["@getquick/content"], "0.4.2");

  const lock = await readJson(root, "gq.lock.json");
  assert.deepEqual(lock.keys[COMPOSER], { "require.getquick/gq-content": hash('"0.4.2"') });
  assert.deepEqual(lock.keys[FRONTEND_PACKAGE], {
    "dependencies.@getquick/content": hash('"0.4.2"'),
  });
  // The route adapters are managed: gq sync keeps them in step.
  for (const route of ROUTES) {
    const source = await readSite(root, route);
    assert.equal(lock.files[route], hash(source), route);
    assert.match(source, /from "\.\.\/\.\.\/lib\/content"/u, route);
  }
  assert.match(await readSite(root, ROUTES[0]), /\.handleEvent\(request/u);
  assert.match(await readSite(root, ROUTES[1]), /\.handleRefresh\(request/u);
  // So are the consent routes: the package's server, with the Site's
  // manifest identity, the same one the content runtime and the purge use.
  for (const route of CONSENT_ROUTES) {
    assert.equal(lock.files[route], hash(await readSite(root, route)), route);
  }
  const consentRoute = await readSite(root, CONSENT_ROUTES[0]);
  assert.match(consentRoute, /createConsentServer\(\{\s*siteId: ops\.project,/u);
  // Its retention is the Worker's CONSENT_RETENTION_DAYS, which the purge
  // Worker deletes by too (gq.ops.json's consent.retentionDays).
  assert.match(consentRoute, /retentionDays: retention \? Number\(retention\) : undefined,/u);
  assert.match(
    consentRoute,
    /const \{ CONSENT_RETENTION_DAYS: retention, GQ_TRUSTED_PROXIES: proxies \} = await bindings\(\);/u,
  );
  // Posts from the public host count as the Site's own behind an external
  // proxy, and so does the visitor's address its trusted proxies forward.
  assert.match(
    consentRoute,
    /const siteOrigins = \[domains\?\.frontend, domains\?\.frontendTarget\]/u,
  );
  assert.match(consentRoute, /siteId: ops\.project,\s*siteOrigins,/u);
  assert.match(consentRoute, /trustedProxies: trustedProxies\(proxies\),\n {2}\}\);/u);
  assert.match(consentRoute, /from "@getquick\/content\/consent\/server"/u);
  assert.match(consentRoute, /\.handle\(request\)\) \?\? new Response\(null, \{ status: 404 \}\)/u);
  assert.match(await readSite(root, CONSENT_ROUTES[1]), /from "\.\.\/consent"/u);

  // The Site configures the package rather than copying its runtime.
  const content = await readSite(root, "apps/frontend/src/lib/content.ts");
  assert.match(content, /from "@getquick\/content\/server"/u);
  assert.match(content, /createContentRuntime\(/u);
  // With the consent Runtime: embeds rewritten at delivery, GQ Config's Legal
  // Contract and GA4 read into the chrome, and the layout composing its UI.
  assert.match(content, /consent: \{\s*services: \[\],\s*cmsSettings: true,/u);
  const layout = await readSite(root, "apps/frontend/src/layouts/Layout.astro");
  assert.match(layout, /from "@getquick\/content\/consent\/astro"/u);
  assert.match(layout, /startConsent\(\)/u);
  const files = Object.keys(await snapshot(root));
  for (const copied of [
    "apps/frontend/migrations/0001_publications.sql",
    "apps/frontend/src/lib/delivery.ts",
    "apps/frontend/src/lib/wordpress.ts",
    "apps/frontend/src/lib/site-language.ts",
    "apps/cms/web/app/mu-plugins/publication-events.php",
    "apps/cms/web/app/mu-plugins/delivery-retries.php",
    "apps/cms/web/app/mu-plugins/settings-events.php",
  ]) {
    assert.ok(!files.includes(copied), `${copied} is the package's now`);
  }
  // Durable delivery's migrations come from the installed package.
  assert.match(await readSite(root, "infra/frontend.run.ts"), /@getquick\/content\/package\.json/u);
  // The CMS plugin signs its events with the Site's manifest identity.
  assert.match(
    await readSite(root, "apps/cms/config/application.php"),
    /Config::define\('GQ_CONTENT_SITE_ID', 'acme'\);/u,
  );

  const check = await run(["sync", "--check"]);
  assert.equal(check.code, 0, check.stdout + check.stderr);
});

test("gq sync restores a half of the pair a Site dropped", async () => {
  const { root, run } = await newSite();
  const frontend = await readJson(root, FRONTEND_PACKAGE);
  delete frontend.dependencies["@getquick/content"];
  await writeFile(join(root, FRONTEND_PACKAGE), `${JSON.stringify(frontend, null, 2)}\n`);

  const check = await run(["sync", "--check"]);
  assert.equal(check.code, 1);
  assert.match(check.stdout, /apps\/frontend\/package\.json: pending/u);
  assert.match(check.stdout, /getquick\/gq-content 0\.4\.2.*@getquick\/content is missing/u);

  const sync = await run(["sync"]);
  assert.equal(sync.code, 0, sync.stderr);
  assert.equal((await readJson(root, FRONTEND_PACKAGE)).dependencies["@getquick/content"], "0.4.2");
});

test("gq sync names a pinned file a Site deleted, and how to get it back", async () => {
  const { root, run } = await newSite();
  await rm(join(root, COMPOSER));

  const sync = await run(["sync"]);
  assert.equal(sync.code, 1);
  assert.match(
    sync.stderr,
    /apps\/cms\/composer\.json is missing.*--recreate apps\/cms\/composer\.json/u,
  );
  const recreated = await run(["sync", "--recreate", COMPOSER]);
  assert.equal(recreated.code, 0, recreated.stderr);
  assert.equal((await readJson(root, COMPOSER)).require["getquick/gq-content"], "0.4.2");
});

test("gq sync --check fails, naming both, when a Site's halves disagree", async () => {
  const { root, run } = await newSite();
  const text = await readSite(root, COMPOSER);
  await writeFile(
    join(root, COMPOSER),
    text.replace('"getquick/gq-content": "0.4.2"', '"getquick/gq-content": "0.3.2"'),
  );
  const before = await snapshot(root);

  const check = await run(["sync", "--check"]);
  assert.equal(check.code, 1);
  assert.match(check.stdout, /getquick\/gq-content 0\.3\.2.*@getquick\/content 0\.4\.2.*disagree/u);
  const sync = await run(["sync"]);
  assert.equal(sync.code, 1);
  assert.deepEqual(await snapshot(root), before);
});

test("a Site generated before the pair keeps its copied runtime through gq sync", async () => {
  const { root, run } = await newSite();
  // As a Site generated by an earlier gq: no contentRuntime, its own route
  // handlers and migrations, and @getquick/content only for consent.
  const ops = await readJson(root, "gq.ops.json");
  delete ops.contentRuntime;
  await writeFile(join(root, "gq.ops.json"), `${JSON.stringify(ops, null, 2)}\n`);
  const composer = (await readSite(root, COMPOSER)).replace(
    /,\n {4}"getquick\/gq-content": "0\.4\.2"/u,
    "",
  );
  await writeFile(join(root, COMPOSER), composer);
  for (const route of ROUTES) {
    await writeSiteFile(root, route, `// ${route}: the Site's copied handler.\n`);
  }
  await writeSiteFile(root, "apps/frontend/migrations/0001_publications.sql", "-- copied\n");
  await writeSiteFile(
    root,
    "apps/cms/web/app/mu-plugins/publication-events.php",
    "<?php // copied\n",
  );
  const before = await snapshot(root);
  const sync = await run(["sync"]);
  assert.equal(sync.code, 0, sync.stdout + sync.stderr);

  const after = await snapshot(root);
  for (const [path, file] of Object.entries(before)) {
    if (path === "gq.lock.json") continue;
    assert.deepEqual(after[path], file, path);
  }
  assert.ok(!(await readFile(join(root, COMPOSER), "utf8")).includes("gq-content"));
  const lock = await readJson(root, "gq.lock.json");
  assert.equal(lock.keys[COMPOSER], undefined);
  assert.equal(lock.keys[FRONTEND_PACKAGE], undefined);
  for (const route of ROUTES) assert.equal(lock.files[route], undefined, route);
  const check = await run(["sync", "--check"]);
  assert.equal(check.code, 0, check.stdout + check.stderr);
});

test("an older Site opts in to the pair once it deletes its copied routes", async () => {
  const { root, run } = await newSite();
  // As a Site generated by an earlier gq (docs/guides/content-pair-migration.md):
  // its own route handlers and no lib/content.ts, @getquick/content 0.1.0 for
  // consent and no CMS pin; then it sets contentRuntime "package".
  const composer = (await readSite(root, COMPOSER)).replace(
    /,\n {4}"getquick\/gq-content": "0\.4\.2"/u,
    "",
  );
  await writeFile(join(root, COMPOSER), composer);
  const frontend = (await readSite(root, FRONTEND_PACKAGE)).replace(
    '"@getquick/content": "0.4.2"',
    '"@getquick/content": "0.1.0"',
  );
  await writeFile(join(root, FRONTEND_PACKAGE), frontend);
  for (const route of ROUTES) {
    await writeSiteFile(root, route, `// ${route}: the Site's copied handler.\n`);
  }
  await rm(join(root, "apps/frontend/src/lib/content.ts"));
  const lock = await readJson(root, "gq.lock.json");
  delete lock.keys[COMPOSER];
  delete lock.keys[FRONTEND_PACKAGE];
  for (const route of ROUTES) delete lock.files[route];
  lock.created = lock.created.filter((path) => path !== "apps/frontend/src/lib/content.ts");
  await writeFile(join(root, "gq.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);

  // The copies gq never wrote, and a pin the Site set itself, are the Site's:
  // gq sync names each and writes nothing.
  const before = await snapshot(root);
  const refused = await run(["sync"]);
  assert.equal(refused.code, 1);
  for (const path of [...ROUTES, FRONTEND_PACKAGE]) {
    assert.match(refused.stderr, new RegExp(path.replaceAll("/", "\\/")), path);
  }
  assert.deepEqual(await snapshot(root), before);

  // Deleted routes are regenerated, and a pin already at the blueprint's
  // version is taken over as it stands.
  for (const route of ROUTES) await rm(join(root, route));
  await writeFile(join(root, FRONTEND_PACKAGE), frontend.replace('"0.1.0"', '"0.4.2"'));
  const sync = await run(["sync", "--recreate", "apps/frontend/src/lib/content.ts"]);
  assert.equal(sync.code, 0, sync.stdout + sync.stderr);
  assert.equal((await readJson(root, COMPOSER)).require["getquick/gq-content"], "0.4.2");
  for (const route of ROUTES) {
    assert.match(await readSite(root, route), /from "\.\.\/\.\.\/lib\/content"/u, route);
  }
  // lib/content.ts is a skeleton file, so only --recreate writes it into an
  // existing Frontend.
  assert.match(await readSite(root, "apps/frontend/src/lib/content.ts"), /createContentRuntime\(/u);
  const synced = await readJson(root, "gq.lock.json");
  assert.deepEqual(synced.keys[FRONTEND_PACKAGE], {
    "dependencies.@getquick/content": hash('"0.4.2"'),
  });
  const check = await run(["sync", "--check"]);
  assert.equal(check.code, 0, check.stdout + check.stderr);
});

test("an older Site's existing Frontend gains lib/content.ts only through --recreate", async () => {
  const { root, run } = await newSite();
  await rm(join(root, "apps/frontend/src/lib/content.ts"));
  const lock = await readJson(root, "gq.lock.json");
  lock.created = lock.created.filter((path) => path !== "apps/frontend/src/lib/content.ts");
  await writeFile(join(root, "gq.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);

  const sync = await run(["sync"]);
  assert.equal(sync.code, 0, sync.stdout + sync.stderr);
  assert.ok(!Object.keys(await snapshot(root)).includes("apps/frontend/src/lib/content.ts"));
});

test("a Site from before the consent routes gains them through gq sync, its layout untouched", async () => {
  const { root, run } = await newSite();
  // As a Site gq 0.20.0 generated: no consent routes, and its own layout and
  // lib/content.ts without the consent Runtime (create-once, so the Site's).
  const lock = await readJson(root, "gq.lock.json");
  for (const route of CONSENT_ROUTES) {
    await rm(join(root, route));
    delete lock.files[route];
  }
  await writeFile(join(root, "gq.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  const own = {
    "apps/frontend/src/layouts/Layout.astro": "---\n// The Site's own layout.\n---\n<slot />\n",
    "apps/frontend/src/lib/content.ts": "// The Site's own runtime options.\n",
  };
  for (const [path, text] of Object.entries(own)) await writeFile(join(root, path), text);

  const sync = await run(["sync"]);
  assert.equal(sync.code, 0, sync.stdout + sync.stderr);
  const synced = await readJson(root, "gq.lock.json");
  for (const route of CONSENT_ROUTES) {
    assert.equal(synced.files[route], hash(await readSite(root, route)), route);
  }
  for (const [path, text] of Object.entries(own)) {
    assert.equal(await readSite(root, path), text, path);
  }
  const check = await run(["sync", "--check"]);
  assert.equal(check.code, 0, check.stdout + check.stderr);
});

test("a consent route a Site composed by hand is its own: gq sync names it and writes nothing", async () => {
  const { root, run } = await newSite();
  const lock = await readJson(root, "gq.lock.json");
  for (const route of CONSENT_ROUTES) delete lock.files[route];
  await writeFile(join(root, "gq.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  await writeFile(join(root, CONSENT_ROUTES[0]), "// The Site's hand-composed route.\n");
  const before = await snapshot(root);

  const sync = await run(["sync"]);
  assert.equal(sync.code, 1);
  assert.match(sync.stderr, /apps\/frontend\/src\/pages\/gq\/consent\.ts/u);
  assert.deepEqual(await snapshot(root), before);
});

// `gq site check` at the run() seam: whether a new content Site's resilience
// guarantee holds. One in-memory world stands in for every part behind a
// recording fetch: the CMS's GraphQL endpoint (installed or not, WPGraphQL
// active or not, its schema with or without the GETQUICK fields), the
// deployed Frontend (its signed check, refresh token, store and homepage),
// Ploi (the CMS's .env and crontabs), the media bucket, its public domain and
// the CMS's REST media endpoint. Nothing here reaches the network.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { LANGUAGES_QUERY, SCHEMA_QUERY, schemaQuery } from "../../src/site/readiness.mjs";
import { createFixtureSite, recordingExec, recordingFetch } from "../support/fixture-site.mjs";

const OPS = Object.freeze({
  schemaVersion: 1,
  project: "fixture",
  variant: "content",
  domains: { admin: "admin.example.test", frontend: "www.example.test" },
  ploi: { serverId: "12", siteId: "34", systemUser: "fixture" },
  media: { bucket: "fixture-media", domain: "media.example.test" },
  cloudflare: { accountId: "account-1" },
  wordpress: { plugins: ["gq-design", "wp-graphql", "wpgraphql-blocks", "s3-uploads"] },
});

const SECRETS = Object.freeze({
  PLOI_API_TOKEN: "ploi-secret-token",
  S3_UPLOADS_KEY: "media-key-id",
  S3_UPLOADS_SECRET: "media-secret-value",
  CMS_CHECK_USER: "media-check",
  CMS_CHECK_APP_PASSWORD: "abcd efgh ijkl mnop",
  FRONTEND_REFRESH_TOKEN: "fixture-refresh-token-0123456789abcdef0123",
  PUBLICATION_EVENT_SECRET: "fixture-event-signing-key-0123456789abcdef",
});

const CRONTAB = Object.freeze({
  user: "fixture",
  frequency: "* * * * *",
  command:
    'cd /home/fixture/admin.example.test/apps/cms && PATH="/usr/local/bin:$PATH" wp gq-events retry-due --quiet',
});

const PREPARED = Object.freeze({
  home: "published",
  chrome: "published",
  design: "published",
  entries: { published: 3, moved: 1 },
  withdrawals: 0,
  failedEvents: 0,
});

// What `gq ploi provision`, `gq ploi media` and `gq ploi events` leave in the
// Ploi site's .env.
const CMS_ENV = [
  "WP_HOME='https://admin.example.test'",
  "GETQUICK_FRONTEND_URL='https://www.example.test'",
  `PUBLICATION_EVENT_SECRET='${SECRETS.PUBLICATION_EVENT_SECRET}'`,
  "S3_UPLOADS_BUCKET='fixture-media'",
  "S3_UPLOADS_KEY='media-key-id'",
  "S3_UPLOADS_SECRET='media-secret-value'",
  "S3_UPLOADS_ENDPOINT='https://account-1.r2.cloudflarestorage.com'",
  "S3_UPLOADS_BUCKET_URL='https://media.example.test'",
];

/** A Site that is ready unless `overrides` say otherwise. */
function world(overrides = {}) {
  const state = {
    cms: "ready", // "down", "not-installed", "no-graphql", "ready"
    schemaQuery: SCHEMA_QUERY,
    schemaErrors: [],
    // A bilingual Site's: Polylang's languages, as GQ Polylang for WPGraphQL
    // lists them (null: it isn't active), and each other language's homepage.
    cmsLanguages: null,
    languageHomeStatus: {},
    eventKey: SECRETS.PUBLICATION_EVENT_SECRET, // the Worker's; null when unbound
    refreshToken: SECRETS.FRONTEND_REFRESH_TOKEN, // the Worker's; null when unbound
    frontendDown: false,
    store: PREPARED,
    reconciliation: {
      running: false,
      startedAt: Date.now() - 50_000,
      finishedAt: Date.now() - 49_000,
      reconciledAt: Date.now() - 50_000,
      outcome: "reconciled",
      checked: 4,
      changed: 0,
      pending: 0,
      failed: 0,
    },
    homeStatus: 200,
    homeHeaders: { "cache-control": "no-cache" },
    cmsEnv: `${CMS_ENV.join("\n")}\n`,
    crontabs: [{ id: 1, ...CRONTAB }],
    bucket: new Map(),
    attachments: new Map(),
    nextId: 100,
    ...overrides,
  };

  const fetch = recordingFetch(({ method, url, headers, body }) => {
    const { hostname, pathname, search } = new URL(url);
    if (hostname === "admin.example.test") {
      if (state.cms === "down") throw new TypeError("fetch failed");
      if (state.cms === "not-installed") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://admin.example.test/wp/wp-admin/install.php" },
        });
      }
      if (pathname === "/wp/graphql") {
        if (state.cms === "no-graphql") {
          return new Response("<html>Page not found</html>", { status: 404 });
        }
        const { query } = JSON.parse(body);
        if (query === "{ __typename }") return { data: { __typename: "RootQuery" } };
        if (query === LANGUAGES_QUERY) {
          return state.cmsLanguages
            ? { data: { languages: state.cmsLanguages.map((slug) => ({ slug })) } }
            : { errors: [{ message: 'Cannot query field "languages" on type "RootQuery".' }] };
        }
        assert.equal(query, state.schemaQuery);
        return state.schemaErrors.length > 0
          ? { errors: state.schemaErrors.map((message) => ({ message })) }
          : { data: {} };
      }
      const expected = `Basic ${btoa(`${SECRETS.CMS_CHECK_USER}:${SECRETS.CMS_CHECK_APP_PASSWORD}`)}`;
      if (pathname.startsWith("/wp-json/") && headers.Authorization !== expected) {
        return new Response(JSON.stringify({ code: "rest_not_logged_in" }), { status: 401 });
      }
      if (method === "POST" && pathname === "/wp-json/wp/v2/media") {
        const id = state.nextId++;
        const path = `uploads/2026/10/${/filename="([^"]+)"/u.exec(headers["Content-Disposition"])[1]}`;
        state.bucket.set(path, body);
        state.attachments.set(id, path);
        return new Response(
          JSON.stringify({ id, source_url: `https://media.example.test/${path}` }),
          { status: 201 },
        );
      }
      const deleted = /^\/wp-json\/wp\/v2\/media\/(\d+)$/u.exec(pathname);
      if (method === "DELETE" && deleted && search === "?force=true") {
        state.bucket.delete(state.attachments.get(Number(deleted[1])));
        return { deleted: true };
      }
    }
    if (hostname === "www.example.test") {
      if (state.frontendDown) throw new TypeError("fetch failed");
      if (method === "POST" && pathname === "/gq/events") {
        if (!state.eventKey) {
          return new Response(
            JSON.stringify({
              error:
                "Events are disabled: this Frontend has no event secret of 32 characters or more bound.",
            }),
            { status: 403 },
          );
        }
        const timestamp = headers["GQ-Event-Timestamp"];
        const signature = createHmac("sha256", state.eventKey)
          .update(`${timestamp}.${body}`)
          .digest("hex");
        if (headers["GQ-Event-Signature"] !== `v1=${signature}`) {
          return new Response(JSON.stringify({ error: "An event needs a current signature." }), {
            status: 401,
          });
        }
        const event = JSON.parse(body);
        assert.equal(event.action, "check");
        return {
          status: "checked",
          site: event.site,
          reconciliation: state.reconciliation,
          ...(state.store === undefined ? {} : { store: state.store }),
        };
      }
      if (method === "POST" && pathname === "/gq/refresh") {
        if (!state.refreshToken) return new Response("{}", { status: 403 });
        if (headers.Authorization !== `Bearer ${state.refreshToken}`) {
          return new Response("{}", { status: 401 });
        }
        assert.deepEqual(JSON.parse(body), { uris: [] }, "the probe refreshes nothing");
        return new Response(JSON.stringify({ error: "uris must list 1 to 100 paths." }), {
          status: 400,
        });
      }
      if (method === "GET" && pathname === "/") {
        return new Response("<main><h1>Welcome</h1></main>", {
          status: state.homeStatus,
          headers: { "content-type": "text/html", ...state.homeHeaders },
        });
      }
      const language = /^\/([a-z-]+)\/$/u.exec(pathname)?.[1];
      if (method === "GET" && language && state.cmsLanguages?.includes(language)) {
        return new Response("<main><h1>Welcome</h1></main>", {
          status: state.languageHomeStatus[language] ?? 200,
          headers: { "content-type": "text/html", ...state.homeHeaders },
        });
      }
    }
    if (hostname === "ploi.io") {
      assert.equal(headers.Authorization, `Bearer ${SECRETS.PLOI_API_TOKEN}`);
      if (method === "GET" && pathname === "/api/servers/12/sites/34/env") {
        return { data: state.cmsEnv };
      }
      if (method === "GET" && pathname === "/api/servers/12/sites/34") {
        return { data: { system_user: "fixture", domain: "admin.example.test" } };
      }
      if (method === "GET" && pathname === "/api/servers/12/crontabs") {
        return { data: state.crontabs };
      }
    }
    if (hostname === "account-1.r2.cloudflarestorage.com") {
      if (!headers.authorization?.includes(`Credential=${SECRETS.S3_UPLOADS_KEY}/`)) {
        return new Response(null, { status: 403 });
      }
      const stored = state.bucket.get(
        decodeURIComponent(pathname.replace(/^\/fixture-media\//u, "")),
      );
      if (method === "HEAD") return new Response(null, { status: stored ? 200 : 404 });
      if (method === "GET") return new Response(stored ?? null, { status: stored ? 200 : 404 });
    }
    if (hostname === "media.example.test") {
      const stored = state.bucket.get(decodeURIComponent(pathname.slice(1)));
      if (method === "HEAD" || !stored) return new Response(null, { status: 404 });
      return new Response(stored, { headers: { "content-type": "image/png" } });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  return { fetch, state };
}

async function check(overrides = {}, { env = SECRETS, argv = [], ops = OPS } = {}) {
  const fixture = await createFixtureSite({ ops });
  const { fetch, state } = world(overrides);
  const result = await fixture.run(["site", "check", "--json", ...argv], { env, fetch });
  const report = JSON.parse(result.stdout);
  const byName = Object.fromEntries(report.checks.map((entry) => [entry.name, entry]));
  return { ...result, report, byName, fetch, state };
}

const notReady = (report) =>
  report.checks.filter(({ status }) => status === "not-ready").map(({ name }) => name);

test("a provisioned, prepared and reconciled Site with independent media is ready", async () => {
  const { code, report, byName } = await check();

  assert.equal(code, 0, JSON.stringify(notReady(report)));
  assert.equal(report.status, "ready");
  assert.equal(report.scope, "production");
  for (const name of [
    "wordpress",
    "wpgraphql-schema",
    "frontend-events",
    "frontend-refresh",
    "publication-store",
    "homepage",
    "reconciliation",
    "delivery-delays",
    "cms-events",
    "upload",
  ]) {
    assert.equal(byName[name]?.status, "ok", `${name}: ${byName[name]?.detail}`);
  }
  assert.deepEqual(
    [...new Set(report.checks.map(({ area }) => area))],
    ["cms", "frontend", "delivery", "media"],
  );
});

test("the report never shows a secret, and the text report groups the checks", async () => {
  const fixture = await createFixtureSite({ ops: OPS });
  const { fetch } = world();

  const result = await fixture.run(["site", "check"], { env: SECRETS, fetch });

  assert.equal(result.code, 0, result.stdout);
  for (const heading of ["CMS:", "Frontend:", "Event delivery:", "Independent media:"]) {
    assert.ok(result.stdout.includes(`\n${heading}\n`), heading);
  }
  assert.match(result.stdout, /^Ready: published content is served from the publication store/mu);
  for (const value of Object.values(SECRETS)) {
    assert.ok(!result.stdout.includes(value), "a secret value is never printed");
  }
});

test("a CMS that is running without WordPress installed is not ready", async () => {
  const { code, byName } = await check({ cms: "not-installed" });

  assert.equal(code, 1);
  assert.equal(byName.wordpress.status, "not-ready");
  assert.match(byName.wordpress.detail, /WordPress isn't installed/u);
  assert.match(byName.wordpress.action, /wp-admin\/install\.php/u);
  assert.equal(byName["wpgraphql-schema"], undefined, "nothing else is asked of it");
});

test("WordPress without WPGraphQL active is not ready", async () => {
  const { code, byName } = await check({ cms: "no-graphql" });

  assert.equal(code, 1);
  assert.match(byName.wordpress.detail, /isn't a WPGraphQL endpoint \(HTTP 404\)/u);
  assert.match(byName.wordpress.action, /release the CMS/u);
});

test("a schema without the GETQUICK fields names what adds them", async () => {
  const { code, byName } = await check({
    schemaErrors: [
      'Cannot query field "designTokens" on type "RootQuery".',
      'Cannot query field "siteLogo" on type "GeneralSettings".',
      'Value "PRIMARY" does not exist in "MenuLocationEnum" enum.',
    ],
  });

  assert.equal(code, 1);
  const schema = byName["wpgraphql-schema"];
  assert.equal(schema.status, "not-ready");
  assert.match(schema.detail, /GETQUICK Design \(gq-design\)/u);
  assert.match(schema.detail, /getquick-theme/u);
  assert.doesNotMatch(schema.detail, /WPGraphQL Blocks/u);
  assert.match(schema.action, /10-theme\.sh activates getquick-theme/u);
});

test("an unreachable CMS is not ready, and the Frontend is still checked", async () => {
  const { code, byName } = await check({ cms: "down" });

  assert.equal(code, 1);
  assert.match(byName.wordpress.detail, /doesn't answer/u);
  assert.equal(byName["publication-store"].status, "ok");
});

test("a running Frontend whose store was never prepared is not ready", async () => {
  const { code, byName } = await check({
    store: { home: null, chrome: null, design: null, entries: {}, withdrawals: 0, failedEvents: 0 },
    reconciliation: null,
    homeStatus: 503,
  });

  assert.equal(code, 1);
  assert.equal(byName["frontend-events"].status, "ok", "the Worker answers");
  assert.match(byName["publication-store"].detail, /never prepared/u);
  assert.match(byName["publication-store"].action, /pnpm frontend:refresh/u);
  assert.match(byName.homepage.detail, /HTTP 503/u);
  assert.match(byName.reconciliation.detail, /never reconciled/u);
  assert.match(byName.reconciliation.action, /pnpm ploi:events/u);
});

test("a store this Frontend can't read, or can't serve, is not ready", async () => {
  const unreadable = await check({ store: null });
  assert.match(
    unreadable.byName["publication-store"].detail,
    /couldn't read its publication store/u,
  );

  const format = await check({ store: { ...PREPARED, design: "unusable" } });
  assert.match(format.byName["publication-store"].detail, /design presets in a format/u);

  const older = await check({ store: undefined });
  assert.match(older.byName["publication-store"].detail, /predates gq site check/u);
});

test("a Site whose scheduler stopped reconciling is not ready; a delayed delivery only warns", async () => {
  const stale = await check({
    reconciliation: {
      running: false,
      startedAt: Date.now() - 3_600_000,
      finishedAt: Date.now() - 3_599_000,
      reconciledAt: Date.now() - 3_600_000,
      outcome: "reconciled",
    },
  });
  assert.equal(stale.code, 1);
  assert.match(stale.byName.reconciliation.detail, /over 10 minutes ago/u);

  const delayed = await check({ store: { ...PREPARED, failedEvents: 2 } });
  assert.equal(delayed.code, 0);
  assert.equal(delayed.byName["delivery-delays"].status, "warn");
  assert.match(delayed.byName["delivery-delays"].action, /wp gq-events delays/u);
});

test("a Frontend with another event key, or none bound, is not ready", async () => {
  const other = await check({ eventKey: "another-sites-event-key-0123456789abcdef" });
  assert.equal(other.code, 1);
  assert.match(other.byName["frontend-events"].action, /redeploy the Frontend/u);
  assert.equal(other.byName["publication-store"].status, "skipped");

  const unbound = await check({ eventKey: null });
  assert.match(unbound.byName["frontend-events"].action, /pnpm frontend:secrets/u);
});

test("the refresh token is proven without refreshing anything", async () => {
  const ready = await check();
  const probes = ready.fetch.requests.filter(({ url }) => url.endsWith("/gq/refresh"));
  assert.equal(probes.length, 1);

  const unbound = await check({ refreshToken: null });
  assert.equal(unbound.code, 1);
  assert.match(unbound.byName["frontend-refresh"].detail, /no FRONTEND_REFRESH_TOKEN bound/u);

  const wrong = await check({ refreshToken: "another-token-0123456789abcdef0123456789" });
  assert.match(wrong.byName["frontend-refresh"].detail, /refuses Sigillo staging's/u);
});

test("a cache in front of the Frontend is not ready: it could outlive a withdrawal", async () => {
  const { code, byName } = await check({
    homeHeaders: { "cache-control": "public, max-age=3600", "cf-cache-status": "HIT" },
  });

  assert.equal(code, 1);
  assert.match(byName.homepage.detail, /from Cloudflare's cache/u);
});

test("a CMS without the event key or the retry crontab is not ready", async () => {
  const { code, byName } = await check({
    cmsEnv: `${CMS_ENV.filter((line) => !line.startsWith("PUBLICATION_EVENT_SECRET")).join("\n")}\n`,
    crontabs: [],
  });

  assert.equal(code, 1);
  assert.match(byName["cms-events"].detail, /missing or different PUBLICATION_EVENT_SECRET/u);
  assert.match(byName["cms-events"].detail, /no crontab running .*wp gq-events retry-due/u);
  assert.match(byName["cms-events"].action, /pnpm ploi:events/u);
});

test("independent media isn't taken on trust: without the upload probe the Site is not ready", async () => {
  const env = Object.fromEntries(
    Object.entries(SECRETS).filter(([name]) => !name.startsWith("CMS_CHECK_")),
  );

  const { code, byName, state } = await check({}, { env });

  assert.equal(code, 1);
  assert.equal(byName.upload.status, "not-ready");
  assert.equal(state.attachments.size, 0);
});

test("without the Sigillo secrets every credentialed check says how to run it", async () => {
  const { code, byName } = await check({}, { env: {} });

  assert.equal(code, 1);
  for (const name of ["frontend-events", "frontend-refresh", "cms-events"]) {
    assert.match(byName[name].action, /gq sigillo run staging \(pnpm site:check\)/u, name);
  }
});

// A bilingual Site: Portuguese by default, English under /en/.
const BILINGUAL = Object.freeze({
  ...OPS,
  wordpress: {
    ...OPS.wordpress,
    plugins: [...OPS.wordpress.plugins, "polylang-pro", "gq-polylang-graphql"],
    locale: "pt_PT_ao90",
    languages: [{ locale: "en_US", slug: "en" }],
  },
});

const LANGUAGES = [
  { locale: "pt_PT_ao90", slug: "pt", code: "PT", home: "/", isDefault: true },
  { locale: "en_US", slug: "en", code: "EN", home: "/en/", isDefault: false },
];

/** A bilingual Site that is ready unless `overrides` say otherwise. */
const checkBilingual = (overrides = {}) =>
  check(
    {
      cmsLanguages: ["pt", "en"],
      schemaQuery: schemaQuery(LANGUAGES),
      store: { ...PREPARED, languages: { en: { home: "published", chrome: "published" } } },
      ...overrides,
    },
    { ops: BILINGUAL },
  );

test("a bilingual Site is ready when every language's front page, chrome and homepage are served", async () => {
  const { code, report, byName, fetch } = await checkBilingual();

  assert.equal(code, 0, JSON.stringify(notReady(report)));
  for (const name of [
    "languages",
    "wpgraphql-schema",
    "publication-store",
    "homepage",
    "homepage-en",
  ]) {
    assert.equal(byName[name]?.status, "ok", `${name}: ${byName[name]?.detail}`);
  }
  assert.match(
    byName.languages.detail,
    /Polylang has every language gq\.ops\.json declares: pt, en/u,
  );
  assert.match(byName["publication-store"].detail, /en: front page \(published\), site chrome/u);
  assert.match(byName["homepage-en"].detail, /https:\/\/www\.example\.test\/en\/ serves/u);
  // The CMS probe validates each language's front page, title and menu.
  const schema = schemaQuery(LANGUAGES);
  assert.match(schema, /nodeByUri\(uri: "\/en\/"\) @skip\(if: true\)/u);
  assert.match(schema, /language\(code: EN\) @skip\(if: true\) \{\s+title\s+description/u);
  assert.match(
    schema,
    /menuItems\(where: \{ location: PRIMARY, language: EN \}, first: 100\) @skip/u,
  );
  assert.match(schema, /language: ALL/u);
  assert.ok(
    fetch.requests.some(
      ({ body }) => body?.includes("GqSiteCheck") && body.includes("language(code: EN)"),
    ),
  );
});

test("a missing English home fails readiness and names it", async () => {
  const { code, byName } = await checkBilingual({
    store: { ...PREPARED, languages: { en: { home: null, chrome: "published" } } },
    languageHomeStatus: { en: 404 },
  });

  assert.equal(code, 1);
  assert.equal(byName["publication-store"].status, "not-ready");
  assert.match(byName["publication-store"].detail, /the store holds no en front page/u);
  assert.match(byName["publication-store"].action, /pnpm frontend:refresh/u);
});

test("a bilingual Site whose CMS publishes no English front page is not ready", async () => {
  const { code, byName } = await checkBilingual({
    store: { ...PREPARED, languages: { en: { home: "missing", chrome: "published" } } },
    languageHomeStatus: { en: 404 },
  });

  assert.equal(code, 1);
  assert.equal(byName["publication-store"].status, "not-ready");
  assert.match(byName["publication-store"].detail, /WordPress has no published en front page/u);
  assert.match(byName["publication-store"].action, /translate the front page into en/u);
  assert.equal(byName["homepage-en"].status, "not-ready");
  assert.match(
    byName["homepage-en"].detail,
    /\/en\/ is a 404: WordPress confirms no en front page/u,
  );
});

test("a bilingual Site without a published default front page is not ready either", async () => {
  const { code, byName } = await checkBilingual({
    store: {
      ...PREPARED,
      home: "missing",
      languages: { en: { home: "published", chrome: "published" } },
    },
    homeStatus: 404,
  });

  assert.equal(code, 1);
  assert.equal(byName["publication-store"].status, "not-ready");
  assert.equal(byName.homepage.status, "not-ready");
});

test("an English homepage that isn't served is not ready", async () => {
  const { code, byName } = await checkBilingual({ languageHomeStatus: { en: 503 } });

  assert.equal(code, 1);
  assert.equal(byName.homepage.status, "ok");
  assert.equal(byName["homepage-en"].status, "not-ready");
  assert.match(byName["homepage-en"].detail, /\/en\/ answers HTTP 503/u);
});

test("a CMS without a declared language, or without GQ Polylang for WPGraphQL, is not ready", async () => {
  const missing = await checkBilingual({ cmsLanguages: ["pt"] });
  assert.equal(missing.code, 1);
  assert.equal(missing.byName.languages.status, "not-ready");
  assert.match(missing.byName.languages.detail, /Polylang has no en language/u);
  assert.match(missing.byName.languages.action, /release the CMS/u);

  const inactive = await checkBilingual({
    cmsLanguages: null,
    schemaErrors: ['Unknown type "LanguageCodeEnum".'],
  });
  assert.equal(inactive.code, 1);
  assert.match(inactive.byName.languages.detail, /GQ Polylang for WPGraphQL/u);
  assert.match(
    inactive.byName["wpgraphql-schema"].detail,
    /GQ Polylang for WPGraphQL \(gq-polylang-graphql\)/u,
  );
});

test("a Frontend that doesn't report each language's rows is not ready", async () => {
  const { code, byName } = await checkBilingual({ store: PREPARED });

  assert.equal(code, 1);
  assert.match(
    byName["publication-store"].detail,
    /doesn't report each language's front page and chrome/u,
  );
});

test("a monolingual Site asks the CMS for no languages and fetches only /", async () => {
  const { fetch } = await check();

  assert.ok(!fetch.requests.some(({ body }) => body?.includes("languages")));
  const pages = fetch.requests
    .filter(({ method, url }) => method === "GET" && url.startsWith("https://www.example.test"))
    .map(({ url }) => url);
  assert.deepEqual([...new Set(pages)], ["https://www.example.test/"]);
});

test("--url checks another Frontend origin", async () => {
  const { fetch } = await check({}, { argv: ["--url", "https://www.example.test"] });
  assert.ok(fetch.requests.some(({ url }) => url === "https://www.example.test/gq/events"));
});

// --- the local CMS -------------------------------------------------------------

function ddev(status) {
  return recordingExec(({ command, args }) => {
    if (command === "mkcert") return { code: 1 };
    if (command === "ddev" && args[0] === "describe") {
      return status ? { stdout: JSON.stringify({ raw: { status } }) } : { code: 1 };
    }
    return { code: 1, stderr: `unexpected ${command}` };
  });
}

async function checkLocal({ status, cmsEnv, cms = "ready", schemaErrors = [] }) {
  const fixture = await createFixtureSite({
    ops: OPS,
    files: cmsEnv === undefined ? {} : { "apps/cms/.env": cmsEnv },
  });
  const local = recordingFetch(({ url, body }) => {
    assert.equal(url, "https://fixture-admin.ddev.site/wp/graphql");
    if (cms === "not-installed") {
      return new Response(null, {
        status: 302,
        headers: { location: "https://fixture-admin.ddev.site/wp/wp-admin/install.php" },
      });
    }
    const { query } = JSON.parse(body);
    if (query === "{ __typename }") return { data: { __typename: "RootQuery" } };
    return schemaErrors.length > 0
      ? { errors: schemaErrors.map((message) => ({ message })) }
      : { data: {} };
  });
  const result = await fixture.run(["site", "check", "--local", "--json"], {
    exec: ddev(status),
    fetch: local,
  });
  const report = JSON.parse(result.stdout);
  return {
    ...result,
    report,
    byName: Object.fromEntries(report.checks.map((entry) => [entry.name, entry])),
  };
}

const LOCAL_ENV = "WP_HOME='https://fixture-admin.ddev.site'\n";

test("--local: a CMS that was never started is not ready", async () => {
  const { code, byName } = await checkLocal({ status: null });

  assert.equal(code, 1);
  assert.match(byName.ddev.detail, /never started here/u);
  assert.match(byName.ddev.action, /pnpm cms:dev/u);
});

test("--local: DDEV running isn't a ready CMS until WordPress is installed with the GETQUICK schema", async () => {
  const installer = await checkLocal({
    status: "running",
    cmsEnv: LOCAL_ENV,
    cms: "not-installed",
  });
  assert.equal(installer.code, 1);
  assert.equal(installer.byName.ddev.status, "ok");
  assert.match(installer.byName.wordpress.detail, /WordPress isn't installed/u);

  const schema = await checkLocal({
    status: "running",
    cmsEnv: LOCAL_ENV,
    schemaErrors: ['Unknown argument "attributes" on field "blocks" of type "Page".'],
  });
  assert.equal(schema.code, 1);
  assert.match(schema.byName["wpgraphql-schema"].detail, /WPGraphQL Blocks/u);

  const ready = await checkLocal({ status: "running", cmsEnv: LOCAL_ENV });
  assert.equal(ready.code, 0, JSON.stringify(ready.report));
  assert.equal(ready.report.scope, "local");
});

test("--local and --url can't be combined", async () => {
  const fixture = await createFixtureSite({ ops: OPS });
  const result = await fixture.run(["site", "check", "--local", "--url", "https://x.example"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Pick one/u);
});

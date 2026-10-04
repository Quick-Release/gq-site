// `gq frontend refresh` at the run() seam: the trusted refresh of a content
// site's durable published content. A recording fetch stands in for the deployed
// Frontend's POST /gq/refresh; nothing here reaches the network.
import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureSite, json, recordingFetch } from "../support/fixture-site.mjs";

const OPS = Object.freeze({
  schemaVersion: 1,
  project: "fixture",
  variant: "content",
  domains: { admin: "admin.example.test", frontend: "www.example.test" },
});

const TOKEN = "fixture-refresh-token-0123456789abcdef0123";

const REFRESHED = Object.freeze({
  ready: true,
  refreshed: true,
  home: { outcome: "promoted", state: "published" },
  chrome: { outcome: "promoted", state: "published" },
  design: { outcome: "promoted", state: "published" },
  routes: { outcome: "listed", count: 2 },
  entries: { "/about/": { outcome: "promoted", state: "published" } },
  moved: {},
});

async function refresh(
  argv = [],
  { env = { FRONTEND_REFRESH_TOKEN: TOKEN }, respond, ops = OPS } = {},
) {
  const fixture = await createFixtureSite({ ops });
  const fetch = recordingFetch(respond ?? (() => json(REFRESHED)));
  return fixture.run(["frontend", "refresh", ...argv], { env, fetch });
}

test("a refresh asks the Frontend, with its token, to promote the whole Site", async () => {
  const { code, stdout, fetch } = await refresh();

  assert.equal(code, 0);
  assert.equal(fetch.requests.length, 1);
  const [request] = fetch.requests;
  assert.equal(request.method, "POST");
  assert.equal(request.url, "https://www.example.test/gq/refresh");
  assert.equal(request.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(request.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(request.body), {});
  assert.match(stdout, /✓ front page: promoted \(published\)/u);
  assert.match(stdout, /✓ site chrome: promoted \(published\)/u);
  assert.match(stdout, /✓ design presets: promoted \(published\)/u);
  assert.match(stdout, /✓ published routes: 2 listed/u);
  assert.match(stdout, /✓ \/about\/: promoted \(published\)/u);
  assert.match(stdout, /^Ready: published content is served from the publication store\.$/mu);
  assert.ok(!stdout.includes(TOKEN));
});

test("a refresh that kept stored versions reports why and exits 1", async () => {
  const report = {
    ready: true,
    refreshed: false,
    home: {
      outcome: "kept",
      failure: { reason: "timeout", message: "WordPress didn't answer within 8 seconds" },
    },
    chrome: { outcome: "promoted", state: "published" },
  };
  const { code, stdout } = await refresh([], { respond: () => json(report, 503) });

  assert.equal(code, 1);
  assert.match(
    stdout,
    /✗ front page: kept the stored version \(timeout\): WordPress didn't answer within 8 seconds/u,
  );
  assert.match(stdout, /Ready, but not refreshed/u);
});

test("a record the Site adds to the refresh is reported by its name", async () => {
  const report = {
    ...REFRESHED,
    refreshed: false,
    patterns: { outcome: "promoted", state: "published" },
    forms: { outcome: "kept", failure: { reason: "http", message: "HTTP 502" } },
  };
  const { code, stdout } = await refresh([], { respond: () => json(report) });

  assert.equal(code, 1);
  assert.match(stdout, /✓ patterns: promoted \(published\)/u);
  assert.match(stdout, /✗ forms: kept the stored version \(http\): HTTP 502/u);
  assert.doesNotMatch(stdout, /\? /u);
});

test("a Frontend that isn't ready yet exits 1", async () => {
  const report = {
    ready: false,
    refreshed: false,
    home: { outcome: "promoted", state: "published" },
    chrome: { outcome: "kept", failure: { reason: "network", message: "unreachable" } },
  };
  const { code, stdout } = await refresh([], { respond: () => json(report, 503) });

  assert.equal(code, 1);
  assert.match(stdout, /^Not ready: pages are a 503/mu);
});

const BILINGUAL = Object.freeze({
  ...OPS,
  wordpress: {
    plugins: ["wp-graphql", "polylang-pro", "gq-polylang-graphql"],
    locale: "pt_PT_ao90",
    languages: [{ locale: "en_US", slug: "en" }],
  },
});

test("a bilingual Site's refresh lists each language's front page and chrome", async () => {
  const report = {
    ...REFRESHED,
    refreshed: false,
    ready: false,
    languages: {
      en: {
        home: { outcome: "promoted", state: "published" },
        chrome: { outcome: "kept", failure: { reason: "network", message: "unreachable" } },
      },
    },
  };
  const { code, stdout } = await refresh([], {
    ops: BILINGUAL,
    respond: () => json(report, 503),
  });

  assert.equal(code, 1);
  assert.match(stdout, /✓ pt front page: promoted \(published\)/u);
  assert.match(stdout, /✓ pt site chrome: promoted \(published\)/u);
  assert.match(stdout, /✓ en front page: promoted \(published\)/u);
  assert.match(stdout, /✗ en site chrome: kept the stored version \(network\): unreachable/u);
  assert.match(stdout, /✓ design presets: promoted \(published\)/u);
  assert.doesNotMatch(stdout, /\? /u);
  assert.match(
    stdout,
    /^Not ready: pages are a 503 until a refresh stores every language's front page and site chrome\.$/mu,
  );
});

test("a refused refresh is reported without the token", async () => {
  const { code, stdout } = await refresh([], {
    respond: () =>
      json({ error: "A refresh needs this Frontend's refresh token as a bearer token." }, 401),
  });

  assert.equal(code, 1);
  assert.match(stdout, /refused the refresh: A refresh needs this Frontend's refresh token/u);
  assert.ok(!stdout.includes(TOKEN));
});

test("--json prints the Frontend's report", async () => {
  const { code, stdout } = await refresh(["--json"]);

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), REFRESHED);
});

test("--url refreshes another Frontend, such as a local runtime", async () => {
  const { code, fetch } = await refresh(["--url", "http://127.0.0.1:8799"]);

  assert.equal(code, 0);
  assert.equal(fetch.requests[0].url, "http://127.0.0.1:8799/gq/refresh");
});

test("the token is never sent over plain HTTP to another host", async () => {
  const { code, stderr, fetch } = await refresh(["--url", "http://www.example.test"]);

  assert.equal(code, 1);
  assert.match(stderr, /only sent over HTTPS \(or to localhost\)/u);
  assert.equal(fetch.requests.length, 0);
});

test("without FRONTEND_REFRESH_TOKEN nothing is sent", async () => {
  const { code, stderr, fetch } = await refresh([], { env: {} });

  assert.equal(code, 1);
  assert.match(stderr, /FRONTEND_REFRESH_TOKEN is missing/u);
  assert.equal(fetch.requests.length, 0);
});

test("--uri refreshes only the entries at those paths, and reports moves", async () => {
  const report = {
    refreshed: true,
    entries: { "/about-us/": { outcome: "promoted", state: "published" } },
    moved: { "/about/": "/about-us/" },
  };
  const { code, stdout, fetch } = await refresh(["--uri", "/about-us/", "--uri", "/news/"], {
    respond: () => json(report),
  });

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(fetch.requests[0].body), { uris: ["/about-us/", "/news/"] });
  assert.match(stdout, /✓ \/about-us\/: promoted \(published\)/u);
  assert.match(stdout, /✓ \/about\/: moved to \/about-us\/, and redirects there/u);
  assert.match(stdout, /^Refreshed: these entries are served from the publication store\.$/mu);
  assert.doesNotMatch(stdout, /front page/u);
});

test("an entry refresh that kept a stored version exits 1", async () => {
  const report = {
    refreshed: false,
    entries: {
      "/about/": { outcome: "kept", failure: { reason: "http", message: "HTTP 502" } },
    },
    moved: {},
  };
  const { code, stdout } = await refresh(["--uri", "/about/"], {
    respond: () => json(report, 503),
  });

  assert.equal(code, 1);
  assert.match(stdout, /✗ \/about\/: kept the stored version \(http\): HTTP 502/u);
  assert.match(stdout, /^Not refreshed/mu);
});

test("--uri takes paths only", async () => {
  const { code, stderr, fetch } = await refresh(["--uri", "https://www.example.test/about/"]);

  assert.equal(code, 1);
  assert.match(stderr, /--uri must be a path such as \/about\//u);
  assert.equal(fetch.requests.length, 0);
});

test("a Frontend that only stores its homepage is still reported", async () => {
  const homepageOnly = {
    ready: true,
    refreshed: true,
    home: REFRESHED.home,
    chrome: REFRESHED.chrome,
  };
  const { code, stdout } = await refresh([], { respond: () => json(homepageOnly) });

  assert.equal(code, 0);
  assert.match(stdout, /✓ front page: promoted \(published\)/u);
});

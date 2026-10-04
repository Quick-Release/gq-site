/// <reference types="node" />
// The durable homepage, rendered through Astro's Container API: a trusted
// refresh reads the front page and its chrome from a stubbed WordPress into
// the publication store (the Frontend's own D1 migrations on SQLite), and
// visitors are served from it, through CMS outages, long after any cache would
// have expired, failed refreshes and Worker restarts.
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { openTestD1, type TestD1 } from "./test/sqlite-d1";
import {
  chrome,
  data,
  httpError,
  queries,
  stubWordPress,
  timeout,
  type Answer,
  type Handler,
} from "./test/wordpress-stub";

// The monolingual Site this file describes: the site's gq.ops.json without
// wordpress.languages. languages.test.ts and language-updates.test.ts cover
// the bilingual Site.
vi.mock("../../../gq.ops.json", async (importOriginal) => {
  const { default: ops } = await importOriginal<{
    default: { wordpress: { languages?: unknown } };
  }>();
  const { languages: _languages, ...wordpress } = ops.wordpress;
  return { default: { ...ops, wordpress } };
});

// The Worker's bindings (cloudflare:workers), as the deployed Worker has them.
const runtime = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock("cloudflare:workers", () => ({
  get env() {
    return runtime.env;
  },
}));

const TOKEN = "acme-refresh-token-0123456789abcdef0123456789";

const brand = { colors: [{ slug: "brand", color: "#c00" }], spacingSizes: [] };

function frontPage(content: string, title = "Home") {
  return data({
    generalSettings: { title: "Acme", description: "Things" },
    nodeByUri: { __typename: "Page", isFrontPage: true, title, content },
    designTokens: brand,
  });
}

const welcome = () => frontPage('<h1 class="has-brand-color">Welcome to Acme</h1>');

const newChrome = () =>
  data({
    ...chrome,
    menuItems: {
      nodes: [{ id: "b", parentId: null, label: "Contact", url: "/contact/", target: null }],
    },
  });

const unreachable = () => Promise.reject(new TypeError("fetch failed"));

// WordPress, with the design presets the front page is read with.
function wordpress(handlers: Parameters<typeof stubWordPress>[0]) {
  return stubWordPress({ design: () => data({ designTokens: brand }), ...handlers });
}

let directory: string;
let db: TestD1;
let consoleError: ReturnType<typeof vi.spyOn>;

function bind(database: TestD1, token: string | undefined = TOKEN) {
  db = database;
  runtime.env = { PUBLICATION_DB: database, FRONTEND_REFRESH_TOKEN: token };
}

beforeEach(() => {
  vi.stubEnv("DEV", false);
  directory = mkdtempSync(join(tmpdir(), "acme-publications-"));
  bind(openTestD1(join(directory, "publications.sqlite")));
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function visit() {
  const { default: Home } = await import("./pages/index.astro");
  const container = await AstroContainer.create();
  const response = await container.renderToResponse(Home, {
    request: new Request("https://acme.example/"),
    partial: false,
  });
  return { status: response.status, html: await response.text() };
}

async function refresh({
  authorization = `Bearer ${TOKEN}`,
  method = "POST",
}: { authorization?: string | null; method?: string } = {}) {
  const endpoint = await import("./pages/gq/refresh");
  const container = await AstroContainer.create();
  const headers: Record<string, string> = authorization ? { Authorization: authorization } : {};
  const response = await container.renderToResponse(endpoint as never, {
    routeType: "endpoint",
    request: new Request("https://acme.example/gq/refresh", { method, headers }),
  });
  return { status: response.status, report: await response.json() };
}

// The Worker restarts (or is redeployed): its memory and modules are gone,
// the publication store isn't.
function restartWorker() {
  db.close();
  vi.resetModules();
  bind(openTestD1(join(directory, "publications.sqlite")));
}

async function prepare(home: Handler = welcome) {
  wordpress({ home });
  const { status, report } = await refresh();
  expect(status).toBe(200);
  expect(report.ready).toBe(true);
}

function expectPublishedHome(html: string, heading = "Welcome to Acme") {
  expect(html).toContain(heading);
  expect(html).toMatch(/<a href="\/about\/"[^>]*>About us<\/a>/);
  expect(html).toContain('src="https://media.example/logo.svg"');
  expect(html).toContain(".prose-wp .has-brand-color{color:var(--wp--preset--color--brand)}");
  expect(html).toContain("--wp--preset--color--brand:#c00");
}

test("a Site that was never refreshed is a 503, and a visit doesn't read the CMS", async () => {
  const fetchMock = wordpress({ home: welcome });

  const { status, html } = await visit();

  expect(status).toBe(503);
  expect(html).toContain("Temporarily unavailable.");
  expect(html).not.toContain("Welcome to Acme");
  expect(html).not.toContain("almost ready");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining("front page can't be served (not-ready)"),
  );
});

test("after a refresh the front page, menu, logo and design presets are served from the store", async () => {
  await prepare();
  const fetchMock = wordpress({ home: unreachable, chrome: unreachable });

  const first = await visit();
  const second = await visit();

  expect(first.status).toBe(200);
  expectPublishedHome(first.html);
  expect(second.html).toBe(first.html);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("the front page outlives a CMS outage of any length", async () => {
  await prepare();
  wordpress({ home: unreachable, chrome: unreachable });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 400 * 24 * 60 * 60 * 1000);

  const { status, html } = await visit();

  expect(status).toBe(200);
  expectPublishedHome(html);
});

test("the front page survives a Worker restart or redeploy while the CMS is down", async () => {
  await prepare();
  wordpress({ home: unreachable, chrome: unreachable });

  restartWorker();
  const { status, html } = await visit();

  expect(status).toBe(200);
  expectPublishedHome(html);
});

test("a refresh replaces the front page and the chrome with WordPress's newer versions", async () => {
  await prepare();
  wordpress({ home: () => frontPage("<h1>Spring at Acme</h1>"), chrome: newChrome });

  const { status, report } = await refresh();
  const { html } = await visit();

  expect(status).toBe(200);
  expect(report).toMatchObject({
    ready: true,
    refreshed: true,
    home: { outcome: "promoted", state: "published" },
    chrome: { outcome: "promoted", state: "published" },
  });
  expect(html).toContain("Spring at Acme");
  expect(html).not.toContain("Welcome to Acme");
  expect(html).toMatch(/<a href="\/contact\/"[^>]*>Contact<\/a>/);
});

test.each<[string, Handler, string]>([
  ["a timeout", timeout, "timeout"],
  ["an unreachable CMS", unreachable, "network"],
  ["an HTTP error", () => httpError(500), "http"],
  [
    "a GraphQL error next to partial data",
    () =>
      ({
        ok: true,
        json: async () => ({
          data: { generalSettings: null, nodeByUri: null, designTokens: null },
          errors: [{ message: "Internal server error" }],
        }),
      }) as Answer,
    "graphql",
  ],
  [
    "missing design data",
    () =>
      data({
        generalSettings: { title: "Acme", description: "" },
        nodeByUri: { __typename: "Page", isFrontPage: true, title: "Home", content: "<p>New</p>" },
        designTokens: null,
      }),
    "schema",
  ],
  [
    "a front page WordPress returns only without its blocks",
    ({ withBlocks }) => (withBlocks === false ? frontPage("<p>No blocks</p>") : httpError(502)),
    "partial",
  ],
])("a refresh failing on %s keeps the last good front page", async (_case, home, reason) => {
  await prepare();
  wordpress({ home, chrome: unreachable });

  const { status, report } = await refresh();
  const { status: visitStatus, html } = await visit();

  expect(status).toBe(503);
  expect(report).toMatchObject({
    ready: true,
    refreshed: false,
    home: { outcome: "kept", failure: { reason } },
    chrome: { outcome: "kept", failure: { reason: "network" } },
  });
  expect(visitStatus).toBe(200);
  expectPublishedHome(html);
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining(`front page kept its last stored version (${reason})`),
  );
});

test("a failed chrome read keeps the stored menu and logo and still promotes the front page", async () => {
  await prepare();
  wordpress({ home: () => frontPage("<h1>Spring at Acme</h1>"), chrome: () => httpError(503) });

  const { report } = await refresh();
  const { status, html } = await visit();

  expect(report).toMatchObject({
    home: { outcome: "promoted" },
    chrome: { outcome: "kept", failure: { reason: "http" } },
  });
  expect(status).toBe(200);
  expect(html).toContain("Spring at Acme");
  expect(html).toMatch(/<a href="\/about\/"[^>]*>About us<\/a>/);
  expect(html).toContain('src="https://media.example/logo.svg"');
});

test("a first refresh whose chrome read fails doesn't make the Site ready", async () => {
  wordpress({ home: welcome, chrome: timeout });

  const { status, report } = await refresh();
  const visited = await visit();

  expect(status).toBe(503);
  expect(report).toMatchObject({ ready: false, home: { outcome: "promoted" } });
  expect(visited.status).toBe(503);
  expect(visited.html).not.toContain("Welcome to Acme");
});

test("a refresh whose read started earlier doesn't overwrite a newer one", async () => {
  let releaseSlowRead!: () => void;
  const slowRead = new Promise<void>((resolve) => (releaseSlowRead = resolve));
  let reads = 0;
  wordpress({
    home: async () => {
      reads += 1;
      if (reads === 1) {
        await slowRead;
        return frontPage("<h1>Old news</h1>");
      }
      return frontPage("<h1>Latest news</h1>");
    },
  });

  vi.useFakeTimers({ toFake: ["Date"] });
  const slow = refresh();
  await vi.waitFor(() => expect(reads).toBe(1));
  vi.setSystemTime(Date.now() + 1000);
  const fast = await refresh();
  releaseSlowRead();
  const late = await slow;
  const { html } = await visit();

  expect(fast.report.home).toEqual({ outcome: "promoted", state: "published" });
  expect(late.report.home).toEqual({ outcome: "superseded", state: "published" });
  expect(html).toContain("Latest news");
  expect(html).not.toContain("Old news");
});

test("a refresh confirming no front page is set makes the front page a 404 with the hint", async () => {
  await prepare();
  wordpress({
    home: () =>
      data({
        generalSettings: { title: "Acme", description: "" },
        nodeByUri: { __typename: "Page", isFrontPage: false, title: "Blog", content: "" },
        designTokens: brand,
      }),
  });

  const { report } = await refresh();
  const { status, html } = await visit();

  expect(report.home).toEqual({ outcome: "promoted", state: "missing" });
  expect(status).toBe(404);
  expect(html).toContain("The front page is almost ready.");
  expect(html).not.toContain("Welcome to Acme");
});

test.each([
  ["no credentials", null],
  ["another token", "Bearer someone-else-0123456789abcdef0123456789"],
  ["the token without the Bearer scheme", TOKEN],
])("a refresh with %s is refused and changes nothing", async (_case, authorization) => {
  await prepare();
  const fetchMock = wordpress({ home: () => frontPage("<h1>Injected</h1>") });

  const { status, report } = await refresh({ authorization });
  const { html } = await visit();

  expect(status).toBe(401);
  expect(JSON.stringify(report)).not.toContain(TOKEN);
  expect(fetchMock).not.toHaveBeenCalled();
  expectPublishedHome(html);
});

test("a Site's refresh token doesn't refresh another Site", async () => {
  await prepare();
  const otherSite = openTestD1(join(directory, "other-site.sqlite"));
  db.close();
  bind(otherSite, "other-site-refresh-token-0123456789abcdef0123");
  const fetchMock = wordpress({ home: welcome });

  const { status } = await refresh();
  const { status: visitStatus } = await visit();

  expect(status).toBe(401);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(visitStatus).toBe(503);
});

test.each([
  ["no refresh token bound", undefined],
  ["a refresh token too short to trust", "short"],
])("with %s, refresh is disabled", async (_case, token) => {
  runtime.env = { PUBLICATION_DB: db, FRONTEND_REFRESH_TOKEN: token };
  const fetchMock = wordpress({ home: welcome });

  const { status, report } = await refresh({ authorization: `Bearer ${token}` });

  expect(status).toBe(403);
  expect(report.error).toContain("Refresh is disabled");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a refresh is a POST", async () => {
  const fetchMock = wordpress({ home: welcome });

  const { status } = await refresh({ method: "GET" });

  expect(status).toBe(405);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a refresh reads WordPress anonymously, so only published content is stored", async () => {
  const fetchMock = wordpress({ home: welcome });

  await refresh();

  for (const [, init] of fetchMock.mock.calls) {
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("Cookie")).toBeNull();
  }
  expect(queries(fetchMock, "HomePage")).toHaveLength(1);
  expect(queries(fetchMock, "SiteChrome")).toHaveLength(1);
});

test("an unreadable store is a 503, not the CMS", async () => {
  await prepare();
  const fetchMock = wordpress({ home: welcome });
  db.unavailable = true;

  const { status, html } = await visit();

  expect(status).toBe(503);
  expect(html).toContain("Temporarily unavailable.");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining("front page can't be served (store)"),
  );
});

test("a refresh that can't write the store keeps what it holds and says so", async () => {
  await prepare();
  wordpress({ home: () => frontPage("<h1>Spring at Acme</h1>") });
  db.unavailable = true;

  const { status, report } = await refresh();
  db.unavailable = false;
  const { html } = await visit();

  expect(status).toBe(503);
  expect(report).toMatchObject({
    ready: false,
    home: { outcome: "kept", failure: { reason: "store" } },
  });
  expectPublishedHome(html);
});

test("content stored in a format this Frontend doesn't know is not ready, never misread", async () => {
  await prepare();
  db.exec("UPDATE publications SET format = 2, body = '{\"blocks\":[]}' WHERE key = 'home'");

  const { status, html } = await visit();

  expect(status).toBe(503);
  expect(html).not.toContain("Welcome to Acme");
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining("home is stored in format 2; this Frontend serves format 1"),
  );
});

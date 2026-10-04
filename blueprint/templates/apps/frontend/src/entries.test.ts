/// <reference types="node" />
// Durable entries (published pages and posts), rendered through Astro's
// Container API: a trusted refresh reads them, with the site chrome, from a
// stubbed WordPress into the publication store (the Frontend's own D1
// migrations on SQLite), and visitors are served from it through CMS outages,
// restarts, failed refreshes, new and moved publications and removals.
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
  routes,
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

interface Entry {
  id: string;
  title: string;
  content: string;
  /** Posts have a date; pages don't. */
  date?: string;
  status?: string;
  isRestricted?: boolean;
}

// What WordPress publishes, by URI. Anonymous readers never see drafts or
// private entries, so they aren't here; a password-protected one is, as
// restricted.
let published: Map<string, Entry>;
let presets: { colors: Array<{ slug: string; color: string }>; spacingSizes: [] };
// Where WordPress's permalinks point. A GETQUICK CMS points them at the
// Frontend, and WPGraphQL then gives every entry's uri as an absolute URL.
let permalinkOrigin: string | null;

/** An entry's uri as WordPress gives it. */
const cmsUri = (path: string) => (permalinkOrigin ? new URL(path, permalinkOrigin).href : path);

const unreachable = () => Promise.reject(new TypeError("fetch failed"));

function entryAnswer({ uri }: Record<string, unknown>): Answer {
  const path = decodeURI(String(uri));
  const entry = published.get(path);
  const node = entry && {
    id: entry.id,
    title: entry.title,
    content: entry.content,
    uri: cmsUri([...published].find(([, other]) => other === entry)![0]),
    status: entry.status ?? "publish",
    isRestricted: entry.isRestricted ?? false,
    featuredImage: null,
    ...(entry.date ? { excerpt: null, date: entry.date } : {}),
  };
  return data({
    postBy: entry?.date ? node : null,
    pageBy: entry && !entry.date ? node : null,
    designTokens: presets,
  });
}

const frontPage = () =>
  data({
    generalSettings: { title: "Acme", description: "Things" },
    nodeByUri: { __typename: "Page", isFrontPage: true, title: "Home", content: "<h1>Hi</h1>" },
    designTokens: presets,
  });

// WordPress, up and answering from `published`, unless a handler says otherwise.
function wordpress(
  handlers: { entry?: Handler; chrome?: Handler; design?: Handler; routes?: Handler } = {},
) {
  return stubWordPress({
    home: frontPage,
    entry: entryAnswer,
    design: () => data({ designTokens: presets }),
    routes: () => routes("/", ...[...published.keys()].map(cmsUri)),
    ...handlers,
  });
}

function cmsDown() {
  return stubWordPress({
    home: unreachable,
    entry: unreachable,
    chrome: unreachable,
    design: unreachable,
    routes: unreachable,
  });
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
  published = new Map([
    [
      "/about/",
      { id: "page-64", title: "About", content: '<p class="has-brand-color">We make things.</p>' },
    ],
    [
      "/2026/09/hello/",
      { id: "post-7", title: "Hello", content: "<p>First post.</p>", date: "2026-09-30T10:00:00" },
    ],
  ]);
  presets = { colors: [{ slug: "brand", color: "#c00" }], spacingSizes: [] };
  permalinkOrigin = null;
  directory = mkdtempSync(join(tmpdir(), "acme-entries-"));
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

async function visit(path: string, headers: Record<string, string> = {}) {
  const { default: Entry } = await import("./pages/[...slug].astro");
  const container = await AstroContainer.create();
  const response = await container.renderToResponse(Entry, {
    request: new Request(new URL(path, "https://acme.example"), { headers }),
    params: { slug: path.replace(/^\/|\/$/g, "") },
    partial: false,
  });
  return {
    status: response.status,
    location: response.headers.get("Location"),
    html: await response.text(),
  };
}

async function refresh(
  body?: unknown,
  { authorization = `Bearer ${TOKEN}` }: { authorization?: string | null } = {},
) {
  const endpoint = await import("./pages/gq/refresh");
  const container = await AstroContainer.create();
  const headers: Record<string, string> = authorization ? { Authorization: authorization } : {};
  const response = await container.renderToResponse(endpoint as never, {
    routeType: "endpoint",
    request: new Request("https://acme.example/gq/refresh", {
      method: "POST",
      headers,
      body: body === undefined ? "{}" : JSON.stringify(body),
    }),
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

async function prepare() {
  wordpress();
  const { status, report } = await refresh();
  expect(status).toBe(200);
  expect(report.ready).toBe(true);
}

async function storedEntries() {
  const { results } = await db
    .prepare(
      "SELECT key, state, node_id AS nodeId FROM publications WHERE key LIKE 'entry:%' ORDER BY key",
    )
    .all<{ key: string; state: string; nodeId: string | null }>();
  return results;
}

function expectServedAbout(html: string, menuLabel = "About us") {
  expect(html).toContain("<title>About — {{Project}}</title>");
  expect(html).toContain("We make things.");
  expect(html).toMatch(new RegExp(`<a href="/about/"[^>]*>${menuLabel}</a>`));
  expect(html).toContain('src="https://media.example/logo.svg"');
  expect(html).toContain(".prose-wp .has-brand-color{color:var(--wp--preset--color--brand)}");
  expect(html).toContain("--wp--preset--color--brand:#c00");
}

test("preparing a Site stores every published page and post, served with the chrome without reading the CMS", async () => {
  await prepare();
  const fetchMock = cmsDown();

  const about = await visit("/about/");
  const hello = await visit("/2026/09/hello/");

  expect(about.status).toBe(200);
  expectServedAbout(about.html);
  expect(hello.status).toBe(200);
  expect(hello.html).toContain("First post.");
  expect(hello.html).toContain("September 30, 2026");
  expect(hello.html).toMatch(/<a href="\/about\/"[^>]*>About us<\/a>/);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("the preparation's report lists every entry it stored", async () => {
  wordpress();

  const { status, report } = await refresh();

  expect(status).toBe(200);
  expect(report).toMatchObject({
    ready: true,
    refreshed: true,
    routes: { outcome: "listed", count: 3 },
    entries: {
      "/about/": { outcome: "promoted", state: "published" },
      "/2026/09/hello/": { outcome: "promoted", state: "published" },
    },
    moved: {},
  });
  expect(report.entries["/"]).toBeUndefined();
});

test("entries outlive a CMS outage of any length and a Worker restart", async () => {
  await prepare();
  cmsDown();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 400 * 24 * 60 * 60 * 1000);

  restartWorker();
  const { status, html } = await visit("/about/");

  expect(status).toBe(200);
  expectServedAbout(html);
});

test("a Site that was never refreshed is a 503 for an entry, and a visit doesn't read the CMS", async () => {
  const fetchMock = wordpress();

  const { status, html } = await visit("/about/");

  expect(status).toBe(503);
  expect(html).toContain("Temporarily unavailable.");
  expect(html).not.toContain("We make things.");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining("entry /about/ can't be served (not-ready)"),
  );
});

test("the healthy cold path: an entry the store never held is looked up once, stored and served", async () => {
  await prepare();
  published.set("/new/", { id: "page-90", title: "New", content: "<p>Just published.</p>" });
  const fetchMock = wordpress();

  const first = await visit("/new/");
  const lookups = queries(fetchMock, "EntryByUri").length;
  cmsDown();
  const duringOutage = await visit("/new/");

  expect(first.status).toBe(200);
  expect(first.html).toContain("Just published.");
  expect(first.html).toMatch(/<a href="\/about\/"[^>]*>About us<\/a>/);
  expect(lookups).toBe(1);
  expect(duringOutage.status).toBe(200);
  expect(duringOutage.html).toContain("Just published.");
});

test("an uncached entry while the CMS is down is a 503, never a 404", async () => {
  await prepare();
  cmsDown();

  const { status, html } = await visit("/not-stored-yet/");

  expect(status).toBe(503);
  expect(html).toContain("Temporarily unavailable.");
  expect(html).not.toContain("Nothing here.");
});

test("a URL WordPress confirms isn't published is a 404, and nothing is stored for it", async () => {
  await prepare();
  const before = await storedEntries();
  wordpress();

  const { status, html } = await visit("/made-up/");

  expect(status).toBe(404);
  expect(html).toContain("Nothing here.");
  expect(html).toMatch(/<a href="\/about\/"[^>]*>About us<\/a>/);
  expect(await storedEntries()).toEqual(before);
});

test("an unreadable store is a 503 for an entry, not a CMS read", async () => {
  await prepare();
  const fetchMock = wordpress();
  db.unavailable = true;

  const stored = await visit("/about/");
  const uncached = await visit("/new/");

  expect(stored.status).toBe(503);
  expect(uncached.status).toBe(503);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining("entry /about/ can't be served (store)"),
  );
});

test("refreshing a new publication makes its route available, through a later outage", async () => {
  await prepare();
  published.set("/news/launch/", {
    id: "post-91",
    title: "Launch",
    content: "<p>We launched.</p>",
    date: "2026-10-01T09:00:00",
  });
  wordpress();

  const { status, report } = await refresh({ uris: ["/news/launch/"] });
  cmsDown();
  const visited = await visit("/news/launch/");

  expect(status).toBe(200);
  expect(report).toEqual({
    refreshed: true,
    entries: { "/news/launch/": { outcome: "promoted", state: "published" } },
    moved: {},
  });
  expect(visited.status).toBe(200);
  expect(visited.html).toContain("We launched.");
});

test("refreshing a moved entry redirects its old route instead of presenting the old copy", async () => {
  await prepare();
  const about = published.get("/about/")!;
  published.delete("/about/");
  published.set("/about-us/", { ...about, content: "<p>We make better things.</p>" });
  wordpress();

  const { report } = await refresh({ uris: ["/about-us/"] });
  cmsDown();
  const oldRoute = await visit("/about/");
  const newRoute = await visit("/about-us/");

  expect(report).toMatchObject({
    refreshed: true,
    entries: { "/about-us/": { outcome: "promoted", state: "published" } },
    moved: { "/about/": "/about-us/" },
  });
  expect(oldRoute.status).toBe(301);
  expect(oldRoute.location).toBe("/about-us/");
  expect(oldRoute.html).not.toContain("We make things.");
  expect(newRoute.status).toBe(200);
  expect(newRoute.html).toContain("We make better things.");
});

test("a full refresh reconciles a moved entry the same way, though WordPress has nothing at the old route", async () => {
  await prepare();
  const about = published.get("/about/")!;
  published.delete("/about/");
  published.set("/company/about/", about);
  wordpress();

  const { status, report } = await refresh();
  const oldRoute = await visit("/about/");

  expect(status).toBe(200);
  expect(report.entries["/about/"]).toEqual({
    outcome: "promoted",
    state: "moved",
    uri: "/company/about/",
  });
  expect(report.moved).toEqual({ "/about/": "/company/about/" });
  expect(oldRoute.status).toBe(301);
  expect(oldRoute.location).toBe("/company/about/");
});

test("an entry moved back to its first route is served there again, and the other route redirects", async () => {
  await prepare();
  const about = published.get("/about/")!;
  published.delete("/about/");
  published.set("/about-us/", about);
  wordpress();
  await refresh({ uris: ["/about-us/"] });
  published.delete("/about-us/");
  published.set("/about/", about);

  await refresh({ uris: ["/about/"] });
  const first = await visit("/about/");
  const second = await visit("/about-us/");

  expect(first.status).toBe(200);
  expectServedAbout(first.html);
  expect(second.status).toBe(301);
  expect(second.location).toBe("/about/");
});

test("a refresh confirming an entry was removed makes it a 404 that outlives an outage", async () => {
  await prepare();
  published.delete("/2026/09/hello/");
  wordpress();

  const { report } = await refresh();
  cmsDown();
  const { status, html } = await visit("/2026/09/hello/");

  expect(report.entries["/2026/09/hello/"]).toEqual({ outcome: "promoted", state: "missing" });
  expect(status).toBe(404);
  expect(html).toContain("Nothing here.");
  expect(html).not.toContain("First post.");
});

test("a route confirmed missing becomes available when something is published there", async () => {
  await prepare();
  wordpress();
  await refresh({ uris: ["/careers/"] });
  expect((await visit("/careers/")).status).toBe(404);
  published.set("/careers/", { id: "page-12", title: "Careers", content: "<p>Join us.</p>" });

  const { report } = await refresh();
  const { status, html } = await visit("/careers/");

  expect(report.entries["/careers/"]).toEqual({ outcome: "promoted", state: "published" });
  expect(status).toBe(200);
  expect(html).toContain("Join us.");
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
          data: { postBy: null, pageBy: null, designTokens: null },
          errors: [{ message: "Internal server error" }],
        }),
      }) as Answer,
    "graphql",
  ],
  ["missing design data", () => data({ postBy: null, pageBy: null, designTokens: null }), "schema"],
  [
    "an entry WordPress returns only without its blocks",
    (variables) =>
      variables.withBlocks === false ? entryAnswer({ uri: "/about/" }) : httpError(502),
    "partial",
  ],
])("an entry refresh failing on %s keeps the last good entry", async (_case, entry, reason) => {
  await prepare();
  published.get("/about/")!.content = "<p>Changed.</p>";
  wordpress({ entry });

  const { status, report } = await refresh({ uris: ["/about/"] });
  const visited = await visit("/about/");

  expect(status).toBe(503);
  expect(report).toMatchObject({
    refreshed: false,
    entries: { "/about/": { outcome: "kept", failure: { reason } } },
  });
  expect(visited.status).toBe(200);
  expectServedAbout(visited.html);
  expect(visited.html).not.toContain("Changed.");
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining(`entry /about/ kept its last stored version (${reason})`),
  );
});

test("a failed chrome read keeps the menu and logo entries are served with, and still refreshes them", async () => {
  await prepare();
  published.get("/about/")!.content = '<p class="has-brand-color">We make new things.</p>';
  wordpress({ chrome: () => httpError(503) });

  const { status, report } = await refresh();
  const { html } = await visit("/about/");

  expect(status).toBe(503);
  expect(report).toMatchObject({
    ready: true,
    refreshed: false,
    chrome: { outcome: "kept", failure: { reason: "http" } },
    entries: { "/about/": { outcome: "promoted", state: "published" } },
  });
  expect(html).toContain("We make new things.");
  expect(html).toMatch(/<a href="\/about\/"[^>]*>About us<\/a>/);
  expect(html).toContain('src="https://media.example/logo.svg"');
});

test("a failed list of published routes still refreshes the stored entries, and removes none", async () => {
  await prepare();
  published.get("/about/")!.content = "<p>Updated.</p>";
  wordpress({ routes: () => httpError(500) });

  const { status, report } = await refresh();
  const about = await visit("/about/");
  const hello = await visit("/2026/09/hello/");

  expect(status).toBe(503);
  expect(report).toMatchObject({
    refreshed: false,
    routes: { outcome: "failed", failure: { reason: "http" } },
    entries: {
      "/about/": { outcome: "promoted", state: "published" },
      "/2026/09/hello/": { outcome: "promoted", state: "published" },
    },
  });
  expect(about.html).toContain("Updated.");
  expect(hello.status).toBe(200);
});

test("changed menus and design presets reach every stored entry after a refresh", async () => {
  await prepare();
  presets = { colors: [{ slug: "brand", color: "#0a0" }], spacingSizes: [] };
  wordpress({
    chrome: () =>
      data({
        ...chrome,
        menuItems: {
          nodes: [{ id: "b", parentId: null, label: "Contact", url: "/contact/", target: null }],
        },
      }),
  });

  await refresh();
  cmsDown();
  const pages = await Promise.all([visit("/about/"), visit("/2026/09/hello/")]);

  for (const { status, html } of pages) {
    expect(status).toBe(200);
    expect(html).toMatch(/<a href="\/contact\/"[^>]*>Contact<\/a>/);
    expect(html).not.toContain("About us");
  }
  expect(pages[0]!.html).toContain("--wp--preset--color--brand:#0a0");
});

test("drafts, private and password-protected entries never enter the store", async () => {
  await prepare();
  // Anonymous readers get nothing for a draft or a private entry; a
  // password-protected one is listed, restricted.
  published.set("/members/", {
    id: "page-5",
    title: "Members",
    content: "<p>Secret</p>",
    isRestricted: true,
  });
  wordpress();

  const { report } = await refresh();
  const refreshed = await visit("/members/");
  const draft = await visit("/draft-preview/");

  expect(report.entries["/members/"]).toEqual({ outcome: "promoted", state: "missing" });
  expect(refreshed.status).toBe(404);
  expect(refreshed.html).not.toContain("Secret");
  expect(draft.status).toBe(404);
  expect(JSON.stringify(await storedEntries())).not.toContain("Secret");
});

test("refreshes and lookups read WordPress anonymously, whatever the visitor sends", async () => {
  await prepare();
  published.set("/new/", { id: "page-90", title: "New", content: "<p>New.</p>" });
  const fetchMock = wordpress();

  await refresh();
  await visit("/new/", { Cookie: "wordpress_logged_in_abc=editor", Authorization: "Basic eA==" });

  expect(fetchMock).toHaveBeenCalled();
  for (const [, init] of fetchMock.mock.calls) {
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("Cookie")).toBeNull();
  }
});

test("each stored entry records which WordPress entry it holds and when it was read", async () => {
  await prepare();

  expect(await storedEntries()).toEqual([
    { key: "entry:/2026/09/hello/", state: "published", nodeId: "post-7" },
    { key: "entry:/about/", state: "published", nodeId: "page-64" },
  ]);
});

test("an entry refresh whose read started earlier doesn't overwrite a newer one", async () => {
  await prepare();
  let releaseSlowRead!: () => void;
  const slowRead = new Promise<void>((resolve) => (releaseSlowRead = resolve));
  let reads = 0;
  wordpress({
    entry: async (variables) => {
      reads += 1;
      if (reads === 1) {
        await slowRead;
        published.get("/about/")!.content = "<p>Old news</p>";
      } else {
        published.get("/about/")!.content = "<p>Latest news</p>";
      }
      return entryAnswer(variables);
    },
  });

  vi.useFakeTimers({ toFake: ["Date"] });
  const slow = refresh({ uris: ["/about/"] });
  await vi.waitFor(() => expect(reads).toBe(1));
  vi.setSystemTime(Date.now() + 1000);
  const fast = await refresh({ uris: ["/about/"] });
  releaseSlowRead();
  const late = await slow;
  const { html } = await visit("/about/");

  expect(fast.report.entries["/about/"]).toEqual({ outcome: "promoted", state: "published" });
  expect(late.report.entries["/about/"]).toEqual({ outcome: "superseded", state: "published" });
  expect(html).toContain("Latest news");
});

test("a full refresh on a CMS that gives absolute URIs stores every entry at its path, moving none", async () => {
  permalinkOrigin = "https://acme-fe.example";
  wordpress();

  const { status, report } = await refresh();
  cmsDown();
  const about = await visit("/about/");

  expect(status).toBe(200);
  expect(report).toMatchObject({
    ready: true,
    routes: { outcome: "listed", count: 3 },
    entries: {
      "/about/": { outcome: "promoted", state: "published" },
      "/2026/09/hello/": { outcome: "promoted", state: "published" },
    },
    moved: {},
  });
  expect(Object.keys(report.entries)).toEqual(["/about/", "/2026/09/hello/"]);
  expect(about.status).toBe(200);
  expectServedAbout(about.html);
});

test("an entry moved on a CMS that gives absolute URIs redirects to its new path", async () => {
  await prepare();
  permalinkOrigin = "https://acme-fe.example";
  const about = published.get("/about/")!;
  published.delete("/about/");
  published.set("/company/about/", about);
  wordpress();

  const { report } = await refresh();
  const oldRoute = await visit("/about/");

  expect(report.moved).toEqual({ "/about/": "/company/about/" });
  expect(oldRoute.status).toBe(301);
  expect(oldRoute.location).toBe("/company/about/");
});

test("an entry WordPress gives an absolute URI is refreshed and served at its path", async () => {
  await prepare();
  permalinkOrigin = "https://acme-fe.example";
  published.set("/café/", { id: "page-30", title: "Café", content: "<p>Coffee.</p>" });
  wordpress();

  const { report } = await refresh({ uris: ["/about/", "/caf%c3%a9/"] });
  cmsDown();
  const about = await visit("/about/");
  const cafe = await visit("/caf%C3%A9/");

  expect(report).toMatchObject({
    refreshed: true,
    entries: {
      "/about/": { outcome: "promoted", state: "published" },
      "/café/": { outcome: "promoted", state: "published" },
    },
    moved: {},
  });
  expect(about.status).toBe(200);
  expectServedAbout(about.html);
  expect(cafe.status).toBe(200);
  expect(cafe.html).toContain("Coffee.");
});

test("a percent-encoded route is the same entry as WordPress's", async () => {
  await prepare();
  published.set("/café/", { id: "page-30", title: "Café", content: "<p>Coffee.</p>" });
  wordpress();
  await refresh({ uris: ["/caf%c3%a9/"] });
  cmsDown();

  const { status, html } = await visit("/caf%C3%A9");

  expect(status).toBe(200);
  expect(html).toContain("Coffee.");
});

test.each<[string, unknown]>([
  ["a body that isn't JSON", "not json"],
  ["uris that isn't a list", { uris: "/about/" }],
  ["an empty list", { uris: [] }],
  ["a full URL", { uris: ["https://evil.example/about/"] }],
  ["a protocol-relative path", { uris: ["//evil.example/"] }],
  ["a query string", { uris: ["/about/?preview=true"] }],
  ["the front page", { uris: ["/"] }],
  ["an unknown field", { uris: ["/about/"], site: "other" }],
])("a refresh request with %s is a 400 and changes nothing", async (_case, body) => {
  await prepare();
  const before = await storedEntries();
  const fetchMock = wordpress();

  const endpoint = await import("./pages/gq/refresh");
  const container = await AstroContainer.create();
  const response = await container.renderToResponse(endpoint as never, {
    routeType: "endpoint",
    request: new Request("https://acme.example/gq/refresh", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  });

  expect(response.status).toBe(400);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await storedEntries()).toEqual(before);
});

test("an entry refresh without the token is refused and changes nothing", async () => {
  await prepare();
  published.get("/about/")!.content = "<p>Injected.</p>";
  const fetchMock = wordpress();

  const { status } = await refresh({ uris: ["/about/"] }, { authorization: null });
  const { html } = await visit("/about/");

  expect(status).toBe(401);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(html).not.toContain("Injected.");
});

test("one Site's entries and refresh token don't reach another Site", async () => {
  await prepare();
  db.close();
  bind(
    openTestD1(join(directory, "other-site.sqlite")),
    "other-site-refresh-token-0123456789abcdef0123",
  );
  const fetchMock = wordpress();

  const refused = await refresh({ uris: ["/about/"] });
  const visited = await visit("/about/");

  expect(refused.status).toBe(401);
  expect(visited.status).toBe(503);
  expect(visited.html).not.toContain("We make things.");
  expect(fetchMock).not.toHaveBeenCalled();
});

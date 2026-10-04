/// <reference types="node" />
// The CMS's publication events, through the rendered Frontend: WordPress
// signs an event when a page or post is published, POST /gq/events refreshes
// it from a stubbed WordPress into the publication store (the Frontend's own
// D1 migrations on SQLite), and visitors see it without a deploy, through a
// later outage. Refused, duplicate, delayed and failed events change nothing
// that is served.
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { openTestD1, type TestD1 } from "./test/sqlite-d1";
import {
  data,
  httpError,
  queries,
  routes,
  stubWordPress,
  timeout,
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

const SITE = "{{project}}";
const TOKEN = "acme-refresh-token-0123456789abcdef0123456789";
const SECRET = "acme-event-signing-key-0123456789abcdef0123456";

interface Entry {
  id: string;
  title: string;
  content: string;
  status?: string;
  isRestricted?: boolean;
}

// What WordPress publishes, by URI, as an anonymous reader sees it.
let published: Map<string, Entry>;
let heading: string;
// Where WordPress's permalinks point. A GETQUICK CMS points them at the
// Frontend, and WPGraphQL then gives every entry's uri as an absolute URL.
let permalinkOrigin: string | null;

/** An entry's uri as WordPress gives it. */
const cmsUri = (path: string) => (permalinkOrigin ? new URL(path, permalinkOrigin).href : path);

const unreachable = () => Promise.reject(new TypeError("fetch failed"));
const presets = { colors: [], spacingSizes: [] };

function entryAnswer({ uri }: Record<string, unknown>) {
  const path = decodeURI(String(uri));
  const entry = published.get(path);
  return data({
    postBy: null,
    pageBy: entry
      ? {
          id: entry.id,
          title: entry.title,
          content: entry.content,
          uri: cmsUri([...published].find(([, other]) => other === entry)![0]),
          status: entry.status ?? "publish",
          isRestricted: entry.isRestricted ?? false,
          featuredImage: null,
        }
      : null,
    designTokens: presets,
  });
}

function wordpress(handlers: { entry?: Handler; home?: Handler } = {}) {
  return stubWordPress({
    home: () =>
      data({
        generalSettings: { title: "Acme", description: "Things" },
        nodeByUri: {
          __typename: "Page",
          isFrontPage: true,
          title: "Home",
          content: `<h1>${heading}</h1>`,
        },
        designTokens: presets,
      }),
    entry: entryAnswer,
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

function bind(database: TestD1, env: Record<string, unknown> = {}) {
  db = database;
  runtime.env = {
    PUBLICATION_DB: database,
    FRONTEND_REFRESH_TOKEN: TOKEN,
    PUBLICATION_EVENT_SECRET: SECRET,
    ...env,
  };
}

beforeEach(() => {
  vi.stubEnv("DEV", false);
  published = new Map([
    ["/about/", { id: "page-64", title: "About", content: "<p>Version 1.</p>" }],
  ]);
  heading = "Welcome";
  permalinkOrigin = null;
  directory = mkdtempSync(join(tmpdir(), "acme-events-"));
  bind(openTestD1(join(directory, "publications.sqlite")));
  vi.spyOn(console, "error").mockImplementation(() => {});
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

async function visit(path: string) {
  const page =
    path === "/" ? await import("./pages/index.astro") : await import("./pages/[...slug].astro");
  const container = await AstroContainer.create();
  const response = await container.renderToResponse(page.default, {
    request: new Request(new URL(path, "https://acme.example")),
    params: { slug: path.replace(/^\/|\/$/g, "") },
    partial: false,
  });
  return {
    status: response.status,
    location: response.headers.get("Location"),
    html: await response.text(),
  };
}

async function endpoint(path: string, init: RequestInit) {
  const module = await import(path === "/gq/events" ? "./pages/gq/events" : "./pages/gq/refresh");
  const container = await AstroContainer.create();
  const response = await container.renderToResponse(module as never, {
    routeType: "endpoint",
    request: new Request(`https://acme.example${path}`, init),
  });
  return { status: response.status, body: await response.json() };
}

/** A publication event, as the Site's CMS sends it. */
function publication(uri: string, overrides: Record<string, unknown> = {}) {
  const entry = published.get(uri);
  return {
    site: SITE,
    id: randomUUID(),
    action: "publish",
    occurredAt: Date.now(),
    entry: { id: entry?.id ?? "page-99", uri },
    ...overrides,
  };
}

function signature(body: string, timestamp: number, secret = SECRET) {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** Delivers an event the way the CMS does: its body signed with the Site's event secret. */
async function deliver(
  event: unknown,
  {
    secret = SECRET,
    timestamp = Math.floor(Date.now() / 1000),
    headers,
    method = "POST",
  }: {
    secret?: string;
    timestamp?: number;
    headers?: Record<string, string>;
    method?: string;
  } = {},
) {
  const body = typeof event === "string" ? event : JSON.stringify(event);
  return endpoint("/gq/events", {
    method,
    headers: headers ?? {
      "Content-Type": "application/json",
      "GQ-Event-Timestamp": String(timestamp),
      "GQ-Event-Signature": signature(body, timestamp, secret),
    },
    body: method === "GET" ? undefined : body,
  });
}

async function prepare() {
  wordpress();
  const { status } = await endpoint("/gq/refresh", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: "{}",
  });
  expect(status).toBe(200);
}

async function recordedEvents() {
  const { results } = await db
    .prepare("SELECT id, status, attempts, reason FROM publication_events ORDER BY received_at")
    .all<{ id: string; status: string; attempts: number; reason: string | null }>();
  return results;
}

async function storedRows() {
  const { results } = await db
    .prepare("SELECT key, state, body, read_started_at FROM publications ORDER BY key")
    .all();
  return results;
}

test("a published change reaches visitors through its event, without a deploy, and outlives an outage", async () => {
  await prepare();
  published.get("/about/")!.content = "<p>Version 2.</p>";
  wordpress();

  const event = publication("/about/");
  const { status, body } = await deliver(event);
  cmsDown();
  const visited = await visit("/about/");

  expect(status).toBe(200);
  expect(body).toEqual({
    event: event.id,
    status: "refreshed",
    entries: { "/about/": { outcome: "promoted", state: "published" } },
    moved: {},
  });
  expect(visited.status).toBe(200);
  expect(visited.html).toContain("Version 2.");
  expect(await recordedEvents()).toEqual([
    { id: event.id, status: "refreshed", attempts: 1, reason: null },
  ]);
});

test("a new publication's event makes it available, through a later outage", async () => {
  await prepare();
  published.set("/news/", { id: "page-80", title: "News", content: "<p>We launched.</p>" });
  wordpress();

  const { status } = await deliver(publication("/news/"));
  cmsDown();
  const visited = await visit("/news/");

  expect(status).toBe(200);
  expect(visited.status).toBe(200);
  expect(visited.html).toContain("We launched.");
});

test("a moved entry's event redirects the route it left", async () => {
  await prepare();
  const about = published.get("/about/")!;
  published.delete("/about/");
  published.set("/about-us/", { ...about, content: "<p>Moved.</p>" });
  wordpress();

  const { status, body } = await deliver(
    publication("/about-us/", {
      entry: { id: about.id, uri: "/about-us/", previousUri: "/about/" },
    }),
  );
  cmsDown();
  const oldRoute = await visit("/about/");
  const newRoute = await visit("/about-us/");

  expect(status).toBe(200);
  expect(body.moved).toEqual({ "/about/": "/about-us/" });
  expect(oldRoute.status).toBe(301);
  expect(oldRoute.location).toBe("/about-us/");
  expect(newRoute.html).toContain("Moved.");
});

test("an event for an entry WordPress gives an absolute URI refreshes it at its path", async () => {
  await prepare();
  permalinkOrigin = "https://acme-fe.example";
  published.get("/about/")!.content = "<p>Version 2.</p>";
  wordpress();

  const { status, body } = await deliver(publication("/about/"));
  cmsDown();
  const visited = await visit("/about/");

  expect(status).toBe(200);
  expect(body).toMatchObject({
    status: "refreshed",
    entries: { "/about/": { outcome: "promoted", state: "published" } },
    moved: {},
  });
  expect(visited.status).toBe(200);
  expect(visited.html).toContain("Version 2.");
});

test("a moved entry's event on a CMS that gives absolute URIs redirects to its new path", async () => {
  await prepare();
  permalinkOrigin = "https://acme-fe.example";
  const about = published.get("/about/")!;
  published.delete("/about/");
  published.set("/about-us/", { ...about, content: "<p>Moved.</p>" });
  wordpress();

  const { status, body } = await deliver(
    publication("/about-us/", {
      entry: { id: about.id, uri: "/about-us/", previousUri: "/about/" },
    }),
  );
  cmsDown();
  const oldRoute = await visit("/about/");
  const newRoute = await visit("/about-us/");

  expect(status).toBe(200);
  expect(body.moved).toEqual({ "/about/": "/about-us/" });
  expect(oldRoute.status).toBe(301);
  expect(oldRoute.location).toBe("/about-us/");
  expect(newRoute.status).toBe(200);
  expect(newRoute.html).toContain("Moved.");
});

test("the front page's event refreshes the homepage", async () => {
  await prepare();
  heading = "Spring at Acme";
  const fetchMock = wordpress();

  const { status, body } = await deliver(publication("/", { entry: { id: "page-2", uri: "/" } }));
  cmsDown();
  const home = await visit("/");

  expect(status).toBe(200);
  expect(body).toMatchObject({ status: "refreshed", home: { outcome: "promoted" }, entries: {} });
  expect(queries(fetchMock, "SiteChrome")).toHaveLength(0);
  expect(queries(fetchMock, "PublishedRoutes")).toHaveLength(0);
  expect(home.status).toBe(200);
  expect(home.html).toContain("Spring at Acme");
});

test("a duplicate event is recognised and doesn't read the CMS again", async () => {
  await prepare();
  wordpress();
  const event = publication("/about/");
  await deliver(event);
  const fetchMock = wordpress();

  const { status, body } = await deliver(event);

  expect(status).toBe(200);
  expect(body).toEqual({ event: event.id, status: "refreshed", duplicate: true });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await recordedEvents()).toHaveLength(1);
});

test("a delayed event older than a refreshed one is superseded, never processed", async () => {
  await prepare();
  const older = publication("/about/", { occurredAt: Date.now() - 60_000 });
  published.get("/about/")!.content = "<p>Version 2.</p>";
  wordpress();
  const newer = publication("/about/");
  await deliver(newer);
  const before = await storedRows();
  const fetchMock = wordpress();

  const { status, body } = await deliver(older);
  const visited = await visit("/about/");

  expect(status).toBe(200);
  expect(body).toEqual({ event: older.id, status: "superseded", by: newer.id });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await storedRows()).toEqual(before);
  expect(visited.html).toContain("Version 2.");
});

test("a newer refreshed event supersedes an older one that had failed, so a retry skips it", async () => {
  await prepare();
  wordpress({ entry: () => httpError(500) });
  const older = publication("/about/", { occurredAt: Date.now() - 60_000 });
  await deliver(older);
  wordpress();
  await deliver(publication("/about/"));
  const fetchMock = wordpress();

  const retried = await deliver(older);

  expect(retried.body).toEqual({ event: older.id, status: "superseded", duplicate: true });
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each<[string, Handler, string]>([
  ["a timeout", timeout, "timeout"],
  ["an unreachable CMS", unreachable, "network"],
  ["an HTTP error", () => httpError(502), "http"],
  ["missing design data", () => data({ postBy: null, pageBy: null, designTokens: null }), "schema"],
])(
  "an event whose refresh fails on %s keeps the served entry and stays on record, failed",
  async (_case, entry, reason) => {
    await prepare();
    published.get("/about/")!.content = "<p>Version 2.</p>";
    wordpress({ entry });

    const event = publication("/about/");
    const { status, body } = await deliver(event);
    const visited = await visit("/about/");

    expect(status).toBe(503);
    expect(body).toMatchObject({
      event: event.id,
      status: "failed",
      entries: { "/about/": { outcome: "kept", failure: { reason } } },
    });
    expect(visited.status).toBe(200);
    expect(visited.html).toContain("Version 1.");
    expect(await recordedEvents()).toEqual([
      { id: event.id, status: "failed", attempts: 1, reason },
    ]);
  },
);

test("a failed event retried after a Worker restart and the CMS's recovery is refreshed", async () => {
  await prepare();
  published.get("/about/")!.content = "<p>Version 2.</p>";
  cmsDown();
  const event = publication("/about/");
  await deliver(event);

  db.close();
  vi.resetModules();
  bind(openTestD1(join(directory, "publications.sqlite")));
  wordpress();
  const { status, body } = await deliver(event);
  const visited = await visit("/about/");

  expect(status).toBe(200);
  expect(body.status).toBe("refreshed");
  expect(visited.html).toContain("Version 2.");
  expect(await recordedEvents()).toEqual([
    { id: event.id, status: "refreshed", attempts: 2, reason: null },
  ]);
});

test("an event never puts a draft, private or password-protected entry in the store", async () => {
  await prepare();
  published.set("/members/", {
    id: "page-5",
    title: "Members",
    content: "<p>Secret</p>",
    isRestricted: true,
  });
  const fetchMock = wordpress();

  const restricted = await deliver(publication("/members/"));
  // A draft: anonymous WordPress has nothing at its URI.
  const draft = await deliver(publication("/draft/", { entry: { id: "page-6", uri: "/draft/" } }));
  cmsDown();

  expect(restricted.body.entries["/members/"]).toEqual({ outcome: "promoted", state: "missing" });
  expect(draft.body.entries["/draft/"]).toEqual({ outcome: "promoted", state: "missing" });
  expect((await visit("/members/")).status).toBe(404);
  expect((await visit("/draft/")).status).toBe(404);
  expect(JSON.stringify(await storedRows())).not.toContain("Secret");
  for (const [, init] of fetchMock.mock.calls) {
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("Cookie")).toBeNull();
  }
});

const now = () => Math.floor(Date.now() / 1000);

test.each<[string, () => Promise<{ status: number; body: Record<string, unknown> }>]>([
  [
    "no signature",
    () => deliver(publication("/about/"), { headers: { "Content-Type": "application/json" } }),
  ],
  ["another key's signature", () => deliver(publication("/about/"), { secret: "x".repeat(40) })],
  [
    "the refresh token as a bearer token",
    () =>
      deliver(publication("/about/"), {
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      }),
  ],
  [
    "a signature older than five minutes (a replay)",
    () => deliver(publication("/about/"), { timestamp: now() - 6 * 60 }),
  ],
  [
    "a signed body changed in transit",
    () => {
      const event = JSON.stringify(publication("/about/"));
      const timestamp = now();
      return deliver(event.replace("/about/", "/about-us/"), {
        headers: {
          "GQ-Event-Timestamp": String(timestamp),
          "GQ-Event-Signature": signature(event, timestamp),
        },
      });
    },
  ],
])("an event with %s is refused and changes nothing", async (_case, send) => {
  await prepare();
  const before = await storedRows();
  published.get("/about/")!.content = "<p>Injected.</p>";
  const fetchMock = wordpress();

  const { status, body } = await send();

  expect(status).toBe(401);
  expect(JSON.stringify(body)).not.toContain(SECRET);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await storedRows()).toEqual(before);
  expect(await recordedEvents()).toEqual([]);
  expect((await visit("/about/")).html).not.toContain("Injected.");
});

test.each<[string, () => unknown, number]>([
  ["for another Site", () => ({ ...publication("/about/"), site: "other-site" }), 403],
  ["with an unsupported action", () => ({ ...publication("/about/"), action: "purge" }), 422],
  ["without an action", () => ({ ...publication("/about/"), action: undefined }), 422],
  ["that isn't JSON", () => "publish /about/", 400],
  ["that isn't an object", () => [publication("/about/")], 400],
  ["without its entry", () => ({ ...publication("/about/"), entry: undefined }), 400],
  [
    "with a URL for a URI",
    () => publication("/about/", { entry: { id: "page-64", uri: "https://evil.example/" } }),
    400,
  ],
  [
    "with an unknown field",
    () => ({ ...publication("/about/"), content: "<p>Injected.</p>" }),
    400,
  ],
  ["with an id that isn't one", () => publication("/about/", { id: "1" }), 400],
  [
    "that happened after it was signed",
    () => publication("/about/", { occurredAt: Date.now() + 3_600_000 }),
    400,
  ],
])("an event %s is rejected and changes nothing", async (_case, event, expected) => {
  await prepare();
  const before = await storedRows();
  const fetchMock = wordpress();

  const { status, body } = await deliver(event());

  expect(status).toBe(expected);
  expect(typeof body.error).toBe("string");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await storedRows()).toEqual(before);
  expect(await recordedEvents()).toEqual([]);
});

test.each([
  ["no event secret bound", undefined],
  ["an event secret too short to trust", "short"],
])("with %s, events are disabled", async (_case, secret) => {
  bind(db, { PUBLICATION_EVENT_SECRET: secret });
  const fetchMock = wordpress();

  const { status, body } = await deliver(publication("/about/"), { secret: secret ?? "" });

  expect(status).toBe(403);
  expect(body.error).toContain("Events are disabled");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("the event secret doesn't authorise a refresh", async () => {
  const fetchMock = wordpress();

  const { status } = await endpoint("/gq/refresh", {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}` },
    body: "{}",
  });

  expect(status).toBe(401);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("one Site's event secret doesn't reach another Site", async () => {
  await prepare();
  db.close();
  bind(openTestD1(join(directory, "other-site.sqlite")), {
    PUBLICATION_EVENT_SECRET: "other-site-event-signing-key-0123456789abcdef",
  });
  const fetchMock = wordpress();

  const { status } = await deliver(publication("/about/"));

  expect(status).toBe(401);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await recordedEvents()).toEqual([]);
});

test("a check event proves the Frontend accepts this Site's events, and changes nothing", async () => {
  const fetchMock = wordpress();

  const { status, body } = await deliver({
    site: SITE,
    id: randomUUID(),
    action: "check",
    occurredAt: Date.now(),
  });

  expect(status).toBe(200);
  expect(body).toEqual({
    status: "checked",
    site: SITE,
    reconciliation: null,
    store: {
      home: null,
      chrome: null,
      design: null,
      entries: {},
      withdrawals: 0,
      failedEvents: 0,
    },
  });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await recordedEvents()).toEqual([]);
});

test("the check says what the store holds, so an unprepared Site isn't mistaken for a ready one", async () => {
  const check = () =>
    deliver({ site: SITE, id: randomUUID(), action: "check", occurredAt: Date.now() });
  // The Worker answers, but nothing was ever stored: pages are a 503.
  expect((await check()).body.store).toMatchObject({ home: null, chrome: null, entries: {} });
  expect((await visit("/")).status).toBe(503);

  await prepare();
  published.set("/news/", { id: "page-80", title: "News", content: "<p>We launched.</p>" });
  await deliver({
    site: SITE,
    id: randomUUID(),
    action: "withdraw",
    occurredAt: Date.now(),
    entry: { id: "page-64", uri: "/about/" },
  });
  published.get("/news/")!.content = "<p>Updated.</p>";
  const failing = wordpress({ entry: () => httpError(502) });
  await deliver(publication("/news/"));
  db.exec("UPDATE publications SET format = 99 WHERE key = 'design'");
  const fetched = failing.mock.calls.length;

  const { status, body } = await check();

  expect(status).toBe(200);
  expect(body.store).toEqual({
    home: "published",
    chrome: "published",
    design: "unusable",
    entries: { withdrawn: 1 },
    withdrawals: 1,
    failedEvents: 1,
  });
  expect(failing.mock.calls.length).toBe(fetched);
  expect(JSON.stringify(body)).not.toContain("Version 1.");
});

test("a check on a store that can't be read still proves the key, and says the store is unreadable", async () => {
  db.unavailable = true;

  const { status, body } = await deliver({
    site: SITE,
    id: randomUUID(),
    action: "check",
    occurredAt: Date.now(),
  });

  expect(status).toBe(200);
  expect(body).toMatchObject({ status: "checked", site: SITE, store: null });
});

test("an event the store can't record is a 503, for the CMS to deliver again", async () => {
  await prepare();
  const fetchMock = wordpress();
  db.unavailable = true;

  const { status, body } = await deliver(publication("/about/"));

  expect(status).toBe(503);
  expect(body.error).toContain("deliver the event again");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("events are delivered with POST", async () => {
  const { status } = await deliver(publication("/about/"), { method: "GET" });

  expect(status).toBe(405);
});

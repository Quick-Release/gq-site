/// <reference types="node" />
// Reconciliation through the rendered Frontend, on a controlled clock: the
// CMS's scheduler (delivery-retries.php, on the server's cron) sends a signed
// "reconcile" event every minute, and the Frontend compares its publication
// store with what a stubbed WordPress publishes. A change whose own event was
// lost (a publication, an update, a move, a removal, a republication, a shared
// setting) reaches visitors within five minutes, without a visit reading the
// CMS and without republishing. Outages keep every page and invent no
// withdrawal; recovery catches up by the same rules as events; an accepted
// withdrawal survives older scans and work in flight; interrupted, repeated
// and overlapping runs are safe; and one run stays within Workers' subrequest
// budget.
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { SqlDatabase } from "./lib/publications";
import { openTestD1, type TestD1 } from "./test/sqlite-d1";
import {
  data,
  gmt,
  httpError,
  listing,
  queries,
  stubWordPress,
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

const SITE = "{{project}}";
const TOKEN = "acme-refresh-token-0123456789abcdef0123456789";
const SECRET = "acme-event-signing-key-0123456789abcdef0123456";
const MINUTE = 60_000;
/** The agreed target: a missed change is public within five minutes while WordPress is healthy. */
const TARGET = 5 * MINUTE;

interface Entry {
  id: string;
  title: string;
  content: string;
  /** When WordPress last modified it (ms, to the second). */
  modified: number;
}

/** What WordPress publishes, as an anonymous reader gets it. */
interface WordPress {
  entries: Map<string, Entry>;
  heading: string;
  menu: string;
  logo: string;
  icon: string;
  tagline: string;
  color: string;
}

let cms: WordPress;
// Where WordPress's permalinks point. A GETQUICK CMS points them at the
// Frontend, and WPGraphQL then gives every entry's uri as an absolute URL.
let permalinkOrigin: string | null;

/** An entry's uri as WordPress gives it. */
const cmsUri = (path: string) => (permalinkOrigin ? new URL(path, permalinkOrigin).href : path);

const unreachable = () => Promise.reject(new TypeError("fetch failed"));
const presets = () => ({ colors: [{ slug: "brand", color: cms.color }], spacingSizes: [] });
const now = () => Math.floor(Date.now() / 1000) * 1000;

function entryAnswer({ uri }: Record<string, unknown>): Answer {
  const path = decodeURI(String(uri));
  const entry = cms.entries.get(path);
  return data({
    postBy: null,
    pageBy: entry
      ? {
          id: entry.id,
          title: entry.title,
          content: `<p class="has-brand-color">${entry.content}</p>`,
          uri: cmsUri(path),
          status: "publish",
          isRestricted: false,
          modifiedGmt: gmt(entry.modified),
          featuredImage: null,
        }
      : null,
    designTokens: presets(),
  });
}

const handlers = {
  home: () =>
    data({
      generalSettings: { title: "Acme", description: cms.tagline },
      nodeByUri: {
        __typename: "Page",
        id: "page-2",
        isFrontPage: true,
        title: "Home",
        content: `<h1 class="has-brand-color">${cms.heading}</h1>`,
      },
      designTokens: presets(),
    }),
  entry: entryAnswer,
  chrome: () =>
    data({
      generalSettings: {
        siteIcon: { node: { sourceUrl: cms.icon, altText: "" } },
        siteLogo: { node: { sourceUrl: cms.logo, altText: "Acme" } },
      },
      menuItems: {
        nodes: [{ id: "a", parentId: null, label: cms.menu, url: "/about/", target: null }],
      },
    }),
  design: () => data({ designTokens: presets() }),
  routes: () =>
    listing(
      { uri: "/", id: "page-2", modifiedGmt: gmt(Date.parse("2026-09-01T00:00:00Z")) },
      ...[...cms.entries].map(([uri, entry]) => ({
        uri: cmsUri(uri),
        id: entry.id,
        modifiedGmt: gmt(entry.modified),
      })),
    ),
} satisfies Record<string, Handler>;

// WordPress, up and answering from `cms`, unless a handler says otherwise.
function wordpress(overrides: Partial<Record<keyof typeof handlers, Handler>> = {}) {
  return stubWordPress({ ...handlers, ...overrides });
}

function cmsDown() {
  return wordpress({
    home: unreachable,
    entry: unreachable,
    chrome: unreachable,
    design: unreachable,
    routes: unreachable,
  });
}

/** An editor's change in WordPress whose event never reaches the Frontend. */
function edit(uri: string, change: Partial<Entry>) {
  const entry = cms.entries.get(uri)!;
  cms.entries.set(uri, { ...entry, ...change, modified: now() });
}

function publishWithoutEvent(uri: string, id: string, content: string) {
  cms.entries.set(uri, { id, title: uri, content, modified: now() });
}

let directory: string;
let db: TestD1;

function bind(database: TestD1, store: SqlDatabase = database, env: Record<string, unknown> = {}) {
  db = database;
  runtime.env = {
    PUBLICATION_DB: store,
    FRONTEND_REFRESH_TOKEN: TOKEN,
    PUBLICATION_EVENT_SECRET: SECRET,
    ...env,
  };
}

/** A Worker restart: the same store, a fresh module graph. */
function restart() {
  vi.resetModules();
  bind(db);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-02T09:00:00Z"));
  vi.stubEnv("DEV", false);
  const modified = Date.parse("2026-09-15T08:00:00Z");
  cms = {
    entries: new Map([
      ["/about/", { id: "page-64", title: "About", content: "We make things.", modified }],
      ["/2026/09/hello/", { id: "post-7", title: "Hello", content: "First post.", modified }],
    ]),
    heading: "Welcome",
    menu: "About us",
    logo: "https://media.example/logo.svg",
    icon: "https://media.example/icon.png",
    tagline: "Things",
    color: "#c00",
  };
  permalinkOrigin = null;
  directory = mkdtempSync(join(tmpdir(), "acme-reconciliation-"));
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

/**
 * What visitors get, with WordPress unreachable while they visit: whatever
 * they see came from the store, not from a visit reading the CMS.
 */
async function served(path: string) {
  return (await servedAll([path]))[0]!;
}

async function servedAll(paths: string[]) {
  cmsDown();
  try {
    return await Promise.all(paths.map(visit));
  } finally {
    wordpress();
  }
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

/** Delivers an event the way the CMS does, now: signed with the Site's key at the current time. */
async function deliver(event: unknown, secret = SECRET) {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return endpoint("/gq/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "GQ-Event-Timestamp": String(timestamp),
      "GQ-Event-Signature": `v1=${signature}`,
    },
    body,
  });
}

/** One run of the CMS's scheduler: its signed reconcile event. */
const cron = (overrides: Record<string, unknown> = {}) =>
  deliver({
    site: SITE,
    id: randomUUID(),
    action: "reconcile",
    occurredAt: Date.now(),
    ...overrides,
  });

const withdrawal = (uri: string, id: string) => ({
  site: SITE,
  id: randomUUID(),
  action: "withdraw",
  occurredAt: Date.now(),
  entry: { id, uri },
});

/** Moves the clock on. */
const after = (ms: number) => vi.setSystemTime(Date.now() + ms);

async function prepare() {
  wordpress();
  const { status } = await endpoint("/gq/refresh", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: "{}",
  });
  expect(status).toBe(200);
}

/**
 * Runs the CMS's scheduler every minute from the change until `visible`
 * holds, as visitors see the site. Resolves to how long that took (null if
 * not within `limit`) and each run's answer.
 */
async function untilVisible(visible: () => Promise<boolean>, limit = 10 * MINUTE) {
  const changedAt = Date.now();
  const runs = [];
  while (Date.now() - changedAt < limit) {
    after(MINUTE);
    runs.push(await cron());
    if (await visible()) return { took: Date.now() - changedAt, runs };
  }
  return { took: null, runs };
}

async function publicationEvents() {
  const { results } = await db
    .prepare(
      "SELECT id, node_id, status, attempts, reason FROM publication_events ORDER BY node_id, id",
    )
    .all<{
      id: string;
      node_id: string;
      status: string;
      attempts: number;
      reason: string | null;
    }>();
  return results;
}

test("a publication and an update whose events were lost are public within five minutes, without a visit or a republish", async () => {
  await prepare();
  publishWithoutEvent("/news/", "page-80", "We launched.");
  edit("/about/", { content: "We make better things." });

  const { took, runs } = await untilVisible(
    async () =>
      (await served("/news/")).html.includes("We launched.") &&
      (await served("/about/")).html.includes("We make better things."),
  );

  expect(took).not.toBeNull();
  expect(took!).toBeLessThanOrEqual(TARGET);
  expect(runs.at(-1)).toMatchObject({
    status: 200,
    body: {
      status: "reconciled",
      entries: {
        "/news/": { change: "new", outcome: "refreshed" },
        "/about/": { change: "changed", outcome: "refreshed" },
      },
      changed: 2,
      pending: 0,
      failed: 0,
    },
  });
  // Each change is recorded as a publication event, processed by the same rules.
  expect(await publicationEvents()).toEqual([
    expect.objectContaining({ node_id: "page-64", status: "refreshed", attempts: 1 }),
    expect.objectContaining({ node_id: "page-80", status: "refreshed", attempts: 1 }),
  ]);
  expect((await publicationEvents()).every(({ id }) => id.startsWith("reconcile-"))).toBe(true);
});

test("a lost move redirects the route it left, and a lost removal is a 404 once WordPress confirms it", async () => {
  await prepare();
  const about = cms.entries.get("/about/")!;
  cms.entries.delete("/about/");
  cms.entries.set("/about-us/", { ...about, modified: now() });
  cms.entries.delete("/2026/09/hello/");

  const { took, runs } = await untilVisible(
    async () =>
      (await served("/about/")).status === 301 && (await served("/2026/09/hello/")).status === 404,
  );
  const moved = await served("/about/");
  const renamed = await served("/about-us/");

  expect(took!).toBeLessThanOrEqual(TARGET);
  expect(runs.at(-1)?.body).toMatchObject({
    status: "reconciled",
    entries: {
      "/about-us/": { change: "moved", outcome: "refreshed" },
      "/2026/09/hello/": { change: "removed", outcome: "refreshed" },
    },
  });
  expect(moved.location).toBe("/about-us/");
  expect(renamed.status).toBe(200);
  expect(renamed.html).toContain("We make things.");
});

test("on a CMS that gives absolute URIs, an unchanged site is reconciled as unchanged", async () => {
  permalinkOrigin = "https://acme-fe.example";
  await prepare();

  after(MINUTE);
  const first = await cron();
  after(MINUTE);
  const second = await cron();
  const about = await served("/about/");

  for (const run of [first, second]) {
    expect(run.body).toMatchObject({ status: "reconciled", changed: 0, failed: 0 });
    // Stored entries are only re-read in turn: none is new, moved or removed.
    for (const entry of Object.values(run.body.entries ?? {})) {
      expect(entry).toMatchObject({ change: "verified" });
    }
  }
  expect(about.status).toBe(200);
  expect(about.html).toContain("We make things.");
  expect(await publicationEvents()).toEqual([]);
});

test("on a CMS that gives absolute URIs, lost publications, moves and removals reach their paths", async () => {
  permalinkOrigin = "https://acme-fe.example";
  await prepare();
  publishWithoutEvent("/news/", "page-80", "We launched.");
  const about = cms.entries.get("/about/")!;
  cms.entries.delete("/about/");
  cms.entries.set("/about-us/", { ...about, modified: now() });
  cms.entries.delete("/2026/09/hello/");

  const { took, runs } = await untilVisible(
    async () =>
      (await served("/news/")).html.includes("We launched.") &&
      (await served("/about/")).status === 301 &&
      (await served("/2026/09/hello/")).status === 404,
  );
  const moved = await served("/about/");
  const renamed = await served("/about-us/");

  expect(took!).toBeLessThanOrEqual(TARGET);
  expect(runs.at(-1)?.body).toMatchObject({
    status: "reconciled",
    entries: {
      "/news/": { change: "new", outcome: "refreshed" },
      "/about-us/": { change: "moved", outcome: "refreshed" },
      "/2026/09/hello/": { change: "removed", outcome: "refreshed" },
    },
  });
  expect(moved.location).toBe("/about-us/");
  expect(renamed.status).toBe(200);
  expect(renamed.html).toContain("We make things.");
});

test("lost changes to every shared setting reach the homepage and every entry", async () => {
  await prepare();
  cms.menu = "Contact";
  cms.logo = "https://media.example/logo-2026.svg";
  cms.icon = "https://media.example/icon-2026.png";
  cms.tagline = "Better things";
  cms.color = "#0a0";
  cms.heading = "Spring at Acme";

  const everyPage = () => servedAll(["/", "/about/", "/2026/09/hello/"]);
  const { took, runs } = await untilVisible(async () =>
    (await everyPage()).every(
      ({ html }) =>
        html.includes(">Contact</a>") &&
        html.includes('src="https://media.example/logo-2026.svg"') &&
        html.includes("https://media.example/icon-2026.png") &&
        html.includes("--wp--preset--color--brand:#0a0"),
    ),
  );
  const [home] = await everyPage();

  expect(took!).toBeLessThanOrEqual(TARGET);
  expect(runs.at(-1)?.body).toMatchObject({
    status: "reconciled",
    shared: {
      home: { outcome: "promoted" },
      chrome: { outcome: "promoted" },
      design: { outcome: "promoted" },
    },
  });
  expect(home.html).toContain("Spring at Acme");
  expect(home.html).toContain('<meta name="description" content="Better things">');
});

test("with nothing changed, a run reads only the shared rows, the list and a few stored entries, and rewrites nothing shared", async () => {
  await prepare();
  after(MINUTE);
  await cron();
  const { results: before } = await db
    .prepare("SELECT key, promoted_at FROM publications WHERE key IN ('home', 'chrome', 'design')")
    .all();
  const fetchMock = wordpress();

  after(MINUTE);
  const run = await cron();
  const { results: afterRun } = await db
    .prepare("SELECT key, promoted_at FROM publications WHERE key IN ('home', 'chrome', 'design')")
    .all();

  expect(run.body).toMatchObject({
    status: "reconciled",
    shared: {
      home: { outcome: "unchanged" },
      chrome: { outcome: "unchanged" },
      design: { outcome: "unchanged" },
    },
    checked: 3,
    changed: 0,
  });
  expect(queries(fetchMock, "PublishedRoutes")).toHaveLength(1);
  expect(queries(fetchMock, "EntryByUri").length).toBeLessThanOrEqual(2);
  expect(afterRun).toEqual(before);
  expect(await publicationEvents()).toEqual([]);
});

test("a change that left the modification time alone is caught as stored entries are re-read in turn", async () => {
  await prepare();
  cms.entries.get("/2026/09/hello/")!.content = "First post, corrected.";

  const { took } = await untilVisible(async () =>
    (await served("/2026/09/hello/")).html.includes("First post, corrected."),
  );

  expect(took).not.toBeNull();
});

test("during an outage of any length a run fails, keeps every page and withdraws nothing; recovery then catches up", async () => {
  await prepare();
  const before = await servedAll(["/", "/about/", "/2026/09/hello/"]);
  // WordPress changes while it can't be read.
  publishWithoutEvent("/news/", "page-80", "We launched.");
  edit("/about/", { content: "We make better things." });
  cms.entries.delete("/2026/09/hello/");
  cms.menu = "Contact";
  cmsDown();

  const failed = [];
  for (const wait of [MINUTE, 60 * MINUTE, 30 * 24 * 60 * MINUTE]) {
    after(wait);
    failed.push(await cron());
  }
  const during = await servedAll(["/", "/about/", "/2026/09/hello/"]);
  const news = await served("/news/");

  expect(failed.map(({ status }) => status)).toEqual([503, 503, 503]);
  expect(failed[0]?.body).toMatchObject({
    status: "failed",
    listing: { outcome: "kept", failure: { reason: "network" } },
    shared: { home: { outcome: "kept" }, chrome: { outcome: "kept" }, design: { outcome: "kept" } },
    failure: { reason: "network" },
  });
  expect(during.map(({ status }) => status)).toEqual([200, 200, 200]);
  expect(during.map(({ html }) => html)).toEqual(before.map(({ html }) => html));
  // Uncached, with the CMS down: unavailable, not missing.
  expect(news.status).toBe(503);

  wordpress();
  const { took, runs } = await untilVisible(
    async () =>
      (await served("/news/")).status === 200 &&
      (await served("/about/")).html.includes("We make better things.") &&
      (await served("/2026/09/hello/")).status === 404 &&
      (await served("/")).html.includes(">Contact</a>"),
  );
  expect(took!).toBeLessThanOrEqual(TARGET);
  expect(runs.at(-1)?.body).toMatchObject({ status: "reconciled" });
});

test("a list WordPress fails to give removes nothing, and an entry it fails to read keeps its stored version until a later run", async () => {
  await prepare();
  cms.entries.delete("/2026/09/hello/");
  wordpress({ routes: () => httpError(502) });
  after(MINUTE);
  const noList = await cron();

  expect(noList).toMatchObject({
    status: 503,
    body: { status: "failed", listing: { outcome: "kept", failure: { reason: "http" } } },
  });
  expect((await served("/2026/09/hello/")).status).toBe(200);

  edit("/about/", { content: "We make better things." });
  wordpress({ entry: ({ uri }) => (uri === "/about/" ? httpError(500) : entryAnswer({ uri })) });
  after(MINUTE);
  const unread = await cron();
  const kept = await served("/about/");
  const [failedEvent] = (await publicationEvents()).filter(({ node_id }) => node_id === "page-64");

  expect(unread.body).toMatchObject({
    status: "failed",
    entries: {
      "/about/": { change: "changed", outcome: "kept", failure: { reason: "http" } },
      "/2026/09/hello/": { change: "removed", outcome: "refreshed" },
    },
  });
  expect(kept.html).toContain("We make things.");
  expect(failedEvent).toMatchObject({ status: "failed", attempts: 1, reason: "http" });

  wordpress();
  after(MINUTE);
  const recovered = await cron();

  expect(recovered.body).toMatchObject({ status: "reconciled" });
  expect((await served("/about/")).html).toContain("We make better things.");
  // The same change, retried: one record, two attempts.
  expect((await publicationEvents()).filter(({ node_id }) => node_id === "page-64")).toEqual([
    { ...failedEvent, status: "refreshed", attempts: 2, reason: null },
  ]);
});

test("an accepted withdrawal isn't undone by a scan of a WordPress that still lists the entry from before it", async () => {
  await prepare();
  after(MINUTE);
  const withdrawn = await deliver(withdrawal("/about/", "page-64"));
  // WordPress (or a cache in front of it) still lists and returns the entry as
  // last modified before the withdrawal.
  const fetchMock = wordpress();

  const runs = [];
  for (let minute = 0; minute < 5; minute += 1) {
    after(MINUTE);
    runs.push(await cron());
  }

  expect(withdrawn.body).toMatchObject({ status: "withdrawn" });
  expect(runs.every(({ status, body }) => status === 200 && !("/about/" in body.entries))).toBe(
    true,
  );
  expect(queries(fetchMock, "EntryByUri").map(([, init]) => init.body)).not.toContainEqual(
    expect.stringContaining('"uri":"/about/"'),
  );
  expect((await served("/about/")).status).toBe(404);
});

test("a reconciliation read in flight when a withdrawal is accepted doesn't bring the entry back", async () => {
  await prepare();
  edit("/about/", { content: "We make better things." });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reading!: () => void;
  const read = new Promise<void>((resolve) => {
    reading = resolve;
  });
  wordpress({
    entry: async (variables) => {
      const answer = entryAnswer(variables);
      if (variables.uri === "/about/") {
        reading();
        await released;
      }
      return answer;
    },
  });

  after(MINUTE);
  const running = cron();
  await read;
  after(1000);
  const withdrawn = await deliver(withdrawal("/about/", "page-64"));
  release();
  const run = await running;

  expect(withdrawn.body).toMatchObject({ status: "withdrawn" });
  expect(run.body.entries["/about/"]).toMatchObject({ change: "changed" });
  expect((await served("/about/")).status).toBe(404);
  after(MINUTE);
  await cron();
  expect((await served("/about/")).status).toBe(404);
});

test("a republication whose event was lost is public again once WordPress modified it after the withdrawal", async () => {
  await prepare();
  after(MINUTE);
  await deliver(withdrawal("/about/", "page-64"));
  after(MINUTE);
  edit("/about/", { content: "Back again." });

  const { took, runs } = await untilVisible(async () => (await served("/about/")).status === 200);

  expect(took!).toBeLessThanOrEqual(TARGET);
  expect(runs.at(-1)?.body.entries["/about/"]).toEqual({
    change: "republished",
    outcome: "refreshed",
  });
  expect((await served("/about/")).html).toContain("Back again.");
});

test("a run while another holds the lease reads nothing; an interrupted run's lease expires and its work is retried as the same change", async () => {
  await prepare();
  edit("/about/", { content: "We make better things." });
  // The Worker stops as it promotes the change: nothing after is written, not
  // the change's outcome nor the run's, and the run's lease is left held.
  let stopped = false;
  bind(db, {
    prepare(query) {
      if (stopped || query.includes("INSERT INTO publications")) {
        stopped = true;
        throw new Error("The Worker was stopped.");
      }
      return db.prepare(query);
    },
    batch: (statements) => db.batch(statements),
  });
  wordpress();
  after(MINUTE);
  const interrupted = await cron();
  restart();
  const fetchMock = wordpress();

  after(MINUTE);
  const overlapping = await cron();
  const readWhileHeld = fetchMock.mock.calls.length;
  after(MINUTE);
  const resumed = await cron();
  after(MINUTE);
  const repeated = await cron();

  expect(stopped).toBe(true);
  expect(interrupted.status).toBe(503);
  expect(overlapping).toMatchObject({ status: 200, body: { status: "busy" } });
  expect(readWhileHeld).toBe(0);
  expect(resumed.body).toMatchObject({
    status: "reconciled",
    entries: { "/about/": { outcome: "refreshed" } },
  });
  expect((await served("/about/")).html).toContain("We make better things.");
  expect(repeated.body).toMatchObject({ status: "reconciled", changed: 0 });
  expect(await publicationEvents()).toEqual([
    expect.objectContaining({ node_id: "page-64", status: "refreshed", attempts: 2 }),
  ]);
});

test("more changes than one run's budget are caught up over the next runs, each within Workers' subrequest limit", async () => {
  await prepare();
  const paths = Array.from({ length: 50 }, (_, index) => `/news-${index}/`);
  paths.forEach((path, index) =>
    publishWithoutEvent(path, `page-${100 + index}`, `Story ${index}.`),
  );

  const changedAt = Date.now();
  const requests: number[] = [];
  const statuses: string[] = [];
  let visible = false;
  while (!visible && Date.now() - changedAt < 10 * MINUTE) {
    after(MINUTE);
    const fetchMock = wordpress();
    const run = await cron();
    requests.push(fetchMock.mock.calls.length);
    statuses.push(run.body.status);
    visible = (await servedAll(paths)).every(({ status }) => status === 200);
  }

  expect(visible).toBe(true);
  expect(Date.now() - changedAt).toBeLessThanOrEqual(TARGET);
  expect(statuses).toEqual(["behind", "behind", "reconciled"]);
  expect(Math.max(...requests)).toBeLessThanOrEqual(40);
});

test("the report says when a run is behind, and the check shows how the last run went", async () => {
  await prepare();
  for (let index = 0; index < 30; index += 1) {
    publishWithoutEvent(`/news-${index}/`, `page-${100 + index}`, `Story ${index}.`);
  }
  wordpress();
  after(MINUTE);
  const behind = await cron();
  const checked = await deliver({
    site: SITE,
    id: randomUUID(),
    action: "check",
    occurredAt: Date.now(),
  });
  restart();
  wordpress();
  after(MINUTE);
  const caughtUp = await cron();
  const afterRestart = await deliver({
    site: SITE,
    id: randomUUID(),
    action: "check",
    occurredAt: Date.now(),
  });

  expect(behind).toMatchObject({ status: 200, body: { status: "behind", failed: 0 } });
  expect(behind.body.pending).toBeGreaterThan(0);
  expect(checked.body.reconciliation).toMatchObject({
    outcome: "behind",
    running: false,
    reconciledAt: null,
  });
  expect(caughtUp.body).toMatchObject({ status: "reconciled", pending: 0 });
  expect(afterRestart.body.reconciliation).toMatchObject({
    outcome: "reconciled",
    reconciledAt: caughtUp.body.startedAt,
  });
});

test("refused reconcile requests read nothing and change nothing", async () => {
  await prepare();
  edit("/about/", { content: "We make better things." });
  const fetchMock = wordpress();
  after(MINUTE);

  const unsigned = await endpoint("/gq/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ site: SITE, id: randomUUID(), action: "reconcile", occurredAt: 1 }),
  });
  const anotherKey = await deliver(
    { site: SITE, id: randomUUID(), action: "reconcile", occurredAt: Date.now() },
    "another-sites-event-signing-key-0123456789abcdef",
  );
  const anotherSite = await cron({ site: "another-site" });
  const malformed = await cron({ uris: ["/about/"] });
  bind(db, db, { PUBLICATION_EVENT_SECRET: undefined });
  const disabled = await cron();

  expect(
    [unsigned, anotherKey, anotherSite, malformed, disabled].map(({ status }) => status),
  ).toEqual([401, 401, 403, 400, 403]);
  expect(fetchMock).not.toHaveBeenCalled();
  expect((await served("/about/")).html).toContain("We make things.");
  const { results } = await db.prepare("SELECT * FROM reconciliation").all();
  expect(results).toEqual([]);
});

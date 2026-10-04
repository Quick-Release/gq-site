/// <reference types="node" />
// Retried deliveries through the rendered Frontend, on a controlled clock: the
// CMS retries an event the Frontend didn't confirm (its cms
// delivery-retries.php, on the server's cron) by sending the same event again,
// signed anew, minutes or hours after it happened. Until a retry succeeds,
// visitors keep the last good version; the retry that succeeds delivers the
// publication or the setting without another publish; work interrupted by a
// Worker restart is completed by the next retry; and a retry can't overwrite
// what a newer event already delivered.
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { SqlDatabase } from "./lib/publications";
import { openTestD1, type TestD1 } from "./test/sqlite-d1";
import { chrome, data, httpError, queries, routes, stubWordPress } from "./test/wordpress-stub";

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

// What WordPress publishes: the About page's body and the primary menu's label.
let about: string;
let menu: string;

const unreachable = () => Promise.reject(new TypeError("fetch failed"));
const presets = { colors: [], spacingSizes: [] };

function wordpress() {
  return stubWordPress({
    home: () =>
      data({
        generalSettings: { title: "Acme", description: "Things" },
        nodeByUri: { __typename: "Page", isFrontPage: true, title: "Home", content: "<h1>Hi</h1>" },
        designTokens: presets,
      }),
    entry: ({ uri }) =>
      data({
        postBy: null,
        pageBy:
          uri === "/about/"
            ? {
                id: "page-64",
                title: "About",
                content: `<p>${about}</p>`,
                uri: "/about/",
                status: "publish",
                isRestricted: false,
                featuredImage: null,
              }
            : null,
        designTokens: presets,
      }),
    chrome: () =>
      data({
        ...chrome,
        menuItems: {
          nodes: [{ id: "a", parentId: null, label: menu, url: "/about/", target: null }],
        },
      }),
    design: () => data({ designTokens: presets }),
    routes: () => routes("/", "/about/"),
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

function bind(database: TestD1, store: SqlDatabase = database) {
  db = database;
  runtime.env = {
    PUBLICATION_DB: store,
    FRONTEND_REFRESH_TOKEN: TOKEN,
    PUBLICATION_EVENT_SECRET: SECRET,
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
  about = "Version 1.";
  menu = "About us";
  directory = mkdtempSync(join(tmpdir(), "acme-retries-"));
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
  return { status: response.status, html: await response.text() };
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
async function deliver(event: unknown) {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex");
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

const publication = () => ({
  site: SITE,
  id: randomUUID(),
  action: "publish",
  occurredAt: Date.now(),
  entry: { id: "page-64", uri: "/about/" },
});

const menusChange = () => ({
  site: SITE,
  id: randomUUID(),
  action: "settings",
  occurredAt: Date.now(),
  setting: "menus",
});

/** Moves the clock on, as the CMS's retry delays pass. */
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

async function recordedEvents() {
  const { results } = await db
    .prepare("SELECT id, status, attempts, reason FROM publication_events ORDER BY received_at")
    .all();
  return results;
}

test("a publication whose refresh keeps failing is delivered by a later retry, hours on, without another publish", async () => {
  await prepare();
  about = "Version 2.";
  cmsDown();
  const event = publication();

  // The editor's publication, then the CMS's retries along its delays while
  // WordPress can't be read back.
  const attempts = [await deliver(event)];
  for (const delay of [1, 2, 5, 10, 30, 60, 60, 60]) {
    after(delay * MINUTE);
    attempts.push(await deliver(event));
  }
  const meanwhile = await visit("/about/");
  wordpress();
  after(60 * MINUTE);
  const recovered = await deliver(event);
  cmsDown();
  const visited = await visit("/about/");

  expect(attempts.map(({ status }) => status)).toEqual(Array(9).fill(503));
  expect(meanwhile.status).toBe(200);
  expect(meanwhile.html).toContain("Version 1.");
  expect(recovered).toMatchObject({ status: 200, body: { event: event.id, status: "refreshed" } });
  expect(visited.html).toContain("Version 2.");
  expect(await recordedEvents()).toEqual([
    { id: event.id, status: "refreshed", attempts: 10, reason: null },
  ]);
});

test("a settings change whose refresh failed is delivered to every page by a later retry", async () => {
  await prepare();
  menu = "Contact";
  const fetchMock = stubWordPress({ chrome: () => httpError(502) });
  const event = menusChange();

  const failed = await deliver(event);
  const meanwhile = await Promise.all(["/", "/about/"].map(visit));
  wordpress();
  after(5 * MINUTE);
  const retried = await deliver(event);
  cmsDown();
  const pages = await Promise.all(["/", "/about/"].map(visit));

  expect(failed.status).toBe(503);
  expect(queries(fetchMock, "SiteChrome")).toHaveLength(1);
  expect(meanwhile.every(({ html }) => html.includes(">About us</a>"))).toBe(true);
  expect(retried).toMatchObject({ status: 200, body: { status: "refreshed", setting: "menus" } });
  expect(pages.every(({ status, html }) => status === 200 && html.includes(">Contact</a>"))).toBe(
    true,
  );
});

test("work interrupted before its outcome was recorded is completed by the CMS's retry after a Worker restart", async () => {
  await prepare();
  about = "Version 2.";
  wordpress();
  // The Worker stops after the refresh, before recording how it went.
  let interrupted = false;
  bind(db, {
    prepare(query) {
      if (!interrupted && query.includes("SET status = ?2")) {
        interrupted = true;
        throw new Error("The Worker was stopped.");
      }
      return db.prepare(query);
    },
    batch: (statements) => db.batch(statements),
  });
  const event = publication();

  const first = await deliver(event);
  const left = await recordedEvents();
  restart();
  after(2 * MINUTE);
  const retried = await deliver(event);

  expect(first.status).toBe(503);
  expect(left).toEqual([{ id: event.id, status: "received", attempts: 1, reason: null }]);
  expect(retried).toMatchObject({ status: 200, body: { status: "refreshed" } });
  expect((await visit("/about/")).html).toContain("Version 2.");
  expect(await recordedEvents()).toEqual([
    { id: event.id, status: "refreshed", attempts: 2, reason: null },
  ]);
});

test("a retry of an older event, delivered after a newer one, reads nothing and can't overwrite it", async () => {
  await prepare();
  about = "Version 2.";
  cmsDown();
  const older = publication();
  await deliver(older);
  after(MINUTE);
  about = "Version 3.";
  wordpress();
  await deliver(publication());
  about = "Version 2.";
  const fetchMock = wordpress();

  after(MINUTE);
  const retried = await deliver(older);

  expect(retried.body).toEqual({ event: older.id, status: "superseded", duplicate: true });
  expect(fetchMock).not.toHaveBeenCalled();
  expect((await visit("/about/")).html).toContain("Version 3.");
});

test("a retry's signature is checked like any event's: a resent copy of an old signature is refused", async () => {
  await prepare();
  cmsDown();
  const event = publication();
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex");
  await deliver(event);

  wordpress();
  after(10 * MINUTE);
  const replayed = await endpoint("/gq/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "GQ-Event-Timestamp": String(timestamp),
      "GQ-Event-Signature": `v1=${signature}`,
    },
    body,
  });

  expect(replayed.status).toBe(401);
  expect(await recordedEvents()).toMatchObject([{ id: event.id, status: "failed", attempts: 1 }]);
});

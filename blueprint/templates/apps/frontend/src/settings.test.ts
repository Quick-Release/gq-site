/// <reference types="node" />
// Shared settings through the rendered Frontend: when an editor changes the
// menus, the logo, the site's identity (title, tagline, icon) or the design
// presets, the Site's CMS signs a "settings" event, POST /gq/events refreshes
// the shared rows every page is served with from a stubbed WordPress, and the
// homepage and every stored entry show the change, without reading or
// republishing the entries, and through a later outage. Failed, duplicate and
// delayed settings events never erase or roll back what is served.
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

/** What WordPress currently has for the shared settings, as an anonymous reader sees them. */
interface Settings {
  menu: string;
  logo: string;
  icon: string;
  title: string;
  tagline: string;
  color: string;
}

let settings: Settings;
const ENTRIES = ["/about/", "/2026/09/hello/"];

const unreachable = () => Promise.reject(new TypeError("fetch failed"));
const presets = () => ({ colors: [{ slug: "brand", color: settings.color }], spacingSizes: [] });

function entryAnswer({ uri }: Record<string, unknown>): Answer {
  const path = decodeURI(String(uri));
  const node = ENTRIES.includes(path) && {
    id: `page-${path.length}`,
    title: `Entry ${path}`,
    content: `<p class="has-brand-color">Body of ${path}</p>`,
    uri: path,
    status: "publish",
    isRestricted: false,
    featuredImage: null,
  };
  return data({ postBy: null, pageBy: node || null, designTokens: presets() });
}

const handlers = {
  home: () =>
    data({
      generalSettings: { title: settings.title, description: settings.tagline },
      nodeByUri: {
        __typename: "Page",
        isFrontPage: true,
        title: "",
        content: '<h1 class="has-brand-color">Welcome</h1>',
      },
      designTokens: presets(),
    }),
  entry: entryAnswer,
  chrome: () =>
    data({
      generalSettings: {
        siteIcon: { node: { sourceUrl: settings.icon, altText: "" } },
        siteLogo: { node: { sourceUrl: settings.logo, altText: "Acme" } },
      },
      menuItems: {
        nodes: [{ id: "a", parentId: null, label: settings.menu, url: "/about/", target: null }],
      },
    }),
  design: () => data({ designTokens: presets() }),
  routes: () => routes("/", ...ENTRIES),
} satisfies Record<string, Handler>;

// WordPress, up and answering from `settings`, unless a handler says otherwise.
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

let directory: string;
let db: TestD1;

function bind(database: TestD1) {
  db = database;
  runtime.env = {
    PUBLICATION_DB: database,
    FRONTEND_REFRESH_TOKEN: TOKEN,
    PUBLICATION_EVENT_SECRET: SECRET,
  };
}

beforeEach(() => {
  vi.stubEnv("DEV", false);
  settings = {
    menu: "About us",
    logo: "https://media.example/logo.svg",
    icon: "https://media.example/icon.png",
    title: "Acme",
    tagline: "Things",
    color: "#c00",
  };
  directory = mkdtempSync(join(tmpdir(), "acme-settings-"));
  bind(openTestD1(join(directory, "publications.sqlite")));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
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

/** The homepage and every stored entry, as visitors get them. */
const everyPage = () => Promise.all(["/", ...ENTRIES].map(visit));

async function endpoint(path: string, init: RequestInit) {
  const module = await import(path === "/gq/events" ? "./pages/gq/events" : "./pages/gq/refresh");
  const container = await AstroContainer.create();
  const response = await container.renderToResponse(module as never, {
    routeType: "endpoint",
    request: new Request(`https://acme.example${path}`, init),
  });
  return { status: response.status, body: await response.json() };
}

/** A shared setting's change, as the Site's CMS sends it. */
function change(setting: string, overrides: Record<string, unknown> = {}) {
  return {
    site: SITE,
    id: randomUUID(),
    action: "settings",
    occurredAt: Date.now(),
    setting,
    ...overrides,
  };
}

/** Delivers an event the way the CMS does: its body signed with the Site's event secret. */
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

async function prepare() {
  wordpress();
  const { status, body } = await endpoint("/gq/refresh", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: "{}",
  });
  expect(status).toBe(200);
  expect(body.design).toEqual({ outcome: "promoted", state: "published" });
}

async function recordedEvents() {
  const { results } = await db
    .prepare(
      "SELECT id, action, node_id, status, attempts, reason FROM publication_events ORDER BY received_at",
    )
    .all();
  return results;
}

async function storedRows() {
  const { results } = await db
    .prepare("SELECT key, state, body, read_started_at FROM publications ORDER BY key")
    .all();
  return results;
}

const menuLink = (label: string) => new RegExp(`<a href="/about/"[^>]*>${label}</a>`);
const brandColor = (color: string) => `--wp--preset--color--brand:${color}`;

/** Each setting: how an editor changes it, and how every affected page shows it. */
const cases: Array<
  [string, () => void, (page: string, html: string) => void, (page: string, html: string) => void]
> = [
  [
    "menus",
    () => (settings.menu = "Contact"),
    (_page, html) => {
      expect(html).toMatch(menuLink("Contact"));
      expect(html).not.toContain("About us");
    },
    (_page, html) => expect(html).toMatch(menuLink("About us")),
  ],
  [
    "logo",
    () => (settings.logo = "https://media.example/logo-2026.svg"),
    (_page, html) => expect(html).toContain('src="https://media.example/logo-2026.svg"'),
    (_page, html) => expect(html).toContain('src="https://media.example/logo.svg"'),
  ],
  [
    "identity",
    () => {
      settings.title = "Acme & Co";
      settings.tagline = "Better things";
      settings.icon = "https://media.example/icon-2026.png";
    },
    (page, html) => {
      expect(html).toContain('<link rel="icon" href="https://media.example/icon-2026.png">');
      // The title and tagline are the front page's; entries name themselves.
      if (page === "/") {
        expect(html).toContain("<title>Acme &amp; Co — {{Project}}</title>");
        expect(html).toContain('<meta name="description" content="Better things">');
      }
    },
    (page, html) => {
      expect(html).toContain('<link rel="icon" href="https://media.example/icon.png">');
      if (page === "/") expect(html).toContain('<meta name="description" content="Things">');
    },
  ],
  [
    "design",
    () => (settings.color = "#0a0"),
    (_page, html) => {
      expect(html).toContain(brandColor("#0a0"));
      expect(html).not.toContain(brandColor("#c00"));
    },
    (_page, html) => expect(html).toContain(brandColor("#c00")),
  ],
];

test.each(cases)(
  "a change to the %s reaches the homepage and every entry through its event, without reading the entries, and outlives an outage",
  async (setting, edit, shows) => {
    await prepare();
    edit();
    const fetchMock = wordpress();

    const event = change(setting);
    const { status, body } = await deliver(event);
    cmsDown();
    const pages = await everyPage();

    expect(status).toBe(200);
    expect(body).toMatchObject({ event: event.id, status: "refreshed", setting });
    expect(queries(fetchMock, "EntryByUri")).toHaveLength(0);
    expect(queries(fetchMock, "PublishedRoutes")).toHaveLength(0);
    ["/", ...ENTRIES].forEach((page, index) => {
      expect(pages[index]!.status).toBe(200);
      shows(page, pages[index]!.html);
    });
    expect(pages[1]!.html).toContain("Body of /about/");
    expect(await recordedEvents()).toEqual([
      {
        id: event.id,
        action: "settings",
        node_id: `setting:${setting}`,
        status: "refreshed",
        attempts: 1,
        reason: null,
      },
    ]);
  },
);

test.each(cases)(
  "a %s event during a CMS outage is recorded as failed, and every page keeps the previous settings",
  async (setting, edit, _shows, kept) => {
    await prepare();
    edit();
    cmsDown();

    const event = change(setting);
    const { status, body } = await deliver(event);
    const pages = await everyPage();

    expect(status).toBe(503);
    expect(body).toMatchObject({ event: event.id, status: "failed", setting });
    ["/", ...ENTRIES].forEach((page, index) => {
      expect(pages[index]!.status).toBe(200);
      kept(page, pages[index]!.html);
    });
    expect(await recordedEvents()).toMatchObject([
      { id: event.id, status: "failed", attempts: 1, reason: "network" },
    ]);
  },
);

test.each<[string, Handler, string]>([
  ["a timeout", timeout, "timeout"],
  ["an HTTP error", () => httpError(502), "http"],
  [
    "a GraphQL error next to partial data",
    () => ({
      ok: true,
      json: async () => ({ data: { designTokens: null }, errors: [{ message: "Internal" }] }),
    }),
    "graphql",
  ],
  ["missing design data", () => data({ designTokens: null }), "schema"],
  [
    "presets without their values",
    () => data({ designTokens: { colors: [{ slug: "brand" }], spacingSizes: [] } }),
    "schema",
  ],
])(
  "a design refresh failing on %s keeps the stored presets on every page",
  async (_case, design, reason) => {
    await prepare();
    settings.color = "#0a0";
    wordpress({ design });

    const { status, body } = await deliver(change("design"));
    const pages = await everyPage();

    expect(status).toBe(503);
    expect(body.design).toMatchObject({ outcome: "kept", failure: { reason } });
    for (const { status: pageStatus, html } of pages) {
      expect(pageStatus).toBe(200);
      expect(html).toContain(brandColor("#c00"));
    }
  },
);

test("a partly failed identity refresh keeps the stored menu, logo and icon, and its retry completes it", async () => {
  await prepare();
  settings.title = "Acme & Co";
  settings.icon = "https://media.example/icon-2026.png";
  wordpress({ chrome: () => httpError(503) });

  const event = change("identity");
  const failed = await deliver(event);
  const during = await everyPage();

  expect(failed.status).toBe(503);
  expect(failed.body).toMatchObject({
    status: "failed",
    home: { outcome: "promoted", state: "published" },
    chrome: { outcome: "kept", failure: { reason: "http" } },
  });
  // The title reached the homepage; the chrome everyone shares wasn't erased.
  expect(during[0]!.html).toContain("<title>Acme &amp; Co — {{Project}}</title>");
  for (const { html } of during) {
    expect(html).toContain('<link rel="icon" href="https://media.example/icon.png">');
    expect(html).toMatch(menuLink("About us"));
    expect(html).toContain('src="https://media.example/logo.svg"');
  }

  wordpress();
  const retried = await deliver(event);
  cmsDown();
  const after = await everyPage();

  expect(retried.status).toBe(200);
  expect(retried.body.status).toBe("refreshed");
  for (const { html } of after) {
    expect(html).toContain('<link rel="icon" href="https://media.example/icon-2026.png">');
  }
  expect(await recordedEvents()).toMatchObject([
    { id: event.id, status: "refreshed", attempts: 2, reason: null },
  ]);
});

test("a duplicate settings event is recognised and doesn't read the CMS again", async () => {
  await prepare();
  wordpress();
  const event = change("menus");
  await deliver(event);
  const fetchMock = wordpress();

  const { status, body } = await deliver(event);

  expect(status).toBe(200);
  expect(body).toEqual({ event: event.id, status: "refreshed", duplicate: true });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a delayed settings event older than a refreshed one for the same setting is superseded, and can't roll it back", async () => {
  await prepare();
  const older = change("menus", { occurredAt: Date.now() - 60_000 });
  settings.menu = "Contact";
  wordpress();
  const newer = change("menus");
  await deliver(newer);
  const before = await storedRows();
  // Even if WordPress answered with the old menu (a stale read), it isn't read.
  settings.menu = "About us";
  const fetchMock = wordpress();

  const { status, body } = await deliver(older);
  const pages = await everyPage();

  expect(status).toBe(200);
  expect(body).toEqual({ event: older.id, status: "superseded", by: newer.id });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await storedRows()).toEqual(before);
  for (const { html } of pages) expect(html).toMatch(menuLink("Contact"));
});

test("a newer refreshed settings event supersedes an older failed one, so its retry is skipped", async () => {
  await prepare();
  cmsDown();
  const older = change("design", { occurredAt: Date.now() - 60_000 });
  await deliver(older);
  settings.color = "#0a0";
  wordpress();
  await deliver(change("design"));
  const fetchMock = wordpress();

  const retried = await deliver(older);

  expect(retried.body).toEqual({ event: older.id, status: "superseded", duplicate: true });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("settings are ordered apart: a newer menus event doesn't supersede an older logo change", async () => {
  await prepare();
  const logo = change("logo", { occurredAt: Date.now() - 60_000 });
  wordpress();
  await deliver(change("menus"));
  settings.logo = "https://media.example/logo-2026.svg";
  wordpress();

  const { status, body } = await deliver(logo);
  const pages = await everyPage();

  expect(status).toBe(200);
  expect(body.status).toBe("refreshed");
  for (const { html } of pages) expect(html).toContain("logo-2026.svg");
});

test("a read that started before a newer promoted one never replaces it", async () => {
  await prepare();
  // A slow design read starts with the old presets; meanwhile a full refresh
  // stores the new ones.
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  const stale = data({ designTokens: presets() });
  wordpress({ design: () => gate.then(() => stale) });
  const slow = deliver(change("design"));
  await vi.waitFor(() =>
    expect(queries(globalThis.fetch as never, "DesignPresets")).toHaveLength(1),
  );
  settings.color = "#0a0";
  wordpress();
  await endpoint("/gq/refresh", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: "{}",
  });
  release();

  const { body } = await slow;
  const pages = await everyPage();

  expect(body.design).toEqual({ outcome: "superseded", state: "published" });
  for (const { html } of pages) expect(html).toContain(brandColor("#0a0"));
});

test("an entry published after a design change is served with the shared presets", async () => {
  await prepare();
  settings.color = "#0a0";
  wordpress();
  await deliver(change("design"));
  // The entry's own read carries older presets (a lagging read of it).
  wordpress({
    entry: (variables) => {
      const answer = entryAnswer(variables);
      return answer.ok
        ? {
            ok: true,
            json: async () => {
              const body = (await answer.json()) as { data: Record<string, unknown> };
              body.data.designTokens = {
                colors: [{ slug: "brand", color: "#c00" }],
                spacingSizes: [],
              };
              return body;
            },
          }
        : answer;
    },
  });
  await deliver({
    site: SITE,
    id: randomUUID(),
    action: "publish",
    occurredAt: Date.now(),
    entry: { id: "page-7", uri: "/about/" },
  });
  cmsDown();

  const about = await visit("/about/");

  expect(about.html).toContain(brandColor("#0a0"));
});

test("a Site prepared before the shared presets were stored serves each page's own, until a design change stores them", async () => {
  await prepare();
  db.exec("DELETE FROM publications WHERE key = 'design'");
  cmsDown();
  const before = await everyPage();
  settings.color = "#0a0";
  wordpress();
  await deliver(change("design"));
  cmsDown();
  const after = await everyPage();

  for (const { status, html } of before) {
    expect(status).toBe(200);
    expect(html).toContain(brandColor("#c00"));
  }
  for (const { html } of after) expect(html).toContain(brandColor("#0a0"));
});

test("shared presets this Frontend can't read leave each page with its own", async () => {
  await prepare();
  db.exec("UPDATE publications SET format = 99, body = '{}' WHERE key = 'design'");
  cmsDown();

  const pages = await everyPage();

  for (const { status, html } of pages) {
    expect(status).toBe(200);
    expect(html).toContain(brandColor("#c00"));
  }
});

test.each<[string, () => unknown]>([
  ["an unsupported setting", () => change("widgets")],
  ["no setting", () => change("menus", { setting: undefined })],
  ["the setting's content", () => change("menus", { menu: [{ label: "Injected" }] })],
])("a settings event with %s is rejected and changes nothing", async (_case, event) => {
  await prepare();
  const before = await storedRows();
  const fetchMock = wordpress();

  const { status, body } = await deliver(event());

  expect(status).toBe(400);
  expect(typeof body.error).toBe("string");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await storedRows()).toEqual(before);
  expect(await recordedEvents()).toEqual([]);
});

test("a settings event signed with another key is refused and changes nothing", async () => {
  await prepare();
  const before = await storedRows();
  settings.menu = "Injected";
  const fetchMock = wordpress();
  const body = JSON.stringify(change("menus"));
  const timestamp = Math.floor(Date.now() / 1000);

  const { status } = await endpoint("/gq/events", {
    method: "POST",
    headers: {
      "GQ-Event-Timestamp": String(timestamp),
      "GQ-Event-Signature": `v1=${createHmac("sha256", "x".repeat(40)).update(`${timestamp}.${body}`).digest("hex")}`,
    },
    body,
  });

  expect(status).toBe(401);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await storedRows()).toEqual(before);
});

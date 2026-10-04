/// <reference types="node" />
// A bilingual Site (gq.ops.json's wordpress.languages) kept current per
// language: the CMS's signed events name the language a change is in, so a
// publication refreshes only its own entry or its language's home, and a
// shared setting only its language's rows, unless it is shared by every
// language (the logo, the icon, the design, the site's own title). A
// whole-Site refresh is ready only once every language's home and chrome are
// stored; the signed check reports each language's rows; and reconciliation
// reads every language's shared rows within its subrequest budget, catching
// up a change in any language whose event was lost.
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { openTestD1, type TestD1 } from "./test/sqlite-d1";
import {
  data,
  gmt,
  listing,
  queries,
  stubWordPress,
  type Answer,
  type Handler,
} from "./test/wordpress-stub";

vi.mock("../../../gq.ops.json", () => ({
  default: {
    schemaVersion: 1,
    project: "acme",
    variant: "content",
    wordpress: {
      plugins: ["wp-graphql", "polylang-pro", "gq-polylang-graphql"],
      locale: "pt_PT_ao90",
      languages: [{ locale: "en_US", slug: "en" }],
    },
  },
}));

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

type Language = "PT" | "EN";

interface Entry {
  id: string;
  title: string;
  content: string;
  language: Language;
  /** Its published translation, if it has one. */
  translation?: string;
  /** When WordPress last modified it (ms, to the second). */
  modified: number;
}

/** A language's own settings: its front page, title, tagline and menu. */
interface Front {
  id: string;
  heading: string;
  title: string;
  tagline: string;
  menu: string;
}

/** What WordPress publishes, as an anonymous reader gets it. */
interface WordPress {
  entries: Map<string, Entry>;
  fronts: Record<Language, Front>;
  logo: string;
  color: string;
}

let cms: WordPress;

const now = () => Math.floor(Date.now() / 1000) * 1000;
const presets = () => ({ colors: [{ slug: "brand", color: cms.color }], spacingSizes: [] });
const unreachable = () => Promise.reject(new TypeError("fetch failed"));

function entryAnswer({ uri }: Record<string, unknown>): Answer {
  const path = decodeURI(String(uri));
  const entry = cms.entries.get(path);
  const translation = entry?.translation ? cms.entries.get(entry.translation) : undefined;
  return data({
    postBy: null,
    pageBy: entry
      ? {
          id: entry.id,
          title: entry.title,
          content: `<p>${entry.content}</p>`,
          uri: path,
          status: "publish",
          isRestricted: false,
          modifiedGmt: gmt(entry.modified),
          featuredImage: null,
          language: { slug: entry.language.toLowerCase() },
          translations: translation
            ? [{ uri: entry.translation, language: { slug: translation.language.toLowerCase() } }]
            : [],
        }
      : null,
    designTokens: presets(),
  });
}

const handlers = {
  home: (variables) => {
    const language = (variables.language as Language | undefined) ?? "PT";
    const front = cms.fronts[language];
    const node = {
      __typename: "Page",
      id: front.id,
      isFrontPage: true,
      title: language === "PT" ? "Início" : "Home",
      content: `<h1>${front.heading}</h1>`,
    };
    // The default language's front page is read as a monolingual Site's is.
    return variables.language
      ? data({
          language: { title: front.title, description: front.tagline },
          nodeByUri: node,
          designTokens: presets(),
        })
      : data({
          generalSettings: { title: front.title, description: front.tagline },
          nodeByUri: node,
          designTokens: presets(),
        });
  },
  chrome: (variables) => {
    const language = (variables.language as Language | undefined) ?? "PT";
    return data({
      generalSettings: {
        siteIcon: null,
        siteLogo: { node: { sourceUrl: cms.logo, altText: "Acme" } },
      },
      menuItems: {
        nodes: [
          {
            id: `menu-${language}`,
            parentId: null,
            label: cms.fronts[language].menu,
            url: language === "PT" ? "/sobre/" : "/en/about/",
            target: null,
          },
        ],
      },
    });
  },
  entry: entryAnswer,
  design: () => data({ designTokens: presets() }),
  routes: () =>
    listing(
      { uri: "/", id: cms.fronts.PT.id, modifiedGmt: gmt(Date.parse("2026-09-01T00:00:00Z")) },
      { uri: "/en/", id: cms.fronts.EN.id, modifiedGmt: gmt(Date.parse("2026-09-01T00:00:00Z")) },
      ...[...cms.entries].map(([uri, entry]) => ({
        uri,
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

/** The variables of each query of this name WordPress was sent. */
const variablesOf = (fetchMock: ReturnType<typeof stubWordPress>, name: string) =>
  queries(fetchMock, name).map(([, init]) => JSON.parse(init.body as string).variables);

let directory: string;
let db: TestD1;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-02T09:00:00Z"));
  vi.stubEnv("DEV", false);
  const modified = Date.parse("2026-09-15T08:00:00Z");
  cms = {
    entries: new Map([
      [
        "/sobre/",
        {
          id: "p1",
          title: "Sobre",
          content: "Fazemos coisas.",
          language: "PT",
          translation: "/en/about/",
          modified,
        },
      ],
      [
        "/en/about/",
        {
          id: "p2",
          title: "About",
          content: "We make things.",
          language: "EN",
          translation: "/sobre/",
          modified,
        },
      ],
    ]),
    fronts: {
      PT: {
        id: "front-PT",
        heading: "Bem-vindo",
        title: "Acme PT",
        tagline: "Coisas",
        menu: "Sobre nós",
      },
      EN: {
        id: "front-EN",
        heading: "Welcome",
        title: "Acme EN",
        tagline: "Things",
        menu: "About us",
      },
    },
    logo: "https://media.example/logo.svg",
    color: "#c00",
  };
  directory = mkdtempSync(join(tmpdir(), "acme-language-updates-"));
  db = openTestD1(join(directory, "publications.sqlite"));
  runtime.env = {
    PUBLICATION_DB: db,
    FRONTEND_REFRESH_TOKEN: TOKEN,
    PUBLICATION_EVENT_SECRET: SECRET,
  };
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
    params: path === "/" ? {} : { slug: path.replace(/^\/|\/$/g, "") },
    partial: false,
  });
  return { status: response.status, html: await response.text() };
}

/** What visitors get with WordPress unreachable: only the store. */
async function served(path: string) {
  cmsDown();
  try {
    return await visit(path);
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

const refresh = () =>
  endpoint("/gq/refresh", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: "{}",
  });

/** Delivers an event the way the CMS does: its body signed with the Site's event secret. */
async function deliver(event: Record<string, unknown>) {
  const body = JSON.stringify({ site: SITE, id: randomUUID(), occurredAt: Date.now(), ...event });
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
  const { status } = await refresh();
  expect(status).toBe(200);
}

/** When each stored row was last read, by key: a row a later change left alone keeps its time. */
async function readTimes() {
  const { results } = await db
    .prepare("SELECT key, read_started_at FROM publications ORDER BY key")
    .all<{ key: string; read_started_at: number }>();
  return Object.fromEntries(results.map((row) => [row.key, row.read_started_at]));
}

/** The keys whose rows were read again since `before`. */
async function reread(before: Record<string, number>) {
  const after = await readTimes();
  return Object.keys(after).filter((key) => after[key] !== before[key]);
}

/** Moves the clock on. */
const later = () => vi.setSystemTime(Date.now() + MINUTE);

describe("publication events in each language", () => {
  test("publishing an English page refreshes only its /en/… entry", async () => {
    await prepare();
    const before = await readTimes();
    later();
    cms.entries.set("/en/about/", {
      ...cms.entries.get("/en/about/")!,
      content: "We make better things.",
      modified: now(),
    });
    const fetchMock = wordpress();

    const { status, body } = await deliver({
      action: "publish",
      entry: { id: "p2", uri: "/en/about/", language: "en" },
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "refreshed",
      entries: { "/en/about/": { outcome: "promoted", state: "published" } },
    });
    expect(body.home).toBeUndefined();
    expect(body.languages).toBeUndefined();
    expect(variablesOf(fetchMock, "EntryByUri")).toEqual([{ uri: "/en/about/" }]);
    expect(queries(fetchMock, "HomePage")).toEqual([]);
    expect(await reread(before)).toEqual(["entry:/en/about/"]);
    expect((await served("/en/about/")).html).toContain("We make better things.");
  });

  test("publishing the English front page refreshes home:en", async () => {
    await prepare();
    const before = await readTimes();
    later();
    cms.fronts.EN.heading = "Welcome back";
    const fetchMock = wordpress();

    const { status, body } = await deliver({
      action: "publish",
      entry: { id: "front-EN", uri: "/en/", language: "en" },
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "refreshed",
      languages: { en: { home: { outcome: "promoted", state: "published" } } },
      entries: {},
    });
    expect(body.home).toBeUndefined();
    expect(variablesOf(fetchMock, "HomePage")).toEqual([{ uri: "/en/", language: "EN" }]);
    expect(queries(fetchMock, "EntryByUri")).toEqual([]);
    expect(await reread(before)).toEqual(["home:en"]);
    expect((await served("/en/")).html).toContain("Welcome back");
    expect((await served("/")).html).toContain("Bem-vindo");
  });

  test("publishing the Portuguese front page refreshes only home, as a monolingual Site's does", async () => {
    await prepare();
    const before = await readTimes();
    later();
    const fetchMock = wordpress();

    const { body } = await deliver({
      action: "publish",
      entry: { id: "front-PT", uri: "/", language: "pt" },
    });

    expect(body).toMatchObject({ status: "refreshed", home: { outcome: "promoted" } });
    expect(variablesOf(fetchMock, "HomePage")).toEqual([{}]);
    expect(await reread(before)).toEqual(["home"]);
  });

  test("withdrawing the English front page withdraws home:en only", async () => {
    await prepare();

    const { status, body } = await deliver({
      action: "withdraw",
      entry: { id: "front-EN", uri: "/en/", language: "en" },
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "withdrawn", withdrawn: ["/en/"] });
    expect((await served("/en/")).status).toBe(404);
    expect((await served("/")).status).toBe(200);
  });

  test("an entry whose language isn't its URI's is refused, and nothing is read", async () => {
    await prepare();
    const fetchMock = wordpress();

    const english = await deliver({
      action: "publish",
      entry: { id: "p1", uri: "/sobre/", language: "en" },
    });
    const unknown = await deliver({
      action: "publish",
      entry: { id: "p9", uri: "/fr/a-propos/", language: "fr" },
    });

    expect(english).toMatchObject({ status: 400 });
    expect(english.body.error).toMatch(/entry\.language en isn't the language of \/sobre\/ \(pt\)/);
    expect(unknown).toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("settings events in each language", () => {
  test("reassigning the English primary menu refreshes only chrome:en", async () => {
    await prepare();
    const before = await readTimes();
    later();
    cms.fronts.EN.menu = "Who we are";
    const fetchMock = wordpress();

    const { status, body } = await deliver({
      action: "settings",
      setting: "menus",
      language: "en",
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "refreshed",
      setting: "menus",
      language: "en",
      languages: { en: { chrome: { outcome: "promoted", state: "published" } } },
    });
    expect(body.chrome).toBeUndefined();
    expect(variablesOf(fetchMock, "SiteChrome")).toEqual([{ location: "PRIMARY", language: "EN" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await reread(before)).toEqual(["chrome:en"]);
    expect((await served("/en/about/")).html).toMatch(
      /<a href="\/en\/about\/"[^>]*>Who we are<\/a>/,
    );
    expect((await served("/sobre/")).html).toMatch(/<a href="\/sobre\/"[^>]*>Sobre nós<\/a>/);
  });

  test("changing the English tagline refreshes only home:en", async () => {
    await prepare();
    const before = await readTimes();
    later();
    cms.fronts.EN.tagline = "Better things";
    const fetchMock = wordpress();

    const { status, body } = await deliver({
      action: "settings",
      setting: "identity",
      language: "en",
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "refreshed",
      languages: { en: { home: { outcome: "promoted", state: "published" } } },
    });
    expect(variablesOf(fetchMock, "HomePage")).toEqual([{ uri: "/en/", language: "EN" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await reread(before)).toEqual(["home:en"]);
    expect((await served("/en/")).html).toContain(
      '<meta name="description" content="Better things">',
    );
    expect((await served("/")).html).toContain('<meta name="description" content="Coisas">');
  });

  test("changing the logo refreshes every language's chrome", async () => {
    await prepare();
    const before = await readTimes();
    later();
    cms.logo = "https://media.example/logo-2026.svg";
    const fetchMock = wordpress();

    const { status, body } = await deliver({ action: "settings", setting: "logo" });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "refreshed",
      chrome: { outcome: "promoted" },
      languages: { en: { chrome: { outcome: "promoted" } } },
    });
    expect(variablesOf(fetchMock, "SiteChrome")).toEqual([
      { location: "PRIMARY" },
      { location: "PRIMARY", language: "EN" },
    ]);
    expect((await reread(before)).sort()).toEqual(["chrome", "chrome:en"]);
    for (const path of ["/", "/en/", "/sobre/", "/en/about/"]) {
      expect((await served(path)).html).toContain('src="https://media.example/logo-2026.svg"');
    }
  });

  test("a change to the site's own title refreshes every language's home and chrome", async () => {
    await prepare();
    const before = await readTimes();
    later();
    wordpress();

    const { body } = await deliver({ action: "settings", setting: "identity" });

    expect(body).toMatchObject({ status: "refreshed" });
    expect((await reread(before)).sort()).toEqual(["chrome", "chrome:en", "home", "home:en"]);
  });

  test("a menu change in the default language refreshes only its chrome", async () => {
    await prepare();
    const before = await readTimes();
    later();
    const fetchMock = wordpress();

    const { body } = await deliver({ action: "settings", setting: "menus", language: "pt" });

    expect(body).toMatchObject({ status: "refreshed", chrome: { outcome: "promoted" } });
    expect(body.languages).toBeUndefined();
    expect(variablesOf(fetchMock, "SiteChrome")).toEqual([{ location: "PRIMARY" }]);
    expect(await reread(before)).toEqual(["chrome"]);
  });

  test("a failed English menu read is recorded failed and keeps the stored English menu", async () => {
    await prepare();
    later();
    cms.fronts.EN.menu = "Who we are";
    wordpress({ chrome: unreachable });

    const { status, body } = await deliver({
      action: "settings",
      setting: "menus",
      language: "en",
    });

    expect(status).toBe(503);
    expect(body).toMatchObject({
      status: "failed",
      languages: { en: { chrome: { outcome: "kept", failure: { reason: "network" } } } },
    });
    expect((await served("/en/about/")).html).toMatch(/>About us<\/a>/);
  });

  test("a language the Site doesn't serve, or one a shared setting can't have, is refused", async () => {
    await prepare();
    const fetchMock = wordpress();

    const unknown = await deliver({ action: "settings", setting: "menus", language: "fr" });
    const logo = await deliver({ action: "settings", setting: "logo", language: "en" });

    expect(unknown).toMatchObject({ status: 400 });
    expect(logo).toMatchObject({ status: 400 });
    expect(logo.body.error).toMatch(/logo is shared by every language/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("each language's settings are ordered apart: an older English menu event isn't superseded by a newer Portuguese one", async () => {
    await prepare();
    later();
    wordpress();
    const occurredAt = Date.now();
    await deliver({ action: "settings", setting: "menus", language: "pt", occurredAt });

    const { body } = await deliver({
      action: "settings",
      setting: "menus",
      language: "en",
      occurredAt: occurredAt - 1000,
    });

    expect(body).toMatchObject({ status: "refreshed" });
  });
});

describe("the whole-Site refresh and the check", () => {
  test("the refresh is ready only once every language's home and chrome are stored", async () => {
    wordpress({
      chrome: (variables) => (variables.language ? unreachable() : handlers.chrome(variables)),
    });
    const first = await refresh();
    wordpress();
    const second = await refresh();

    expect(first).toMatchObject({
      status: 503,
      body: {
        ready: false,
        refreshed: false,
        languages: { en: { chrome: { outcome: "kept" } } },
      },
    });
    expect(second).toMatchObject({ status: 200, body: { ready: true, refreshed: true } });
  });

  test("a targeted refresh of a language's home is refused: it is refreshed with the whole Site", async () => {
    const fetchMock = wordpress();

    const { status, body } = await endpoint("/gq/refresh", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ uris: ["/en/"] }),
    });

    expect(status).toBe(400);
    expect(body.error).toBe("/en/ is the en front page: refresh the whole Site for it.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("the signed check reports each language's home and chrome", async () => {
    wordpress({
      home: (variables) => (variables.language ? unreachable() : handlers.home(variables)),
    });
    await refresh();

    const { body } = await deliver({ action: "check" });

    expect(body.store).toMatchObject({
      home: "published",
      chrome: "published",
      languages: { en: { home: null, chrome: "published" } },
    });
  });
});

describe("reconciliation in each language", () => {
  const cron = () => deliver({ action: "reconcile" });

  test("a run reads every language's front page and chrome, and the entries of every language", async () => {
    await prepare();
    later();
    const fetchMock = wordpress();

    const { body } = await cron();

    expect(body).toMatchObject({
      status: "reconciled",
      shared: {
        home: { outcome: "unchanged" },
        chrome: { outcome: "unchanged" },
        design: { outcome: "unchanged" },
        languages: { en: { home: { outcome: "unchanged" }, chrome: { outcome: "unchanged" } } },
      },
    });
    expect(variablesOf(fetchMock, "HomePage")).toEqual([{}, { uri: "/en/", language: "EN" }]);
    expect(variablesOf(fetchMock, "SiteChrome")).toEqual([
      { location: "PRIMARY" },
      { location: "PRIMARY", language: "EN" },
    ]);
    // Every language's entries, not only the default's.
    const [routes] = queries(fetchMock, "PublishedRoutes");
    expect(JSON.parse(routes![1].body as string).query).toContain("language: ALL");
  });

  test("a missed English change, to a page and to the tagline, is restored at the next run", async () => {
    await prepare();
    later();
    cms.entries.set("/en/about/", {
      ...cms.entries.get("/en/about/")!,
      content: "We make better things.",
      modified: now(),
    });
    cms.fronts.EN.tagline = "Better things";
    cms.fronts.EN.menu = "Who we are";
    later();
    wordpress();

    const { body } = await cron();

    expect(body).toMatchObject({
      status: "reconciled",
      shared: {
        home: { outcome: "unchanged" },
        chrome: { outcome: "unchanged" },
        languages: { en: { home: { outcome: "promoted" }, chrome: { outcome: "promoted" } } },
      },
      entries: { "/en/about/": { change: "changed", outcome: "refreshed" } },
    });
    expect((await served("/en/about/")).html).toContain("We make better things.");
    expect((await served("/en/about/")).html).toMatch(/>Who we are<\/a>/);
    expect((await served("/en/")).html).toContain(
      '<meta name="description" content="Better things">',
    );
  });

  test("with two languages a run stays within its budget, catching up fewer entries per run", async () => {
    await prepare();
    later();
    for (let index = 0; index < 40; index += 1) {
      cms.entries.set(`/en/news-${index}/`, {
        id: `page-${100 + index}`,
        title: `News ${index}`,
        content: `Story ${index}.`,
        language: "EN",
        modified: now(),
      });
    }

    const runs = [];
    for (let run = 0; run < 3; run += 1) {
      later();
      const fetchMock = wordpress();
      const { body } = await cron();
      runs.push({ requests: fetchMock.mock.calls.length, body });
    }

    // 40 requests: the 5 shared reads (the design, then each language's home
    // and chrome), the list, and 2 per entry read: 17 entries a run, where a
    // monolingual Site's 3 shared reads leave room for 18.
    expect(runs.map(({ body }) => [body.status, body.changed, body.pending])).toEqual([
      ["behind", 17, 23],
      ["behind", 17, 6],
      ["reconciled", 6, 0],
    ]);
    expect(Math.max(...runs.map(({ requests }) => requests))).toBeLessThanOrEqual(40);
    expect((await served("/en/news-39/")).status).toBe(200);
  });
});

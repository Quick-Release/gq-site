/// <reference types="node" />
// A bilingual Site (gq.ops.json's wordpress.languages), rendered through
// Astro's Container API: a trusted refresh reads each language's front page,
// title, tagline and menu, and every entry with its language and
// translations, from a stubbed WordPress (as GQ Polylang for WPGraphQL
// answers) into the publication store, and visitors get each page in its
// language, linked to its published translations, without any fallback
// across languages.
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { openTestD1, type TestD1 } from "./test/sqlite-d1";
import { data, queries, routes, stubWordPress, tokens, type Handler } from "./test/wordpress-stub";

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

const TOKEN = "acme-refresh-token-0123456789abcdef0123456789";

type Language = "PT" | "EN";

const page = (
  id: string,
  title: string,
  uri: string,
  language: Language,
  translations: Array<[string, Language]> = [],
) => ({
  id,
  title,
  content: `<p>${title}.</p>`,
  uri,
  status: "publish",
  isRestricted: false,
  featuredImage: null,
  language: { slug: language.toLowerCase() },
  translations: translations.map(([uri, code]) => ({
    uri,
    language: { slug: code.toLowerCase() },
  })),
});

// The pages WordPress has published, by URI: About in both languages, and a
// page in English only.
const pages: Record<string, ReturnType<typeof page>> = {
  "/sobre/": page("p1", "Sobre", "/sobre/", "PT", [["/en/about/", "EN"]]),
  "/en/about/": page("p2", "About", "/en/about/", "EN", [["/sobre/", "PT"]]),
  "/en/english-only/": page("p3", "English only", "/en/english-only/", "EN"),
};

// Each language's front page, title and tagline.
const fronts: Record<Language, { title: string; description: string; heading: string }> = {
  PT: { title: "Acme PT", description: "Coisas", heading: "Bem-vindo à Acme" },
  EN: { title: "Acme EN", description: "Things", heading: "Welcome to Acme" },
};

const home: Handler = (variables) => {
  const language = (variables.language as Language | undefined) ?? "PT";
  const front = fronts[language];
  const node = {
    __typename: "Page",
    id: `front-${language}`,
    isFrontPage: true,
    title: language === "PT" ? "Início" : "Home",
    content: `<h1>${front.heading}</h1>`,
  };
  // The default language's front page is read as a monolingual Site's is.
  return variables.language
    ? data({
        language: { title: front.title, description: front.description },
        nodeByUri: node,
        designTokens: tokens,
      })
    : data({
        generalSettings: { title: front.title, description: front.description },
        nodeByUri: node,
        designTokens: tokens,
      });
};

const chrome: Handler = (variables) => {
  const english = variables.language === "EN";
  return data({
    generalSettings: { siteIcon: null, siteLogo: null },
    menuItems: {
      nodes: [
        {
          id: english ? "m-en" : "m-pt",
          parentId: null,
          label: english ? "About us" : "Sobre nós",
          url: english ? "/en/about/" : "/sobre/",
          target: null,
        },
      ],
    },
  });
};

const entry: Handler = (variables) =>
  data({ postBy: null, pageBy: pages[variables.uri as string] ?? null, designTokens: tokens });

function wordpress(handlers: Parameters<typeof stubWordPress>[0] = {}) {
  return stubWordPress({
    home,
    chrome,
    entry,
    routes: () => routes("/", "/en/", ...Object.keys(pages)),
    ...handlers,
  });
}

let directory: string;
let db: TestD1;

beforeEach(() => {
  vi.stubEnv("DEV", false);
  directory = mkdtempSync(join(tmpdir(), "acme-languages-"));
  db = openTestD1(join(directory, "publications.sqlite"));
  runtime.env = { PUBLICATION_DB: db, FRONTEND_REFRESH_TOKEN: TOKEN };
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
  const container = await AstroContainer.create();
  const { default: Page } =
    path === "/" ? await import("./pages/index.astro") : await import("./pages/[...slug].astro");
  const response = await container.renderToResponse(Page, {
    request: new Request(new URL(path, "https://acme.example")),
    params: path === "/" ? {} : { slug: path.replace(/^\/|\/$/g, "") },
    partial: false,
  });
  return { status: response.status, html: await response.text() };
}

async function refresh(body?: unknown) {
  const endpoint = await import("./pages/gq/refresh");
  const container = await AstroContainer.create();
  const response = await container.renderToResponse(endpoint as never, {
    routeType: "endpoint",
    request: new Request("https://acme.example/gq/refresh", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  });
  return { status: response.status, report: await response.json() };
}

async function prepare(handlers: Parameters<typeof stubWordPress>[0] = {}) {
  wordpress(handlers);
  const { status, report } = await refresh();
  expect(status).toBe(200);
  return report;
}

// What a visit serves once WordPress is down: only the store.
function cmsDown() {
  return stubWordPress({
    home: () => Promise.reject(new TypeError("fetch failed")),
    chrome: () => Promise.reject(new TypeError("fetch failed")),
    entry: () => Promise.reject(new TypeError("fetch failed")),
  });
}

const alternates = (html: string) =>
  [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map(
    ([, hreflang, href]) => `${hreflang} ${href}`,
  );

const switcher = (html: string) =>
  /<nav class="language-switcher"[^>]*>(.*?)<\/nav>/s.exec(html)?.[1] ?? null;

describe("each language's home", () => {
  test("/ and /en/ are each language's home, with its title, menu and <html lang>", async () => {
    await prepare();
    const fetchMock = cmsDown();

    const pt = await visit("/");
    const en = await visit("/en/");

    expect(pt.status).toBe(200);
    expect(pt.html).toContain('<html lang="pt-PT">');
    expect(pt.html).toContain("Bem-vindo à Acme");
    expect(pt.html).toContain("<title>Início — {{Project}}</title>");
    expect(pt.html).toContain('<meta name="description" content="Coisas">');
    expect(pt.html).toMatch(/<a href="\/sobre\/"[^>]*>Sobre nós<\/a>/);
    expect(pt.html).toMatch(/<a href="\/" class="site-header__home"/);

    expect(en.status).toBe(200);
    expect(en.html).toContain('<html lang="en-US">');
    expect(en.html).toContain("Welcome to Acme");
    expect(en.html).toContain("<title>Home — {{Project}}</title>");
    expect(en.html).toContain('<meta name="description" content="Things">');
    expect(en.html).toMatch(/<a href="\/en\/about\/"[^>]*>About us<\/a>/);
    expect(en.html).not.toContain("Sobre nós");
    expect(en.html).toMatch(/<a href="\/en\/" class="site-header__home"/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("each home links to the other with hreflang alternates and the language switcher", async () => {
    await prepare();
    cmsDown();

    const pt = await visit("/");
    const en = await visit("/en/");

    const both = [
      "pt-PT https://acme.example/",
      "en-US https://acme.example/en/",
      "x-default https://acme.example/",
    ];
    expect(alternates(pt.html)).toEqual(both);
    expect(alternates(en.html)).toEqual(both);
    expect(switcher(pt.html)).toMatch(
      /<a href="\/en\/" hreflang="en-US" lang="en-US"[^>]*>EN<\/a>/,
    );
    expect(switcher(en.html)).toMatch(/<a href="\/" hreflang="pt-PT" lang="pt-PT"[^>]*>PT<\/a>/);
  });

  test("the refresh reads each language's front page, title, tagline and menu", async () => {
    const fetchMock = wordpress();

    const { report } = await refresh();

    expect(report).toMatchObject({
      ready: true,
      refreshed: true,
      languages: {
        en: {
          home: { outcome: "promoted", state: "published" },
          chrome: { outcome: "promoted", state: "published" },
        },
      },
    });
    expect(
      queries(fetchMock, "HomePage").map(([, init]) => JSON.parse(init.body as string).variables),
    ).toEqual(expect.arrayContaining([{ uri: "/en/", language: "EN" }]));
    expect(
      queries(fetchMock, "SiteChrome").map(([, init]) => JSON.parse(init.body as string).variables),
    ).toEqual([{ location: "PRIMARY" }, { location: "PRIMARY", language: "EN" }]);
    // The front pages are homes, never entries.
    expect(report.entries["/en/"]).toBeUndefined();
  });

  test("a language whose home was never stored is a 404, its pages too", async () => {
    // The first refresh couldn't read the English front page.
    wordpress({
      home: (variables) =>
        variables.language ? Promise.reject(new TypeError("fetch failed")) : home(variables),
    });
    await refresh();
    cmsDown();

    expect((await visit("/en/")).status).toBe(404);
    expect((await visit("/en/about/")).status).toBe(404);
    // Nor is it offered as a translation.
    const sobre = await visit("/sobre/");
    expect(sobre.status).toBe(200);
    expect(alternates(sobre.html)).toEqual([]);
    expect(switcher(sobre.html)).toBeNull();
  });
});

describe("entries in each language", () => {
  test("/sobre/ and /en/about/ render in their language, with hreflang alternates to each other", async () => {
    await prepare();
    cmsDown();

    const sobre = await visit("/sobre/");
    const about = await visit("/en/about/");

    expect(sobre.status).toBe(200);
    expect(sobre.html).toContain('<html lang="pt-PT">');
    expect(sobre.html).toContain("<title>Sobre — {{Project}}</title>");
    expect(sobre.html).toMatch(/<a href="\/sobre\/"[^>]*>Sobre nós<\/a>/);
    expect(about.status).toBe(200);
    expect(about.html).toContain('<html lang="en-US">');
    expect(about.html).toContain("<title>About — {{Project}}</title>");
    expect(about.html).toMatch(/<a href="\/en\/about\/"[^>]*>About us<\/a>/);
    expect(about.html).toMatch(/<a href="\/en\/" class="site-header__home"/);

    const both = [
      "pt-PT https://acme.example/sobre/",
      "en-US https://acme.example/en/about/",
      "x-default https://acme.example/sobre/",
    ];
    expect(alternates(sobre.html)).toEqual(both);
    expect(alternates(about.html)).toEqual(both);
    expect(switcher(sobre.html)).toMatch(/<a href="\/en\/about\/" hreflang="en-US"[^>]*>EN<\/a>/);
    expect(switcher(about.html)).toMatch(/<a href="\/sobre\/" hreflang="pt-PT"[^>]*>PT<\/a>/);
  });

  test("an English page without a Portuguese translation has no Portuguese alternate", async () => {
    await prepare();
    cmsDown();

    const { status, html } = await visit("/en/english-only/");

    expect(status).toBe(200);
    expect(alternates(html)).toEqual([]);
    expect(html).not.toContain('hreflang="x-default"');
    // The switcher offers the Portuguese home instead.
    expect(switcher(html)).toMatch(/<a href="\/" hreflang="pt-PT"[^>]*>PT<\/a>/);
  });

  test("/en/sobre/ is a 404 in English: no fallback across languages", async () => {
    await prepare();
    cmsDown();
    // Even a WordPress that would resolve it to the Portuguese page.
    wordpress({
      entry: (variables) =>
        data({
          postBy: null,
          pageBy: variables.uri === "/en/sobre/" ? pages["/sobre/"] : null,
          designTokens: tokens,
        }),
    });

    const { status, html } = await visit("/en/sobre/");

    expect(status).toBe(404);
    expect(html).toContain('<html lang="en-US">');
    expect(html).toContain("Nothing here.");
    expect(html).toMatch(/<a href="\/en\/"[^>]*>Back to the front page<\/a>/);
    expect(html).not.toContain("Sobre.");
  });

  test("a Portuguese 404 is in Portuguese", async () => {
    await prepare();
    wordpress({ entry: () => data({ postBy: null, pageBy: null, designTokens: tokens }) });

    const { status, html } = await visit("/nada/");

    expect(status).toBe(404);
    expect(html).toContain('<html lang="pt-PT">');
    expect(html).toContain("<title>Página não encontrada — {{Project}}</title>");
    expect(html).toContain("Nada aqui.");
    expect(html).toMatch(/<a href="\/"[^>]*>Voltar à página inicial<\/a>/);
  });

  test("an English page the store never held is looked up and served in English", async () => {
    await prepare({ routes: () => routes("/", "/en/", "/sobre/") });

    const { status, html } = await visit("/en/about/");

    expect(status).toBe(200);
    expect(html).toContain('<html lang="en-US">');
    expect(alternates(html)).toContain("pt-PT https://acme.example/sobre/");
  });

  test("an entry stored before the Site listed its languages is the default language's", async () => {
    await prepare();
    // As a monolingual Site's refresh stored it: without a language or translations.
    db.exec(
      `UPDATE publications SET body = json_remove(body, '$.language', '$.translations')
       WHERE key = 'entry:/sobre/'`,
    );
    cmsDown();

    const { status, html } = await visit("/sobre/");

    expect(status).toBe(200);
    expect(html).toContain('<html lang="pt-PT">');
    expect(html).toContain("<title>Sobre — {{Project}}</title>");
    expect(alternates(html)).toEqual([]);
  });

  test("a withdrawn translation is no longer an alternate", async () => {
    await prepare();
    const { publicationStore } = await import("./lib/publications");
    const { withdrawEntry } = await import("./lib/delivery");
    await withdrawEntry(publicationStore(db), {
      id: "withdraw-p2",
      action: "withdraw",
      nodeId: "p2",
      uri: "/en/about/",
      previousUri: null,
      occurredAt: Date.now(),
    });
    cmsDown();

    const sobre = await visit("/sobre/");

    expect((await visit("/en/about/")).status).toBe(404);
    expect(alternates(sobre.html)).toEqual([]);
    expect(switcher(sobre.html)).toMatch(/<a href="\/en\/" hreflang="en-US"[^>]*>EN<\/a>/);
  });
});

describe("promotion and withdrawal per language", () => {
  test("a route that resolves to the English front page moves to /en/", async () => {
    await prepare();
    wordpress({
      entry: (variables) =>
        data({
          postBy: null,
          pageBy:
            variables.uri === "/en/home/"
              ? { ...page("front-EN", "Home", "/en/", "EN"), content: "<h1>Welcome to Acme</h1>" }
              : null,
          designTokens: tokens,
        }),
    });

    const { report } = await refresh({ uris: ["/en/home/"] });
    cmsDown();

    expect(report.entries["/en/home/"]).toEqual({
      outcome: "promoted",
      state: "moved",
      uri: "/en/",
    });
    const moved = await visit("/en/home/");
    expect(moved.status).toBe(301);
  });

  test("withdrawing the English front page withdraws only the English home", async () => {
    await prepare();
    const { publicationStore } = await import("./lib/publications");
    const { withdrawEntry } = await import("./lib/delivery");

    const report = await withdrawEntry(publicationStore(db), {
      id: "withdraw-front-en",
      action: "withdraw",
      nodeId: "front-EN",
      uri: "/en/",
      previousUri: null,
      occurredAt: Date.now(),
    });
    cmsDown();

    expect(report).toEqual({ status: "withdrawn", withdrawn: ["/en/"] });
    expect((await visit("/en/")).status).toBe(404);
    expect((await visit("/")).status).toBe(200);
  });
});

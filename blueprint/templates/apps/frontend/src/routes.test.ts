// The public routes, rendered through Astro's Container API against a stubbed
// WordPress: the page a visitor gets, and its HTTP status, when content is
// published, confirmed missing, or WordPress fails. Delivery itself (the
// publication store, events, refresh, retries) is @getquick/content's and is
// tested there; these test what this Site composes from what it delivers:
// the pages, their words, metadata and chrome.
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { designGridStyle } from "@getquick/content";
import { scanConsentHtml } from "@getquick/content/consent/testing";
import Entry from "./pages/[...slug].astro";
import Home from "./pages/index.astro";
import {
  chrome,
  consentSettings,
  data,
  httpError,
  queries,
  stubWordPress,
  timeout,
  tokens,
} from "./test/wordpress-stub";

// The monolingual Site this file describes: the site's gq.ops.json without
// wordpress.languages.
vi.mock("../../../gq.ops.json", async (importOriginal) => {
  const { default: ops } = await importOriginal<{
    default: { wordpress: { languages?: unknown } };
  }>();
  const { languages: _languages, ...wordpress } = ops.wordpress;
  return { default: { ...ops, wordpress } };
});

const about = {
  id: "64",
  title: "About",
  content: "<p>We make things.</p>",
  uri: "/about/",
  status: "publish",
  isRestricted: false,
  featuredImage: null,
};

const frontPage = {
  __typename: "Page",
  isFrontPage: true,
  title: "Home",
  content: "<h1>Welcome to Acme</h1>",
};

async function render(path: string) {
  const container = await AstroContainer.create();
  const page = path === "/" ? Home : Entry;
  const slug = path.replace(/^\/|\/$/g, "");
  const response = await container.renderToResponse(page, {
    request: new Request(new URL(path, "https://acme.example")),
    params: path === "/" ? {} : { slug },
    partial: false,
  });
  return { status: response.status, html: await response.text() };
}

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // A production build: local development's placeholder is the exception.
  vi.stubEnv("DEV", false);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("entries read live in local development", () => {
  beforeEach(() => {
    vi.stubEnv("DEV", true);
  });

  test("a published entry renders with the site chrome", async () => {
    stubWordPress({ entry: () => data({ postBy: null, pageBy: about, designTokens: tokens }) });

    const { status, html } = await render("/about/");

    expect(status).toBe(200);
    expect(html).toContain("<title>About — {{Project}}</title>");
    expect(html).toContain("<p>We make things.</p>");
    expect(html).toMatch(/<a href="\/about\/"[^>]*>About us<\/a>/);
    expect(html).toContain('src="https://media.example/logo.svg"');
  });

  test("the header and footer GQ Design selects replace the site's own", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const block = (name: string, content: string | null) => ({
      name,
      attributes: {},
      content,
      children: [],
    });
    const fetchMock = stubWordPress({
      entry: () => data({ postBy: null, pageBy: about, designTokens: tokens }),
      chrome: () =>
        data({
          ...chrome,
          header: {
            title: "Main header",
            blocksJson: JSON.stringify([
              block("core/paragraph", '<p class="brand">Acme header</p>'),
              block("acme/navigation", null),
            ]),
          },
          footer: {
            title: "Main footer",
            blocksJson: JSON.stringify([block("core/paragraph", "<p>© Acme</p>")]),
          },
        }),
    });

    const { status, html } = await render("/about/");

    expect(status).toBe(200);
    const header = /<header\b[^>]*>([\s\S]*?)<\/header>/.exec(html)?.[1] ?? "";
    expect(header).toContain('<p class="brand">Acme header</p>');
    expect(header).not.toContain("About us");
    expect(header).not.toContain("logo.svg");
    // One shared stylesheet covers selected chrome and page content alike.
    const gridCss = designGridStyle();
    const head = /<head\b[^>]*>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? "";
    expect(head).toContain(gridCss);
    expect(html.split(gridCss)).toHaveLength(2);
    expect(/<footer\b[^>]*>([\s\S]*?)<\/footer>/.exec(html)?.[1]).toContain("<p>© Acme</p>");
    // A Site block renders only through the Site's renderer.
    expect(warn).toHaveBeenCalledWith("No renderer for acme/navigation");
    expect(
      JSON.parse(queries(fetchMock, "SiteChrome")[0]![1].body as string).variables,
    ).toMatchObject({ template: "page" });
  });

  test("an entry WordPress confirms isn't published is a 404", async () => {
    stubWordPress({ entry: () => data({ postBy: null, pageBy: null, designTokens: tokens }) });

    const { status, html } = await render("/gone/");

    expect(status).toBe(404);
    expect(html).toContain("Nothing here.");
    expect(consoleError).not.toHaveBeenCalled();
  });

  test("an entry request that times out is a 503, and isn't retried", async () => {
    const fetchMock = stubWordPress({ entry: timeout });

    const { status, html } = await render("/about/");

    expect(status).toBe(503);
    expect(html).toContain("Temporarily unavailable.");
    expect(html).not.toContain("Nothing here.");
    expect(queries(fetchMock, "EntryByUri")).toHaveLength(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("/about/ is unavailable (timeout)"),
    );
  });

  test("a published entry is still served when the site chrome can't be read", async () => {
    stubWordPress({
      entry: () => data({ postBy: null, pageBy: about, designTokens: tokens }),
      chrome: () => httpError(500),
    });

    const { status, html } = await render("/about/");

    expect(status).toBe(200);
    expect(html).toContain("<p>We make things.</p>");
    expect(html).not.toContain("About us");
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("site chrome is unavailable (http)"),
    );
  });

  test("an optional featured image left empty doesn't fail an entry", async () => {
    stubWordPress({
      entry: () =>
        data({
          postBy: {
            ...about,
            featuredImage: { node: null },
            excerpt: null,
            date: "2026-09-30T10:00:00",
          },
          pageBy: null,
          designTokens: tokens,
        }),
    });

    const { status, html } = await render("/about/");

    expect(status).toBe(200);
    expect(html).toContain("September 30, 2026");
    expect(html).not.toContain("featured-image");
  });
});

test("a built Frontend without a publication store is a 503 for an entry, and reads no CMS", async () => {
  const fetchMock = stubWordPress({
    entry: () => data({ postBy: null, pageBy: about, designTokens: tokens }),
  });

  const { status, html } = await render("/about/");

  expect(status).toBe(503);
  expect(html).toContain("Temporarily unavailable.");
  expect(html).not.toContain("We make things.");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining("entry /about/ can't be served (not-ready)"),
  );
});

test("a built Frontend without a publication store is a 503 for the front page, and reads no CMS", async () => {
  const fetchMock = stubWordPress({
    home: () =>
      data({
        generalSettings: { title: "Acme", description: "" },
        nodeByUri: frontPage,
        designTokens: tokens,
      }),
  });

  const { status, html } = await render("/");

  expect(status).toBe(503);
  expect(html).toContain("Temporarily unavailable.");
  expect(html).not.toContain("Welcome to Acme");
  expect(html).not.toContain("Content is on its way.");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining("front page can't be served (not-ready)"),
  );
});

test("local development renders WordPress's front page live", async () => {
  vi.stubEnv("DEV", true);
  stubWordPress({
    home: () =>
      data({
        generalSettings: { title: "Acme", description: "Things" },
        nodeByUri: frontPage,
        designTokens: tokens,
      }),
  });

  const { status, html } = await render("/");

  expect(status).toBe(200);
  expect(html).toContain("<h1>Welcome to Acme</h1>");
  expect(html).toContain('<meta name="description" content="Things">');
  expect(html).toMatch(/<a href="\/about\/"[^>]*>About us<\/a>/);
});

test("local development without a CMS still shows the friendly placeholder", async () => {
  vi.stubEnv("DEV", true);
  stubWordPress({
    home: () => Promise.reject(new TypeError("fetch failed")),
    chrome: () => Promise.reject(new TypeError("fetch failed")),
  });

  const { status, html } = await render("/");

  expect(status).toBe(200);
  expect(html).toContain("Content is on its way.");
});

test("local development with no front page set is a 404 that says how to set one", async () => {
  vi.stubEnv("DEV", true);
  stubWordPress({
    home: () =>
      data({
        generalSettings: { title: "Acme", description: "" },
        nodeByUri: { ...frontPage, isFrontPage: false },
        designTokens: tokens,
      }),
  });

  const { status, html } = await render("/");

  expect(status).toBe(404);
  expect(html).toContain("The front page is almost ready.");
});

// CONSENT-1 and LEGAL-1: the consent Runtime's UI, composed by the layout from
// @getquick/content/consent/astro, on every page. What the UI does (the
// banner, the decisions, the records) is the Runtime's, tested in gq-content
// and by its shared acceptance suite in a browser.
describe("the consent UI", () => {
  const youtube =
    '<figure class="wp-block-embed is-provider-youtube"><div class="wp-block-embed__wrapper"><iframe title="Video" width="560" height="315" src="https://www.youtube.com/embed/abcdefghijk?feature=oembed" allowfullscreen></iframe></div></figure>';

  beforeEach(() => {
    vi.stubEnv("DEV", true);
  });

  /** The page's footer: the legal links and the Cookie settings control. */
  function footer(html: string) {
    return /<footer\b[^>]*>([\s\S]*?)<\/footer>/.exec(html)?.[1] ?? "";
  }

  test("every page carries the Runtime's configuration, the legal links and Cookie settings", async () => {
    stubWordPress({
      home: () =>
        data({
          generalSettings: { title: "Acme", description: "" },
          nodeByUri: frontPage,
          designTokens: tokens,
        }),
      entry: () => data({ postBy: null, pageBy: about, designTokens: tokens }),
    });

    for (const path of ["/", "/about/", "/gone/"]) {
      const { html } = await render(path);

      expect(html, path).toMatch(/<script type="application\/json" id="gq-consent-config">/);
      expect(footer(html), path).toMatch(
        /<a href="\/privacy\/" data-gq-legal-role="privacy_policy">Privacy policy<\/a>/,
      );
      expect(footer(html), path).toMatch(
        /<a href="\/cookies\/" data-gq-legal-role="cookie_policy">Cookie policy<\/a>/,
      );
      // "Cookie settings", in the page's language.
      expect(footer(html), path).toMatch(/<button[^>]*data-gq-consent-open[^>]*>[^<]+</);
      expect(html, path).toMatch(/<dialog id="gq-consent-preferences"/);
    }
  });

  test("a published YouTube embed is served without its live source", async () => {
    stubWordPress({
      entry: () =>
        data({
          postBy: null,
          pageBy: { ...about, content: `<p>We make things.</p>${youtube}` },
          designTokens: tokens,
        }),
    });

    const { status, html } = await render("/about/");

    expect(status).toBe(200);
    expect(html).toContain("<p>We make things.</p>");
    const scan = scanConsentHtml(html, {
      siteOrigin: "https://acme.example",
      firstPartyHosts: ["media.example"],
    });
    expect(scan.liveThirdParty).toEqual([]);
    // No catalog service is declared yet, so the embed stays blocked.
    expect(scan.blocked).toEqual([{ host: "www.youtube.com", tag: "iframe" }]);
  });

  test("with no optional service there is no banner, and Cookie settings stays", async () => {
    stubWordPress({ entry: () => data({ postBy: null, pageBy: about, designTokens: tokens }) });

    const { html } = await render("/about/");

    expect(html).not.toContain('id="gq-consent-banner"');
    expect(footer(html)).toContain("data-gq-consent-open");
  });

  test("GA4 switched on in GQ Config asks first, in a banner before the page", async () => {
    stubWordPress({
      entry: () => data({ postBy: null, pageBy: about, designTokens: tokens }),
      consent: () => consentSettings({ enabled: true, measurementId: "G-TEST1234" }),
    });

    const { html } = await render("/about/");

    const banner = /<section id="gq-consent-banner"[^>]*>/.exec(html)?.[0];
    expect(banner).toBeDefined();
    expect(banner).not.toContain("hidden");
    expect(html.indexOf('id="gq-consent-banner"')).toBeLessThan(html.indexOf("<header"));
    expect(html).toContain('"services":["consent","ga4"]');
    // The tag itself loads only after a grant, from the Runtime's client.
    expect(html).not.toContain("googletagmanager.com");
  });
});

// The public routes, rendered through Astro's Container API against a stubbed
// WordPress: what a visitor gets, and which HTTP status, when content is
// published, confirmed missing, or WordPress fails. These are the live reads
// of local development (`astro dev`, no publication store) and of an entry's
// cold lookup; the deployed Frontend serves from its store (homepage.test.ts,
// entries.test.ts).
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import Entry from "./pages/[...slug].astro";
import Home from "./pages/index.astro";
import {
  data,
  httpError,
  queries,
  stubWordPress,
  timeout,
  tokens,
  type Answer,
} from "./test/wordpress-stub";

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

  test.each([
    ["a WordPress HTTP error", () => httpError(403)],
    [
      "a GraphQL error",
      () =>
        ({
          ok: true,
          json: async () => ({ errors: [{ message: "Internal server error" }] }),
        }) as Answer,
    ],
    [
      "a GraphQL error next to partial data",
      () =>
        ({
          ok: true,
          json: async () => ({
            data: { postBy: null, pageBy: null, designTokens: tokens },
            errors: [{ message: "Cannot return null for designTokens" }],
          }),
        }) as Answer,
    ],
    ["an unreachable WordPress", () => Promise.reject(new TypeError("fetch failed"))],
    [
      "an answer that isn't JSON",
      () => ({ ok: true, json: async () => JSON.parse("<html>") }) as Answer,
    ],
    ["missing design tokens", () => data({ postBy: null, pageBy: null, designTokens: null })],
    [
      "an entry without its required id",
      () => data({ postBy: null, pageBy: { ...about, id: undefined }, designTokens: tokens }),
    ],
    ["no postBy field at all", () => data({ pageBy: null, designTokens: tokens })],
  ])("%s is a 503 for an entry, not a 404", async (_case, entry) => {
    stubWordPress({ entry });

    const { status, html } = await render("/about/");

    expect(status).toBe(503);
    expect(html).not.toContain("Nothing here.");
  });

  test("an entry whose blocks WordPress fails to return still renders, without them", async () => {
    const fetchMock = stubWordPress({
      entry: ({ withBlocks }) =>
        withBlocks === false
          ? data({ postBy: null, pageBy: about, designTokens: tokens })
          : httpError(502),
    });

    const { status, html } = await render("/about/");

    expect(status).toBe(200);
    expect(html).toContain("<p>We make things.</p>");
    expect(queries(fetchMock, "EntryByUri")).toHaveLength(2);
  });

  test("an entry whose recovery without blocks fails too is a 503, not a 404", async () => {
    const fetchMock = stubWordPress({
      entry: ({ withBlocks }) => (withBlocks === false ? timeout() : httpError(502)),
    });

    const { status, html } = await render("/about/");

    expect(status).toBe(503);
    expect(html).not.toContain("Nothing here.");
    expect(queries(fetchMock, "EntryByUri")).toHaveLength(2);
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

// The front page's CMS failures, refresh and outages are in homepage.test.ts:
// a built Frontend serves it from the publication store only.
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

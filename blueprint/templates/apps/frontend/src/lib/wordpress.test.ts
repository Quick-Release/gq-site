import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { getEntryByUri, getHomeContent, getPublishedRoutes, getSiteChrome } from "./wordpress";

// The monolingual Site this file describes: the site's gq.ops.json without
// wordpress.languages. languages.test.ts and language-updates.test.ts cover
// the bilingual Site.
vi.mock("../../../../gq.ops.json", async (importOriginal) => {
  const { default: ops } = await importOriginal<{
    default: { wordpress: { languages?: unknown } };
  }>();
  const { languages: _languages, ...wordpress } = ops.wordpress;
  return { default: { ...ops, wordpress } };
});

test("home content comes from the page marked as the WordPress front page", async () => {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(init.body as string) as { query: string };
    expect(request.query).toContain('nodeByUri(uri: "/")');
    expect(request.query).toContain("isFrontPage");
    expect(request.query).toContain(
      "blocks(attributes: true, htmlContent: true, dynamicContent: true, postTemplate: false)",
    );
    expect(request.query).not.toContain("posts(first: 6)");

    return {
      ok: true,
      json: async () => ({
        data: {
          generalSettings: { title: "Acme", description: "Description" },
          nodeByUri: {
            __typename: "Page",
            isFrontPage: true,
            title: "Home",
            content: '<div class="wp-block-group"><h1>Welcome</h1></div>',
          },
          designTokens: {
            colors: [{ slug: "accent", color: "#e7472e" }],
            spacingSizes: [{ slug: "md", size: "2rem" }],
          },
        },
      }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);

  expect(await getHomeContent()).toMatchObject({
    kind: "found",
    content: {
      settings: { title: "Acme", description: "Description" },
      page: {
        title: "Home",
        content: '<div class="wp-block-group"><h1>Welcome</h1></div>',
      },
      blocksOmitted: false,
      spacingSizes: [{ slug: "md", size: "2rem" }],
      colors: [{ slug: "accent", color: "#e7472e" }],
    },
  });
  expect(fetchMock).toHaveBeenCalledOnce();
});

test("renders a homepage Video Hero from its structured GraphQL attributes", async () => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      data: {
        generalSettings: { title: "Acme", description: "Description" },
        nodeByUri: {
          __typename: "Page",
          isFrontPage: true,
          title: "Home",
          content: "<section>Saved block HTML</section>",
          blocks: JSON.stringify([
            {
              name: "getquick-design/video-hero",
              attributes: {
                videoType: "youtube",
                videoId: 0,
                videoUrl: "https://youtu.be/abcdefghijk",
                posterId: 0,
                posterUrl: "",
              },
              htmlContent: '<section class="wp-block-getquick-design-video-hero"></section>',
              innerBlocks: [
                {
                  name: "core/heading",
                  attributes: { level: 1 },
                  htmlContent: "<h1>Welcome</h1>",
                  innerBlocks: [],
                },
              ],
            },
          ]),
        },
        designTokens: { colors: [], spacingSizes: [] },
      },
    }),
  }));
  vi.stubGlobal("fetch", fetchMock);

  const result = await getHomeContent();
  if (result.kind !== "found") throw new Error(`expected the front page, got ${result.kind}`);

  expect(result.content.page.hasVideoHero).toBe(true);
  expect(result.content.page.content).toContain("youtube-nocookie.com/embed/abcdefghijk");
  expect(result.content.page.content).toContain("playlist=abcdefghijk");
  expect(result.content.page.content).toContain("<h1>Welcome</h1>");
  expect(result.content.page.content).not.toContain("Saved block HTML");
});

test("the front page is missing unless WordPress marks a page as the front page", async () => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      data: {
        generalSettings: { title: "Acme", description: "" },
        nodeByUri: {
          __typename: "Page",
          isFrontPage: false,
          title: "Not the homepage",
          content: "<p>Other page</p>",
        },
        designTokens: { colors: [], spacingSizes: [] },
      },
    }),
  }));
  vi.stubGlobal("fetch", fetchMock);

  expect(await getHomeContent()).toEqual({ kind: "missing" });
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("page content includes the CMS spacing presets, including numeric and overridden slugs", async () => {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(init.body as string) as {
      query: string;
      variables: { uri: string };
    };
    expect(request.query).toContain("query EntryByUri($uri: String!, $withBlocks: Boolean = true)");
    expect(request.query).toContain("spacingSizes");
    expect(request.query).toContain("colors");
    expect(request.variables.uri).toBe("/sample-page/");

    return {
      ok: true,
      json: async () => ({
        data: {
          postBy: null,
          pageBy: {
            id: "1",
            title: "Sample Page",
            content: "<p>Content</p>",
            uri: "/sample-page/",
            status: "publish",
            isRestricted: false,
            featuredImage: null,
          },
          designTokens: {
            colors: [{ slug: "accent", color: "#2563eb" }],
            spacingSizes: [
              { slug: "20", size: "0.44rem" },
              { slug: "md", size: "2rem" },
            ],
          },
        },
      }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);

  expect(await getEntryByUri("/sample-page/")).toMatchObject({
    kind: "found",
    content: {
      title: "Sample Page",
      date: "",
      excerpt: "",
      blocksOmitted: false,
      spacingSizes: [
        { slug: "20", size: "0.44rem" },
        { slug: "md", size: "2rem" },
      ],
      colors: [{ slug: "accent", color: "#2563eb" }],
    },
  });
  expect(fetchMock).toHaveBeenCalledOnce();
});

test("an entry whose blocks WordPress fails to return still loads, without them", async () => {
  // The CMS can answer a 502 for one page's block attributes.
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(init.body as string) as {
      variables: { withBlocks?: boolean };
    };
    if (request.variables.withBlocks !== false) return { ok: false, status: 502 };

    return {
      ok: true,
      json: async () => ({
        data: {
          postBy: null,
          pageBy: {
            id: "64",
            title: "About",
            content: "<p>Content</p>",
            uri: "/about/",
            status: "publish",
            isRestricted: false,
            featuredImage: null,
          },
          designTokens: { colors: [], spacingSizes: [] },
        },
      }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);

  expect(await getEntryByUri("/about/")).toMatchObject({
    kind: "found",
    content: {
      title: "About",
      content: "<p>Content</p>",
      hasVideoHero: false,
      blocksOmitted: true,
    },
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("an entry request that times out is unavailable, and isn't retried", async () => {
  const fetchMock = vi.fn(async () => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  });
  vi.stubGlobal("fetch", fetchMock);

  expect(await getEntryByUri("/about/")).toMatchObject({
    kind: "unavailable",
    failure: { reason: "timeout" },
  });
  expect(fetchMock).toHaveBeenCalledOnce();
});

test("HTTP errors, GraphQL errors, missing required fields and absent content stay distinct", async () => {
  const answers: Record<string, unknown> = {
    "/http/": { ok: false, status: 404 },
    "/graphql/": { ok: true, json: async () => ({ errors: [{ message: "Syntax Error" }] }) },
    "/schema/": {
      ok: true,
      json: async () => ({ data: { postBy: null, pageBy: { id: "1" }, designTokens: null } }),
    },
    "/absent/": {
      ok: true,
      json: async () => ({
        data: { postBy: null, pageBy: null, designTokens: { colors: [], spacingSizes: [] } },
      }),
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const { variables } = JSON.parse(init.body as string) as { variables: { uri: string } };
      return answers[variables.uri];
    }),
  );

  expect(await getEntryByUri("/http/")).toEqual({
    kind: "unavailable",
    failure: { reason: "http", httpStatus: 404, message: "WordPress responded with HTTP 404" },
  });
  expect(await getEntryByUri("/graphql/")).toEqual({
    kind: "unavailable",
    failure: { reason: "graphql", message: "Syntax Error" },
  });
  const schema = await getEntryByUri("/schema/");
  expect(schema).toMatchObject({ kind: "unavailable", failure: { reason: "schema" } });
  if (schema.kind === "unavailable") {
    expect(schema.failure.message).toContain("pageBy.title");
    expect(schema.failure.message).toContain("designTokens");
  }
  expect(await getEntryByUri("/absent/")).toEqual({ kind: "missing" });
});

test.each([
  ["password-protected", { status: "publish", isRestricted: true, content: null }],
  ["not published", { status: "draft", isRestricted: false }],
  ["without a status", { status: null, isRestricted: null }],
])(
  "an entry WordPress returns %s is missing: only public content is served",
  async (_case, fields) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: {
            postBy: {
              id: "9",
              title: "Members",
              excerpt: null,
              content: "<p>Secret</p>",
              uri: "/members/",
              date: null,
              featuredImage: null,
              ...fields,
            },
            pageBy: null,
            designTokens: { colors: [], spacingSizes: [] },
          },
        }),
      })),
    );

    expect(await getEntryByUri("/members/")).toEqual({ kind: "missing" });
  },
);

test("the published routes are read page by page, and any failed page fails the list", async () => {
  const pages: Record<string, unknown> = {
    first: { hasNextPage: true, endCursor: "c1", nodes: [{ uri: "/about/" }, { uri: null }] },
    c1: { hasNextPage: false, endCursor: null, nodes: [{ uri: "/2026/hello/" }] },
  };
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(init.body as string) as {
      query: string;
      variables: { after: string | null };
    };
    expect(request.query).toContain("contentTypes: [PAGE, POST]");
    const { nodes, ...pageInfo } = pages[request.variables.after ?? "first"] as {
      nodes: unknown[];
    };
    return { ok: true, json: async () => ({ data: { contentNodes: { pageInfo, nodes } } }) };
  });
  vi.stubGlobal("fetch", fetchMock);

  expect(await getPublishedRoutes()).toEqual({
    kind: "found",
    content: ["/about/", "/2026/hello/"],
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);

  pages.c1 = undefined;
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const { variables } = JSON.parse(init.body as string) as {
      variables: { after: string | null };
    };
    if (variables.after) return { ok: false, status: 500 } as never;
    const { nodes, ...pageInfo } = pages.first as { nodes: unknown[] };
    return { ok: true, json: async () => ({ data: { contentNodes: { pageInfo, nodes } } }) };
  });
  expect(await getPublishedRoutes()).toMatchObject({
    kind: "unavailable",
    failure: { reason: "http" },
  });
});

test("absolute URIs from WordPress become paths, keeping their percent-encoding and trailing slash", async () => {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const { query } = JSON.parse(init.body as string) as { query: string };
    const data = query.includes("contentNodes")
      ? {
          contentNodes: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              { uri: "/" },
              { uri: "https://acme-fe.example/team/" },
              { uri: "https://acme-fe.example/caf%c3%a9/" },
              { uri: "https://acme-fe.example/2026/hello" },
              { uri: "/about/" },
            ],
          },
        }
      : {
          postBy: null,
          pageBy: {
            id: "page-30",
            title: "Café",
            content: "<p>Coffee.</p>",
            uri: "https://acme-fe.example/caf%c3%a9/",
            status: "publish",
            isRestricted: false,
            featuredImage: null,
          },
          designTokens: { colors: [], spacingSizes: [] },
        };
    return { ok: true, json: async () => ({ data }) };
  });
  vi.stubGlobal("fetch", fetchMock);

  expect(await getPublishedRoutes()).toEqual({
    kind: "found",
    content: ["/", "/team/", "/caf%c3%a9/", "/2026/hello", "/about/"],
  });
  expect(await getEntryByUri("/caf%c3%a9/")).toMatchObject({
    kind: "found",
    content: { uri: "/caf%c3%a9/" },
  });
});

test("the front page's blocks are recovered like an entry's, and a failed recovery stays unavailable", async () => {
  const frontPage = {
    data: {
      generalSettings: { title: "Acme", description: "" },
      nodeByUri: { __typename: "Page", isFrontPage: true, title: "Home", content: "<p>Hi</p>" },
      designTokens: { colors: [], spacingSizes: [] },
    },
  };
  let retry: () => unknown = () => ({ ok: true, json: async () => frontPage });
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(init.body as string) as {
      query: string;
      variables?: { withBlocks?: boolean };
    };
    expect(request.query).toContain("query HomePage($withBlocks: Boolean = true)");
    return request.variables?.withBlocks === false ? retry() : { ok: false, status: 502 };
  });
  vi.stubGlobal("fetch", fetchMock);

  expect(await getHomeContent()).toMatchObject({
    kind: "found",
    content: { page: { content: "<p>Hi</p>" }, blocksOmitted: true },
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);

  retry = () => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  };
  expect(await getHomeContent()).toMatchObject({
    kind: "unavailable",
    failure: { reason: "timeout", message: expect.stringContaining("HTTP 502; without blocks") },
  });
});

test("site chrome includes the WordPress favicon, logo and primary menu", async () => {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(init.body as string) as {
      query: string;
      variables: Record<string, string>;
    };
    expect(request.query).toContain("siteIcon");
    expect(request.query).toContain("siteLogo");
    expect(request.query).toContain("menuItems(where: { location: $location }");
    expect(request.variables).toEqual({ location: "PRIMARY" });

    return {
      ok: true,
      json: async () => ({
        data: {
          generalSettings: {
            siteIcon: {
              node: { sourceUrl: "https://media.example/favicon.png", altText: "" },
            },
            siteLogo: {
              node: { sourceUrl: "https://media.example/logo.svg", altText: "Acme" },
            },
          },
          menuItems: {
            nodes: [
              {
                id: "a",
                parentId: null,
                label: "Projetos",
                url: "https://{{project}}-admin.ddev.site/work/",
                target: null,
              },
              {
                id: "b",
                parentId: "a",
                label: "Casa",
                url: "https://{{project}}.example/work/house/?x=1#top",
                target: "",
              },
              {
                id: "c",
                parentId: null,
                label: "Instagram",
                url: "https://instagram.com/{{project}}",
                target: "_blank",
              },
            ],
          },
        },
      }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);

  expect(await getSiteChrome("https://{{project}}.example")).toEqual({
    kind: "found",
    content: {
      siteIcon: { sourceUrl: "https://media.example/favicon.png", altText: "" },
      siteLogo: { sourceUrl: "https://media.example/logo.svg", altText: "Acme" },
      menuItems: [
        {
          id: "a",
          label: "Projetos",
          href: "/work/",
          target: null,
          children: [
            { id: "b", label: "Casa", href: "/work/house/?x=1#top", target: null, children: [] },
          ],
        },
        {
          id: "c",
          label: "Instagram",
          href: "https://instagram.com/{{project}}",
          target: "_blank",
          children: [],
        },
      ],
    },
  });
});

test("a site chrome read that fails is unavailable, not an empty menu", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 503 })),
  );
  expect(await getSiteChrome()).toMatchObject({
    kind: "unavailable",
    failure: { reason: "http", httpStatus: 503 },
  });
});

test("a site chrome answer without its menu is invalid schema, not an empty menu", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: { generalSettings: { siteIcon: null, siteLogo: null }, menuItems: null },
      }),
    })),
  );
  expect(await getSiteChrome()).toMatchObject({
    kind: "unavailable",
    failure: { reason: "schema" },
  });
});

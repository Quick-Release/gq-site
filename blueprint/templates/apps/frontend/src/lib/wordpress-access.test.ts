import { afterEach, expect, test, vi } from "vite-plus/test";
import { frontendBindings } from "./runtime";
import { getPublishedRoutes } from "./wordpress";

vi.mock("./runtime", () => ({ frontendBindings: vi.fn(async () => ({})) }));
vi.mock("../../../../gq.ops.json", async (importOriginal) => {
  const { default: ops } = await importOriginal<{ default: { domains: { admin: string } } }>();
  return { default: { ...ops, domains: { ...ops.domains, admin: "cms.example.test" } } };
});

const credentials = {
  GQ_AUTH_GRAPHQL_CLIENT_ID: "private-graphql-id",
  GQ_AUTH_GRAPHQL_CLIENT_SECRET: "private-graphql-secret",
};

function setup() {
  vi.stubEnv("SSR", true);
  vi.stubEnv("PUBLIC_WORDPRESS_GRAPHQL_URL", "https://cms.example.test/graphql");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          data: {
            contentNodes: {
              nodes: [{ uri: "/published/" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(frontendBindings).mockResolvedValue({});
});

test("server publication reads send only the GraphQL pair to the configured CMS, without redirects", async () => {
  const fetch = setup();
  vi.mocked(frontendBindings).mockResolvedValue(credentials);
  expect(await getPublishedRoutes()).toEqual({ kind: "found", content: ["/published/"] });
  expect(fetch).toHaveBeenCalledWith(
    "https://cms.example.test/graphql",
    expect.objectContaining({
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        "CF-Access-Client-Id": credentials.GQ_AUTH_GRAPHQL_CLIENT_ID,
        "CF-Access-Client-Secret": credentials.GQ_AUTH_GRAPHQL_CLIENT_SECRET,
      },
    }),
  );
  expect(fetch).toHaveBeenCalledOnce();
});

test("without the optional pair reads remain anonymous", async () => {
  const fetch = setup();
  expect((await getPublishedRoutes()).kind).toBe("found");
  expect(fetch).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      headers: { "Content-Type": "application/json" },
      redirect: "manual",
    }),
  );
});

test.each([
  { GQ_AUTH_GRAPHQL_CLIENT_ID: credentials.GQ_AUTH_GRAPHQL_CLIENT_ID },
  { GQ_AUTH_GRAPHQL_CLIENT_SECRET: credentials.GQ_AUTH_GRAPHQL_CLIENT_SECRET },
])("partial pairs fail before sending and never reveal their values", async (bindings) => {
  const fetch = setup();
  vi.mocked(frontendBindings).mockResolvedValue(bindings);
  const result = await getPublishedRoutes();
  expect(result).toMatchObject({
    kind: "unavailable",
    failure: { message: expect.stringContaining("must be set together") },
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain("private-graphql");
});

test("raw fetch errors and redirect failures cannot leak either credential", async () => {
  const fetch = setup();
  vi.mocked(frontendBindings).mockResolvedValue(credentials);
  fetch.mockRejectedValue(new Error(Object.values(credentials).join(" ")));
  expect(await getPublishedRoutes()).toEqual({
    kind: "unavailable",
    failure: { reason: "network", message: "WordPress couldn't be reached" },
  });
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private-graphql");
});

test("a CMS redirect is an unavailable read, never followed or promoted", async () => {
  const fetch = setup();
  vi.mocked(frontendBindings).mockResolvedValue(credentials);
  fetch.mockResolvedValue(
    new Response(null, {
      status: 302,
      headers: { location: "https://third-party.example.test/graphql" },
    }),
  );
  expect(await getPublishedRoutes()).toEqual({
    kind: "unavailable",
    failure: { reason: "http", httpStatus: 302, message: "WordPress responded with HTTP 302" },
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledWith(
    "https://cms.example.test/graphql",
    expect.objectContaining({ redirect: "manual" }),
  );
});

test.each([
  "https://media.example.test/graphql",
  "https://cms.example.test:444/graphql",
  "http://cms.example.test/graphql",
  "https://cms.example.test/app/uploads/logo.png",
  "https://cms.example.test/wp-json/wp/v2/posts",
  "https://userinfo:private-password@cms.example.test/graphql",
])(
  "an endpoint override outside the configured CMS origin receives no credentials: %s",
  async (url) => {
    const fetch = setup();
    vi.mocked(frontendBindings).mockResolvedValue(credentials);
    vi.stubEnv("PUBLIC_WORDPRESS_GRAPHQL_URL", url);
    expect((await getPublishedRoutes()).kind).toBe("unavailable");
    expect(fetch).not.toHaveBeenCalled();
  },
);

test("browser reads never load bindings or send a CMS request", async () => {
  const fetch = setup();
  vi.stubEnv("SSR", false);
  vi.mocked(frontendBindings).mockClear();
  expect((await getPublishedRoutes()).kind).toBe("unavailable");
  expect(frontendBindings).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

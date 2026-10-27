// A stubbed WordPress for the rendered-route tests, answering each GraphQL
// query by name.
import { vi } from "vite-plus/test";

export type Answer = { ok: false; status: number } | { ok: true; json: () => Promise<unknown> };
export type Handler = (variables: Record<string, unknown>) => Answer | Promise<Answer>;

export const tokens = { colors: [], spacingSizes: [] };

export const chrome = {
  generalSettings: {
    siteIcon: null,
    siteLogo: { node: { sourceUrl: "https://media.example/logo.svg", altText: "Acme" } },
  },
  menuItems: {
    nodes: [{ id: "a", parentId: null, label: "About us", url: "/about/", target: null }],
  },
  // GQ Design's Header & Footer selects no pattern, so the layout keeps its own.
  header: null,
  footer: null,
};

/** GQ Config's Legal Contract for a language, as getquickLegal answers it (LEGAL-1). */
export const legal = {
  schemaVersion: 1,
  controller: { name: "Acme, Lda.", privacyEmail: "privacy@acme.example", dpoContact: null },
  roles: [
    {
      role: "privacy_policy",
      url: "/privacy/",
      title: "Privacy policy",
      revision: "2026-10-01T09:00:00",
      isFallback: false,
    },
    {
      role: "cookie_policy",
      url: "/cookies/",
      title: "Cookie policy",
      revision: "2026-10-02T09:00:00",
      isFallback: false,
    },
  ],
  missingRequired: [],
};

/** GQ Config's consent settings: the Legal Contract, and GA4 off unless a test says otherwise. */
export function consentSettings(
  analytics: { enabled: boolean; measurementId: string | null } = {
    enabled: false,
    measurementId: null,
  },
): Answer {
  return data({ getquickLegal: legal, googleAnalytics: analytics });
}

/** WordPress's list of published routes, on one page. */
export function routes(...uris: string[]): Answer {
  return data({
    contentNodes: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: uris.map((uri) => ({ uri })),
    },
  });
}

/** A published entry as WordPress lists it: its URI, and its id and modification time when given. */
export interface ListedNode {
  uri: string;
  id?: string | null;
  modifiedGmt?: string | null;
}

/** WordPress's list of published entries with their ids and modification times, on one page. */
export function listing(...nodes: ListedNode[]): Answer {
  return data({ contentNodes: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } });
}

/** A time as WPGraphQL gives modifiedGmt: GMT, to the second, without a zone. */
export function gmt(ms: number) {
  return new Date(ms).toISOString().slice(0, 19);
}

export function data(value: unknown): Answer {
  return { ok: true, json: async () => ({ data: value }) };
}

export function httpError(status: number): Answer {
  return { ok: false, status };
}

export function timeout(): never {
  throw new DOMException("The operation timed out.", "TimeoutError");
}

// The site chrome, GQ Config's consent settings and the design presets are
// fine, and nothing but the front page is published, unless a test says
// otherwise; any other query fails the test.
export function stubWordPress(handlers: {
  home?: Handler;
  entry?: Handler;
  chrome?: Handler;
  consent?: Handler;
  design?: Handler;
  routes?: Handler;
}) {
  const answer = {
    chrome: () => data(chrome),
    consent: () => consentSettings(),
    design: () => data({ designTokens: tokens }),
    routes: () => routes("/"),
    ...handlers,
  };
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(init.body as string) as {
      query: string;
      variables?: Record<string, unknown>;
    };
    const name = /query (\w+)/.exec(request.query)?.[1];
    const handler = {
      HomePage: answer.home,
      EntryByUri: answer.entry,
      SiteChrome: answer.chrome,
      ConsentSettings: answer.consent,
      DesignPresets: answer.design,
      PublishedRoutes: answer.routes,
    }[name ?? ""];
    if (!handler) throw new Error(`Unexpected query ${name}`);
    return handler(request.variables ?? {});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export function queries(fetchMock: ReturnType<typeof stubWordPress>, name: string) {
  return fetchMock.mock.calls.filter(([, init]) => (init.body as string).includes(`query ${name}`));
}

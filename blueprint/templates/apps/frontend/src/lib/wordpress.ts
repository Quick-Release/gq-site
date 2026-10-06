import { z } from "astro/zod";
import ops from "../../../../gq.ops.json";
import { frontendBindings } from "./runtime";
import { defaultLanguage, languageSubject, multilingual, type SiteLanguage } from "./site-language";
import { hasVideoHero, parseWordPressBlocks, renderWordPressBlocks } from "./wp-block-renderer";

export interface WordPressImage {
  sourceUrl: string;
  altText: string;
}

export interface WordPressPost {
  id: string;
  title: string;
  excerpt: string;
  content: string;
  uri: string;
  date: string;
  featuredImage: WordPressImage | null;
  hasVideoHero: boolean;
}

export interface WordPressMenuItem {
  id: string;
  label: string;
  href: string;
  target: string | null;
  children: WordPressMenuItem[];
}

export interface WordPressSettings {
  title: string;
  description: string;
}

export interface DesignPresets {
  spacingSizes: Array<{ slug: string; size: string }>;
  colors: Array<{ slug: string; color: string }>;
}

export interface HomeContent extends DesignPresets {
  /** The front page's WordPress entry (WPGraphQL's global id), if WordPress gave it. */
  nodeId: string | null;
  settings: WordPressSettings;
  page: { title: string; content: string; hasVideoHero: boolean };
  /** WordPress failed on the blocks, so this is the page without them. */
  blocksOmitted: boolean;
}

/** A published translation of an entry: its URI and its language's slug. */
export interface Translation {
  uri: string;
  language: string;
}

export interface EntryContent extends WordPressPost, DesignPresets {
  /** Its language's slug, on a multilingual Site. */
  language?: string;
  /** Its published translations into the site's other languages, on a multilingual Site. */
  translations?: Translation[];
  /** WordPress failed on the blocks, so this is the entry without them. */
  blocksOmitted: boolean;
  /** When WordPress last modified it (ms, the CMS's clock), if it said. */
  modifiedAt: number | null;
}

/** A published page or post as WordPress lists it: its id, URI and last modification. */
export interface PublishedEntry {
  /** WPGraphQL's global id, when WordPress gives it. */
  id: string | null;
  uri: string;
  /** When WordPress last modified it (ms, the CMS's clock), if it said. */
  modifiedAt: number | null;
}

export interface SiteChrome {
  menuItems: WordPressMenuItem[];
  siteIcon: WordPressImage | null;
  siteLogo: WordPressImage | null;
}

/**
 * Why WordPress couldn't deliver: it didn't answer in time (`timeout`), couldn't
 * be reached (`network`), answered with an HTTP error (`http`) or GraphQL errors
 * (`graphql`), or answered with data missing the fields the Frontend requires
 * (`schema`).
 */
export type CmsFailureReason = "timeout" | "network" | "http" | "graphql" | "schema";

export interface CmsFailure {
  reason: CmsFailureReason;
  message: string;
  httpStatus?: number;
}

export interface Found<T> {
  kind: "found";
  content: T;
}

/** WordPress answered with valid data, and has nothing published there. */
export interface Missing {
  kind: "missing";
}

/** The content couldn't be read. This says nothing about whether it exists. */
export interface Unavailable {
  kind: "unavailable";
  failure: CmsFailure;
}

export type Delivery<T> = Found<T> | Missing | Unavailable;

/** Found is 200, confirmed missing is 404, and a CMS failure is 503, never 404. */
export function responseStatus(delivery: { kind: Delivery<unknown>["kind"] }) {
  if (delivery.kind === "found") return 200;
  return delivery.kind === "missing" ? 404 : 503;
}

// The GETQUICK schema the Frontend requires. A field WordPress leaves out, or
// returns with another type, fails the read: only the fields declared nullable
// here may be null, and only those fall back to a default.
const image = z.object({ sourceUrl: z.string(), altText: z.string().nullable() });
const imageEdge = z.object({ node: image.nullable() }).nullable();

const designTokens = z.object({
  spacingSizes: z.array(z.object({ slug: z.string(), size: z.string() })),
  colors: z.array(z.object({ slug: z.string(), color: z.string() })),
});

const homeData = z.object({
  generalSettings: z.object({ title: z.string().nullable(), description: z.string().nullable() }),
  nodeByUri: z
    .union([
      z.object({
        __typename: z.literal("Page"),
        id: z.string().nullable().optional(),
        isFrontPage: z.boolean(),
        title: z.string().nullable(),
        content: z.string().nullable(),
        // Left out when read without blocks.
        blocks: z.unknown().optional(),
      }),
      z.object({ __typename: z.string().refine((typename) => typename !== "Page") }),
    ])
    .nullable(),
  designTokens,
});

const pageEntry = z.object({
  id: z.string(),
  title: z.string().nullable(),
  content: z.string().nullable(),
  uri: z.string(),
  // Only `publish` and unrestricted is public. A password-protected entry is
  // restricted: WordPress lists it to anonymous readers, without its content.
  status: z.string().nullable(),
  isRestricted: z.boolean().nullable(),
  // When it was last modified (GMT, without a zone). Only reconciliation
  // uses it, so a WordPress that leaves it out is still served.
  modifiedGmt: z.string().nullable().optional(),
  featuredImage: imageEdge,
  // Left out when read without blocks.
  blocks: z.unknown().optional(),
});
const postEntry = pageEntry.extend({ excerpt: z.string().nullable(), date: z.string().nullable() });

// On a multilingual Site, an entry's language and its translations (GQ
// Polylang for WPGraphQL), which only include what anonymous readers may see.
const languageRef = z.object({ slug: z.string() });
const translated = {
  language: languageRef.nullable(),
  translations: z
    .array(z.object({ uri: z.string().nullable(), language: languageRef.nullable() }))
    .nullable(),
};

const entryData = z.object({
  postBy: postEntry.nullable(),
  pageBy: pageEntry.nullable(),
  designTokens,
});

const translatedEntryData = z.object({
  postBy: postEntry.extend(translated).nullable(),
  pageBy: pageEntry.extend(translated).nullable(),
  designTokens,
});

// Another language's front page, title and tagline (GQ Polylang for WPGraphQL).
const languageHomeData = homeData.omit({ generalSettings: true }).extend({
  language: z.object({ title: z.string().nullable(), description: z.string().nullable() }),
});

const designData = z.object({ designTokens });

const menuItem = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  label: z.string().nullable(),
  url: z.string().nullable(),
  target: z.string().nullable(),
});

const publishedRoutesData = z.object({
  contentNodes: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
    nodes: z.array(
      z.object({
        uri: z.string().nullable(),
        id: z.string().nullable().optional(),
        modifiedGmt: z.string().nullable().optional(),
      }),
    ),
  }),
});

const siteChromeData = z.object({
  generalSettings: z.object({ siteIcon: imageEdge, siteLogo: imageEdge }),
  menuItems: z.object({ nodes: z.array(menuItem) }),
});

type RawEntry = z.infer<typeof pageEntry> &
  Partial<z.infer<typeof postEntry>> &
  Partial<z.infer<z.ZodObject<typeof translated>>>;
type RawMenuItem = z.infer<typeof menuItem>;

// Blocks are left out (withBlocks: false) when WordPress fails to return them.
const homeQuery = /* GraphQL */ `
  query HomePage($withBlocks: Boolean = true) {
    generalSettings {
      title
      description
    }
    nodeByUri(uri: "/") {
      __typename
      ... on Page {
        id
        title
        content
        blocks(attributes: true, htmlContent: true, dynamicContent: true, postTemplate: false)
          @include(if: $withBlocks)
        isFrontPage
      }
    }
    designTokens {
      spacingSizes {
        slug
        size
      }
      colors {
        slug
        color
      }
    }
  }
`;

// Another language's front page (/en/), with its translated title and tagline.
const languageHomeQuery = /* GraphQL */ `
  query HomePage($uri: String!, $language: LanguageCodeEnum!, $withBlocks: Boolean = true) {
    language(code: $language) {
      title
      description
    }
    nodeByUri(uri: $uri) {
      __typename
      ... on Page {
        id
        title
        content
        blocks(attributes: true, htmlContent: true, dynamicContent: true, postTemplate: false)
          @include(if: $withBlocks)
        isFrontPage
      }
    }
    designTokens {
      spacingSizes {
        slug
        size
      }
      colors {
        slug
        color
      }
    }
  }
`;

// WPGraphQL only exposes menus assigned to a theme location to anonymous callers.
// `inLanguage`: the menu at the location in a language (GQ Polylang for
// WPGraphQL); without, the default language's.
function siteChromeQueryText(inLanguage: boolean) {
  return /* GraphQL */ `
  query SiteChrome($location: MenuLocationEnum!${inLanguage ? ", $language: LanguageCodeEnum!" : ""}) {
    generalSettings {
      siteIcon {
        node {
          sourceUrl
          altText
        }
      }
      siteLogo {
        node {
          sourceUrl
          altText
        }
      }
    }
    menuItems(where: { location: $location${inLanguage ? ", language: $language" : ""} }, first: 100) {
      nodes {
        id
        parentId
        label
        url
        target
      }
    }
  }
`;
}
const siteChromeQuery = siteChromeQueryText(false);
const languageChromeQuery = siteChromeQueryText(true);

// Blocks are left out (withBlocks: false) when WordPress fails to return them.
// On a multilingual Site (`translated`), each entry comes with its language
// and translations (GQ Polylang for WPGraphQL).
function entryQueryText(translated: boolean) {
  const languageFields = translated
    ? `
      language {
        slug
      }
      translations {
        uri
        language {
          slug
        }
      }`
    : "";
  return /* GraphQL */ `
  query EntryByUri($uri: String!, $withBlocks: Boolean = true) {
    designTokens {
      colors {
        slug
        color
      }
      spacingSizes {
        slug
        size
      }
    }
    postBy(uri: $uri) {
      id
      title
      excerpt
      content
      blocks(attributes: true, htmlContent: true, dynamicContent: true, postTemplate: false)
        @include(if: $withBlocks)
      uri${languageFields}
      date
      status
      isRestricted
      modifiedGmt
      featuredImage {
        node {
          sourceUrl
          altText
        }
      }
    }
    pageBy(uri: $uri) {
      id
      title
      content
      blocks(attributes: true, htmlContent: true, dynamicContent: true, postTemplate: false)
        @include(if: $withBlocks)
      uri${languageFields}
      status
      isRestricted
      modifiedGmt
      featuredImage {
        node {
          sourceUrl
          altText
        }
      }
    }
  }
`;
}
const entryQuery = entryQueryText(false);
const translatedEntryQuery = entryQueryText(true);

// The design presets alone, for a change to them that reaches every page.
const designQuery = /* GraphQL */ `
  query DesignPresets {
    designTokens {
      spacingSizes {
        slug
        size
      }
      colors {
        slug
        color
      }
    }
  }
`;

// Anonymous readers only get what is published: no drafts, private entries or
// revisions. The id and the modification time let reconciliation tell which
// entries changed without reading each one. On a multilingual Site
// (`everyLanguage`), the entries of every language (GQ Polylang for WPGraphQL).
function publishedRoutesQueryText(everyLanguage: boolean) {
  return /* GraphQL */ `
  query PublishedRoutes($after: String) {
    contentNodes(first: 100, after: $after, where: { contentTypes: [PAGE, POST]${everyLanguage ? ", language: ALL" : ""} }) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        uri
        id
        modifiedGmt
      }
    }
  }
`;
}
const publishedRoutesQuery = publishedRoutesQueryText(multilingual);

function endpoint() {
  return (
    import.meta.env.PUBLIC_WORDPRESS_GRAPHQL_URL?.trim() ||
    "https://{{project}}-admin.ddev.site/wp/graphql"
  );
}

/**
 * WPGraphQL's GMT time ("2026-10-02T09:00:00", without a zone) in ms, or null
 * when it is absent or not a time.
 */
export function cmsTime(value: string | null | undefined) {
  if (!value) return null;
  const time = Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(time) ? null : time;
}

function normalizeImage(edge: z.infer<typeof imageEdge>): WordPressImage | null {
  const node = edge?.node;
  return node ? { sourceUrl: node.sourceUrl, altText: node.altText ?? "" } : null;
}

/**
 * An entry's URI as a path. A CMS whose permalinks point at the Frontend gives
 * absolute URIs (`https://acme.example/team/`); only the path is the route.
 * Percent-encoding and the trailing slash are kept as WordPress gives them.
 */
export function uriPath(uri: string) {
  try {
    return new URL(uri, "https://frontend.invalid").pathname;
  } catch {
    return uri;
  }
}

function normalizePost(post: RawEntry): WordPressPost {
  return {
    id: post.id,
    title: post.title ?? "",
    excerpt: post.excerpt ?? "",
    content: post.content ?? "",
    uri: uriPath(post.uri),
    date: post.date ?? "",
    featuredImage: normalizeImage(post.featuredImage),
    hasVideoHero: hasVideoHero(parseWordPressBlocks(post.blocks)),
  };
}

/** A read WordPress didn't complete; becomes an Unavailable delivery. */
class CmsFailureError extends Error {
  constructor(
    readonly failure: CmsFailure,
    options?: { cause?: unknown },
  ) {
    super(failure.message, options);
  }
}

function describeIssues(error: z.ZodError) {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "data"}: ${issue.message}`)
    .join("; ");
}

async function query<S extends z.ZodType>(
  schema: S,
  queryText: string,
  variables?: Record<string, string | boolean | null>,
): Promise<z.infer<S>> {
  let response: Response;
  try {
    if (!import.meta.env.SSR) throw new Error("CMS reads are server-only");
    const url = new URL(endpoint());
    const bindings = await frontendBindings();
    const id = bindings.GQ_AUTH_GRAPHQL_CLIENT_ID?.trim();
    const secret = bindings.GQ_AUTH_GRAPHQL_CLIENT_SECRET?.trim();
    if (Boolean(id) !== Boolean(secret)) {
      throw new CmsFailureError({
        reason: "network",
        message: "GQ_AUTH_GRAPHQL_CLIENT_ID and GQ_AUTH_GRAPHQL_CLIENT_SECRET must be set together",
      });
    }
    const admin =
      id && secret
        ? z.object({ domains: z.object({ admin: z.string() }) }).parse(ops).domains.admin
        : null;
    if (
      id &&
      secret &&
      (url.origin !== new URL(`https://${admin}`).origin ||
        !["/graphql", "/wp/graphql"].includes(url.pathname) ||
        url.protocol !== "https:" ||
        url.username ||
        url.password)
    ) {
      throw new CmsFailureError({
        reason: "network",
        message: "Cloudflare Access credentials require the configured CMS HTTPS GraphQL endpoint",
      });
    }
    // This is the only destination: the configured CMS endpoint, never an
    // asset or a link returned by WordPress. Redirects must not forward it.
    response = await fetch(url.href, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(id && secret ? { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } : {}),
      },
      redirect: "manual",
      body: JSON.stringify({ query: queryText, variables }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    if (error instanceof CmsFailureError) throw error;
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    // A transport/invalid-header error may contain credential values. Neither
    // the public Unavailable delivery nor its log retains that raw error.
    throw new CmsFailureError(
      timedOut
        ? { reason: "timeout", message: "WordPress didn't answer within 8 seconds" }
        : { reason: "network", message: "WordPress couldn't be reached" },
    );
  }

  if (!response.ok) {
    throw new CmsFailureError({
      reason: "http",
      httpStatus: response.status,
      message: `WordPress responded with HTTP ${response.status}`,
    });
  }

  let result: { data?: unknown; errors?: Array<{ message: string }> } | null;
  try {
    result = await response.json();
  } catch (error) {
    throw new CmsFailureError(
      { reason: "schema", message: "WordPress answered with something other than JSON" },
      { cause: error },
    );
  }

  // Any GraphQL error fails the read, even next to partial data: a field it
  // nulled out isn't evidence that the content is gone.
  if (result?.errors?.length) {
    throw new CmsFailureError({
      reason: "graphql",
      message: result.errors.map((error) => error.message).join(", "),
    });
  }

  const parsed = schema.safeParse(result?.data);
  if (!parsed.success) {
    throw new CmsFailureError({
      reason: "schema",
      message: `WordPress's answer doesn't match the required schema: ${describeIssues(parsed.error)}`,
    });
  }
  return parsed.data;
}

function isServerError(error: unknown) {
  return (
    error instanceof CmsFailureError &&
    error.failure.reason === "http" &&
    (error.failure.httpStatus ?? 0) >= 500
  );
}

/**
 * The CMS can fail on one page's blocks (a 502 for a block's attributes) while
 * the rest of it is fine: read it again without them rather than fail it. Only
 * Video Hero pages need blocks. A timeout isn't retried, and a retry that fails
 * too is a failure, never absence.
 */
async function queryWithBlockRecovery<S extends z.ZodType>(
  schema: S,
  queryText: string,
  variables: Record<string, string | boolean> = {},
): Promise<{ data: z.infer<S>; blocksOmitted: boolean }> {
  try {
    return { data: await query(schema, queryText, variables), blocksOmitted: false };
  } catch (error) {
    if (!isServerError(error)) throw error;
    try {
      const data = await query(schema, queryText, { ...variables, withBlocks: false });
      return { data, blocksOmitted: true };
    } catch (retryError) {
      if (!(retryError instanceof CmsFailureError)) throw retryError;
      const first = (error as CmsFailureError).failure;
      throw new CmsFailureError(
        {
          ...retryError.failure,
          message: `${first.message}; without blocks: ${retryError.failure.message}`,
        },
        { cause: retryError },
      );
    }
  }
}

/** Turns a CMS failure into an Unavailable delivery, and logs why. Other errors are bugs. */
async function deliver<R>(subject: string, read: () => Promise<R>): Promise<R | Unavailable> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof CmsFailureError)) throw error;
    console.error(
      `WordPress: ${subject} is unavailable (${error.failure.reason}): ${error.message}`,
    );
    return { kind: "unavailable", failure: error.failure };
  }
}

/**
 * The page WordPress marks as a language's front page, with the site's title
 * and tagline in that language. Missing when no page is.
 */
export async function getHomeContent(
  language: SiteLanguage = defaultLanguage,
): Promise<Delivery<HomeContent>> {
  return deliver(
    languageSubject(language, "front page"),
    async (): Promise<Found<HomeContent> | Missing> => {
      const { data, blocksOmitted } = language.isDefault
        ? await queryWithBlockRecovery(homeData, homeQuery)
        : await queryWithBlockRecovery(languageHomeData, languageHomeQuery, {
            uri: language.home,
            language: language.code,
          }).then(({ data, blocksOmitted }) => ({
            data: { ...data, generalSettings: data.language },
            blocksOmitted,
          }));
      const node = data.nodeByUri;
      if (!node || !("isFrontPage" in node) || !node.isFrontPage) return { kind: "missing" };

      const blocks = parseWordPressBlocks(node.blocks);
      const containsVideoHero = hasVideoHero(blocks);
      return {
        kind: "found",
        content: {
          nodeId: node.id ?? null,
          settings: {
            title: data.generalSettings.title ?? "",
            description: data.generalSettings.description ?? "",
          },
          page: {
            title: node.title ?? "",
            content: containsVideoHero ? renderWordPressBlocks(blocks) : (node.content ?? ""),
            hasVideoHero: containsVideoHero,
          },
          blocksOmitted,
          spacingSizes: data.designTokens.spacingSizes,
          colors: data.designTokens.colors,
        },
      };
    },
  );
}

/**
 * The published post or page at a URI. Missing when WordPress has neither, or
 * only one that isn't public (password-protected): the Frontend serves only
 * what any visitor may read.
 */
export async function getEntryByUri(uri: string): Promise<Delivery<EntryContent>> {
  return deliver(`the entry ${uri}`, async (): Promise<Found<EntryContent> | Missing> => {
    const { data, blocksOmitted } = multilingual
      ? await queryWithBlockRecovery(translatedEntryData, translatedEntryQuery, { uri })
      : await queryWithBlockRecovery(entryData, entryQuery, { uri });
    const post: RawEntry | null = data.postBy ?? data.pageBy;
    if (!post || post.isRestricted || post.status !== "publish") return { kind: "missing" };

    const normalized = normalizePost(post);
    const blocks = parseWordPressBlocks(post.blocks);
    const containsVideoHero = hasVideoHero(blocks);
    return {
      kind: "found",
      content: {
        ...normalized,
        content: containsVideoHero ? renderWordPressBlocks(blocks) : normalized.content,
        hasVideoHero: containsVideoHero,
        blocksOmitted,
        modifiedAt: cmsTime(post.modifiedGmt),
        spacingSizes: data.designTokens.spacingSizes,
        colors: data.designTokens.colors,
        ...(multilingual ? languageOf(post) : {}),
      },
    };
  });
}

/** An entry's language and published translations, as a multilingual Site stores them. */
function languageOf(post: RawEntry): Pick<EntryContent, "language" | "translations"> {
  return {
    ...(post.language ? { language: post.language.slug } : {}),
    translations: (post.translations ?? []).flatMap((translation) =>
      translation.uri && translation.language
        ? [{ uri: uriPath(translation.uri), language: translation.language.slug }]
        : [],
    ),
  };
}

/** The design presets every page shares (GQ Design's spacing sizes and colors). */
export async function getDesignPresets(): Promise<Found<DesignPresets> | Unavailable> {
  return deliver("the design presets", async (): Promise<Found<DesignPresets>> => {
    const { designTokens } = await query(designData, designQuery);
    return {
      kind: "found",
      content: { spacingSizes: designTokens.spacingSizes, colors: designTokens.colors },
    };
  });
}

/**
 * Every published page and post (its id, URI and last modification), read
 * page by page, and how many requests that took. Any failed page fails the
 * list: an incomplete list says nothing about what isn't in it.
 */
export async function getPublishedEntries(): Promise<
  Found<{ entries: PublishedEntry[]; requests: number }> | Unavailable
> {
  return deliver("the published routes", async () => {
    const entries: PublishedEntry[] = [];
    let after: string | null = null;
    for (let page = 0; page < 1000; page += 1) {
      const { contentNodes }: z.infer<typeof publishedRoutesData> = await query(
        publishedRoutesData,
        publishedRoutesQuery,
        { after },
      );
      for (const node of contentNodes.nodes) {
        if (!node.uri) continue;
        entries.push({
          id: node.id ?? null,
          uri: uriPath(node.uri),
          modifiedAt: cmsTime(node.modifiedGmt),
        });
      }
      if (!contentNodes.pageInfo.hasNextPage) {
        return { kind: "found" as const, content: { entries, requests: page + 1 } };
      }
      if (!contentNodes.pageInfo.endCursor) {
        throw new CmsFailureError({
          reason: "schema",
          message: "WordPress said there are more published routes without a cursor to them",
        });
      }
      after = contentNodes.pageInfo.endCursor;
    }
    throw new CmsFailureError({
      reason: "schema",
      message: "WordPress listed more than 100,000 published routes",
    });
  });
}

/** The URI of every published page and post. */
export async function getPublishedRoutes(): Promise<Found<string[]> | Unavailable> {
  const listed = await getPublishedEntries();
  if (listed.kind !== "found") return listed;
  return { kind: "found", content: listed.content.entries.map((entry) => entry.uri) };
}

/**
 * Links into this site (the WordPress origin, or the frontend origin WordPress
 * uses as its home URL) become frontend paths; other origins stay absolute.
 */
export function menuItemHref(url: string, internalOrigins: string[]) {
  try {
    const parsed = new URL(url, internalOrigins[0]);
    if (!internalOrigins.includes(parsed.origin)) return url;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

export function buildMenuTree(items: RawMenuItem[], internalOrigins: string[]) {
  const byId = new Map<string, WordPressMenuItem>();
  for (const item of items) {
    byId.set(item.id, {
      id: item.id,
      label: item.label ?? "",
      href: item.url ? menuItemHref(item.url, internalOrigins) : "#",
      target: item.target || null,
      children: [],
    });
  }

  const roots: WordPressMenuItem[] = [];
  for (const item of items) {
    const node = byId.get(item.id)!;
    const parent = item.parentId ? byId.get(item.parentId) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}

/**
 * The menu, logo and icon every page in a language shares: the logo and icon
 * are the site's, the menu the one at the location in that language. A site
 * without them is found with an empty menu and no images; a failed read is
 * Unavailable, not that.
 */
export async function getSiteChrome(
  siteOrigin?: string,
  {
    location = "PRIMARY",
    language = defaultLanguage,
  }: { location?: string; language?: SiteLanguage } = {},
): Promise<Found<SiteChrome> | Unavailable> {
  return deliver(languageSubject(language, "site chrome"), async (): Promise<Found<SiteChrome>> => {
    const data = language.isDefault
      ? await query(siteChromeData, siteChromeQuery, { location })
      : await query(siteChromeData, languageChromeQuery, { location, language: language.code });
    const origins = [new URL(endpoint()).origin, ...(siteOrigin ? [siteOrigin] : [])];

    return {
      kind: "found",
      content: {
        menuItems: buildMenuTree(data.menuItems.nodes, origins),
        siteIcon: normalizeImage(data.generalSettings.siteIcon),
        siteLogo: normalizeImage(data.generalSettings.siteLogo),
      },
    };
  });
}

export function stripHtml(value: string) {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatDate(value: string, lang = "en") {
  return new Intl.DateTimeFormat(lang, {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(value));
}

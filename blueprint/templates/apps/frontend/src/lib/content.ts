// The Site's content runtime: @getquick/content, configured for this Site from
// its gq.ops.json, its build environment and its Worker's bindings. The
// runtime (WPGraphQL reads, the publication store, events and refresh, and
// the consent Runtime's embed rewriting) is the package's; this file only says
// which Site it serves. The pages, the layout and the /gq/events and
// /gq/refresh routes (managed by gq sync) use it.
import { createContentRuntime, type ContentBindings } from "@getquick/content/server";
import ops from "../../../../gq.ops.json";

const manifest = ops as {
  project: string;
  domains?: { admin: string; frontend: string };
  media?: { domain: string };
  wordpress?: { locale?: string; languages?: Array<{ locale: string; slug: string }> };
};

/** The CMS's GraphQL endpoint: the deploy sets it; local development reads DDEV's. */
const graphqlEndpoint =
  import.meta.env.PUBLIC_WORDPRESS_GRAPHQL_URL?.trim() ||
  "https://{{project}}-admin.ddev.site/wp/graphql";

// Imported once, so concurrent requests share one import of the module.
let workers: Promise<{ env: Record<string, unknown> } | null> | undefined;

/**
 * The deployed Worker's bindings (infra/frontend.run.ts declares them).
 * `astro dev` and tests run outside workerd, where `cloudflare:workers`
 * doesn't exist: there are none.
 */
async function bindings(): Promise<ContentBindings> {
  if (!import.meta.env.SSR) return {};
  workers ??= import("cloudflare:workers").catch(() => null);
  return ((await workers)?.env ?? {}) as ContentBindings;
}

/**
 * This Site's content runtime, made for each request. Only local development
 * reads the CMS live without a publication store; a built Frontend without
 * one is a 503.
 */
export function content() {
  return createContentRuntime({
    // The Site's identity: the CMS signs its events with the same one
    // (GQ_CONTENT_SITE_ID in apps/cms/config/application.php).
    site: manifest.project,
    graphqlEndpoint,
    cmsOrigin: manifest.domains
      ? `https://${manifest.domains.admin}`
      : new URL(graphqlEndpoint).origin,
    wordpress: manifest.wordpress,
    development: import.meta.env.DEV,
    isServer: () => import.meta.env.SSR,
    bindings,
    // CONSENT-1 (docs/guides/consent.md): every published body's third-party
    // embeds become consent placeholders at delivery, and each language's
    // chrome carries GQ Config's Legal Contract and GA4 toggle. Declare the
    // catalog services the Site's pages embed (e.g. "youtube", "vimeo",
    // "google_maps"); an embed of a service not declared stays blocked. With
    // no optional service there is no banner, only the "Cookie settings"
    // control. The Site's own Frontend and media hosts are first party, as
    // the CMS's is.
    consent: {
      services: [],
      cmsSettings: true,
      firstPartyHosts: [manifest.domains?.frontend, manifest.media?.domain].filter(
        (host): host is string => Boolean(host),
      ),
    },
  });
}

export type ContentRuntime = ReturnType<typeof content>;

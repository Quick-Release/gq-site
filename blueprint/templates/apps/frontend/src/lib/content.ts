// The Site's content runtime: @getquick/content, configured for this Site from
// its gq.ops.json, its build environment and its Worker's bindings. The
// runtime (WPGraphQL reads, the publication store, events and refresh) is the
// package's; this file only says which Site it serves. The pages and the
// /gq/events and /gq/refresh routes (managed by gq sync) use it.
import { createContentRuntime, type ContentBindings } from "@getquick/content/server";
import ops from "../../../../gq.ops.json";

const manifest = ops as {
  project: string;
  domains?: { admin: string };
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
  });
}

export type ContentRuntime = ReturnType<typeof content>;

// Managed by gq sync: the consent Runtime's endpoints (CONSENT-1; ADR 0019),
// handled by @getquick/content's createConsentServer. POST /gq/consent records
// a visitor's decision in CONSENT_DB; the reads under /gq/consent/ (records,
// export, stats) take CONSENT_READ_TOKEN as a bearer token. Any other path is
// a 404. The Site's identity is its manifest's, as the Content Runtime's and
// the purge Worker's are. It reads the Worker's bindings itself rather than
// through src/lib/content.ts, which is the Site's own file, so it works
// whatever that file exports.
import type { APIRoute } from "astro";
import { createConsentServer, type ConsentBindings } from "@getquick/content/consent/server";
import ops from "../../../../../gq.ops.json";

export const prerender = false;

const consent = createConsentServer({
  siteId: ops.project,
  // The deployed Worker's bindings (infra/frontend.run.ts declares them).
  // Outside workerd there are none, and the Runtime answers 503.
  bindings: async () =>
    ((await import("cloudflare:workers").catch(() => null))?.env ?? {}) as ConsentBindings,
});

export const ALL: APIRoute = async ({ request }) =>
  (await consent.handle(request)) ?? new Response(null, { status: 404 });

// Managed by gq sync: the consent Runtime's endpoints (CONSENT-1; ADR 0019),
// handled by @getquick/content's createConsentServer. POST /gq/consent records
// a visitor's decision in CONSENT_DB; the reads under /gq/consent/ (records,
// export, stats) take CONSENT_READ_TOKEN as a bearer token. Any other path is
// a 404. The Site's identity is its manifest's, as the Content Runtime's and
// the purge Worker's are. It reads the Worker's bindings itself rather than
// through src/lib/content.ts, which is the Site's own file, so it works
// whatever that file exports. Records are kept for CONSENT_RETENTION_DAYS
// (gq.ops.json's consent.retentionDays), the retention the purge Worker
// deletes by; without it, the Runtime's default.
import type { APIRoute } from "astro";
import {
  createConsentServer,
  type ConsentBindings,
  type ConsentServer,
} from "@getquick/content/consent/server";
import ops from "../../../../../gq.ops.json";

export const prerender = false;

// The deployed Worker's bindings (infra/frontend.run.ts declares them).
// Outside workerd there are none, and the Runtime answers 503.
const bindings = async () =>
  ((await import("cloudflare:workers").catch(() => null))?.env ?? {}) as ConsentBindings & {
    CONSENT_RETENTION_DAYS?: string;
  };

let consent: ConsentServer | undefined;

export const ALL: APIRoute = async ({ request }) => {
  const { CONSENT_RETENTION_DAYS: retention } = await bindings();
  consent ??= createConsentServer({
    siteId: ops.project,
    bindings,
    retentionDays: retention ? Number(retention) : undefined,
  });
  return (await consent.handle(request)) ?? new Response(null, { status: 404 });
};

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

const domains = (ops as { domains?: { frontend: string; frontendTarget?: string } }).domains;
// The Site's public origin (domains.frontend) and the Worker's own host when
// it is another (domains.frontendTarget): behind an external proxy, the
// Worker sees the latter while visitors' browsers post from the former.
const siteOrigins = [domains?.frontend, domains?.frontendTarget]
  .filter((host): host is string => Boolean(host))
  .map((host) => `https://${host}`);

// The deployed Worker's bindings (infra/frontend.run.ts declares them).
// Outside workerd there are none, and the Runtime answers 503.
const bindings = async () =>
  ((await import("cloudflare:workers").catch(() => null))?.env ?? {}) as ConsentBindings & {
    CONSENT_RETENTION_DAYS?: string;
    GQ_TRUSTED_PROXIES?: string;
  };

// The Site's reverse proxy's addresses, from GQ_TRUSTED_PROXIES (comma-separated;
// infra/frontend.run.ts binds it for gq.ops.json domains.frontendProxy): the
// visitor's address is read from its X-Forwarded-For only when it is them.
// @getquick/content takes trustedProxies from the release of gq-content #55;
// spread in, an older one ignores it.
const trustedProxies = (value: string | undefined) => {
  const list = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return list.length > 0 ? { trustedProxies: list } : {};
};

let consent: ConsentServer | undefined;

export const ALL: APIRoute = async ({ request }) => {
  const { CONSENT_RETENTION_DAYS: retention, GQ_TRUSTED_PROXIES: proxies } = await bindings();
  consent ??= createConsentServer({
    siteId: ops.project,
    siteOrigins,
    bindings,
    retentionDays: retention ? Number(retention) : undefined,
    ...trustedProxies(proxies),
  });
  return (await consent.handle(request)) ?? new Response(null, { status: 404 });
};

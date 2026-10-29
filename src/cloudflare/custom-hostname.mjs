// The production Frontend on a hostname outside the Cloudflare zone, through
// Cloudflare for SaaS: gq.ops.json domains.frontend (the public hostname, in
// the client's own DNS) served by the Worker whose Custom Domain is
// domains.frontendTarget (in cloudflare.zoneId). With the account's
// token-manager token and a 1-hour token that is deleted right after:
//
//   1. create the custom hostname domains.frontend: TXT ownership
//      pre-validation and a DV certificate validated by TXT, which delegated
//      DCV answers from then on
//   2. print the DNS records the client adds at their DNS
//
// The zone's fallback origin is shared by every custom hostname on the zone,
// so it is set once for the zone, by hand, and never to a Site's own host:
// this checks it and says when it is missing. The Worker route that hands the
// custom hostname's requests to the Frontend is the production deploy's
// (infra/frontend.run.ts). Enabling Cloudflare for SaaS on the zone is a dashboard step: the API has
// none.
//
// `status` reads the same state and the client's DNS (CNAME and CAA, over
// DNS over HTTPS), changes nothing, and exits 1 until the hostname, its
// certificate, the fallback origin and the route are active.
//
//   gq cloudflare custom-hostname [--dry-run]
//   gq cloudflare custom-hostname status [--json]

import { createReporter } from "../cli/reporter.mjs";
import { frontendCustomHostname, frontendProxy } from "../manifest/schema.mjs";
import { frontendWorker } from "../offboard/names.mjs";
import { createCloudflareAccountClient } from "./account-client.mjs";
import { managerToken, tokenName, withTemporaryToken, zonePolicy } from "./tokens.mjs";

/** The certificate authorities Cloudflare issues custom hostnames' DV certificates from, as CAA names them. */
export const CLOUDFLARE_CAA_ISSUERS = ["letsencrypt.org", "pki.goog", "ssl.com"];

const DOH_URL = "https://cloudflare-dns.com/dns-query";
const DNS_TYPES = { CNAME: 5, CAA: 257 };

const provisionPermissions = ["Zone Read", "SSL and Certificates Write"];
const statusPermissions = ["Zone Read", "SSL and Certificates Read", "Workers Routes Read"];

// The zone's fallback origin serves every custom hostname without a route
// of its own, so it is the zone's, never one Site's Frontend.
const FALLBACK_SETUP =
  "set one once for the zone, by hand: a proxied record in the zone for a host that serves no Site (SSL/TLS → Custom Hostnames → Fallback Origin)";

// A fallback origin on a Site's own Frontend host would show that Site for
// every custom hostname without a route of its own.
function ownsFallback(fallback, target) {
  return fallback?.origin?.toLowerCase() === target.toLowerCase();
}

function fallbackLine(fallback, target) {
  if (!fallback) return `! the zone has no fallback origin: ${FALLBACK_SETUP}`;
  if (ownsFallback(fallback, target)) {
    return `! the zone's fallback origin is ${target}, this Site's Frontend: every custom hostname without a route would show it; ${FALLBACK_SETUP}`;
  }
  return `✓ the zone's fallback origin is ${fallback.origin} (${fallback.status})`;
}

function saasHint(zone) {
  return `Is Cloudflare for SaaS enabled on ${zone}? It is a dashboard step: the zone's SSL/TLS → Custom Hostnames → Enable (it asks for a payment method; 100 custom hostnames are included).`;
}

function settings(ops) {
  // Behind an external proxy, Cloudflare never sees the public hostname.
  const proxy = frontendProxy(ops);
  if (proxy) {
    throw new Error(
      `gq.ops.json sets domains.frontendProxy: https://${proxy.hostname} is served by a reverse proxy outside Cloudflare, which forwards to the Worker's Custom Domain ${proxy.target}. There is no Cloudflare for SaaS custom hostname to create or check: the proxy's certificate and ${proxy.hostname}'s DNS are set up where the proxy runs (docs/guides/provisioning.md, "A Frontend behind an external proxy").`,
    );
  }
  const custom = frontendCustomHostname(ops);
  const { accountId, zoneId, zoneName } = ops.cloudflare ?? {};
  if (!custom || !accountId || !zoneId) {
    throw new Error(
      "gq.ops.json domains.frontend, domains.frontendTarget and cloudflare.accountId/zoneId are required: domains.frontendTarget names the Frontend's hostname in the zone when domains.frontend is outside it.",
    );
  }
  return {
    ...custom,
    accountId,
    zoneId,
    zone: zoneName ?? zoneId,
    worker: frontendWorker(ops.project),
  };
}

// Runs `work(zone)` with a zone client for a 1-hour token holding
// `permissions` on the zone; a Cloudflare for SaaS error names the dashboard
// step it may need.
async function withZone(context, command, site, permissions, work) {
  const { accountId, zoneId } = site;
  const request = createCloudflareAccountClient({
    token: managerToken(context, command),
    accountId,
    fetch: site.fetch,
  });
  const groups = await request("GET", "/tokens/permission_groups");
  return withTemporaryToken(
    request,
    {
      name: tokenName(context.config.project, "custom hostname (temporary)"),
      accountId,
      zoneId,
      policies: [zonePolicy(zoneId, permissions, groups)],
      fetch: site.fetch,
    },
    async (_account, zone) => {
      try {
        return await work(zone);
      } catch (error) {
        if (!error.message.includes("/custom_hostnames")) throw error;
        throw new Error(`${error.message}. ${saasHint(site.zone)}`, { cause: error });
      }
    },
  );
}

// The zone's Cloudflare for SaaS state for the custom hostname: the fallback
// origin (null when there is none), the custom hostname (null when missing),
// the account's DCV delegation id and, given `withRoute`, the Worker route.
async function inspect(zone, { hostname }, { withRoute = false } = {}) {
  const listed = await zone("GET", `/custom_hostnames?hostname=${encodeURIComponent(hostname)}`);
  const customHostname =
    (listed ?? []).find((entry) => entry.hostname?.toLowerCase() === hostname.toLowerCase()) ??
    null;
  // A zone without a fallback origin answers with an error that says so.
  const fallback = await zone("GET", "/custom_hostnames/fallback_origin", undefined, {
    allowNotFound: true,
  }).catch((error) => {
    if (/fallback origin/iu.test(error.message) && /\bno\b|not found/iu.test(error.message)) {
      return null;
    }
    throw error;
  });
  // Without a delegation id, the certificate's own TXT records are printed.
  const delegation = await zone("GET", "/dcv_delegation/uuid", undefined, {
    allowNotFound: true,
  }).catch(() => null);
  const routes = withRoute ? ((await zone("GET", "/workers/routes")) ?? []) : [];
  return {
    fallback: fallback?.origin ? fallback : null,
    customHostname,
    dcvUuid: delegation?.uuid ?? null,
    route: routes.find((route) => route.pattern === `${hostname}/*`) ?? null,
  };
}

/**
 * The DNS records the client adds where domains.frontend's DNS is: the
 * CNAME that sends its traffic to the zone, the TXT that proves ownership
 * before it does, and the `_acme-challenge` CNAME that delegates
 * certificate validation to Cloudflare, so renewals need nothing from them.
 * Without a delegation id, the certificate's own TXT records (valid for
 * this issuance only) stand in for it.
 */
export function clientRecords({ hostname, target }, { customHostname, dcvUuid }) {
  const records = [{ purpose: "traffic", type: "CNAME", name: hostname, content: target }];
  const ownership = customHostname?.ownership_verification;
  if (ownership?.name && ownership.value) {
    records.push({
      purpose: "ownership",
      type: "TXT",
      name: ownership.name,
      content: ownership.value,
    });
  }
  const validation = customHostname?.ssl?.validation_records ?? [];
  const delegated = validation.find((record) => record.cname && record.cname_target);
  if (delegated) {
    records.push({
      purpose: "certificate",
      type: "CNAME",
      name: delegated.cname,
      content: delegated.cname_target,
    });
  } else if (dcvUuid) {
    records.push({
      purpose: "certificate",
      type: "CNAME",
      name: `_acme-challenge.${hostname}`,
      content: `${hostname}.${dcvUuid}.dcv.cloudflare.com`,
    });
  } else {
    for (const record of validation.filter((entry) => entry.txt_name && entry.txt_value)) {
      records.push({
        purpose: "certificate (this issuance only)",
        type: "TXT",
        name: record.txt_name,
        content: record.txt_value,
      });
    }
  }
  return records;
}

function formatRecords(records) {
  return records.map(
    ({ purpose, type, name, content }) => `${name}  ${type}  ${content}  (${purpose})`,
  );
}

const CAA_NOTE = `If the client's domain has CAA records, they must also allow ${CLOUDFLARE_CAA_ISSUERS.map((issuer) => `0 issue "${issuer}"`).join(", ")}; gq cloudflare custom-hostname status checks them.`;

// `gq cloudflare custom-hostname [--dry-run]`. Resolves to an exit code.
async function provision({ context, parsed, fetch, io, interactive }) {
  const site = { ...settings(context.config), fetch };
  const { hostname, target } = site;
  const ui = createReporter(io, interactive);
  ui.intro(`Cloudflare for SaaS · https://${hostname} → ${target}`);

  const outcome = await withZone(
    context,
    "cloudflare custom-hostname",
    site,
    provisionPermissions,
    async (zone) => {
      const before = await inspect(zone, site);
      ui.note(
        [
          fallbackLine(before.fallback, target),
          before.customHostname
            ? `✓ the custom hostname ${hostname} exists (${before.customHostname.status}, certificate ${before.customHostname.ssl?.status ?? "none"})`
            : `+ create the custom hostname ${hostname} (TXT ownership, DV certificate validated by TXT, TLS 1.2+)`,
          `• the route ${hostname}/* to the Worker ${site.worker} comes with the next production Frontend deploy`,
        ].join("\n"),
        "Plan",
      );
      if (parsed.dryRun) return { ...before, dryRun: true };

      if (!before.customHostname) {
        await zone("POST", "/custom_hostnames", {
          hostname,
          ssl: { method: "txt", type: "dv", settings: { min_tls_version: "1.2" } },
        });
        ui.success(`Custom hostname ${hostname} created`);
      }
      // The answer to a creation may lack its validation records: read again.
      return inspect(zone, site);
    },
  );

  const records = clientRecords(site, outcome);
  ui.note(
    [
      `At ${hostname}'s DNS (outside Cloudflare):`,
      ...formatRecords(records),
      "",
      "Remove any other _acme-challenge record for the hostname: it stops delegated DCV.",
      CAA_NOTE,
    ].join("\n"),
    "DNS records for the client",
  );
  ui.outro(
    outcome.dryRun
      ? "Dry run: nothing changed."
      : `Next: ${outcome.fallback && !ownsFallback(outcome.fallback, target) ? "" : "set the zone's fallback origin; "}the client adds these records; deploy the production Frontend; gq cloudflare custom-hostname status.`,
  );
  return 0;
}

// One DNS over HTTPS question; resolves to the answers of `type` (data
// only), or null when the lookup failed.
async function resolve(fetch, name, type) {
  try {
    const url = `${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`;
    const response = await fetch(url, {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const answer = await response.json();
    if (answer.Status !== 0 && answer.Status !== 3) return null;
    return (answer.Answer ?? [])
      .filter((record) => record.type === DNS_TYPES[type])
      .map((record) => record.data);
  } catch {
    return null;
  }
}

/**
 * The CAA records that govern `hostname`'s certificate: the first non-empty
 * set from the hostname up to its registrable parent (RFC 8659's climb,
 * stopping above the public suffix it can't know: at two labels), and
 * whether they allow every CA Cloudflare may issue from. No CAA anywhere
 * allows them all. Null when a lookup failed.
 */
export async function caaCheck(fetch, hostname) {
  const labels = hostname.toLowerCase().replace(/\.$/u, "").split(".");
  for (let index = 0; index <= labels.length - 2; index += 1) {
    const name = labels.slice(index).join(".");
    const answers = await resolve(fetch, name, "CAA");
    if (answers === null) return null;
    const records = answers.map(parseCaa).filter(Boolean);
    if (records.length === 0) continue;
    const issuers = records
      .filter(({ tag }) => tag === "issue")
      .map(({ value }) => value.split(";")[0].trim().toLowerCase());
    // Only `issuewild` records still restrict a non-wildcard certificate's
    // issuers when there is no `issue` record: none do.
    const missing =
      issuers.length === 0
        ? []
        : CLOUDFLARE_CAA_ISSUERS.filter((issuer) => !issuers.includes(issuer));
    return { name, records: answers, missing };
  }
  return { name: null, records: [], missing: [] };
}

// A CAA record as DNS over HTTPS writes it: `0 issue "letsencrypt.org"`.
function parseCaa(data) {
  const match = /^\s*\d+\s+(\S+)\s+"?([^"]*)"?\s*$/u.exec(data);
  return match ? { tag: match[1].toLowerCase(), value: match[2] } : null;
}

const MARK = (ok) => (ok ? "✓" : "✗");

// `gq cloudflare custom-hostname status [--json]`. Exits 1 until it is served.
async function status({ context, parsed, fetch, io }) {
  const site = { ...settings(context.config), fetch };
  const { hostname, target, worker } = site;
  const state = await withZone(
    context,
    "cloudflare custom-hostname status",
    site,
    statusPermissions,
    (zone) => inspect(zone, site, { withRoute: true }),
  );
  const cname = await resolve(fetch, hostname, "CNAME");
  const caa = await caaCheck(fetch, hostname);
  const { fallback, customHostname, route } = state;
  const pointsAtTarget =
    cname?.some((value) => value.replace(/\.$/u, "").toLowerCase() === target.toLowerCase()) ??
    false;
  const checks = [
    {
      name: "fallback-origin",
      ok: fallback?.status === "active" && !ownsFallback(fallback, target),
      detail:
        !fallback || ownsFallback(fallback, target)
          ? fallbackLine(fallback, target).slice(2)
          : `the zone's fallback origin ${fallback.origin} is ${fallback.status}${fallback.errors?.length ? `: ${fallback.errors.join("; ")}` : ""}`,
    },
    {
      name: "custom-hostname",
      ok: customHostname?.status === "active",
      detail: customHostname
        ? `the custom hostname ${hostname} is ${customHostname.status}${customHostname.verification_errors?.length ? `: ${customHostname.verification_errors.join("; ")}` : ""}`
        : `there is no custom hostname ${hostname}: run gq cloudflare custom-hostname`,
    },
    {
      name: "certificate",
      ok: customHostname?.ssl?.status === "active",
      detail: customHostname
        ? `its certificate is ${customHostname.ssl?.status ?? "missing"}${customHostname.ssl?.validation_errors?.length ? `: ${customHostname.ssl.validation_errors.map((error) => error.message ?? error).join("; ")}` : ""}`
        : "no certificate without the custom hostname",
    },
    {
      name: "worker-route",
      ok: route?.script === worker,
      detail: route
        ? route.script === worker
          ? `the route ${route.pattern} runs the Worker ${worker}`
          : `the route ${route.pattern} runs ${route.script ?? "no Worker"}, not ${worker}`
        : `there is no route ${hostname}/*: deploy the production Frontend`,
    },
    {
      name: "dns",
      ok: pointsAtTarget,
      detail:
        cname === null
          ? `${hostname}'s CNAME couldn't be looked up`
          : pointsAtTarget
            ? `${hostname} is a CNAME to ${target}`
            : `${hostname} isn't a CNAME to ${target} yet${cname.length ? ` (it is to ${cname.join(", ")})` : ""}`,
    },
    {
      name: "caa",
      ok: caa !== null && caa.missing.length === 0,
      detail:
        caa === null
          ? `${hostname}'s CAA records couldn't be looked up`
          : !caa.name
            ? "no CAA records restrict its certificate"
            : caa.missing.length === 0
              ? `${caa.name}'s CAA records allow Cloudflare's CAs`
              : `${caa.name}'s CAA records (${caa.records.join(", ")}) don't allow ${caa.missing.map((issuer) => `0 issue "${issuer}"`).join(", ")}: the client adds them`,
    },
  ];
  const ready = checks.every((check) => check.ok);
  const records = clientRecords(site, state);

  if (parsed.json) {
    io.out(JSON.stringify({ hostname, target, ready, checks, records }, null, 2));
  } else {
    io.out(`Cloudflare for SaaS · https://${hostname} → ${target}`);
    for (const check of checks) io.out(`  ${MARK(check.ok)} ${check.detail}`);
    io.out(`DNS records for the client (at ${hostname}'s DNS):`);
    for (const line of formatRecords(records)) io.out(`  ${line}`);
    io.out(ready ? `Ready: https://${hostname} is served by ${worker}.` : "Not ready yet.");
  }
  return ready ? 0 : 1;
}

/** `gq cloudflare custom-hostname …`. Resolves to an exit code. */
export function runCustomHostname(dependencies) {
  return dependencies.parsed.command.at(-1) === "status"
    ? status(dependencies)
    : provision(dependencies);
}

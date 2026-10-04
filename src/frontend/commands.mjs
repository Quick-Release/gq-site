// `gq frontend refresh`: the trusted refresh of a content site's published
// content. It asks the deployed Frontend (POST /gq/refresh, the Frontend's
// src/pages/gq/refresh.ts) to read published content from the CMS and promote
// what it read completely into its publication store: the whole Site (front
// page, site chrome and every published page and post, each language's on a
// bilingual Site), or with --uri only the entries at those paths (a new
// publication, or a changed URI). The bearer token is FRONTEND_REFRESH_TOKEN,
// injected by gq sigillo run staging; it is sent only to the Frontend and
// never printed. Exits 1 until everything asked for was refreshed (and, for
// the whole Site, the homepage is ready), so it can gate a script.
//
// `gq frontend events check` proves the deployed Frontend accepts this Site's
// publication events (POST /gq/events, src/pages/gq/events.ts): it sends a
// signed check event, which changes nothing, with PUBLICATION_EVENT_SECRET,
// the key the Site's CMS signs its events with. The secret is never sent or
// printed, only the signature. A Frontend that reconciles with WordPress
// (ADR 0009) also says how its last reconciliation went, which is printed.
//
// `gq frontend secrets` generates the Site's own FRONTEND_REFRESH_TOKEN and
// PUBLICATION_EVENT_SECRET (32 random bytes each, hex) into Sigillo staging
// when they are missing or too short for the Frontend to accept. Values go to
// Sigillo over stdin and are never printed. Deploys, CI releases (gq ci
// deploy) and the CMS (gq ploi events) take them from there.
//
//   gq frontend secrets [--dry-run]
//   gq frontend refresh [--uri <path>]... [--url <frontend origin>] [--json]
//   gq frontend events check [--url <frontend origin>] [--json]

import { createHmac, randomBytes, randomUUID } from "node:crypto";

import { createReporter } from "../cli/reporter.mjs";
import { SECRETS_ENVIRONMENT } from "../cloudflare/tokens.mjs";
import { siteLanguages } from "../manifest/schema.mjs";
import { sigilloSecrets } from "../sigillo/commands.mjs";

export const FRONTEND_USAGE = [
  "gq frontend secrets [--dry-run]",
  "gq frontend refresh [--uri <path>]... [--url <frontend origin>] [--json]",
  "gq frontend events check [--url <frontend origin>] [--json]",
];

/** The Frontend's per-Site secrets; it refuses either when shorter than 32 characters. */
export const FRONTEND_SECRETS = {
  FRONTEND_REFRESH_TOKEN: "the trusted refresh's bearer token (gq frontend refresh)",
  PUBLICATION_EVENT_SECRET: "the key the CMS signs its events with",
};
const MINIMUM_SECRET_LENGTH = 32;

const MARKS = { promoted: "✓", superseded: "✓", kept: "✗" };

/** Without a reconciliation that matched WordPress for this long, it is reported as behind. */
export const RECONCILIATION_STALE_MS = 10 * 60_000;

const COMMANDS = new Map([
  ["frontend secrets", ["dryRun"]],
  ["frontend refresh", ["url", "uri"]],
  ["frontend events check", ["url"]],
]);

export function isFrontendCommand(command) {
  return COMMANDS.has(command.join(" "));
}

export function frontendCommandOptions(command) {
  return COMMANDS.get(command.join(" "));
}

export function frontendOrigin(parsed, ops, path = "/gq/refresh") {
  const origin = parsed.url ?? (ops.domains?.frontend ? `https://${ops.domains.frontend}` : null);
  if (!origin) {
    throw new Error("gq.ops.json domains.frontend is required, or pass --url <frontend origin>.");
  }
  let url;
  try {
    url = new URL(path, origin);
  } catch {
    throw new Error(`--url must be an origin such as https://www.example.com, not ${origin}.`);
  }
  // The token or a signature travels in the request: only to a Frontend over
  // HTTPS, or to this machine (a local runtime proof).
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error(`The refresh token is only sent over HTTPS (or to localhost), not ${origin}.`);
  }
  return url;
}

function requestedUris(parsed) {
  const uris = parsed.uri ?? [];
  for (const uri of uris) {
    if (!uri.startsWith("/") || uri.startsWith("//") || /[?#\s]/u.test(uri)) {
      throw new Error(`--uri must be a path such as /about/, not ${uri}.`);
    }
  }
  return uris;
}

function describe(outcome) {
  if (outcome.outcome === "kept" && outcome.failure) {
    return `kept the stored version (${outcome.failure.reason}): ${outcome.failure.message}`;
  }
  if (!outcome.state) return outcome.outcome;
  return `${outcome.outcome} (${outcome.state}${outcome.uri ? ` to ${outcome.uri}` : ""})`;
}

const REPORTED = new Set(["home", "chrome", "design", "routes", "entries", "moved", "languages"]);

// A bilingual Site's report names each language's front page and chrome: the
// default language's (`home`, `chrome`) by its slug, the others' under
// `languages`.
function printReport(body, io, languages) {
  const lines = [];
  const own = body.languages && languages.length > 0 ? `${languages[0].slug} ` : "";
  if (body.home) lines.push([`${own}front page`, body.home]);
  if (body.chrome) lines.push([`${own}site chrome`, body.chrome]);
  for (const [slug, rows] of Object.entries(body.languages ?? {})) {
    if (rows?.home) lines.push([`${slug} front page`, rows.home]);
    if (rows?.chrome) lines.push([`${slug} site chrome`, rows.chrome]);
  }
  if (body.design) lines.push(["design presets", body.design]);
  // A record a Site adds to its refresh (such as its patterns), by its name.
  for (const [key, value] of Object.entries(body)) {
    if (REPORTED.has(key) || typeof value?.outcome !== "string") continue;
    lines.push([key, value]);
  }
  for (const [label, outcome] of lines) {
    io.out(`  ${MARKS[outcome.outcome] ?? "?"} ${label}: ${describe(outcome)}`);
  }
  if (body.routes) {
    io.out(
      body.routes.outcome === "listed"
        ? `  ✓ published routes: ${body.routes.count} listed`
        : `  ✗ published routes: not listed (${body.routes.failure.reason}): ${body.routes.failure.message}`,
    );
  }
  for (const [route, outcome] of Object.entries(body.entries ?? {})) {
    io.out(`  ${MARKS[outcome.outcome] ?? "?"} ${route}: ${describe(outcome)}`);
  }
  for (const [from, to] of Object.entries(body.moved ?? {})) {
    io.out(`  ✓ ${from}: moved to ${to}, and redirects there`);
  }
}

// Resolves to the exit code: 0 when everything asked for was refreshed (or the
// Frontend accepts this Site's events), 1 when not.
export async function runFrontendCommand({ context, parsed, env, fetch, exec, io, interactive }) {
  if (parsed.command.join(" ") === "frontend events check") {
    return checkEvents({ context, parsed, fetch, io });
  }
  if (parsed.command.join(" ") === "frontend secrets") {
    return generateSecrets({ context, parsed, env, exec, io, interactive });
  }
  const url = frontendOrigin(parsed, context.config);
  const uris = requestedUris(parsed);
  const token = context.env.FRONTEND_REFRESH_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "FRONTEND_REFRESH_TOKEN is missing; add it to Sigillo staging, deploy the Frontend with it and run this through gq sigillo run staging.",
    );
  }

  let response;
  try {
    response = await fetch(url.href, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(uris.length > 0 ? { uris } : {}),
      signal: AbortSignal.timeout(uris.length > 0 ? 30_000 : 300_000),
    });
  } catch (error) {
    throw new Error(`The Frontend at ${url.origin} couldn't be reached: ${error.message}`, {
      cause: error,
    });
  }

  const body = await response.json().catch(() => null);
  const site = uris.length === 0;
  // A Frontend from before entries were stored reports only the homepage.
  const isReport =
    body &&
    typeof body === "object" &&
    (site ? "home" in body && "chrome" in body : typeof body.entries === "object");
  if (!isReport) {
    const reason = body?.error ?? `HTTP ${response.status}`;
    if (parsed.json) io.out(JSON.stringify({ status: response.status, error: reason }, null, 2));
    else io.out(`The Frontend at ${url.origin} refused the refresh: ${reason}`);
    return 1;
  }

  if (parsed.json) {
    io.out(JSON.stringify(body, null, 2));
  } else {
    io.out(`Frontend refresh (${url.origin})`);
    const languages = siteLanguages(context.config);
    printReport(body, io, languages);
    if (!site) {
      io.out(
        body.refreshed
          ? "Refreshed: these entries are served from the publication store."
          : "Not refreshed: entries that kept their stored version are served as before until a refresh succeeds.",
      );
    } else {
      io.out(
        body.ready
          ? body.refreshed
            ? "Ready: published content is served from the publication store."
            : "Ready, but not refreshed: visitors get the last stored versions until a refresh succeeds."
          : languages.length > 0
            ? "Not ready: pages are a 503 until a refresh stores every language's front page and site chrome."
            : "Not ready: pages are a 503 until a refresh stores the front page and the site chrome.",
      );
    }
  }
  return body.refreshed && (!site || body.ready) ? 0 : 1;
}

// `gq frontend secrets [--dry-run]`: generates what Sigillo staging lacks.
// A value this process was given (through gq sigillo run staging) is checked
// for length; one Sigillo lists but didn't inject is kept as it is.
async function generateSecrets({ context, parsed, env, exec, io, interactive }) {
  const secrets = await sigilloSecrets({ context, env, exec }, SECRETS_ENVIRONMENT);
  const listed = await secrets.list();
  const plan = Object.keys(FRONTEND_SECRETS).map((name) => {
    const stored = new RegExp(`\\b${name}\\b`, "u").test(listed);
    const value = context.env[name]?.trim();
    if (!stored) return { name, action: "generate" };
    if (value !== undefined && value.length < MINIMUM_SECRET_LENGTH) {
      return { name, action: "replace" };
    }
    return { name, action: "keep" };
  });

  const ui = createReporter(io, interactive);
  ui.intro(`Frontend secrets · Sigillo ${secrets.name}`);
  ui.note(
    plan
      .map(({ name, action }) =>
        action === "keep"
          ? `✓ ${name} in Sigillo ${secrets.name}`
          : action === "generate"
            ? `+ generate ${name} (${FRONTEND_SECRETS[name]}), store it in Sigillo ${secrets.name}`
            : `~ ${name} is shorter than ${MINIMUM_SECRET_LENGTH} characters, which the Frontend refuses: generate a new one`,
      )
      .join("\n"),
    "Plan (values not shown)",
  );
  const changes = plan.filter(({ action }) => action !== "keep");
  if (changes.length === 0) {
    ui.outro("Nothing to do.");
    return 0;
  }
  if (parsed.dryRun) {
    ui.outro("Dry run: nothing changed.");
    return 0;
  }
  for (const { name } of changes) {
    await secrets.set(name, randomBytes(32).toString("hex"));
    ui.success(`${name} stored in Sigillo ${secrets.name}`);
  }
  ui.outro(
    "Bind them: pnpm ci:deploy (CI releases), then deploy the Frontend (a release or pnpm deploy:frontend); pnpm ploi:events gives the CMS its event key for its next release.",
  );
  return 0;
}

/** The headers the Site's CMS signs an event with: HMAC-SHA256 of "<timestamp>.<body>". */
export function signEvent(body, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return { "GQ-Event-Timestamp": String(timestamp), "GQ-Event-Signature": `v1=${signature}` };
}

/**
 * Sends the Frontend at `url` (its /gq/events) a signed check event, which
 * changes nothing. Resolves to the HTTP status, the answer (null when it isn't
 * JSON) and whether it accepted this Site's key; throws when the Frontend
 * can't be reached.
 */
export async function sendCheckEvent({ url, site, secret, fetch }) {
  const body = JSON.stringify({ site, id: randomUUID(), action: "check", occurredAt: Date.now() });
  let response;
  try {
    response = await fetch(url.href, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...signEvent(body, secret) },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`The Frontend at ${url.origin} couldn't be reached: ${error.message}`, {
      cause: error,
    });
  }
  const answer = await response.json().catch(() => null);
  const accepted = response.status === 200 && answer?.status === "checked" && answer.site === site;
  return { status: response.status, answer, accepted };
}

async function checkEvents({ context, parsed, fetch, io }) {
  const url = frontendOrigin(parsed, context.config, "/gq/events");
  const site = context.config.project;
  if (!site) throw new Error("gq.ops.json project is required.");
  const secret = context.env.PUBLICATION_EVENT_SECRET?.trim();
  if (!secret) {
    throw new Error(
      "PUBLICATION_EVENT_SECRET is missing; add it to Sigillo staging, deploy the Frontend with it and run this through gq sigillo run staging.",
    );
  }

  const { status, answer, accepted } = await sendCheckEvent({ url, site, secret, fetch });
  if (parsed.json) {
    io.out(JSON.stringify({ accepted, status, answer }, null, 2));
  } else if (accepted) {
    io.out(`✓ The Frontend at ${url.origin} accepts ${site}'s publication events.`);
    if ("reconciliation" in answer) io.out(describeReconciliation(answer.reconciliation));
  } else {
    const reason = answer?.error ?? `HTTP ${status}`;
    io.out(`✗ The Frontend at ${url.origin} refused ${site}'s publication events: ${reason}`);
  }
  return accepted ? 0 : 1;
}

/** The Frontend's last reconciliation with WordPress, in one line. */
export function describeReconciliation(reconciliation) {
  if (!reconciliation) {
    return "✗ It hasn't reconciled with WordPress yet: the CMS's cron (gq ploi events) asks for it every minute.";
  }
  const time = (ms) => (ms ? new Date(ms).toISOString() : "never");
  const fresh =
    reconciliation.reconciledAt &&
    Date.now() - reconciliation.reconciledAt <= RECONCILIATION_STALE_MS;
  const failure = reconciliation.reason
    ? ` (${reconciliation.reason}: ${reconciliation.message})`
    : "";
  return `${fresh ? "✓" : "✗"} It last reconciled with WordPress at ${time(reconciliation.startedAt)}: ${reconciliation.outcome ?? "unfinished"}${failure}; it last matched WordPress at ${time(reconciliation.reconciledAt)}.`;
}

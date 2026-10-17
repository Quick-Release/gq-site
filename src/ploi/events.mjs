// Gives the Ploi site's CMS what its publication events need:
//
// - the key it signs them with (PUBLICATION_EVENT_SECRET, from the secret
//   store): the same per-Site secret `pnpm deploy:frontend` and CI releases
//   bind to the Frontend, so the Frontend accepts this CMS's events and no
//   other's. Sets that one .env line and leaves every other as it is; never
//   shows the value.
// - the crontab that retries the events the Frontend didn't confirm
//   (`wp gq-events retry-due`, every minute, as the site's system user;
//   ADR 0008), then asks the Frontend to reconcile with WordPress (ADR 0009).
//   Production disables WP-Cron, which would only run on visits anyway, so
//   this is the CMS's only background scheduler.
//
// Idempotent.
//
//   gq ploi events [--dry-run]

import { applyEnv } from "../dotenv-text.mjs";
import { createReporter } from "../cli/reporter.mjs";
import { refuseOnCommerce } from "../manifest/variant.mjs";
import { createPloiServerClient } from "./server-client.mjs";

export const EVENT_SECRET = "PUBLICATION_EVENT_SECRET";

/** What the cron runs: the CMS's delivery-retries.php sends what is due. */
export const RETRY_COMMAND = "wp gq-events retry-due --quiet";

/**
 * The retry crontab for a Ploi site: every minute, as its system user, from
 * its Bedrock app (Ploi keeps a site in /home/<user>/<domain>). WP-CLI is in
 * /usr/local/bin on Ploi servers, which cron's PATH leaves out.
 */
export function retryCrontab({ systemUser, domain }) {
  for (const [name, value] of Object.entries({ systemUser, domain })) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value ?? "")) {
      throw new Error(
        `The Ploi site's ${name} ${JSON.stringify(value)} can't be used in a crontab.`,
      );
    }
  }
  return {
    user: systemUser,
    frequency: "* * * * *",
    command: `cd /home/${systemUser}/${domain}/apps/cms && PATH="/usr/local/bin:$PATH" ${RETRY_COMMAND}`,
  };
}

/**
 * What the Ploi site's CMS has for its events: its .env with `secret` applied
 * (`changed` names PUBLICATION_EVENT_SECRET when it is missing or differs;
 * values are never returned), the retry crontab it needs, and the one it has,
 * if any. Read-only. `gq ploi events` applies it; `gq site check` reports it.
 */
export async function inspectCmsEvents({ ops, token, secret, fetch }) {
  const client = createPloiServerClient({ token, serverId: ops.ploi.serverId, fetch });
  const sitePath = `/sites/${ops.ploi.siteId}`;
  const response = await client.request("GET", `${sitePath}/env`);
  const current = response?.data ?? response?.env;
  if (typeof current !== "string" || !current.trim()) {
    throw new Error("The Ploi site has no .env yet; run gq ploi provision first.");
  }
  const { output, changed } = applyEnv(current, { [EVENT_SECRET]: secret });

  const site = (await client.request("GET", sitePath))?.data ?? {};
  const crontab = retryCrontab({
    systemUser: site.system_user ?? ops.ploi.systemUser,
    domain: site.domain ?? ops.domains?.admin,
  });
  const crontabs = (await client.request("GET", "/crontabs"))?.data ?? [];
  const existing = crontabs.find(
    (entry) => entry.user === crontab.user && entry.command === crontab.command,
  );
  return { client, sitePath, output, changed, crontab, existing };
}

// `gq ploi events [--dry-run]`. Resolves to an exit code.
export async function runEvents({ context, parsed, fetch, io, interactive }) {
  const ops = context.config;
  refuseOnCommerce(
    ops,
    "gq ploi events",
    "it has no publication events; gq ploi provision gives its CMS the storefront's proxy secret.",
  );
  if (!ops.ploi?.siteId) throw new Error("gq.ops.json ploi.siteId is required.");
  const secret = context.env[EVENT_SECRET]?.trim();
  if (!secret) {
    throw new Error(
      `${EVENT_SECRET} is missing; add it to Sigillo staging (openssl rand -hex 32) and run this through gq sigillo run staging.`,
    );
  }
  if (secret.length < 32) {
    throw new Error(
      `${EVENT_SECRET} must be at least 32 characters; the Frontend refuses shorter ones.`,
    );
  }

  const ui = createReporter(io, interactive);
  ui.intro("Ploi · publication events");
  const { client, sitePath, output, changed, crontab, existing } = await inspectCmsEvents({
    ops,
    token: context.env.PLOI_API_TOKEN,
    secret,
    fetch,
  });
  if (existing && existing.frequency !== crontab.frequency) {
    ui.warn(
      `The retry crontab runs at "${existing.frequency}", not every minute; retries are only as frequent.`,
    );
  }

  const plan = [
    ...changed.map((name) => `~ ${name}`),
    ...(existing ? [] : [`+ crontab (${crontab.user}, ${crontab.frequency}): ${crontab.command}`]),
  ];
  if (plan.length === 0) {
    ui.outro(
      `The Ploi site already has this Site's ${EVENT_SECRET} and the delivery retry crontab.`,
    );
    return 0;
  }
  ui.note(plan.join("\n"), "Plan (values not shown)");
  if (parsed.dryRun) {
    ui.outro("Dry run: nothing changed.");
    return 0;
  }
  if (changed.length > 0) {
    await client.request("PATCH", `${sitePath}/env`, { content: output });
  }
  if (!existing) await client.request("POST", "/crontabs", crontab);
  ui.outro(
    "Updated. The next release copies the .env into the CMS; then `wp gq-events check` there proves the Frontend accepts its events, and `wp gq-events delays` shows the retry scheduler's last run.",
  );
  return 0;
}

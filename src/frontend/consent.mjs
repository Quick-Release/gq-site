// The Frontend's consent records (ADR 0019): one D1 database per Site and
// stage, `<project>-fe-consent[-<stage>]`, created by the Frontend's deploy
// (infra/frontend.run.ts) in the `eu` jurisdiction. Cloudflare sets a D1
// database's jurisdiction at creation and can't change it, so one created
// elsewhere holds visitors' consent records outside the EU until it is
// replaced.

import { createCloudflareAccountClient } from "../cloudflare/account-client.mjs";

// infra/consent.ts declares the same jurisdiction and names for the deploy;
// keep them together.
export const CONSENT_JURISDICTION = "eu";

/** The Frontend's consent read token (Sigillo, the Worker) and the CMS .env line GQ Config reads it from. */
export const CONSENT_READ_TOKEN = "CONSENT_READ_TOKEN";
export const CMS_CONSENT_READ_TOKEN = "GETQUICK_CONSENT_READ_TOKEN";

/** The production consent database's name; another stage's adds `-<stage>`. */
export function consentDatabaseName(project) {
  return `${project}-fe-consent`;
}

/**
 * Every stage's consent database in the account, as { name, jurisdiction }
 * ("default" when Cloudflare reports none). Cloudflare's `name` filter also
 * matches other names containing it; only this Site's are kept. A listing
 * entry without the field is read on its own, so a database is never judged
 * by an omission.
 */
export async function listConsentDatabases({ accountId, token, fetch, project }) {
  const name = consentDatabaseName(project);
  const client = createCloudflareAccountClient({ token, accountId, fetch });
  const path = `/d1/database?name=${encodeURIComponent(name)}`;
  const databases = (await client("GET", path, undefined, { paginate: true })).filter(
    (database) => database.name === name || database.name?.startsWith(`${name}-`),
  );
  const result = [];
  for (const database of databases) {
    const { jurisdiction } =
      "jurisdiction" in database
        ? database
        : ((await client("GET", `/d1/database/${database.uuid}`)) ?? {});
    result.push({ name: database.name, jurisdiction: jurisdiction ?? "default" });
  }
  return result;
}

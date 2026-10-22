// The Frontend's consent records (ADR 0019): one D1 database per Site and
// stage, `<project>-fe-consent[-<stage>]`, created by the Frontend's deploy
// (infra/frontend.run.ts) in the `eu` jurisdiction. Cloudflare sets a D1
// database's jurisdiction at creation and can't change it, so one created
// elsewhere holds visitors' consent records outside the EU until it is
// replaced.

import { createCloudflareAccountClient } from "../cloudflare/account-client.mjs";

export const CONSENT_JURISDICTION = "eu";

/** The production consent database's name; another stage's adds `-<stage>`. */
export function consentDatabaseName(project) {
  return `${project}-fe-consent`;
}

/**
 * Every stage's consent database in the account, as { name, jurisdiction }
 * ("default" when Cloudflare reports none). Cloudflare's `name` filter also
 * matches other names containing it; only this Site's are kept.
 */
export async function listConsentDatabases({ accountId, token, fetch, project }) {
  const name = consentDatabaseName(project);
  const client = createCloudflareAccountClient({ token, accountId, fetch });
  const path = `/d1/database?name=${encodeURIComponent(name)}`;
  const databases = await client("GET", path, undefined, { paginate: true });
  return databases
    .filter((database) => database.name === name || database.name?.startsWith(`${name}-`))
    .map((database) => ({
      name: database.name,
      jurisdiction: database.jurisdiction ?? "default",
    }));
}

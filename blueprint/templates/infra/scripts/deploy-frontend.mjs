#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const alchemy = process.platform === "win32" ? "alchemy.cmd" : "alchemy";
// Public deploy configuration lives in gq.ops.json; only the API token comes
// from Sigillo/CI. Without PUBLIC_WORDPRESS_GRAPHQL_URL the frontend would
// fall back to the local DDEV endpoint, so it is always set here.
const ops = JSON.parse(readFileSync(new URL("../../gq.ops.json", import.meta.url), "utf8"));

// An offboarded Site (gq offboard) stays cut: a deploy would attach its
// domain again.
if (ops.offboarded) {
  console.error(
    `${ops.project} is offboarded (gq.ops.json offboarded): deploying the Frontend would expose it again. If the Site is coming back, run gq offboard --restore first.`,
  );
  process.exit(1);
}

// A Frontend with the publication store (its own apps/frontend/migrations,
// or, on the content package pair, @getquick/content's `./migrations`,
// installed in apps/frontend: frontend.run.ts's rule) is
// refreshed with FRONTEND_REFRESH_TOKEN and receives the CMS's publication
// events signed with PUBLICATION_EVENT_SECRET, both from Sigillo staging and
// bound to the Worker as secrets. Deploying without one disables refresh or
// events, not serving. Their values are never printed.
const frontendApp = new URL("../../apps/frontend/", import.meta.url);
const contentPackage = new URL("node_modules/@getquick/content/package.json", frontendApp);
if (
  existsSync(new URL("migrations", frontendApp)) ||
  (ops.contentRuntime === "package" &&
    existsSync(contentPackage) &&
    typeof JSON.parse(readFileSync(contentPackage, "utf8")).exports?.["./migrations"]?.import ===
      "string")
) {
  const secrets = {
    FRONTEND_REFRESH_TOKEN: "gq frontend refresh",
    PUBLICATION_EVENT_SECRET: "the CMS's publication events",
  };
  for (const [name, disables] of Object.entries(secrets)) {
    const value = process.env[name]?.trim();
    if (value && value.length < 32) {
      console.error(`${name} must be at least 32 characters; the Frontend refuses shorter ones.`);
      process.exit(1);
    }
    if (!value) {
      console.warn(
        `${name} isn't set: this deploy disables ${disables}. ` +
          `What the publication store holds is still served. Add it to Sigillo staging.`,
      );
    }
  }
}

// A Frontend with a consent Runtime (infra/consent.ts) serves its CMS consent
// record reads with CONSENT_READ_TOKEN, from Sigillo staging and bound to the
// Worker as a secret. Deploying without it disables those reads, not
// recording. Its value is never printed.
const consentToken = process.env.CONSENT_READ_TOKEN?.trim();
if (consentToken && consentToken.length < 32) {
  console.error(
    "CONSENT_READ_TOKEN must be at least 32 characters; the Frontend refuses shorter ones.",
  );
  process.exit(1);
}
// Whether the deploy records consent, by infra/consent.ts's rule: the
// Frontend's @getquick/content exports its consent migrations.
const content = new URL(
  "../../apps/frontend/node_modules/@getquick/content/package.json",
  import.meta.url,
);
const consentRecords =
  existsSync(content) &&
  Boolean(JSON.parse(readFileSync(content, "utf8")).exports?.["./consent/migrations"]);
if (!consentToken && consentRecords) {
  console.warn(
    "CONSENT_READ_TOKEN isn't set: this deploy disables the CMS's consent record reads. " +
      "Visitors' decisions are still recorded. Run gq frontend secrets.",
  );
}

const result = spawnSync(
  alchemy,
  [
    "deploy",
    "--stage",
    "prod",
    "--config",
    "frontend.run.ts",
    "--yes",
    "--no-input",
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || ops.cloudflare.accountId,
      PUBLIC_WORDPRESS_GRAPHQL_URL:
        process.env.PUBLIC_WORDPRESS_GRAPHQL_URL ||
        `https://${ops.domains.admin}${ops.wordpress?.graphqlPath ?? "/wp/graphql"}`,
    },
  },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

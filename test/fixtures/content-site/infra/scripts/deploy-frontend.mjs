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

// A Frontend with the publication store (apps/frontend/migrations) is
// refreshed with FRONTEND_REFRESH_TOKEN and receives the CMS's publication
// events signed with PUBLICATION_EVENT_SECRET, both from Sigillo staging and
// bound to the Worker as secrets. Deploying without one disables refresh or
// events, not serving. Their values are never printed.
if (existsSync(new URL("../../apps/frontend/migrations", import.meta.url))) {
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

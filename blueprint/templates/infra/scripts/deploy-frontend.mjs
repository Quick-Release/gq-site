#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

// Deploys the Frontend; `pnpm plan:frontend` runs it with `--dry-run
// --detailed`, so a plan has the same checks, account and bindings as the
// deploy it previews. Arguments pass through to `alchemy deploy`, apart from
// the guards' own `--drop-secret <NAME>` and `--upgrade-state-store` (below).
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

// The managed infra imports Alchemy's Cloudflare provider from its own
// package, and Alchemy's CLI finds the Cloudflare state store and credentials
// only through it: a deploy without it installed in infra can't run.
try {
  import.meta.resolve("@alchemy.run/cloudflare");
} catch {
  console.error(
    "@alchemy.run/cloudflare isn't installed in infra, and the managed infra deploys with it. Run gq sync, then pnpm install.",
  );
  process.exit(1);
}

// Validate before invoking Alchemy; secret values are never logged.
if (
  ops.preview !== undefined ||
  process.env.GQ_PREVIEW_CMS_USERNAME !== undefined ||
  process.env.GQ_PREVIEW_CMS_APPLICATION_PASSWORD !== undefined ||
  process.env.GQ_PREVIEW_ACCESS_CLIENT_ID !== undefined ||
  process.env.GQ_PREVIEW_ACCESS_CLIENT_SECRET !== undefined
) {
  const { previewBindings } = await import("@getquick/site/preview-bindings");
  previewBindings(ops, process.env, () => undefined);
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

// A Site with headless forms (gq.ops.json `forms`) that chose Turnstile
// needs both of its keys from Sigillo staging: without them the form
// endpoint refuses every post, so the deploy stops here instead. The Access
// service token for the CMS's submissions path is optional, both or neither.
if (ops.forms?.spam?.includes("turnstile")) {
  const missing = ["TURNSTILE_SECRET_KEY", "TURNSTILE_SITE_KEY"].filter(
    (name) => !process.env[name]?.trim(),
  );
  if (missing.length > 0) {
    console.error(
      `gq.ops.json forms.spam chooses Turnstile, but ${missing.join(" and ")} ${missing.length === 1 ? "isn't" : "aren't"} set: add ${missing.length === 1 ? "it" : "them"} to Sigillo staging (@getquick/site docs/guides/forms.md).`,
    );
    process.exit(1);
  }
}
if (
  Boolean(process.env.GQ_FORMS_ACCESS_CLIENT_ID?.trim()) !==
  Boolean(process.env.GQ_FORMS_ACCESS_CLIENT_SECRET?.trim())
) {
  console.error(
    "GQ_FORMS_ACCESS_CLIENT_ID and GQ_FORMS_ACCESS_CLIENT_SECRET must be set together.",
  );
  process.exit(1);
}

// The guards (@getquick/site/deploy-guards): no secret the Worker has bound
// is unbound unless `--drop-secret <NAME>` names it; the account's Alchemy
// state store is upgraded only with `--upgrade-state-store`; a plan fails on
// any replacement, deletion or removed binding and reports compatibility-flag
// changes; a deploy compares the Worker's bindings and flags before and
// after. Secret values are never read.
const { guardedFrontendDeploy } = await import("@getquick/site/deploy-guards");
// The installed provider's version: its package.json, found from its entry.
let cloudflarePackage = new URL("package.json", import.meta.resolve("@alchemy.run/cloudflare"));
while (
  !existsSync(cloudflarePackage) ||
  JSON.parse(readFileSync(cloudflarePackage, "utf8")).name !== "@alchemy.run/cloudflare"
) {
  const parent = new URL("../package.json", cloudflarePackage);
  if (parent.href === cloudflarePackage.href) {
    throw new Error("@alchemy.run/cloudflare's package.json wasn't found.");
  }
  cloudflarePackage = parent;
}
const cloudflareVersion = JSON.parse(readFileSync(cloudflarePackage, "utf8")).version;
const env = {
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || ops.cloudflare?.accountId,
  PUBLIC_WORDPRESS_GRAPHQL_URL:
    process.env.PUBLIC_WORDPRESS_GRAPHQL_URL ||
    `https://${ops.domains.admin}${ops.wordpress?.graphqlPath ?? "/wp/graphql"}`,
};

const code = await guardedFrontendDeploy({
  argv: process.argv.slice(2),
  env,
  accountId: env.CLOUDFLARE_ACCOUNT_ID,
  scriptName: `${ops.project}-fe`,
  cloudflareVersion,
  // Alchemy's output streams through and is kept for the plan check.
  runAlchemy: (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(alchemy, args, { stdio: ["inherit", "pipe", "pipe"], env });
      let output = "";
      child.stdout.on("data", (chunk) => {
        process.stdout.write(chunk);
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        process.stderr.write(chunk);
        output += chunk;
      });
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, output }));
    }),
});
process.exit(code);

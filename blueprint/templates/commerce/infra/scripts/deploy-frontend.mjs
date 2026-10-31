#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { findStorefrontRuntime, storefrontBindings } from "../storefront-bindings.ts";

// Deploys the Frontend; `pnpm plan:frontend` runs it with `--dry-run
// --detailed`, so a plan has the same checks, account and bindings as the
// deploy it previews. Arguments pass through to `alchemy deploy`.
const alchemy = process.platform === "win32" ? "alchemy.cmd" : "alchemy";
// Public deploy configuration lives in gq.ops.json; the API token and the
// storefront's secrets come from Sigillo/CI.
const ops = JSON.parse(readFileSync(new URL("../../gq.ops.json", import.meta.url), "utf8"));

// An offboarded Site (gq offboard) stays cut: a deploy would attach its
// domain again.
if (ops.offboarded) {
  console.error(
    `${ops.project} is offboarded (gq.ops.json offboarded): deploying the Frontend would expose it again. If the Site is coming back, run gq offboard --restore first.`,
  );
  process.exit(1);
}

// A protected Site (gq.ops.json deployment) deploys only while its
// deployment.state is "authorized", the same hold gq ploi release and the CI
// release step apply; a reviewed Site change lifts it, never a flag.
const policy = ops.deployment;
if (policy && policy.state !== "authorized") {
  const who = policy.state === "reserved" ? ` is reserved by ${policy.holder}` : " is paused";
  console.error(
    `${ops.project}${who} (gq.ops.json deployment.state: ${policy.state}): ${policy.reason}. Nothing was uploaded, synced or deployed. A reviewed Site change that sets deployment.state to "authorized" lifts the deployment hold.`,
  );
  process.exit(1);
}

// A storefront with the storefront Runtime needs every binding the Runtime
// declares: refused here, by name, before anything is deployed. Values are
// never printed.
const runtime = findStorefrontRuntime(new URL("../../apps/frontend/package.json", import.meta.url));
if (runtime !== undefined) {
  const { missing } = storefrontBindings({ ops, ...runtime, stage: "prod", env: process.env });
  if (missing.length > 0) {
    console.error(
      `The storefront Runtime needs ${missing.join(", ")} to deploy: secrets come from ` +
        "Sigillo staging (pnpm frontend:secrets), rate-limit namespaces from gq.ops.json.",
    );
    process.exit(1);
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
      CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || ops.cloudflare?.accountId,
    },
  },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

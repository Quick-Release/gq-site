// Provisions the scoped Cloudflare token the frontend deploys with, using the
// account's token-manager token:
//
//   1. find or create "GETQUICK <PROJECT> Staging Alchemy" (account Workers
//      permissions, D1 for the Frontend's publication store, + Zone Read /
//      DNS Write / Workers Routes Write on the gq.ops.json cloudflare.zoneId
//      zone only)
//   2. store its value in Sigillo `staging` as CLOUDFLARE_API_TOKEN
//
// Idempotent: nothing is created when the token exists and Sigillo already
// has its value. A token whose value was lost is rolled; one created before
// a permission was added here (D1) gets it, keeping its value.
//
//   gq cloudflare deploy-token [--dry-run]

import { createReporter } from "../cli/reporter.mjs";
import { sigilloSecrets } from "../sigillo/commands.mjs";
import { createCloudflareAccountClient } from "./account-client.mjs";
import {
  accountPolicy,
  applyToken,
  inspectTokens,
  managerToken,
  SECRETS_ENVIRONMENT,
  tokenName,
  zonePolicy,
} from "./tokens.mjs";

const SECRET = "CLOUDFLARE_API_TOKEN";

export const accountPermissions = [
  "Account Settings Read",
  // The publication store: Alchemy creates the Site's D1 database and
  // applies the Frontend's migrations on deploy (ADR 0003).
  "D1 Read",
  "D1 Write",
  "Secrets Store Read",
  "Secrets Store Write",
  "Workers Metadata Read-Only",
  "Workers Observability Write",
  "Workers Routes Read",
  "Workers Routes Write",
  "Workers Scripts Read",
  "Workers Scripts Write",
];
export const zonePermissions = ["Zone Read", "DNS Write", "Workers Routes Write"];

export function deployTokenSpec({ project, accountId, zoneId }) {
  return {
    name: tokenName(project, "Staging Alchemy"),
    secrets: [SECRET],
    permissions: [...accountPermissions, ...zonePermissions],
    policies: (groups) => [
      accountPolicy(accountId, accountPermissions, groups),
      zonePolicy(zoneId, zonePermissions, groups),
    ],
    values: async (token) => ({ [SECRET]: token.value }),
  };
}

// `gq cloudflare deploy-token [--dry-run]`. Resolves to an exit code.
export async function runDeployToken({ context, parsed, env, fetch, exec, io, interactive }) {
  const ops = context.config;
  const { accountId, zoneId, zoneName } = ops.cloudflare ?? {};
  if (!accountId) throw new Error("gq.ops.json cloudflare.accountId is required.");
  if (!zoneId) {
    throw new Error(
      `gq.ops.json cloudflare.zoneId is required: copy the ${zoneName ?? "zone"} Zone ID from the Cloudflare dashboard (Overview, right sidebar).`,
    );
  }
  const token = managerToken(context, "cloudflare deploy-token");
  const request = createCloudflareAccountClient({ token, accountId, fetch });
  const secrets = await sigilloSecrets({ context, env, exec }, SECRETS_ENVIRONMENT);
  const spec = deployTokenSpec({ project: ops.project, accountId, zoneId });

  const ui = createReporter(io, interactive);
  ui.intro(`Cloudflare deploy token · ${spec.name}`);
  const spin = ui.spinner();
  spin.start("Inspecting Cloudflare and Sigillo");
  let planned;
  try {
    [planned] = await inspectTokens(request, secrets, [spec]);
  } catch (error) {
    spin.error("Could not inspect");
    throw error;
  }
  spin.stop("Inspected");

  const { plan, missing } = planned;
  ui.note(
    [
      {
        ok: `✓ token exists and Sigillo ${secrets.name} has ${SECRET}`,
        update: `✓ token exists and Sigillo ${secrets.name} has ${SECRET}`,
        create: `+ create token, store it in Sigillo ${secrets.name}`,
        roll: `~ token exists but Sigillo has no value: roll it, store the new value in Sigillo`,
      }[plan],
      ...(missing.length > 0 && plan !== "create"
        ? [`~ add ${missing.join(", ")} to its permissions (its value is kept)`]
        : []),
    ].join("\n"),
    "Plan",
  );
  if (plan === "ok" || parsed.dryRun) {
    ui.outro(plan === "ok" ? "Nothing to do." : "Dry run: nothing changed.");
    return 0;
  }

  const step = ui.spinner();
  step.start(
    { create: "Creating token", roll: "Rolling token", update: "Updating its permissions" }[plan],
  );
  try {
    const groups =
      plan === "create" || missing.length > 0
        ? await request("GET", "/tokens/permission_groups")
        : [];
    step.message(`Storing in Sigillo ${secrets.name}`);
    await applyToken(request, secrets, planned, groups);
  } catch (error) {
    step.error("Failed");
    throw error;
  }
  step.stop(`Token ready in Sigillo ${secrets.name}`);
  ui.outro(`The frontend deploy reads ${SECRET} from Sigillo ${secrets.name}.`);
  return 0;
}

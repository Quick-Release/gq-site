// Provisions what the site's Cloudflare CI Worker needs (Lombardi's
// cloudflare-ci.mjs), with the account's token-manager token. Idempotent;
// secrets go to Sigillo `staging`, never printed:
//
//   • "GETQUICK <PROJECT> Artifacts" token (Artifacts read/write)
//       → ARTIFACTS_API_TOKEN: creates the repo, mints short-lived git tokens
//   • Artifacts namespace + repository from gq.ops.json `artifacts`, the
//     namespace in `artifacts.jurisdiction` (default "eu"); an existing one
//     elsewhere stops it, since Cloudflare can't move a namespace
//   • private R2 bucket `ci.backupBucket` for CI workspace snapshots, and a
//     "GETQUICK <PROJECT> CI Backups R2" key scoped to it
//       → CI_BACKUP_R2_ACCESS_KEY_ID / CI_BACKUP_R2_SECRET_ACCESS_KEY
//   • "GETQUICK <PROJECT> CI Deploy" token (Workers, Containers, Artifacts,
//     R2 read) → CI_DEPLOY_API_TOKEN: `gq ci deploy` deploys the Worker with it
//
//   gq cloudflare ci [--dry-run]

import { createReporter } from "../cli/reporter.mjs";
import { artifactsJurisdiction, DEFAULT_ARTIFACTS_JURISDICTION } from "../manifest/schema.mjs";
import { sigilloSecrets } from "../sigillo/commands.mjs";
import { createArtifactsClient, createCloudflareAccountClient } from "./account-client.mjs";
import {
  accountPolicy,
  applyToken,
  bucketTokenSpec,
  ensureBucketWithTemporaryToken,
  inspectTokens,
  managerToken,
  SECRETS_ENVIRONMENT,
  tokenName,
} from "./tokens.mjs";

export const artifactsPermissions = ["Artifacts Read", "Artifacts Write"];
export const ciDeployPermissions = [
  "Account Settings Read",
  "Artifacts Read",
  "Workers Containers Read",
  "Workers Containers Write",
  "Workers Observability Write",
  "Workers R2 Storage Read",
  "Workers Scripts Read",
  "Workers Scripts Write",
];

// Each token maps its value to the Sigillo secrets it feeds.
export function ciTokenSpecs({ project, accountId, backupBucket }) {
  return [
    {
      name: tokenName(project, "Artifacts"),
      secrets: ["ARTIFACTS_API_TOKEN"],
      policies: (groups) => [accountPolicy(accountId, artifactsPermissions, groups)],
      values: async (token) => ({ ARTIFACTS_API_TOKEN: token.value }),
    },
    bucketTokenSpec({
      name: tokenName(project, "CI Backups R2"),
      accountId,
      bucket: backupBucket,
      accessKeySecret: "CI_BACKUP_R2_ACCESS_KEY_ID",
      secretKeySecret: "CI_BACKUP_R2_SECRET_ACCESS_KEY",
    }),
    {
      name: tokenName(project, "CI Deploy"),
      secrets: ["CI_DEPLOY_API_TOKEN"],
      policies: (groups) => [accountPolicy(accountId, ciDeployPermissions, groups)],
      values: async (token) => ({ CI_DEPLOY_API_TOKEN: token.value }),
    },
  ];
}

// Why an existing namespace's jurisdiction (`current`) can't serve the one
// gq.ops.json `artifacts.jurisdiction` names (`configured`), and the ways out:
// Cloudflare can't move a namespace, but deleting one frees its name.
export function jurisdictionMismatchMessage({ accountId, namespace, current, configured }) {
  const fallback = configured === DEFAULT_ARTIFACTS_JURISDICTION ? " (the default)" : "";
  return (
    `Artifacts namespace ${namespace} is ${current}, but gq.ops.json artifacts.jurisdiction ` +
    `is ${configured}${fallback}, and Cloudflare can't change a namespace's jurisdiction. ` +
    `Either set artifacts.jurisdiction to "${current}", or delete the namespace ` +
    `(DELETE /accounts/${accountId}/artifacts/namespaces/${namespace}), run gq cloudflare ci ` +
    "to create it again, and push the code to it again."
  );
}

// Fails at an existing namespace outside `jurisdiction`; resolves to whether
// the namespace exists.
async function checkNamespace(artifacts, { accountId, namespace, jurisdiction }) {
  const existing = await artifacts.findNamespace(namespace);
  if (existing && existing.jurisdiction !== jurisdiction) {
    throw new Error(
      jurisdictionMismatchMessage({
        accountId,
        namespace,
        current: existing.jurisdiction,
        configured: jurisdiction,
      }),
    );
  }
  return existing !== null;
}

// `gq cloudflare ci [--dry-run]`. Resolves to an exit code.
export async function runCloudflareCi({ context, parsed, env, fetch, exec, io, interactive }) {
  const ops = context.config;
  const accountId = ops.cloudflare?.accountId;
  const { namespace, repo } = ops.artifacts ?? {};
  const jurisdiction = artifactsJurisdiction(ops);
  const backupBucket = ops.ci?.backupBucket;
  if (!accountId || !namespace || !repo || !backupBucket) {
    throw new Error(
      "gq.ops.json needs cloudflare.accountId, artifacts.namespace/repo and ci.backupBucket.",
    );
  }
  const token = managerToken(context, "cloudflare ci");
  const request = createCloudflareAccountClient({ token, accountId, fetch });
  const secrets = await sigilloSecrets({ context, env, exec }, SECRETS_ENVIRONMENT);
  const specs = ciTokenSpecs({ project: ops.project, accountId, backupBucket });

  const ui = createReporter(io, interactive);
  ui.intro(`Cloudflare CI setup · ${namespace}/${repo}`);
  const spin = ui.spinner();
  spin.start("Inspecting Cloudflare and Sigillo");
  let plans;
  // Known only with a stored Artifacts token; otherwise checked once the
  // token is created, still before the repository.
  let namespaceExists;
  try {
    plans = await inspectTokens(request, secrets, specs);
    if (plans.find(({ spec }) => spec.secrets.includes("ARTIFACTS_API_TOKEN")).plan === "ok") {
      const token = await secrets.get("ARTIFACTS_API_TOKEN");
      const artifacts = createArtifactsClient({ accountId, token, fetch });
      namespaceExists = await checkNamespace(artifacts, { accountId, namespace, jurisdiction });
    }
  } catch (error) {
    spin.error("Could not inspect");
    throw error;
  }
  spin.stop("Inspected");

  const symbol = { ok: "✓", create: "+", roll: "~" };
  ui.note(
    [
      ...plans.map(({ spec, plan }) => `${symbol[plan]} ${spec.name} → ${spec.secrets.join(", ")}`),
      `• bucket ${backupBucket}: created if missing`,
      namespaceExists
        ? `✓ Artifacts namespace ${namespace} (${jurisdiction}); repository ${repo}: created if missing`
        : `• Artifacts namespace ${namespace} (${jurisdiction}) and repository ${repo}: created if missing`,
    ].join("\n"),
    "Plan",
  );
  if (parsed.dryRun) {
    ui.outro("Dry run: nothing changed.");
    return 0;
  }

  const step = ui.spinner();
  step.start("Applying");
  try {
    const groups = await request("GET", "/tokens/permission_groups");
    step.message(`Ensuring bucket ${backupBucket}`);
    await ensureBucketWithTemporaryToken(
      request,
      { accountId, bucket: backupBucket, project: ops.project, purpose: "CI backups", fetch },
      groups,
    );

    let artifactsToken;
    for (const planned of plans) {
      if (planned.plan === "ok") continue;
      step.message(`${planned.plan === "create" ? "Creating" : "Rolling"} ${planned.spec.name}`);
      const values = await applyToken(request, secrets, planned, groups);
      if (values.ARTIFACTS_API_TOKEN) artifactsToken = values.ARTIFACTS_API_TOKEN;
    }

    // Freshly created/rolled above, or read from Sigillo into memory.
    artifactsToken ??= await secrets.get("ARTIFACTS_API_TOKEN");
    step.message(`Ensuring Artifacts ${namespace}/${repo}`);
    const artifacts = createArtifactsClient({ accountId, token: artifactsToken, fetch });
    await checkNamespace(artifacts, { accountId, namespace, jurisdiction });
    const repository = await artifacts.ensureRepository(namespace, repo, { jurisdiction });
    step.stop(`CI setup complete · remote ${repository.remote}`);
  } catch (error) {
    step.error("Failed");
    throw error;
  }
  ui.outro("Next: gq ci deploy, then gq git artifacts setup");
  return 0;
}

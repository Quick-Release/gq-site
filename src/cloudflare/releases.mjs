// Provisions the private R2 bucket that holds admin release archives and the
// S3 credentials `gq ploi release` uses, with the account's token-manager
// token:
//
//   1. create the gq.ops.json releases.bucket (with a 1-hour token that can
//      only manage buckets, deleted right after)
//   2. find or create "GETQUICK <PROJECT> Releases R2": object read/write on
//      that bucket only
//   3. store its S3 credentials in Sigillo `staging` as R2_ACCESS_KEY_ID /
//      R2_SECRET_ACCESS_KEY
//
// Idempotent: nothing changes when the token exists and Sigillo has both
// values; a token whose stored value is missing is rolled.
//
//   gq cloudflare releases [--dry-run]

import { createReporter } from "../cli/reporter.mjs";
import { sigilloSecrets } from "../sigillo/commands.mjs";
import { createCloudflareAccountClient } from "./account-client.mjs";
import {
  applyToken,
  bucketTokenSpec,
  ensureBucketWithTemporaryToken,
  inspectTokens,
  managerToken,
  SECRETS_ENVIRONMENT,
  tokenName,
} from "./tokens.mjs";

// `gq cloudflare releases [--dry-run]`. Resolves to an exit code.
export async function runReleases({ context, parsed, env, fetch, exec, io, interactive }) {
  const ops = context.config;
  const accountId = ops.cloudflare?.accountId;
  const bucket = ops.releases?.bucket;
  if (!accountId || !bucket) {
    throw new Error("gq.ops.json cloudflare.accountId and releases.bucket are required.");
  }
  const token = managerToken(context, "cloudflare releases");
  const request = createCloudflareAccountClient({ token, accountId, fetch });
  const secrets = await sigilloSecrets({ context, env, exec }, SECRETS_ENVIRONMENT);
  const spec = bucketTokenSpec({
    name: tokenName(ops.project, "Releases R2"),
    accountId,
    bucket,
    accessKeySecret: "R2_ACCESS_KEY_ID",
    secretKeySecret: "R2_SECRET_ACCESS_KEY",
  });

  const ui = createReporter(io, interactive);
  ui.intro(`R2 releases · ${bucket}`);
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

  ui.note(
    [
      `• bucket ${bucket}: created if missing (1-hour token, deleted after)`,
      {
        ok: `✓ ${spec.name} exists and Sigillo ${secrets.name} has its S3 credentials`,
        create: `+ create ${spec.name} (object read/write on ${bucket} only), store S3 credentials in Sigillo ${secrets.name}`,
        roll: `~ ${spec.name} exists but Sigillo lacks its credentials: roll it and store them`,
      }[planned.plan],
    ].join("\n"),
    "Plan",
  );
  if (parsed.dryRun) {
    ui.outro("Dry run: nothing changed.");
    return 0;
  }

  const step = ui.spinner();
  step.start(`Ensuring bucket ${bucket}`);
  try {
    const groups = await request("GET", "/tokens/permission_groups");
    const bucketState = await ensureBucketWithTemporaryToken(
      request,
      { accountId, bucket, project: ops.project, purpose: "releases", fetch },
      groups,
    );
    step.message(`Bucket ${bucket} ${bucketState}`);
    if (planned.plan !== "ok") step.message(`Storing S3 credentials in Sigillo ${secrets.name}`);
    await applyToken(request, secrets, planned, groups);
    step.stop(`Bucket ${bucket} ${bucketState}; credentials in Sigillo ${secrets.name}`);
  } catch (error) {
    step.error("Failed");
    throw error;
  }
  ui.outro("Release with: gq ploi release");
  return 0;
}

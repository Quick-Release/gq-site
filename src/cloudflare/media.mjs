// Provisions the site's media uploads bucket on R2 (Human Made S3 Uploads)
// from gq.ops.json `media`, with the account's token-manager token:
//
//   1. create the bucket and attach its public custom domain, with a 1-hour
//      token that is deleted right after
//   2. find or create "GETQUICK <PROJECT> Media R2": object read/write on
//      that bucket only
//   3. store its S3 credentials in Sigillo `staging` as S3_UPLOADS_KEY /
//      S3_UPLOADS_SECRET
//
// Idempotent. `gq ploi media` then sets the S3_UPLOADS_* lines of the Ploi
// site's .env.
//
//   gq cloudflare media [--dry-run]

import { createReporter } from "../cli/reporter.mjs";
import { sigilloSecrets } from "../sigillo/commands.mjs";
import { createCloudflareAccountClient } from "./account-client.mjs";
import {
  accountPolicy,
  applyToken,
  bucketTokenSpec,
  ensureBucket,
  inspectTokens,
  managerToken,
  SECRETS_ENVIRONMENT,
  tokenName,
  withTemporaryToken,
  zonePolicy,
} from "./tokens.mjs";

async function ensureBucketAndDomain(request, { bucket, domain, zoneId }) {
  const bucketState = await ensureBucket(request, bucket);
  const domains = (await request("GET", `/r2/buckets/${bucket}/domains/custom`)).domains ?? [];
  const existing = domains.find((candidate) => candidate.domain === domain);
  let domainState = "exists";
  if (!existing) {
    await request("POST", `/r2/buckets/${bucket}/domains/custom`, {
      domain,
      zoneId,
      enabled: true,
      minTLS: "1.2",
    });
    domainState = "attached";
  } else if (!existing.enabled) {
    await request("PUT", `/r2/buckets/${bucket}/domains/custom/${domain}`, { enabled: true });
    domainState = "enabled";
  }
  return { bucketState, domainState };
}

// `gq cloudflare media [--dry-run]`. Resolves to an exit code.
export async function runCloudflareMedia({ context, parsed, env, fetch, exec, io, interactive }) {
  const ops = context.config;
  const { bucket, domain } = ops.media ?? {};
  const { accountId, zoneId } = ops.cloudflare ?? {};
  if (!bucket || !domain || !accountId || !zoneId) {
    throw new Error(
      "gq.ops.json media.bucket, media.domain and cloudflare.accountId/zoneId are required.",
    );
  }
  const token = managerToken(context, "cloudflare media");
  const request = createCloudflareAccountClient({ token, accountId, fetch });
  const secrets = await sigilloSecrets({ context, env, exec }, SECRETS_ENVIRONMENT);
  const spec = bucketTokenSpec({
    name: tokenName(ops.project, "Media R2"),
    accountId,
    bucket,
    accessKeySecret: "S3_UPLOADS_KEY",
    secretKeySecret: "S3_UPLOADS_SECRET",
  });

  const ui = createReporter(io, interactive);
  ui.intro(`R2 media · ${bucket} → https://${domain}`);
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
      `• bucket ${bucket} and its public domain https://${domain}: created if missing (1-hour token, deleted after)`,
      {
        ok: `✓ ${spec.name} exists and Sigillo ${secrets.name} has its S3 credentials`,
        create: `+ create ${spec.name} (object read/write on ${bucket} only), store S3_UPLOADS_KEY/SECRET in Sigillo ${secrets.name}`,
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
    const { bucketState, domainState } = await withTemporaryToken(
      request,
      {
        name: tokenName(ops.project, "media bucket setup (temporary)"),
        accountId,
        policies: [
          accountPolicy(accountId, ["Workers R2 Storage Write"], groups),
          zonePolicy(zoneId, ["Zone Read", "DNS Write"], groups),
        ],
        fetch,
      },
      (setup) => ensureBucketAndDomain(setup, { bucket, domain, zoneId }),
    );
    step.message(`Bucket ${bucket} ${bucketState}; domain ${domain} ${domainState}`);
    if (planned.plan !== "ok") step.message(`Storing S3 credentials in Sigillo ${secrets.name}`);
    await applyToken(request, secrets, planned, groups);
    step.stop(
      `Bucket ${bucket} ${bucketState}; https://${domain} ${domainState}; credentials in Sigillo ${secrets.name}`,
    );
  } catch (error) {
    step.error("Failed");
    throw error;
  }
  ui.outro("Next: gq ploi media");
  return 0;
}

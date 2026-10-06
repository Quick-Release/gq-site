// Points the Ploi site's .env at the media bucket on R2 (Human Made S3
// Uploads), from gq.ops.json `media`: sets the S3_UPLOADS_* lines and leaves every other line as it
// is. The bucket's credentials (S3_UPLOADS_KEY / S3_UPLOADS_SECRET) come from
// the secret store. Idempotent.
//
//   gq ploi media [--dry-run]

import { applyEnv } from "../dotenv-text.mjs";
import { createReporter } from "../cli/reporter.mjs";
import { createPloiServerClient } from "./server-client.mjs";

// The .env lines S3 Uploads reads; the credentials come from the secret store.
export function mediaEnv({ accountId, bucket, domain }, { key, secret }) {
  return {
    S3_UPLOADS_BUCKET: bucket,
    S3_UPLOADS_KEY: key,
    S3_UPLOADS_SECRET: secret,
    S3_UPLOADS_ENDPOINT: `https://${accountId}.r2.cloudflarestorage.com`,
    S3_UPLOADS_BUCKET_URL: `https://${domain}`,
  };
}

// `gq ploi media [--dry-run]`. Resolves to an exit code.
export async function runMedia({ context, parsed, fetch, io, interactive }) {
  const ops = context.config;
  const { bucket, domain } = ops.media ?? {};
  const accountId = ops.cloudflare?.accountId;
  if (!bucket || !domain || !accountId) {
    throw new Error(
      "gq.ops.json media.bucket, media.domain and cloudflare.accountId are required.",
    );
  }
  if (!ops.ploi?.siteId) throw new Error("gq.ops.json ploi.siteId is required.");
  const key = context.env.S3_UPLOADS_KEY;
  const secret = context.env.S3_UPLOADS_SECRET;
  if (!key || !secret) {
    throw new Error(
      "S3_UPLOADS_KEY / S3_UPLOADS_SECRET are missing; store the media bucket's credentials in the secret store and run this through gq sigillo run.",
    );
  }

  const ui = createReporter(io, interactive);
  ui.intro(`Ploi .env · S3 Uploads → ${bucket}`);
  const client = createPloiServerClient({
    token: context.env.PLOI_API_TOKEN,
    serverId: ops.ploi.serverId,
    fetch,
  });
  const envPath = `/sites/${ops.ploi.siteId}/env`;
  const response = await client.request("GET", envPath);
  const current = response?.data ?? response?.env;
  if (typeof current !== "string" || !current.trim()) {
    throw new Error("The Ploi site has no .env yet; run gq ploi provision first.");
  }

  const { output, changed } = applyEnv(
    current,
    mediaEnv({ accountId, bucket, domain }, { key, secret }),
  );
  if (changed.length === 0) {
    ui.outro("The Ploi .env already has the S3 Uploads settings.");
    return 0;
  }
  ui.note(changed.map((name) => `~ ${name}`).join("\n"), "Plan (values not shown)");
  if (parsed.dryRun) {
    ui.outro("Dry run: nothing changed.");
    return 0;
  }
  await client.request("PATCH", envPath, { content: output });
  ui.outro("Updated. The next release copies the .env into the CMS and activates S3 Uploads.");
  return 0;
}

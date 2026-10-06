// Whether a site's WordPress uploads are hosted independently of its CMS:
// the production prerequisite for keeping uploaded media available while the
// CMS is down, and, separately, whether local development keeps its uploads
// on disk. Every check is read-only except the opt-in upload probe, which
// uploads one generated image through the CMS's REST API and deletes it
// again. Results name what to do next and never carry a secret's value.
//
// A check is { name, status, detail, action? }:
//   ok        — verified
//   not-ready — missing, incompatible or unverifiable; `action` says what to do
//   warn      — worth knowing, doesn't block readiness
//   skipped   — not applicable, or not asked for
// The production result's status is "ready" (every check passed, the upload
// probe among them), "configured" (everything but the probe passed) or
// "not-ready"; only "ready" sets `ready`.

import { cmsFetch } from "../cms/access.mjs";
import { parseDotenv } from "../dotenv-text.mjs";
import { mediaEnv } from "../ploi/media.mjs";
import { createPloiServerClient } from "../ploi/server-client.mjs";
import { createR2Client } from "../r2.mjs";

// The plugin that moves uploads to R2 (Human Made S3 Uploads).
export const S3_UPLOADS_PLUGIN = "s3-uploads";

// The WordPress user the upload probe signs in as, with an application
// password: from the secret store, per command, like every other credential.
export const CHECK_USER = "CMS_CHECK_USER";
export const CHECK_PASSWORD = "CMS_CHECK_APP_PASSWORD";

// A 1×1 PNG: a real image, so WordPress accepts it as media.
const PROBE_IMAGE = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ),
  (character) => character.charCodeAt(0),
);

// Where Bedrock (web/app/uploads) and stock WordPress keep uploads on the
// CMS's own disk.
const CMS_UPLOAD_PATHS = ["/app/uploads/", "/wp-content/uploads/"];

const TIMEOUT = 30_000;
const MEDIA_SETUP = "run pnpm cf:media, then pnpm ploi:media and release the CMS";

// The production prerequisite. `ops` is the validated gq.ops.json; `env` holds
// what the command was given (PLOI_API_TOKEN, S3_UPLOADS_KEY/SECRET and, for
// `upload`, CMS_CHECK_USER/CMS_CHECK_APP_PASSWORD); `fetch` reaches Ploi, R2,
// the CMS, the media domain and the Frontend.
export async function productionMediaReadiness({
  ops,
  env,
  fetch,
  upload = false,
  now = Date.now,
}) {
  const checks = [];
  const add = (check) => checks.push(check);
  const media = ops.media ?? {};
  const accountId = ops.cloudflare?.accountId;
  const admin = ops.domains?.admin;
  const frontend = ops.domains?.frontend;

  const missing = [
    !media.bucket && "media.bucket",
    !media.domain && "media.domain",
    !accountId && "cloudflare.accountId",
    !admin && "domains.admin",
  ].filter(Boolean);
  add(
    missing.length === 0
      ? ok("config", `media bucket ${media.bucket} on https://${media.domain}`)
      : notReady(
          "config",
          `gq.ops.json lacks ${missing.join(", ")}`,
          `add them to gq.ops.json, then ${MEDIA_SETUP}`,
        ),
  );
  if (missing.length > 0) return result("production", checks);

  const mediaHost = media.domain.toLowerCase();
  const sharedWith = [
    mediaHost === admin.toLowerCase() && `the CMS (domains.admin)`,
    frontend && mediaHost === frontend.toLowerCase() && `the Frontend (domains.frontend)`,
  ].filter(Boolean);
  add(
    sharedWith.length === 0
      ? ok("independent-host", `https://${media.domain} is neither the CMS nor the Frontend host`)
      : notReady(
          "independent-host",
          `media.domain ${media.domain} is the host of ${sharedWith.join(" and ")}, so uploads go down with it`,
          `give the media bucket its own host in gq.ops.json media.domain, then ${MEDIA_SETUP}`,
        ),
  );

  const plugins = ops.wordpress?.plugins ?? [];
  add(
    plugins.includes(S3_UPLOADS_PLUGIN)
      ? ok("s3-uploads-plugin", "the CMS deploy activates s3-uploads")
      : notReady(
          "s3-uploads-plugin",
          "gq.ops.json wordpress.plugins doesn't activate s3-uploads, so uploads stay on the CMS",
          "add s3-uploads to wordpress.plugins (and humanmade/s3-uploads to apps/cms/composer.json), run gq sync and release the CMS",
        ),
  );

  add(await checkCmsEnv({ ops, env, fetch }));
  const bucket = bucketClient({ accountId, bucket: media.bucket, env, fetch });
  add(await checkBucketCredentials(bucket));
  add(await checkPublicDomain({ domain: media.domain, fetch }));
  if (upload) {
    for (const check of await probeUpload({ admin, media, bucket, env, fetch, now })) add(check);
  } else {
    add(
      skipped(
        "upload",
        "the WordPress upload path isn't proven until an upload lands on the media host",
        "run pnpm media:check:upload once the CMS is installed",
      ),
    );
  }
  add(await checkFrontend({ frontend, mediaHost, fetch }));
  return result("production", checks);
}

// Local development: uploads stay on disk, which needs no bucket, no
// credentials and no network. `cmsEnv` is apps/cms/.env's text, or null when
// there is none yet (gq cms start creates it).
export function localMediaReadiness({ ops, cmsEnv }) {
  const values = cmsEnv === null ? {} : parseDotenv(cmsEnv);
  const credentials = ["S3_UPLOADS_KEY", "S3_UPLOADS_SECRET"].filter((name) =>
    values[name]?.trim(),
  );
  const checks = [
    credentials.length === 0
      ? ok("local-uploads", "the local CMS keeps uploads on disk in apps/cms/web/app/uploads")
      : notReady(
          "local-uploads",
          `apps/cms/.env sets ${credentials.join(", ")}: the local CMS would write uploads to the live bucket`,
          "remove the S3_UPLOADS_KEY and S3_UPLOADS_SECRET lines from apps/cms/.env",
        ),
  ];
  const fallback = values.S3_UPLOADS_BUCKET_URL?.trim();
  if (fallback) {
    checks.push(ok("bucket-fallback", `media missing locally is served from ${fallback}`));
  } else if (ops.media?.domain) {
    checks.push(
      skipped(
        "bucket-fallback",
        `synced media missing locally isn't served from https://${ops.media.domain} yet`,
        "pnpm cms:dev adds S3_UPLOADS_BUCKET_URL to apps/cms/.env",
      ),
    );
  }
  return result("local", checks);
}

// The Ploi site's .env, which the CMS release copies into place, points S3
// Uploads at the bucket with the credentials the secret store holds.
async function checkCmsEnv({ ops, env, fetch }) {
  const name = "cms-env";
  if (!env.PLOI_API_TOKEN || !ops.ploi?.serverId || !ops.ploi?.siteId) {
    return notReady(
      name,
      "the CMS's .env can't be read without PLOI_API_TOKEN and gq.ops.json ploi.serverId/siteId",
      "run this through gq sigillo run staging (pnpm media:check) once pnpm ploi:provision has run",
    );
  }
  let current;
  try {
    const client = createPloiServerClient({
      token: env.PLOI_API_TOKEN,
      serverId: ops.ploi.serverId,
      fetch,
    });
    const response = await client.request("GET", `/sites/${ops.ploi.siteId}/env`);
    current = parseDotenv(String(response?.data ?? response?.env ?? ""));
  } catch (error) {
    return notReady(name, `couldn't read the CMS's .env from Ploi: ${messageOf(error)}`, "retry");
  }
  const expected = mediaEnv(
    { accountId: ops.cloudflare.accountId, bucket: ops.media.bucket, domain: ops.media.domain },
    { key: env.S3_UPLOADS_KEY, secret: env.S3_UPLOADS_SECRET },
  );
  // Without the secret store's credentials only their presence is checkable.
  const wrong = Object.entries(expected)
    .filter(([key, value]) => (value ? current[key] !== value : !current[key]?.trim()))
    .map(([key]) => key);
  if (wrong.length > 0) {
    return notReady(
      name,
      `the CMS's .env has missing or different ${wrong.join(", ")} (values not shown)`,
      "run pnpm ploi:media, then release the CMS",
    );
  }
  return ok(name, `the CMS's .env points S3 Uploads at ${ops.media.bucket}`);
}

function bucketClient({ accountId, bucket, env, fetch }) {
  if (!env.S3_UPLOADS_KEY || !env.S3_UPLOADS_SECRET) return null;
  return createR2Client({
    accountId,
    bucket,
    accessKeyId: env.S3_UPLOADS_KEY,
    secretAccessKey: env.S3_UPLOADS_SECRET,
    fetch,
  });
}

// The media token can still reach its bucket: a signed HEAD of a key that
// needn't exist answers 404 (or 200), never 403.
async function checkBucketCredentials(bucket) {
  const name = "bucket-credentials";
  if (!bucket) {
    return notReady(
      name,
      "S3_UPLOADS_KEY / S3_UPLOADS_SECRET are missing",
      "run this through gq sigillo run staging (pnpm media:check); if staging lacks them, run pnpm cf:media",
    );
  }
  try {
    await bucket.exists("gq-media-check/readiness");
    return ok(name, "the media credentials reach the bucket");
  } catch (error) {
    return notReady(
      name,
      `the media credentials don't reach the bucket: ${messageOf(error)}`,
      "run pnpm cf:media to roll them, then pnpm ploi:media and release the CMS",
    );
  }
}

// The public custom domain answers over HTTPS. R2 answers 404 for a key it
// lacks; a 5xx or no answer means the domain isn't serving the bucket.
async function checkPublicDomain({ domain, fetch }) {
  const name = "public-domain";
  try {
    const response = await fetch(`https://${domain}/`, {
      method: "HEAD",
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (response.status < 500) return ok(name, `https://${domain} answers`);
    return notReady(
      name,
      `https://${domain} answered ${response.status}`,
      "run pnpm cf:media, which attaches the bucket's custom domain",
    );
  } catch (error) {
    return notReady(
      name,
      `https://${domain} doesn't answer: ${messageOf(error)}`,
      "run pnpm cf:media, which attaches the bucket's custom domain, and check its DNS",
    );
  }
}

// Uploads a generated image as the check user, through the same REST path
// the editor's media library uses, then proves that WordPress handed out a
// URL on the media host, that the object is in the bucket, and that the
// media host serves the bucket's bytes without the CMS. The attachment is
// deleted afterwards, whatever happened.
async function probeUpload({ admin, media, bucket, env, fetch, now }) {
  const name = "upload";
  const user = env[CHECK_USER];
  const password = env[CHECK_PASSWORD];
  if (!user || !password) {
    return [
      notReady(
        name,
        `${CHECK_USER} / ${CHECK_PASSWORD} are missing`,
        `create an application password for a dedicated Author user in the CMS, store them in Sigillo staging as ${CHECK_USER} and ${CHECK_PASSWORD}, and run pnpm media:check:upload`,
      ),
    ];
  }
  if (!bucket) {
    return [notReady(name, "the probe needs S3_UPLOADS_KEY / S3_UPLOADS_SECRET", MEDIA_SETUP)];
  }
  const api = `https://${admin}/wp-json/wp/v2/media`;
  const cms = cmsFetch({ env, origin: `https://${admin}`, fetch });
  const authorization = `Basic ${btoa(`${user}:${password}`)}`;
  const filename = `gq-media-check-${now()}.png`;

  let response;
  let payload;
  try {
    response = await cms(api, {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT),
      headers: {
        Authorization: authorization,
        "Content-Type": "image/png",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
      body: PROBE_IMAGE,
    });
    payload = await response.json().catch(() => ({}));
  } catch (error) {
    return [
      notReady(
        name,
        `the CMS didn't answer the probe upload: ${messageOf(error)}`,
        `retry, and delete ${filename} from the CMS's media library if it is there`,
      ),
    ];
  }

  const checks = [];
  const accepted = response.status === 201 && typeof payload?.source_url === "string";
  try {
    if (!accepted) {
      const code = typeof payload?.code === "string" ? ` (${payload.code})` : "";
      checks.push(
        notReady(
          name,
          `the CMS didn't accept the probe upload: HTTP ${response.status}${code}`,
          `check that ${CHECK_USER} can upload media and its application password is current`,
        ),
      );
    } else {
      checks.push(await verifyUploadedAsset({ url: payload.source_url, media, bucket, fetch }));
    }
  } finally {
    // Whatever WordPress created is removed, even from an unusable answer.
    if (Number.isInteger(payload?.id)) {
      const probe = { api, id: payload.id, authorization, url: payload.source_url };
      checks.push(await deleteProbe(probe, { bucket, media, fetch: cms }));
    }
  }
  return checks;
}

async function verifyUploadedAsset({ url, media, bucket, fetch }) {
  const name = "upload";
  const location = URL.parse(url);
  if (!location) {
    return notReady(name, "the CMS answered the probe upload without a usable URL", "retry");
  }
  if (location.protocol !== "https:" || location.hostname !== media.domain.toLowerCase()) {
    return notReady(
      name,
      `WordPress stored the probe at ${location.origin}, not on https://${media.domain}: S3 Uploads isn't active on the CMS`,
      "run pnpm ploi:media, then release the CMS (its deploy activates s3-uploads)",
    );
  }
  const key = decodeURIComponent(location.pathname.slice(1));
  let stored;
  try {
    stored = new Uint8Array(await (await bucket.get(key)).arrayBuffer());
  } catch (error) {
    return notReady(
      name,
      `the probe's URL is on the media host but ${media.bucket} doesn't hold ${key}: ${messageOf(error)}`,
      "check S3_UPLOADS_BUCKET in the CMS's .env (pnpm ploi:media) and release the CMS",
    );
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
    const served = new Uint8Array(await response.arrayBuffer());
    if (!response.ok || !sameBytes(served, stored)) {
      return notReady(
        name,
        `https://${media.domain} answered ${response.status}${response.ok ? " with other bytes than the bucket holds" : ""} for the probe`,
        "check the bucket's custom domain (pnpm cf:media) and any cache rule on it",
      );
    }
  } catch (error) {
    return notReady(
      name,
      `https://${media.domain} didn't serve the probe: ${messageOf(error)}`,
      "check the bucket's custom domain (pnpm cf:media) and its DNS",
    );
  }
  return ok(
    name,
    `an upload through the CMS is stored in ${media.bucket} and served from https://${media.domain}, without the CMS`,
  );
}

async function deleteProbe({ api, id, authorization, url }, { bucket, media, fetch }) {
  const name = "upload-cleanup";
  const leftover = `delete media item ${id} in the CMS's media library`;
  try {
    const response = await fetch(`${api}/${id}?force=true`, {
      method: "DELETE",
      signal: AbortSignal.timeout(TIMEOUT),
      headers: { Authorization: authorization },
    });
    if (!response.ok) {
      return warn(name, `the CMS refused to delete the probe: HTTP ${response.status}`, leftover);
    }
  } catch (error) {
    return warn(name, `couldn't delete the probe: ${messageOf(error)}`, leftover);
  }
  const location = typeof url === "string" ? URL.parse(url) : null;
  if (location?.hostname !== media.domain.toLowerCase()) return ok(name, "the probe is deleted");
  const key = decodeURIComponent(location.pathname.slice(1));
  try {
    if (await bucket.exists(key)) {
      return warn(
        name,
        `the probe is deleted, but ${media.bucket} still holds ${key}`,
        `delete ${key} from ${media.bucket}`,
      );
    }
  } catch {
    // The attachment is gone; an unconfirmed object is only a stray 1×1 PNG.
  }
  return ok(name, "the probe is deleted from the CMS and the bucket");
}

// The Frontend's rendered homepage references uploads on the media host, not
// on the CMS. Its HTML is read as any visitor gets it.
async function checkFrontend({ frontend, mediaHost, fetch }) {
  const name = "frontend";
  if (!frontend) {
    return skipped(name, "gq.ops.json has no domains.frontend to read");
  }
  let html;
  try {
    const response = await fetch(`https://${frontend}/`, { signal: AbortSignal.timeout(TIMEOUT) });
    if (!response.ok) {
      return notReady(
        name,
        `https://${frontend}/ answered ${response.status}`,
        "deploy the Frontend (pnpm deploy:frontend), then check again",
      );
    }
    html = await response.text();
  } catch (error) {
    return notReady(
      name,
      `https://${frontend}/ doesn't answer: ${messageOf(error)}`,
      "deploy the Frontend (pnpm deploy:frontend), then check again",
    );
  }
  const { independent, onCms } = classifyUploadReferences(html, mediaHost);
  if (onCms.length > 0) {
    return notReady(
      name,
      `the homepage references ${onCms.length} upload(s) on the CMS, e.g. ${onCms[0]}`,
      "move the media library to the bucket (S3 Uploads' wp s3-uploads upload-directory) and update the content that links the CMS copies",
    );
  }
  if (independent.length === 0) {
    return skipped(name, "the homepage references no uploads yet");
  }
  return ok(
    name,
    `the homepage references ${independent.length} upload(s) on https://${mediaHost}`,
  );
}

// Absolute URLs in rendered HTML: those on the media host, and uploads served
// from a CMS's own disk (on its host, or proxied through another).
export function classifyUploadReferences(html, mediaHost) {
  const urls = new Set(
    (html.match(/https?:\/\/[^\s"'<>()\\,]+/gu) ?? []).map((url) => url.replace(/&amp;/gu, "&")),
  );
  const independent = [];
  const onCms = [];
  for (const url of urls) {
    let location;
    try {
      location = new URL(url);
    } catch {
      continue;
    }
    if (location.hostname.toLowerCase() === mediaHost) independent.push(url);
    else if (CMS_UPLOAD_PATHS.some((path) => location.pathname.includes(path))) onCms.push(url);
  }
  return { independent, onCms };
}

function result(scope, checks) {
  const blocked = checks.some((check) => check.status === "not-ready");
  const proven = checks.some((check) => check.name === "upload" && check.status === "ok");
  let status;
  if (scope === "local") status = blocked ? "not-ready" : "ready";
  else status = blocked ? "not-ready" : proven ? "ready" : "configured";
  return { scope, status, ready: status === "ready", checks };
}

function sameBytes(left, right) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

// An error's message, without anything a provider echoed past its first line.
function messageOf(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0];
}

function ok(name, detail) {
  return { name, status: "ok", detail };
}

function notReady(name, detail, action) {
  return { name, status: "not-ready", detail, action };
}

function warn(name, detail, action) {
  return { name, status: "warn", detail, action };
}

function skipped(name, detail, action) {
  return action ? { name, status: "skipped", detail, action } : { name, status: "skipped", detail };
}

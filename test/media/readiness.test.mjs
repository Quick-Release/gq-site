// `gq media check` at the run() seam: whether a site's WordPress uploads are
// hosted independently of its CMS. One in-memory world stands in for every
// provider behind a recording fetch: Ploi (the CMS's .env), the R2 bucket
// (S3 API, keyed by the media credentials), its public custom domain, the
// CMS's REST media endpoint (S3 Uploads active when the CMS's .env says so)
// and the Frontend's rendered homepage. The CMS can be taken down while the
// rest keeps answering. Nothing here reaches the network.
import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureSite, recordingFetch } from "../support/fixture-site.mjs";

const OPS = Object.freeze({
  schemaVersion: 1,
  project: "fixture",
  variant: "content",
  domains: { admin: "admin.example.test", frontend: "www.example.test" },
  ploi: { serverId: "12", siteId: "34" },
  media: { bucket: "fixture-media", domain: "media.example.test" },
  cloudflare: { accountId: "account-1" },
  wordpress: { plugins: ["gq-design", "wp-graphql", "s3-uploads"] },
});

const SECRETS = Object.freeze({
  PLOI_API_TOKEN: "ploi-secret-token",
  S3_UPLOADS_KEY: "media-key-id",
  S3_UPLOADS_SECRET: "media-secret-value",
  CMS_CHECK_USER: "media-check",
  CMS_CHECK_APP_PASSWORD: "abcd efgh ijkl mnop",
});

// What gq ploi media writes into the Ploi site's .env.
const MEDIA_LINES = [
  "S3_UPLOADS_BUCKET='fixture-media'",
  "S3_UPLOADS_KEY='media-key-id'",
  "S3_UPLOADS_SECRET='media-secret-value'",
  "S3_UPLOADS_ENDPOINT='https://account-1.r2.cloudflarestorage.com'",
  "S3_UPLOADS_BUCKET_URL='https://media.example.test'",
];
// What gq ploi fonts writes: the fleet's Google Fonts key.
const FONTS_LINE = "GETQUICK_GOOGLE_FONTS_API_KEY='google-fonts-key-value'";
const BASE_ENV = ["DB_NAME='fixture'", "WP_HOME='https://admin.example.test'"];

// An editor's image, as a published page references it.
const PHOTO = new TextEncoder().encode("a published photo");

function world({
  cmsEnv = [...BASE_ENV, ...MEDIA_LINES, FONTS_LINE],
  frontendHtml,
  cors = true,
} = {}) {
  const state = {
    cors,
    cmsEnv: `${cmsEnv.join("\n")}\n`,
    cmsDown: false,
    bucket: new Map(),
    cmsDisk: new Map(),
    attachments: new Map(),
    nextId: 100,
    frontendHtml,
  };
  // WordPress with S3 Uploads active only when its .env has the bucket and
  // credentials, as config/application.php decides.
  const s3UploadsActive = () => {
    const lines = state.cmsEnv.split("\n");
    return ["S3_UPLOADS_BUCKET=", "S3_UPLOADS_KEY=", "S3_UPLOADS_SECRET="].every((prefix) =>
      lines.some((line) => line.startsWith(prefix) && !line.endsWith("''")),
    );
  };
  const upload = (filename, bytes) => {
    const id = state.nextId++;
    const path = `uploads/2026/10/${filename}`;
    let url;
    if (s3UploadsActive()) {
      state.bucket.set(path, bytes);
      url = `https://media.example.test/${path}`;
    } else {
      state.cmsDisk.set(`app/${path}`, bytes);
      url = `https://admin.example.test/app/${path}`;
    }
    state.attachments.set(id, url);
    return { id, source_url: url };
  };

  const fetch = recordingFetch(({ method, url, headers, body }) => {
    const { hostname, pathname, search } = new URL(url);
    if (hostname === "ploi.io") {
      assert.equal(headers.Authorization, `Bearer ${SECRETS.PLOI_API_TOKEN}`);
      if (method === "GET" && pathname === "/api/servers/12/sites/34/env") {
        return { data: state.cmsEnv };
      }
    }
    if (hostname === "account-1.r2.cloudflarestorage.com") {
      if (!headers.authorization?.includes(`Credential=${SECRETS.S3_UPLOADS_KEY}/`)) {
        return new Response(null, { status: 403 });
      }
      const key = decodeURIComponent(pathname.replace(/^\/fixture-media\//u, ""));
      const stored = state.bucket.get(key);
      if (method === "HEAD") return new Response(null, { status: stored ? 200 : 404 });
      if (method === "GET") return new Response(stored ?? null, { status: stored ? 200 : 404 });
    }
    if (hostname === "media.example.test" && method === "OPTIONS") {
      // R2 answers a preflight from its bucket's CORS rules.
      return new Response(null, {
        status: state.cors ? 204 : 403,
        headers: state.cors ? { "access-control-allow-origin": "*" } : {},
      });
    }
    if (hostname === "media.example.test") {
      const stored = state.bucket.get(decodeURIComponent(pathname.slice(1)));
      if (method === "HEAD" || !stored) return new Response(null, { status: 404 });
      return new Response(stored, { headers: { "content-type": "image/png" } });
    }
    if (hostname === "admin.example.test") {
      if (state.cmsDown) throw new TypeError("fetch failed");
      const expected = `Basic ${btoa(`${SECRETS.CMS_CHECK_USER}:${SECRETS.CMS_CHECK_APP_PASSWORD}`)}`;
      if (pathname.startsWith("/wp-json/") && headers.Authorization !== expected) {
        return json401();
      }
      if (method === "POST" && pathname === "/wp-json/wp/v2/media") {
        const filename = /filename="([^"]+)"/u.exec(headers["Content-Disposition"])[1];
        return new Response(JSON.stringify(upload(filename, body)), { status: 201 });
      }
      const deleted = /^\/wp-json\/wp\/v2\/media\/(\d+)$/u.exec(pathname);
      if (method === "DELETE" && deleted && search === "?force=true") {
        const target = new URL(state.attachments.get(Number(deleted[1])));
        state.attachments.delete(Number(deleted[1]));
        state.bucket.delete(target.pathname.slice(1));
        state.cmsDisk.delete(target.pathname.slice(1));
        return { deleted: true };
      }
      const onDisk = state.cmsDisk.get(pathname.slice(1));
      if (method === "GET" && onDisk) return new Response(onDisk);
    }
    if (hostname === "www.example.test" && method === "GET" && pathname === "/") {
      return new Response(state.frontendHtml ?? "<main>Welcome</main>", {
        headers: { "content-type": "text/html" },
      });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });

  // An editor publishes a page with a photo; the Frontend renders the URL
  // WordPress handed out, as its templates print sourceUrl.
  function publishPhoto() {
    const { source_url: url } = upload("photo.png", PHOTO);
    state.frontendHtml = `<main><h1>Home</h1><img class="featured-image" src="${url}" alt=""></main>`;
    return url;
  }
  return { fetch, state, publishPhoto };
}

function json401() {
  return new Response(JSON.stringify({ code: "rest_not_logged_in" }), { status: 401 });
}

async function check(argv, { ops = OPS, env = SECRETS, fetch, files } = {}) {
  const fixture = await createFixtureSite({ ops, files });
  const result = await fixture.run(["media", "check", ...argv, "--json"], { env, fetch });
  return { ...result, report: result.stdout ? JSON.parse(result.stdout) : undefined };
}

function statuses(report) {
  return Object.fromEntries(report.checks.map(({ name, status }) => [name, status]));
}

function assertNoSecrets(...outputs) {
  for (const output of outputs) {
    for (const value of [...Object.values(SECRETS), "google-fonts-key-value"]) {
      assert.ok(!output.includes(value), value);
    }
  }
}

test("an upload through the CMS proves independent media, and the asset outlives the CMS", async () => {
  const { fetch, state, publishPhoto } = world();
  const photoUrl = publishPhoto();

  const ready = await check(["--upload"], { fetch });

  assert.equal(ready.code, 0, ready.stderr);
  assert.equal(ready.report.status, "ready");
  assert.equal(ready.report.ready, true);
  assert.deepEqual(statuses(ready.report), {
    config: "ok",
    "independent-host": "ok",
    "s3-uploads-plugin": "ok",
    "cms-env": "ok",
    "google-fonts-key": "ok",
    "bucket-credentials": "ok",
    "public-domain": "ok",
    "media-cors": "ok",
    upload: "ok",
    "upload-cleanup": "ok",
    frontend: "ok",
  });
  // The probe went through WordPress's REST upload path and is gone again,
  // from the CMS and the bucket; the editor's photo is untouched.
  const posted = fetch.requests.find(({ method }) => method === "POST");
  assert.equal(posted.url, "https://admin.example.test/wp-json/wp/v2/media");
  assert.deepEqual([...state.bucket.keys()], ["uploads/2026/10/photo.png"]);
  assert.equal(state.attachments.size, 1);
  assertNoSecrets(ready.stdout, ready.stderr);

  // The CMS goes down: the media host still serves the upload the rendered
  // Frontend page references.
  state.cmsDown = true;
  assert.match(
    state.frontendHtml,
    /src="https:\/\/media\.example\.test\/uploads\/2026\/10\/photo\.png"/u,
  );
  const served = await fetch(photoUrl);
  assert.equal(served.status, 200);
  assert.deepEqual(new Uint8Array(await served.arrayBuffer()), PHOTO);
  await assert.rejects(fetch("https://admin.example.test/wp-json/wp/v2/media"), /fetch failed/u);

  const during = await check([], { fetch });
  assert.equal(during.code, 0, during.stderr);
  assert.equal(during.report.status, "configured");
  assert.equal(during.report.ready, false);
  assert.equal(statuses(during.report).frontend, "ok");
  assert.match(
    during.report.checks.find(({ name }) => name === "frontend").detail,
    /references 1 upload\(s\) on https:\/\/media\.example\.test/u,
  );
});

test("without the upload probe the site is configured, not proven, and says how to prove it", async () => {
  const { fetch } = world();
  const fixture = await createFixtureSite({ ops: OPS });

  const result = await fixture.run(["media", "check"], { env: SECRETS, fetch });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^Independent media \(production\)$/mu);
  assert.match(result.stdout, /– upload: .*\n\s+→ run pnpm media:check:upload/u);
  assert.match(result.stdout, /Configured, not yet proven/u);
  assert.ok(!fetch.requests.some(({ url }) => url.startsWith("https://admin.example.test")));
  assertNoSecrets(result.stdout, result.stderr);
});

test("uploads WordPress keeps on the CMS origin are not ready, and the probe is still removed", async () => {
  const { fetch, state } = world({ cmsEnv: BASE_ENV });

  const result = await check(["--upload"], { fetch });

  assert.equal(result.code, 1);
  assert.equal(result.report.status, "not-ready");
  const byName = Object.fromEntries(result.report.checks.map((entry) => [entry.name, entry]));
  assert.equal(byName["cms-env"].status, "not-ready");
  assert.match(byName["cms-env"].action, /pnpm ploi:media/u);
  assert.equal(byName.upload.status, "not-ready");
  assert.match(byName.upload.detail, /stored the probe at https:\/\/admin\.example\.test/u);
  assert.equal(byName["upload-cleanup"].status, "ok");
  assert.equal(state.cmsDisk.size, 0);
  assert.equal(state.attachments.size, 0);
});

test("a rendered Frontend page that references CMS-hosted uploads is not ready", async () => {
  const { fetch } = world({
    frontendHtml:
      '<img src="https://admin.example.test/app/uploads/2026/09/logo.png" srcset="https://media.example.test/uploads/a.png 2x">',
  });

  const result = await check([], { fetch });

  assert.equal(result.code, 1);
  const frontend = result.report.checks.find(({ name }) => name === "frontend");
  assert.equal(frontend.status, "not-ready");
  assert.match(
    frontend.detail,
    /1 upload\(s\) on the CMS, e\.g\. https:\/\/admin\.example\.test\/app\/uploads/u,
  );
});

const FRONTEND_ACCESS = Object.freeze({
  GQ_FRONTEND_ACCESS_CLIENT_ID: "frontend-access-id",
  GQ_FRONTEND_ACCESS_CLIENT_SECRET: "frontend-access-secret",
});

// The world's Frontend behind Cloudflare Access: its pages redirect to the
// Access login unless a request carries the admitted service token.
function behindAccess(inner) {
  return recordingFetch(async ({ url, headers, ...init }) => {
    const admitted =
      headers["CF-Access-Client-Id"] === FRONTEND_ACCESS.GQ_FRONTEND_ACCESS_CLIENT_ID &&
      headers["CF-Access-Client-Secret"] === FRONTEND_ACCESS.GQ_FRONTEND_ACCESS_CLIENT_SECRET;
    if (new URL(url).hostname === "www.example.test" && !admitted) {
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/www.example.test",
        },
      });
    }
    return inner(url, { ...init, headers });
  });
}

test("the Frontend homepage probe reads a Frontend behind Access with its token, and only there", async () => {
  const { fetch: inner, publishPhoto } = world();
  publishPhoto();
  const fetch = behindAccess(inner);

  const result = await check([], { fetch, env: { ...SECRETS, ...FRONTEND_ACCESS } });

  assert.equal(statuses(result.report).frontend, "ok", result.stdout);
  for (const request of fetch.requests) {
    const frontend = new URL(request.url).hostname === "www.example.test";
    assert.equal(
      request.headers["CF-Access-Client-Secret"],
      frontend ? FRONTEND_ACCESS.GQ_FRONTEND_ACCESS_CLIENT_SECRET : undefined,
      request.url,
    );
  }
  for (const value of Object.values(FRONTEND_ACCESS)) {
    assert.ok(!`${result.stdout}${result.stderr}`.includes(value));
  }
});

test("without the token, the Frontend homepage probe says Access turned it away", async () => {
  const { fetch: inner } = world();

  const result = await check([], { fetch: behindAccess(inner) });

  assert.equal(result.code, 1);
  const frontend = result.report.checks.find(({ name }) => name === "frontend");
  assert.equal(frontend.status, "not-ready");
  assert.match(frontend.detail, /Cloudflare Access \(team\.cloudflareaccess\.com\)/u);
  assert.match(
    frontend.action,
    /GQ_FRONTEND_ACCESS_CLIENT_ID and GQ_FRONTEND_ACCESS_CLIENT_SECRET/u,
  );
  assert.match(frontend.action, /Service Auth policy/u);
});

test("missing media configuration is an actionable not-ready result, before any request", async () => {
  const ops = { ...OPS, media: undefined };
  const fetch = recordingFetch();

  const result = await check([], { ops, fetch });

  assert.equal(result.code, 1);
  assert.deepEqual(result.report.checks, [
    {
      name: "config",
      status: "not-ready",
      detail: "gq.ops.json lacks media.bucket, media.domain",
      action:
        "add them to gq.ops.json, then run pnpm cf:media, then pnpm ploi:media and release the CMS",
    },
  ]);
  assert.equal(fetch.requests.length, 0);
});

test("media on the CMS's own host, or without S3 Uploads activated, is not independent", async () => {
  const { fetch } = world();
  const ops = {
    ...OPS,
    media: { bucket: "fixture-media", domain: "admin.example.test" },
    wordpress: { plugins: ["wp-graphql"] },
  };

  const result = await check([], { ops, fetch });

  assert.equal(result.code, 1);
  const byName = statuses(result.report);
  assert.equal(byName["independent-host"], "not-ready");
  assert.equal(byName["s3-uploads-plugin"], "not-ready");
});

test("the production check needs its secrets injected per command, and names how", async () => {
  const { fetch } = world();

  const result = await check([], { env: {}, fetch });

  assert.equal(result.code, 1);
  const byName = Object.fromEntries(result.report.checks.map((entry) => [entry.name, entry]));
  assert.equal(byName["cms-env"].status, "not-ready");
  assert.match(byName["cms-env"].action, /gq sigillo run staging/u);
  assert.equal(byName["bucket-credentials"].status, "not-ready");
  assert.ok(!fetch.requests.some(({ url }) => url.includes("ploi.io")));
});

test("drifted CMS media settings and refused credentials are named without their values", async () => {
  const drifted = MEDIA_LINES.map((line) =>
    line.startsWith("S3_UPLOADS_SECRET=") ? "S3_UPLOADS_SECRET='an-older-secret'" : line,
  );
  const { fetch } = world({ cmsEnv: [...BASE_ENV, ...drifted] });

  const result = await check([], {
    env: { ...SECRETS, S3_UPLOADS_KEY: "revoked-key" },
    fetch,
  });

  assert.equal(result.code, 1);
  const byName = Object.fromEntries(result.report.checks.map((entry) => [entry.name, entry]));
  assert.match(byName["cms-env"].detail, /S3_UPLOADS_KEY, S3_UPLOADS_SECRET \(values not shown\)/u);
  assert.equal(byName["bucket-credentials"].status, "not-ready");
  assert.match(byName["bucket-credentials"].detail, /403/u);
  assert.ok(!result.stdout.includes("an-older-secret"));
  assert.ok(!result.stdout.includes("revoked-key"));
});

test("the upload probe needs a CMS check user from the secret store", async () => {
  const { fetch } = world();
  const env = { ...SECRETS, CMS_CHECK_USER: undefined, CMS_CHECK_APP_PASSWORD: undefined };

  const result = await check(["--upload"], { env, fetch });

  assert.equal(result.code, 1);
  const upload = result.report.checks.find(({ name }) => name === "upload");
  assert.equal(upload.status, "not-ready");
  assert.match(upload.action, /Sigillo staging as CMS_CHECK_USER and CMS_CHECK_APP_PASSWORD/u);
  assert.ok(!fetch.requests.some(({ method }) => method === "POST"));
});

test("an upload the CMS refuses is not ready, and nothing is left to clean up", async () => {
  const { fetch, state } = world();

  const result = await check(["--upload"], {
    env: { ...SECRETS, CMS_CHECK_APP_PASSWORD: "stale password" },
    fetch,
  });

  assert.equal(result.code, 1);
  const upload = result.report.checks.find(({ name }) => name === "upload");
  assert.match(upload.detail, /HTTP 401 \(rest_not_logged_in\)/u);
  assert.equal(state.bucket.size, 0);
  assert.ok(!result.stdout.includes("stale password"));
});

test("local development is ready with uploads on disk, offline, apart from production", async () => {
  const fetch = recordingFetch();
  const fixture = await createFixtureSite({
    ops: OPS,
    files: { "apps/cms/.env": "S3_UPLOADS_BUCKET_URL='https://media.example.test'\n" },
  });

  const result = await fixture.run(["media", "check", "--local"], { env: {}, fetch });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^Independent media \(local development\)$/mu);
  assert.match(result.stdout, /✓ local-uploads: the local CMS keeps uploads on disk/u);
  assert.match(result.stdout, /✓ bucket-fallback: media missing locally is served from/u);
  assert.match(result.stdout, /not the production prerequisite: run pnpm media:check/u);
  assert.equal(fetch.requests.length, 0);

  const fresh = await check(["--local"], { env: {}, fetch });
  assert.equal(fresh.code, 0);
  assert.equal(fresh.report.scope, "local");
  assert.deepEqual(statuses(fresh.report), { "local-uploads": "ok", "bucket-fallback": "skipped" });
});

test("R2 credentials in the local CMS's .env are not ready: they'd write to the live bucket", async () => {
  const result = await check(["--local"], {
    env: {},
    files: { "apps/cms/.env": "S3_UPLOADS_BUCKET='fixture-media'\nS3_UPLOADS_KEY='live-key'\n" },
  });

  assert.equal(result.code, 1);
  assert.equal(result.report.status, "not-ready");
  assert.match(result.report.checks[0].detail, /sets S3_UPLOADS_KEY: .*live bucket/u);
  assert.ok(!result.stdout.includes("live-key"));
});

test("gq media check takes --upload or --local, not both", async () => {
  const fixture = await createFixtureSite({ ops: OPS });

  const both = await fixture.run(["media", "check", "--upload", "--local"]);
  assert.equal(both.code, 1);
  assert.match(both.stderr, /Pick one/u);

  const unknown = await fixture.run(["media", "check", "--dry-run"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /--dry-run is not valid for media check/u);
});

test("a media host without a public-read CORS rule is not ready: browsers refuse its fonts", async () => {
  const { fetch } = world({ cors: false });

  const result = await check([], { fetch });

  assert.equal(result.code, 1);
  const cors = result.report.checks.find(({ name }) => name === "media-cors");
  assert.equal(cors.status, "not-ready");
  assert.match(cors.detail, /doesn't allow cross-origin GET from https:\/\/www\.example\.test/u);
  assert.match(cors.action, /pnpm cf:media/u);
  const preflight = fetch.requests.find(({ method }) => method === "OPTIONS");
  assert.equal(preflight.url, "https://media.example.test/");
  assert.equal(preflight.headers.Origin, "https://www.example.test");
});

test("a CMS without the Google Fonts key only warns, never showing a value", async () => {
  const { fetch } = world({ cmsEnv: [...BASE_ENV, ...MEDIA_LINES] });

  const without = await check([], { fetch });
  assert.equal(without.code, 0, without.stderr);
  const key = without.report.checks.find(({ name }) => name === "google-fonts-key");
  assert.equal(key.status, "warn");
  assert.match(key.action, /pnpm ploi:fonts/u);

  const withKey = await check([], { fetch: world().fetch });
  assert.equal(statuses(withKey.report)["google-fonts-key"], "ok");
  assertNoSecrets(withKey.stdout, withKey.stderr);
});

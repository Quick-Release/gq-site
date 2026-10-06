// Unit tests of the Ploi release and media modules. The site-side contract (admin.sh SHIPPED_PATHS
// matching shippedPaths) stays a site test, against this package's export.
import assert from "node:assert/strict";
import test from "node:test";

import { applyEnv } from "../../src/dotenv-text.mjs";
import { ploiReleaseShippedPaths } from "../../src/index.mjs";
import { mediaEnv } from "../../src/ploi/media.mjs";
import {
  deployVariables,
  releaseKey,
  releaseManifest,
  shippedPaths,
} from "../../src/ploi/release.mjs";
import { s3CredentialsFromToken } from "../../src/r2.mjs";

test("hands the deploy its archive and the registry login", () => {
  assert.deepEqual(deployVariables("https://r2.test/a.tar.gz", "{}"), {
    archive_url: "https://r2.test/a.tar.gz",
    composer_auth: "{}",
  });
  assert.throws(() => deployVariables("u", ""), /COMPOSER_AUTH is missing/u);
});

test("ships the CMS and the deploy script, and exports the list for the site's contract", () => {
  assert.deepEqual(shippedPaths, ["apps/cms", "deploy/ploi"]);
  assert.equal(ploiReleaseShippedPaths, shippedPaths);
  assert.ok(Object.isFrozen(ploiReleaseShippedPaths));
});

test("names release archives by version and commit", () => {
  assert.equal(
    releaseKey("admin/", "0.1.1", "0123456789abcdef0123"),
    "admin/v0.1.1-0123456789ab.tar.gz",
  );
});

test("writes a RELEASE manifest admin.sh can read the commit from", () => {
  const manifest = releaseManifest({ version: "0.1.1", sha: "abc123", ref: "v0.1.1" });
  assert.match(manifest, /^commit=abc123$/mu);
  assert.match(manifest, /^version=0\.1\.1$/mu);
});

test("derives R2 S3 credentials from a Cloudflare API token", async () => {
  const { accessKeyId, secretAccessKey } = await s3CredentialsFromToken("token-id", "value");
  assert.equal(accessKeyId, "token-id");
  // SHA-256("value")
  assert.equal(secretAccessKey, "cd42404d52ad55ccfa9aca4adc828aa5800ad9d385a0671fbcbf724118320619");
});

test("sets only the S3 Uploads lines of a Ploi .env", () => {
  const values = mediaEnv(
    { accountId: "acc", bucket: "larkspur-media", domain: "media.example.test" },
    { key: "key-id", secret: "secret" },
  );
  assert.equal(values.S3_UPLOADS_ENDPOINT, "https://acc.r2.cloudflarestorage.com");
  assert.equal(values.S3_UPLOADS_BUCKET_URL, "https://media.example.test");

  const current = "DB_PASSWORD='keep'\nS3_UPLOADS_BUCKET=''\nAUTH_KEY='keep-too'\n";
  const { output, changed } = applyEnv(current, values);
  assert.deepEqual(changed, Object.keys(values));
  assert.match(output, /^DB_PASSWORD='keep'$/mu);
  assert.match(output, /^AUTH_KEY='keep-too'$/mu);
  assert.match(output, /^S3_UPLOADS_BUCKET='larkspur-media'$/mu);
  assert.deepEqual(applyEnv(output, values).changed, []);
});

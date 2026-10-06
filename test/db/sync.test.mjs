import assert from "node:assert/strict";
import test from "node:test";

import { ddevEnvValues } from "../../src/cms/local.mjs";
import {
  assertExportOnly,
  assertLocalTarget,
  backupKey,
  exportMarker,
  parseExportMarker,
  remoteExportScript,
  searchReplacePairs,
  sitePath,
} from "../../src/db/sync.mjs";
import { applyEnv, parseDotenv } from "../../src/dotenv-text.mjs";

const liveDomains = ["larkspur-admin.bnq.pt", "larkspur-fe.bnq.pt"];
const localEnv = {
  DB_HOST: "db",
  DB_PREFIX: "wp_",
  WP_ENV: "development",
  WP_HOME: "https://larkspur-admin.ddev.site",
};

test("names backups by database and UTC time", () => {
  assert.equal(
    backupKey("db/", "larkspur_staging", new Date("2026-09-24T10:11:12.345Z")),
    "db/larkspur_staging/2026-09-24T10-11-12Z.sql.gz",
  );
});

test("resolves the Ploi site path", () => {
  assert.equal(
    sitePath({ systemUser: "larkspur", domain: "larkspur-admin.bnq.pt", projectRoot: "/" }),
    "/home/larkspur/larkspur-admin.bnq.pt",
  );
});

test("the server script only exports and uploads", () => {
  const script = remoteExportScript({
    path: "/home/larkspur/larkspur-admin.bnq.pt",
    uploadUrl: "https://example.r2.cloudflarestorage.com/b/db/x.sql.gz?X-Amz-Signature=a&b='c",
    marker: "LARKSPUR_DB_EXPORT",
  });
  assert.equal(assertExportOnly(script), script);
  assert.match(script, /wp db export - /u);
  assert.match(script, /wp core version/u);
  assert.match(script, /echo "LARKSPUR_DB_EXPORT=success /u);
  assert.match(script, /'https:\/\/example[^\n]*&b='\\''c'/u);
});

test("refuses server scripts that can write to a database", () => {
  for (const command of [
    "wp db import live.sql",
    "wp db reset --yes",
    "wp  db query 'DROP TABLE wp_posts'",
    "wp search-replace a b",
    "wp user create x x@x.test",
    "wp core update",
    "mysql larkspur_staging < dump.sql",
  ]) {
    assert.throws(() => assertExportOnly(`set -e\n${command}\n`), /Refusing/u, command);
  }
});

test("names the export marker after the project", () => {
  assert.equal(exportMarker("larkspur"), "LARKSPUR_DB_EXPORT");
  assert.equal(exportMarker("my-site.2"), "MY_SITE_2_DB_EXPORT");
});

test("reads the export marker", () => {
  const sha = "a".repeat(64);
  assert.deepEqual(
    parseExportMarker(
      `noise\nLARKSPUR_DB_EXPORT=success PREFIX=wp_ WORDPRESS=7.1.2 BYTES=1234 SHA256=${sha}\n`,
      "LARKSPUR_DB_EXPORT",
    ),
    { prefix: "wp_", wordpress: "7.1.2", bytes: 1234, sha256: sha },
  );
  assert.equal(parseExportMarker("curl: (22) 403", "LARKSPUR_DB_EXPORT"), null);
  assert.equal(
    parseExportMarker(
      `OTHER_DB_EXPORT=success PREFIX=wp_ WORDPRESS=7 BYTES=1 SHA256=${sha}`,
      "LARKSPUR_DB_EXPORT",
    ),
    null,
  );
});

test("parses Bedrock .env values", () => {
  const env = parseDotenv(
    "DB_HOST='db'\n# comment\nWP_HOME=\"https://x.ddev.site\"\nWP_ENV=development\n",
  );
  assert.deepEqual(env, { DB_HOST: "db", WP_HOME: "https://x.ddev.site", WP_ENV: "development" });
});

test("accepts only a local DDEV target", () => {
  assert.deepEqual(assertLocalTarget(localEnv, { liveDomains }), {
    homeUrl: "https://larkspur-admin.ddev.site",
    prefix: "wp_",
  });
  for (const override of [
    { DB_HOST: "larkspur-db.example.com" },
    { WP_ENV: "production" },
    { WP_HOME: "https://larkspur-admin.bnq.pt" },
    { WP_HOME: "not a url" },
  ]) {
    assert.throws(
      () => assertLocalTarget({ ...localEnv, ...override }, { liveDomains }),
      /not a local DDEV setup/u,
      JSON.stringify(override),
    );
  }
});

test("replaces live URLs, plain and JSON-escaped, with local ones", () => {
  const pairs = searchReplacePairs({
    liveAdminDomain: "larkspur-admin.bnq.pt",
    localAdminUrl: "https://larkspur-admin.ddev.site",
    liveFrontendDomain: "larkspur-fe.bnq.pt",
    localFrontendUrl: "http://localhost:4321",
  });
  assert.deepEqual(pairs.slice(0, 2), [
    ["https://larkspur-admin.bnq.pt", "https://larkspur-admin.ddev.site"],
    ["https:\\/\\/larkspur-admin.bnq.pt", "https:\\/\\/larkspur-admin.ddev.site"],
  ]);
  assert.ok(
    pairs.some(
      ([from, to]) => from === "http://larkspur-fe.bnq.pt" && to === "http://localhost:4321",
    ),
  );
  assert.equal(pairs.length, 8);
});

test("points the Bedrock .env at DDEV, keeping every other line", () => {
  const values = ddevEnvValues({
    primary_url: "http://larkspur-admin.ddev.site",
    dbinfo: { dbname: "db", username: "db", password: "db", host: "db" },
  });
  const source =
    "DB_NAME='db'\nDB_HOST='localhost'\nWP_HOME='https://larkspur-admin.ddev.site'\nWP_SITEURL=\"${WP_HOME}/wp\"\nAUTH_KEY='keep'\n";
  const { output, changed } = applyEnv(source, values);
  assert.deepEqual(changed, ["DB_USER", "DB_PASSWORD", "DB_HOST", "WP_HOME"]);
  assert.deepEqual(parseDotenv(output), {
    DB_NAME: "db",
    DB_HOST: "db",
    WP_HOME: "http://larkspur-admin.ddev.site",
    WP_SITEURL: "${WP_HOME}/wp",
    AUTH_KEY: "keep",
    DB_USER: "db",
    DB_PASSWORD: "db",
  });
  assert.deepEqual(applyEnv(output, values).changed, []);
});

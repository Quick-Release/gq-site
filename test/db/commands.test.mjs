// `gq db sync` and `gq db backup` at the run() seam: a fixture site with a
// local DDEV apps/cms/.env, an in-memory Ploi and R2 behind a recording fetch,
// and a recording exec standing in for ddev, composer and mkcert. Nothing here
// reaches the network, DDEV or a database.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { assertExportOnly } from "../../src/db/sync.mjs";
import {
  createFixtureSite,
  recordingExec,
  recordingFetch,
  temporaryDirectory,
} from "../support/fixture-site.mjs";

const OPS = Object.freeze({
  schemaVersion: 1,
  project: "fixture",
  variant: "content",
  domains: { admin: "admin.example.test", frontend: "www.example.test" },
  ploi: {
    serverId: "12",
    siteId: "34",
    systemUser: "fixture",
    projectRoot: "/",
    database: "fx_db",
  },
  backups: { bucket: "fixture-backups", prefix: "db/" },
  media: { bucket: "fixture-media", domain: "media.example.test" },
  local: { adminEmail: "admin@fixture.test", frontendUrl: "http://localhost:3000" },
  cloudflare: { accountId: "account-1" },
});

const HOME = "https://fixture.ddev.site";
const LOCAL_ENV = [
  "DB_NAME='db'",
  "DB_USER='db'",
  "DB_PASSWORD='db'",
  "DB_HOST='db'",
  "DB_PREFIX='wp_'",
  "WP_ENV='development'",
  `WP_HOME='${HOME}'`,
  "AUTH_KEY='kept'",
  "GETQUICK_FRONTEND_URL='http://localhost:3000'",
  "S3_UPLOADS_BUCKET_URL='https://media.example.test'",
  "",
].join("\n");

const ENV = Object.freeze({
  PLOI_API_TOKEN: "ploi-secret",
  R2_ACCESS_KEY_ID: "r2-key",
  R2_SECRET_ACCESS_KEY: "r2-secret",
  COMPOSER_AUTH: '{"http-basic":{}}',
  // The CA relaunch is covered on its own; elsewhere the sync runs in place.
  NODE_EXTRA_CA_CERTS: "/fixture/ca.pem",
});

const DUMP = Buffer.from("-- fixture dump\n");
const DUMP_SHA = createHash("sha256").update(DUMP).digest("hex");

function site({ ops = OPS, env = LOCAL_ENV } = {}) {
  return createFixtureSite({
    ops,
    files: { "apps/cms/.env": env, "apps/cms/.env.example": "DB_HOST='localhost'\n" },
  });
}

// Ploi runs the one-off script (recorded in `scripts`) and reports the export
// marker; R2 serves the dump; the local site answers GraphQL.
function fakeProviders({ marker = "FIXTURE_DB_EXPORT", prefix = "wp_", dump = DUMP } = {}) {
  const scripts = [];
  const fetch = recordingFetch(({ method, url, body }) => {
    const { hostname, pathname } = new URL(url);
    if (hostname.endsWith(".r2.cloudflarestorage.com") && method === "GET") {
      return new Response(dump, { status: 200 });
    }
    if (url.startsWith(`${HOME}/wp/graphql?`)) {
      return { data: { generalSettings: { url: HOME } } };
    }
    const route = `${method} ${pathname}`;
    if (route === "POST /api/servers/12/scripts/run") {
      scripts.push(JSON.parse(body));
      return { data: { id: 9 } };
    }
    if (route === "GET /api/servers/12/scripts/run/9") {
      return {
        data: {
          status: "finished",
          exit_code: 0,
          output: `${marker}=success PREFIX=${prefix} WORDPRESS=7.1.2 BYTES=${DUMP.length} SHA256=${DUMP_SHA}\n`,
        },
      };
    }
    throw new Error(`Unexpected request: ${route}`);
  });
  return { fetch, scripts };
}

// ddev with a running project, composer on the host, no mkcert, and no
// local `dev` user yet.
function fakeLocal({ status = "running", userExists = false, overrides = () => undefined } = {}) {
  return recordingExec((call) => {
    const override = overrides(call);
    if (override) return override;
    const { command, args } = call;
    if (command === "sh") return {};
    if (command === "mkcert") return { code: 1 };
    if (command === "composer") return {};
    if (command !== "ddev") return { code: 127, stderr: `unexpected ${command}` };
    const line = args.join(" ");
    if (line === "describe -j") {
      return {
        stdout: JSON.stringify({
          raw: { status, primary_url: HOME, dbinfo: { dbname: "db", host: "db" } },
        }),
      };
    }
    if (line.startsWith("wp user get")) return userExists ? { stdout: "1\n" } : { code: 1 };
    if (line === "wp core version") return { stdout: "7.1.2\n" };
    if (args[0] === "wp" && args[1] === "eval") {
      return { stdout: JSON.stringify({ home: HOME, dev: true }) };
    }
    return {};
  });
}

const ddevLines = (exec) =>
  exec.calls.filter(({ command }) => command === "ddev").map(({ args }) => args.join(" "));
const requestLine = ({ method, url }) => `${method} ${new URL(url).pathname}`;

// Every request a command makes to Ploi: only the export script and its
// status, never a database import, upload or anything else that writes.
function assertOnlyExportsOnPloi(fetch, scripts) {
  for (const request of fetch.requests.filter(({ url }) => url.startsWith("https://ploi.io/"))) {
    assert.match(
      requestLine(request),
      /^(POST \/api\/servers\/12\/scripts\/run|GET \/api\/servers\/12\/scripts\/run\/9)$/u,
    );
  }
  for (const { content } of scripts) assert.equal(assertExportOnly(content), content);
}

// --- gq db sync -------------------------------------------------------------

test("db sync backs up live, imports it into DDEV and resets the local admin from config", async () => {
  const fixture = await site();
  const { fetch, scripts } = fakeProviders();
  const exec = fakeLocal();

  const result = await fixture.run(["db", "sync", "--yes"], { env: ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  assertOnlyExportsOnPloi(fetch, scripts);
  assert.equal(scripts.length, 1);
  // An explicitly configured CA is kept, without consulting mkcert.
  assert.ok(!exec.calls.some(({ command }) => command === "mkcert"));
  assert.equal(scripts[0].user, "fixture");
  assert.match(scripts[0].content, /cd '\/home\/fixture\/admin\.example\.test\/apps\/cms'/u);
  assert.match(scripts[0].content, /echo "FIXTURE_DB_EXPORT=success /u);

  const lines = ddevLines(exec);
  const composer = exec.calls.findIndex(({ command }) => command === "composer");
  const snapshot = exec.calls.findIndex(({ args }) => args[0] === "snapshot");
  const imported = exec.calls.findIndex(({ args }) => args[0] === "import-db");
  assert.ok(composer !== -1 && composer < snapshot && snapshot < imported, lines.join("\n"));
  assert.deepEqual(exec.calls[composer].args, ["install", "--no-interaction"]);
  assert.equal(exec.calls[composer].cwd, fixture.path("apps/cms"));

  // URLs: the live domains from gq.ops.json `domains` to the DDEV URL and
  // gq.ops.json `local.frontendUrl`, plain and JSON-escaped.
  const replaced = lines
    .filter((line) => line.startsWith("wp search-replace "))
    .map((line) => line.split(" ").slice(2, 4));
  assert.deepEqual(replaced, [
    ["https://admin.example.test", HOME],
    ["https:\\/\\/admin.example.test", "https:\\/\\/fixture.ddev.site"],
    ["http://admin.example.test", HOME],
    ["http:\\/\\/admin.example.test", "https:\\/\\/fixture.ddev.site"],
    ["https://www.example.test", "http://localhost:3000"],
    ["https:\\/\\/www.example.test", "http:\\/\\/localhost:3000"],
    ["http://www.example.test", "http://localhost:3000"],
    ["http:\\/\\/www.example.test", "http:\\/\\/localhost:3000"],
  ]);

  // The local admin: dev / dev with gq.ops.json `local.adminEmail`.
  assert.ok(
    lines.includes(
      "wp user create dev admin@fixture.test --role=administrator --user_pass=dev --quiet",
    ),
    lines.join("\n"),
  );
  const updated = exec.calls.findIndex(
    ({ args }) => args.join(" ") === "wp core update-db --quiet",
  );
  assert.ok(updated > imported);
  assert.ok(fetch.requests.some(({ url }) => url.startsWith(`${HOME}/wp/graphql?`)));
  assert.match(result.stdout, /Undo: ddev snapshot restore pre-db-sync-/u);
  assert.match(result.stdout, /Live backup: r2:\/\/fixture-backups\/db\/fx_db\//u);
});

test("db sync's post-import check keeps the local path without production Access credentials", async () => {
  const fixture = await site({
    ops: { ...OPS, wordpress: { plugins: [], graphqlPath: "/graphql" } },
  });
  const { fetch } = fakeProviders();
  const result = await fixture.run(["db", "sync", "--yes"], {
    env: {
      ...ENV,
      GQ_AUTH_GRAPHQL_CLIENT_ID: "production-read-id",
      GQ_AUTH_GRAPHQL_CLIENT_SECRET: "production-read-secret",
      GQ_AUTH_AUTOMATION_CLIENT_ID: "production-automation-id",
      GQ_AUTH_AUTOMATION_CLIENT_SECRET: "production-automation-secret",
    },
    fetch,
    exec: fakeLocal(),
  });
  assert.equal(result.code, 0, result.stderr);
  const local = fetch.requests.filter(({ url }) => new URL(url).origin === HOME);
  assert.equal(local.length, 1);
  assert.equal(new URL(local[0].url).pathname, "/wp/graphql");
  assert.equal(local[0].headers["CF-Access-Client-Id"], undefined);
  assert.equal(local[0].headers["CF-Access-Client-Secret"], undefined);
});

test("db sync installs the language packs of gq.ops.json's wordpress.locale", async () => {
  const fixture = await site({ ops: { ...OPS, wordpress: { plugins: [], locale: "pt_PT_ao90" } } });
  const { fetch } = fakeProviders();
  // WordPress.org has no translations for the site's themes.
  const exec = fakeLocal({
    overrides: ({ args }) =>
      args.join(" ").startsWith("wp language theme") ? { code: 1 } : undefined,
  });

  const result = await fixture.run(["db", "sync", "--yes"], { env: ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  const lines = ddevLines(exec);
  const languages = lines.filter((line) => line.startsWith("wp language "));
  assert.deepEqual(languages, [
    "wp language core install pt_PT_ao90 --quiet",
    "wp language plugin install --all pt_PT_ao90 --quiet",
    "wp language theme install --all pt_PT_ao90 --quiet",
  ]);
  assert.ok(lines.indexOf("wp core update-db --quiet") < lines.indexOf(languages[0]));
  assert.match(result.stderr, /Some theme translations for pt_PT_ao90 are not available\./u);
});

test("db sync installs no language pack for English or without a locale", async () => {
  for (const ops of [OPS, { ...OPS, wordpress: { plugins: [], locale: "en_US" } }]) {
    const fixture = await site({ ops });
    const { fetch } = fakeProviders();
    const exec = fakeLocal();

    const result = await fixture.run(["db", "sync", "--yes"], { env: ENV, fetch, exec });

    assert.equal(result.code, 0, result.stderr);
    assert.ok(!ddevLines(exec).some((line) => line.startsWith("wp language ")));
  }
});

test("db sync updates an existing local admin with the configured address", async () => {
  const fixture = await site();
  const { fetch } = fakeProviders();
  const exec = fakeLocal({ userExists: true });

  const result = await fixture.run(["db", "sync", "--yes"], { env: ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  assert.ok(
    ddevLines(exec).includes(
      "wp user update dev --user_pass=dev --user_email=admin@fixture.test --role=administrator --skip-email --quiet",
    ),
  );
});

test("db sync refuses an export script that could write to a database, before Ploi gets it", async () => {
  // A site whose values would put a write-capable command into the script.
  const fixture = await site({ ops: { ...OPS, ploi: { ...OPS.ploi, systemUser: "mysql" } } });
  const { fetch } = fakeProviders();
  const exec = fakeLocal();

  const result = await fixture.run(["db", "sync", "--yes"], { env: ENV, fetch, exec });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Refusing to run a server script that can write to the database/u);
  assert.ok(!fetch.requests.some(({ url }) => url.startsWith("https://ploi.io/")));
  assert.ok(!ddevLines(exec).some((line) => line.startsWith("import-db")));
});

test("db sync checks the local target before anything runs on the server", async () => {
  const fixture = await site({
    env: LOCAL_ENV.replace("WP_ENV='development'", "WP_ENV='production'"),
  });
  const { fetch } = fakeProviders();

  const result = await fixture.run(["db", "sync", "--yes"], { env: ENV, fetch, exec: fakeLocal() });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /apps\/cms\/\.env is not a local DDEV setup: WP_ENV is 'production'/u,
  );
  assert.deepEqual(fetch.requests, []);
});

test("db sync starts a stopped DDEV project and wires its .env first", async () => {
  const fixture = await site({ env: LOCAL_ENV.replace("DB_HOST='db'", "DB_HOST='localhost'") });
  const { fetch } = fakeProviders();
  const exec = fakeLocal({ status: "stopped" });

  const result = await fixture.run(["db", "sync", "--yes"], { env: ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(ddevLines(exec)[1], "start");
  assert.match(result.stdout, /Set DB_HOST in apps\/cms\/\.env from DDEV\./u);
});

test("db sync needs --yes without a terminal and asks Ploi for nothing", async () => {
  const fixture = await site();
  const { fetch } = fakeProviders();

  const result = await fixture.run(["db", "sync"], { env: ENV, fetch, exec: fakeLocal() });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Pass --yes to replace the local database non-interactively/u);
  assert.deepEqual(fetch.requests, []);
});

test("db sync stops before importing when the backup does not match the export", async () => {
  const fixture = await site();
  const { fetch } = fakeProviders({ dump: Buffer.from("-- tampered dump\n") });
  const exec = fakeLocal();

  const result = await fixture.run(["db", "sync", "--yes"], { env: ENV, fetch, exec });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /does not match what the server uploaded/u);
  assert.ok(!exec.calls.some(({ command }) => command === "composer"));
  assert.ok(!ddevLines(exec).some((line) => line.startsWith("import-db")));
});

test("db sync stops on a table prefix mismatch", async () => {
  const fixture = await site();
  const { fetch } = fakeProviders({ prefix: "live_" });

  const result = await fixture.run(["db", "sync", "--yes"], { env: ENV, fetch, exec: fakeLocal() });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /live table prefix is 'live_' but apps\/cms\/\.env DB_PREFIX is 'wp_'/u,
  );
});

test("db sync names a missing local admin address as a configuration error", async () => {
  const { local, ...ops } = OPS;
  void local;
  const fixture = await site({ ops });
  const { fetch } = fakeProviders();
  const exec = fakeLocal();

  const result = await fixture.run(["db", "sync", "--yes"], { env: ENV, fetch, exec });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /^gq: gq\.ops\.json local\.adminEmail is required\./u);
  assert.deepEqual(fetch.requests, []);
  assert.deepEqual(exec.calls, []);
});

test("db sync relaunches itself with mkcert's public CA", async () => {
  const fixture = await site();
  const caRoot = await temporaryDirectory();
  await writeFile(join(caRoot, "rootCA.pem"), "public certificate");
  const { NODE_EXTRA_CA_CERTS, ...env } = ENV;
  void NODE_EXTRA_CA_CERTS;
  const exec = recordingExec(({ command }) =>
    command === "mkcert" ? { stdout: `${caRoot}\n` } : { code: 7 },
  );

  const result = await fixture.run(["db", "sync", "--yes"], { env, exec });

  assert.equal(result.code, 7);
  assert.equal(exec.calls.length, 2);
  const [relaunch] = exec.calls.slice(1);
  assert.equal(relaunch.command, process.execPath);
  assert.match(relaunch.args[0], /bin\/gq\.mjs$/u);
  assert.deepEqual(relaunch.args.slice(1), ["db", "sync", "--yes"]);
  assert.equal(relaunch.env.NODE_EXTRA_CA_CERTS, join(caRoot, "rootCA.pem"));
  assert.equal(relaunch.cwd, fixture.root);
  assert.equal(exec.options[1].stdio, "inherit");
});

test("db sync keeps normal TLS checks when mkcert has no CA", async () => {
  const fixture = await site();
  const empty = await temporaryDirectory();
  await mkdir(join(empty, "nothing"), { recursive: true });
  const { NODE_EXTRA_CA_CERTS, ...env } = ENV;
  void NODE_EXTRA_CA_CERTS;
  const { fetch } = fakeProviders();
  const exec = fakeLocal({
    overrides: ({ command }) => (command === "mkcert" ? { stdout: `${empty}\n` } : undefined),
  });

  const result = await fixture.run(["db", "sync", "--yes"], { env, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  assert.ok(!exec.calls.some(({ command }) => command === process.execPath));
});

// --- gq db backup -------------------------------------------------------------

test("db backup exports live to R2 and touches nothing local", async () => {
  const { local, ...ops } = OPS;
  void local;
  const fixture = await site({ ops });
  const { fetch, scripts } = fakeProviders();
  const exec = recordingExec(() => ({ code: 99 }));

  const result = await fixture.run(["db", "backup"], { env: ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(exec.calls, []);
  assertOnlyExportsOnPloi(fetch, scripts);
  assert.ok(!fetch.requests.some(({ url }) => url.includes(".r2.cloudflarestorage.com")));
  const uploadUrl = new URL(/curl [^\n]* '([^']+)'/u.exec(scripts[0].content)[1]);
  assert.match(
    uploadUrl.pathname,
    /^\/fixture-backups\/db\/fx_db\/\d{4}-\d\d-\d\dT[\d-]+Z\.sql\.gz$/u,
  );
  assert.equal(uploadUrl.searchParams.get("X-Amz-Expires"), "900");
  assert.match(result.stdout, /r2:\/\/fixture-backups\/db\/fx_db\/.*\.sql\.gz\n$/u);
});

test("db backup names a missing backup bucket", async () => {
  const { backups, ...ops } = OPS;
  void backups;
  const fixture = await site({ ops });

  const result = await fixture.run(["db", "backup"], { env: ENV });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /gq\.ops\.json backups\.bucket is required\./u);
});

// --- one way only -------------------------------------------------------------

test("no gq command sends a local database to the server", async () => {
  const fixture = await site();
  for (const command of [
    ["db", "push"],
    ["db", "import"],
    ["db", "upload"],
    ["db", "restore"],
  ]) {
    const result = await fixture.run(command, { env: ENV });
    assert.equal(result.code, 1, command.join(" "));
    assert.match(result.stderr, /Unknown command/u);
  }
  const help = await fixture.run(["--help"]);
  const dbCommands = help.stdout.split("\n").filter((line) => /^\s+gq db /u.test(line));
  assert.deepEqual(
    dbCommands.map((line) => line.trim()),
    ["gq db sync [--yes]", "gq db backup"],
  );
  assert.match(help.stdout, /Database \(live → local only\):/u);
});

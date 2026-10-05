// The Ploi workflows (`gq ploi provision`, `release`, `media` and `events`) at the run()
// seam: a fixture site with content-site `ploi`, `releases`, `media` and
// `domains` blocks, an in-memory Ploi and R2 behind a recording fetch, and a
// recording exec standing in for git. Nothing here reaches the network.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { createFixtureSite, recordingExec, recordingFetch } from "../support/fixture-site.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const DEPLOY_SCRIPT = "#!/usr/bin/env bash\necho deploy v1.4.0\n";
const SERVER_IP = "203.0.113.7";

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
    webDirectory: "/apps/cms/web",
    database: "fixture_staging",
    envTemplate: "apps/cms/.env.production.example",
    deployScript: "deploy/ploi/admin.sh",
  },
  releases: { bucket: "fixture-releases", prefix: "admin/" },
  media: { bucket: "fixture-media", domain: "media.example.test" },
  cloudflare: { accountId: "account-1", zoneId: "zone-1", zoneName: "example.test" },
});

const ENV_TEMPLATE = [
  "DB_NAME='site'",
  "DB_USER='site_user'",
  "DB_PASSWORD='replace-with-a-strong-password'",
  "WP_HOME='https://admin.example.test'",
  "AUTH_KEY='replace-me'",
].join("\n");
const READY_ENV = [
  "DB_NAME='fixture_staging'",
  "DB_USER='fixture_staging'",
  "DB_PASSWORD='kept'",
  "WP_HOME='https://admin.example.test'",
  "AUTH_KEY='kept-salt'",
  "",
].join("\n");

const RELEASE_ENV = Object.freeze({
  PLOI_API_TOKEN: "ploi-secret",
  COMPOSER_AUTH: '{"http-basic":{}}',
  R2_ACCESS_KEY_ID: "r2-key",
  R2_SECRET_ACCESS_KEY: "r2-secret",
});

function site({ ops = OPS, files = {} } = {}) {
  return createFixtureSite({
    ops,
    files: {
      "deploy/ploi/admin.sh": DEPLOY_SCRIPT,
      "apps/cms/.env.production.example": ENV_TEMPLATE,
      ...files,
    },
  });
}

// An in-memory Ploi server 12 / site 34 behind a recording fetch. `state`
// holds what Ploi would report; `deployResult` is the line the deploy script
// prints; R2 answers HEAD (missing unless `archived`) and PUT.
function fakeProviders({
  state: overrides = {},
  deployResult = `FIXTURE_DEPLOY_STATUS=success SHA=${SHA}`,
  archived = false,
} = {}) {
  const site = {
    id: 34,
    domain: OPS.domains.admin,
    status: "active",
    system_user: "fixture",
    web_directory: "/apps/cms/web",
    project_root: "/",
  };
  const state = {
    site,
    deployScript: DEPLOY_SCRIPT,
    env: READY_ENV,
    repository: { provider: "none" },
    logs: [{ id: 3, type: "deploy" }],
    crontabs: [],
    ...overrides,
  };
  const fetch = recordingFetch(({ method, url, body }) => {
    const { hostname, pathname, search } = new URL(url);
    if (hostname.endsWith(".r2.cloudflarestorage.com")) {
      if (method === "HEAD") return new Response(null, { status: archived ? 200 : 404 });
      if (method === "PUT") return new Response(null, { status: 200 });
    }
    const path = `${pathname.replace("/api/servers/12", "")}${search}`;
    const route = `${method} ${path}`;
    const data = body === undefined ? undefined : JSON.parse(body);
    switch (route) {
      case "GET ":
        return { data: { ip_address: SERVER_IP } };
      case "GET /system-users?per_page=100":
        return { data: [{ name: "fixture" }] };
      case "GET /sites?per_page=100":
        return { data: state.site ? [state.site] : [] };
      case "GET /databases?per_page=100":
        return { data: [{ id: 5, name: "fixture_staging" }] };
      case "GET /sites/34":
        return { data: state.site };
      case "GET /sites/34/repository":
        return { data: { repository: state.repository } };
      case "GET /sites/34/env":
        return { data: state.env };
      case "PATCH /sites/34/env":
        state.env = data.content;
        return {};
      case "GET /sites/34/certificates?per_page=100":
        return { data: [{ type: "letsencrypt", status: "active" }] };
      case "GET /sites/34/deploy/script":
        return { deploy_script: state.deployScript };
      case "PATCH /sites/34/deploy/script":
        state.deployScript = data.deploy_script;
        return {};
      case "GET /sites/34/log?per_page=5":
        return { data: state.logs };
      case "POST /sites/34/deploy":
        state.deployed = data.variables;
        state.logs = [{ id: 4, type: "deploy" }, ...state.logs];
        return {};
      case "GET /crontabs":
        return { data: state.crontabs };
      case "POST /crontabs":
        state.crontabs = [...state.crontabs, { id: state.crontabs.length + 1, ...data }];
        return { data: state.crontabs.at(-1) };
      case "GET /sites/34/log/4":
        return { data: { content: `composer install\n${deployResult}\n` } };
      default:
        throw new Error(`Unexpected request: ${route}`);
    }
  });
  return { fetch, state };
}

// git for the release commit: no v* tag at HEAD, VERSION 1.4.0, and an
// archive written to wherever --output points.
function fakeGit({ tag = null } = {}) {
  return recordingExec(async ({ command, args }) => {
    assert.equal(command, "git");
    if (args[0] === "describe") {
      return tag ? { stdout: `${tag}\n` } : { code: 128, stderr: "fatal: no tag exactly matches" };
    }
    if (args[0] === "rev-parse") return { stdout: `${SHA}\n` };
    if (args[0] === "show" && args[1] === `${SHA}:VERSION`) return { stdout: "1.4.0\n" };
    if (args[0] === "show" && args[1] === `${SHA}:deploy/ploi/admin.sh`) {
      return { stdout: DEPLOY_SCRIPT };
    }
    if (args[0] === "archive") {
      const output = args.find((argument) => argument.startsWith("--output=")).slice(9);
      await writeFile(output, "release-archive");
      return {};
    }
    return { code: 1, stderr: `unexpected git ${args.join(" ")}` };
  });
}

const resolvesToServer = async () => [{ address: SERVER_IP }];
const requestLine = ({ method, url }) => `${method} ${new URL(url).pathname}`;

// --- gq ploi release -------------------------------------------------------

test("ploi release syncs the stored deploy script from the release commit, then deploys", async () => {
  const fixture = await site();
  const { fetch, state } = fakeProviders({ state: { deployScript: "echo stale\n" } });
  const exec = fakeGit();

  const result = await fixture.run(["ploi", "release"], { env: RELEASE_ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  const lines = fetch.requests.map(requestLine);
  const synced = lines.indexOf("PATCH /api/servers/12/sites/34/deploy/script");
  const deployed = lines.indexOf("POST /api/servers/12/sites/34/deploy");
  assert.ok(synced !== -1 && deployed !== -1, lines.join("\n"));
  assert.ok(synced < deployed, "the deploy script is synced before the deploy starts");
  assert.equal(state.deployScript, DEPLOY_SCRIPT);
  // The script comes from the release commit, not the working tree.
  assert.ok(exec.calls.some(({ args }) => args.join(" ") === `show ${SHA}:deploy/ploi/admin.sh`));
  assert.match(result.stdout, /Updated the Ploi deploy script from deploy\/ploi\/admin\.sh\./u);
  assert.match(result.stdout, /Deployed v1\.4\.0 \(0123456\)/u);
  assert.match(result.stdout, /https:\/\/admin\.example\.test\n$/u);
});

test("ploi release hands COMPOSER_AUTH and the presigned archive over as deploy variables", async () => {
  const fixture = await site();
  const { fetch, state } = fakeProviders();
  const exec = fakeGit();

  const result = await fixture.run(["ploi", "release"], { env: RELEASE_ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(Object.keys(state.deployed).sort(), ["archive_url", "composer_auth"]);
  assert.equal(state.deployed.composer_auth, RELEASE_ENV.COMPOSER_AUTH);
  const archiveUrl = new URL(state.deployed.archive_url);
  assert.equal(
    `${archiveUrl.origin}${archiveUrl.pathname}`,
    "https://account-1.r2.cloudflarestorage.com/fixture-releases/admin/v1.4.0-0123456789ab.tar.gz",
  );
  assert.equal(archiveUrl.searchParams.get("X-Amz-Expires"), "1800");
  // The login never reaches a child process's arguments or the output.
  assert.ok(!JSON.stringify(exec.calls).includes(RELEASE_ENV.COMPOSER_AUTH));
  assert.ok(!result.stdout.includes(RELEASE_ENV.COMPOSER_AUTH));
});

test("ploi release fails without COMPOSER_AUTH before uploading or deploying", async () => {
  const fixture = await site();
  const { fetch } = fakeProviders();
  const { COMPOSER_AUTH, ...env } = RELEASE_ENV;
  void COMPOSER_AUTH;

  const result = await fixture.run(["ploi", "release"], { env, fetch, exec: fakeGit() });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /^gq: COMPOSER_AUTH is missing/u);
  assert.deepEqual(fetch.requests, []);
});

test("ploi release packs the shipped paths of the release commit with a RELEASE manifest", async () => {
  const fixture = await site();
  const { fetch } = fakeProviders();
  const exec = fakeGit({ tag: "v1.4.0" });

  const result = await fixture.run(["ploi", "release"], { env: RELEASE_ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    exec.calls.map(({ args }) => args[0]),
    ["describe", "rev-parse", "show", "show", "archive"],
  );
  assert.deepEqual(exec.calls[1].args, ["rev-parse", "v1.4.0^{commit}"]);
  const archive = exec.calls[4].args;
  assert.ok(
    archive.includes(`--add-virtual-file=RELEASE:version=1.4.0\ncommit=${SHA}\nref=v1.4.0\n`),
  );
  assert.deepEqual(archive.slice(-4), [SHA, "--", "apps/cms", "deploy/ploi"]);
  assert.ok(exec.calls.every(({ cwd }) => cwd === fixture.root));
  const put = fetch.requests.find(({ method }) => method === "PUT");
  assert.equal(Buffer.from(put.body).toString(), "release-archive");
  assert.match(put.headers.authorization, /^AWS4-HMAC-SHA256 Credential=r2-key\//u);
});

test("ploi release reuses an archive already in R2 and reads --ref and --git-dir", async () => {
  const fixture = await site();
  const { fetch } = fakeProviders({ archived: true });
  const exec = fakeGit();

  const result = await fixture.run(["ploi", "release", "--ref", "v1.4.0", "--git-dir", "source"], {
    env: {
      ...RELEASE_ENV,
      RELEASES_R2_ACCESS_KEY_ID: "ci-key",
      RELEASES_R2_SECRET_ACCESS_KEY: "s",
    },
    fetch,
    exec,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    exec.calls.map(({ args }) => args[0]),
    ["rev-parse", "show", "show"],
  );
  assert.ok(exec.calls.every(({ cwd }) => cwd === fixture.path("source")));
  assert.ok(!fetch.requests.some(({ method }) => method === "PUT"));
  // CI passes the releases key as RELEASES_R2_*, beside its own R2_*.
  const head = fetch.requests.find(({ method }) => method === "HEAD");
  assert.match(head.headers.authorization, /Credential=ci-key\//u);
});

test("ploi release leaves a matching deploy script alone", async () => {
  const fixture = await site();
  const { fetch } = fakeProviders();

  const result = await fixture.run(["ploi", "release"], {
    env: RELEASE_ENV,
    fetch,
    exec: fakeGit(),
  });

  assert.equal(result.code, 0, result.stderr);
  assert.ok(
    !fetch.requests.some(({ method, url }) => method === "PATCH" && url.endsWith("/deploy/script")),
  );
  assert.doesNotMatch(result.stdout, /Updated the Ploi deploy script/u);
});

test("ploi release fails when Ploi deploys another commit or reports a failure", async () => {
  const fixture = await site();

  const otherCommit = await fixture.run(["ploi", "release"], {
    env: RELEASE_ENV,
    fetch: fakeProviders({ deployResult: "FIXTURE_DEPLOY_STATUS=success SHA=fedcba" }).fetch,
    exec: fakeGit(),
  });
  assert.equal(otherCommit.code, 1);
  assert.match(otherCommit.stderr, new RegExp(`Ploi deployed fedcba, expected ${SHA}`, "u"));
  assert.match(otherCommit.stdout, /Release not deployed\./u);

  const failed = await fixture.run(["ploi", "release"], {
    env: RELEASE_ENV,
    fetch: fakeProviders({ deployResult: "FIXTURE_DEPLOY_STATUS=failed" }).fetch,
    exec: fakeGit(),
  });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /Deploy failed/u);
});

test("ploi release names the gq.ops.json key a site lacks", async () => {
  const { releases, ...ops } = OPS;
  void releases;
  const fixture = await site({ ops });

  const result = await fixture.run(["ploi", "release"], { env: RELEASE_ENV });

  assert.equal(result.code, 1);
  assert.equal(result.stderr, "gq: gq.ops.json releases.bucket is required.\n");
});

// --- gq ploi provision -----------------------------------------------------

test("ploi provision --dry-run reports a provisioned site and changes nothing", async () => {
  const fixture = await site();
  const { fetch } = fakeProviders();

  const result = await fixture.run(["ploi", "provision", "--dry-run"], {
    env: RELEASE_ENV,
    fetch,
    lookup: resolvesToServer,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    result.stdout,
    [
      "Ploi provision · admin.example.test",
      "Inspecting Ploi",
      "Inspected Ploi",
      "Plan:",
      "  ✓ system user fixture",
      "  ✓ site admin.example.test (34)",
      "  ✓ custom deployments (no git; releases come from R2)",
      "  ✓ database fixture_staging and site .env",
      "  ✓ deploy script matches deploy/ploi/admin.sh",
      "  ✓ SSL certificate (active)",
      "Dry run: nothing to change.",
      "",
    ].join("\n"),
  );
  assert.ok(fetch.requests.every(({ method }) => method === "GET"));
});

test("ploi provision --dry-run reports drift without writing", async () => {
  const fixture = await site();
  const { fetch } = fakeProviders({
    state: {
      deployScript: "echo stale\n",
      repository: { provider: "github", user: "Quick-Release", name: "fixture" },
    },
  });

  const result = await fixture.run(["ploi", "provision", "--dry-run"], {
    env: RELEASE_ENV,
    fetch,
    lookup: resolvesToServer,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /~ switch from git \(Quick-Release\/fixture\)/u);
  assert.match(result.stdout, /~ deploy script ← deploy\/ploi\/admin\.sh/u);
  assert.match(result.stdout, /Dry run: 2 change\(s\) pending\./u);
  assert.ok(fetch.requests.every(({ method }) => method === "GET"));
});

test("ploi provision refuses to apply without a terminal or --yes", async () => {
  const fixture = await site();
  const { fetch } = fakeProviders({ state: { deployScript: "echo stale\n" } });

  const result = await fixture.run(["ploi", "provision"], {
    env: RELEASE_ENV,
    fetch,
    lookup: resolvesToServer,
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Not a TTY: re-run with --yes to apply, or --dry-run to inspect\./u);
  assert.ok(fetch.requests.every(({ method }) => method === "GET"));
});

test("ploi provision --yes applies the plan and records the site ID in gq.ops.json", async () => {
  const fixture = await site({ ops: { ...OPS, ploi: { ...OPS.ploi, siteId: "" } } });
  const { fetch, state } = fakeProviders({ state: { deployScript: "echo stale\n" } });

  const result = await fixture.run(["ploi", "provision", "--yes"], {
    env: RELEASE_ENV,
    fetch,
    lookup: resolvesToServer,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(state.deployScript, DEPLOY_SCRIPT);
  const ops = JSON.parse(await readFile(fixture.path("gq.ops.json"), "utf8"));
  assert.equal(ops.ploi.siteId, "34");
  assert.match(result.stdout, /Deploy with: gq ploi release\n$/u);
});

test("ploi provision records the site ID when gq.ops.json has no ploi.siteId yet", async () => {
  const ploi = { ...OPS.ploi };
  delete ploi.siteId;
  const fixture = await site({ ops: { ...OPS, ploi } });
  const { fetch } = fakeProviders();

  const result = await fixture.run(["ploi", "provision", "--yes"], {
    env: RELEASE_ENV,
    fetch,
    lookup: resolvesToServer,
  });

  assert.equal(result.code, 0, result.stderr);
  const ops = JSON.parse(await readFile(fixture.path("gq.ops.json"), "utf8"));
  assert.deepEqual(ops, OPS);
});

test("ploi provision records the site ID in the gq.ops.json --config selects", async () => {
  const unset = { ...OPS, ploi: { ...OPS.ploi, siteId: "" } };
  const fixture = await site({
    files: { "alternate.ops.json": `${JSON.stringify(unset, null, 2)}\n` },
  });
  const { fetch } = fakeProviders();

  const result = await fixture.run(
    ["ploi", "provision", "--yes", "--config", "alternate.ops.json"],
    {
      env: RELEASE_ENV,
      fetch,
      lookup: resolvesToServer,
    },
  );

  assert.equal(result.code, 0, result.stderr);
  const alternate = JSON.parse(await readFile(fixture.path("alternate.ops.json"), "utf8"));
  assert.equal(alternate.ploi.siteId, "34");
  const root = JSON.parse(await readFile(fixture.path("gq.ops.json"), "utf8"));
  assert.deepEqual(root, OPS);
});

test("ploi provision warns about SSL when the domain doesn't resolve to the server", async () => {
  const fixture = await site();
  const { fetch } = fakeProviders();
  const fetchWithoutCertificate = recordingFetch(async (request) =>
    request.url.endsWith("/certificates?per_page=100")
      ? { data: [] }
      : fetch(request.url, { method: request.method, body: request.body }),
  );

  // run() without a lookup: DNS is unavailable, as for a domain that doesn't resolve.
  const result = await fixture.run(["ploi", "provision", "--dry-run"], {
    env: RELEASE_ENV,
    fetch: fetchWithoutCertificate,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stdout,
    /! no SSL yet: admin\.example\.test does not resolve to 203\.0\.113\.7/u,
  );
});

// --- gq ploi media ---------------------------------------------------------

const MEDIA_ENV = Object.freeze({
  PLOI_API_TOKEN: "ploi-secret",
  S3_UPLOADS_KEY: "media-key",
  S3_UPLOADS_SECRET: "media-secret",
});

test("ploi media sets only the S3 Uploads lines of the Ploi site's .env", async () => {
  const fixture = await site();
  const { fetch, state } = fakeProviders();

  const result = await fixture.run(["ploi", "media"], { env: MEDIA_ENV, fetch });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    state.env,
    READY_ENV +
      [
        "S3_UPLOADS_BUCKET='fixture-media'",
        "S3_UPLOADS_KEY='media-key'",
        "S3_UPLOADS_SECRET='media-secret'",
        "S3_UPLOADS_ENDPOINT='https://account-1.r2.cloudflarestorage.com'",
        "S3_UPLOADS_BUCKET_URL='https://media.example.test'",
        "",
      ].join("\n"),
  );
  // The plan names the lines, never their values.
  assert.match(result.stdout, /~ S3_UPLOADS_SECRET/u);
  assert.ok(!result.stdout.includes("media-secret"));

  const again = await fixture.run(["ploi", "media"], { env: MEDIA_ENV, fetch });
  assert.match(again.stdout, /already has the S3 Uploads settings/u);
  assert.equal(fetch.requests.filter(({ method }) => method === "PATCH").length, 1);
});

test("ploi media --dry-run changes nothing, and needs the bucket's credentials", async () => {
  const fixture = await site();
  const { fetch, state } = fakeProviders();

  const dryRun = await fixture.run(["ploi", "media", "--dry-run"], { env: MEDIA_ENV, fetch });
  assert.equal(dryRun.code, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /Dry run: nothing changed\./u);
  assert.equal(state.env, READY_ENV);

  const missing = await fixture.run(["ploi", "media"], {
    env: { PLOI_API_TOKEN: "ploi-secret" },
    fetch,
  });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /S3_UPLOADS_KEY \/ S3_UPLOADS_SECRET are missing/u);
});

// --- gq ploi events --------------------------------------------------------

const EVENT_KEY = "fixture-event-signing-key-0123456789abcdef";
const RETRY_CRONTAB = {
  user: "fixture",
  frequency: "* * * * *",
  command:
    'cd /home/fixture/admin.example.test/apps/cms && PATH="/usr/local/bin:$PATH" wp gq-events retry-due --quiet',
};

test("ploi events sets only the CMS's event secret in the Ploi site's .env, never showing it", async () => {
  const fixture = await site();
  const { fetch, state } = fakeProviders();
  const env = { PLOI_API_TOKEN: "ploi-secret", PUBLICATION_EVENT_SECRET: EVENT_KEY };

  const result = await fixture.run(["ploi", "events"], { env, fetch });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(state.env, `${READY_ENV}PUBLICATION_EVENT_SECRET='${EVENT_KEY}'\n`);
  assert.match(result.stdout, /~ PUBLICATION_EVENT_SECRET/u);
  assert.ok(!result.stdout.includes(EVENT_KEY));

  const again = await fixture.run(["ploi", "events"], { env, fetch });
  assert.match(again.stdout, /already has this Site's PUBLICATION_EVENT_SECRET/u);
  assert.equal(fetch.requests.filter(({ method }) => method === "PATCH").length, 1);
});

test("ploi events adds the crontab that retries the CMS's undelivered events every minute, once", async () => {
  const fixture = await site();
  const { fetch, state } = fakeProviders();
  const env = { PLOI_API_TOKEN: "ploi-secret", PUBLICATION_EVENT_SECRET: EVENT_KEY };

  const result = await fixture.run(["ploi", "events"], { env, fetch });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    state.crontabs.map(({ user, frequency, command }) => ({ user, frequency, command })),
    [RETRY_CRONTAB],
  );
  assert.match(result.stdout, /\+ crontab \(fixture, \* \* \* \* \*\): cd \/home\/fixture/u);

  // The key set and the crontab there: nothing to do, even with the .env
  // already holding the key.
  const again = await fixture.run(["ploi", "events"], { env, fetch });
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /already has .* and the delivery retry crontab/u);
  assert.equal(fetch.requests.filter(({ method }) => method === "POST").length, 1);
});

test("ploi events keeps an existing retry crontab and warns when it runs less often", async () => {
  const fixture = await site();
  const { fetch, state } = fakeProviders({
    state: {
      env: `${READY_ENV}PUBLICATION_EVENT_SECRET='${EVENT_KEY}'\n`,
      crontabs: [{ id: 9, ...RETRY_CRONTAB, frequency: "*/15 * * * *" }],
    },
  });
  const env = { PLOI_API_TOKEN: "ploi-secret", PUBLICATION_EVENT_SECRET: EVENT_KEY };

  const result = await fixture.run(["ploi", "events"], { env, fetch });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(state.crontabs.length, 1);
  assert.match(result.stderr, /runs at "\*\/15 \* \* \* \*", not every minute/u);
  assert.ok(!fetch.requests.some(({ method }) => method === "POST" || method === "PATCH"));
});

test("ploi events needs an event secret long enough for the Frontend, and --dry-run changes nothing", async () => {
  const fixture = await site();
  const { fetch, state } = fakeProviders();

  const missing = await fixture.run(["ploi", "events"], {
    env: { PLOI_API_TOKEN: "ploi-secret" },
    fetch,
  });
  const short = await fixture.run(["ploi", "events"], {
    env: { PLOI_API_TOKEN: "ploi-secret", PUBLICATION_EVENT_SECRET: "short" },
    fetch,
  });
  const dryRun = await fixture.run(["ploi", "events", "--dry-run"], {
    env: { PLOI_API_TOKEN: "ploi-secret", PUBLICATION_EVENT_SECRET: EVENT_KEY },
    fetch,
  });

  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /PUBLICATION_EVENT_SECRET is missing/u);
  assert.equal(short.code, 1);
  assert.match(short.stderr, /at least 32 characters/u);
  assert.ok(!short.stderr.includes("short'"));
  assert.equal(dryRun.code, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /Dry run: nothing changed\./u);
  assert.match(dryRun.stdout, /\+ crontab/u);
  assert.equal(state.env, READY_ENV);
  assert.deepEqual(state.crontabs, []);
});

test("the Ploi workflows reject options they don't take", async () => {
  const fixture = await site();
  const result = await fixture.run(["ploi", "media", "--yes"]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "gq: --yes is not valid for ploi media.\n");
});

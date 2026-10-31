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
function fakeGit({ tag = null, script = DEPLOY_SCRIPT, files = {} } = {}) {
  return recordingExec(async ({ command, args }) => {
    assert.equal(command, "git");
    if (args[0] === "describe") {
      return tag ? { stdout: `${tag}\n` } : { code: 128, stderr: "fatal: no tag exactly matches" };
    }
    if (args[0] === "rev-parse") return { stdout: `${SHA}\n` };
    if (args[0] === "show" && args[1] === `${SHA}:VERSION`) return { stdout: "1.4.0\n" };
    if (args[0] === "show" && args[1] === `${SHA}:deploy/ploi/admin.sh`) {
      return { stdout: script };
    }
    if (args[0] === "show" && args[1].startsWith(`${SHA}:`)) {
      const content = files[args[1].slice(SHA.length + 1)];
      return content === undefined
        ? { code: 128, stderr: `fatal: path '${args[1]}' does not exist` }
        : { stdout: content };
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

// --- the Site's deployment policy (gq.ops.json deployment) ------------------

const PAUSED = Object.freeze({
  protected: true,
  state: "paused",
  reason: "Nightly updates paused for a controlled release",
});
const RESERVED = Object.freeze({
  protected: true,
  state: "reserved",
  reason: "The nightly pipeline is updating the Site",
  holder: "nightly pipeline",
});

test("ploi release refuses a paused or reserved Site before any provider call", async () => {
  for (const deployment of [PAUSED, RESERVED]) {
    const fixture = await site({ ops: { ...OPS, deployment } });
    const { fetch } = fakeProviders();
    const exec = fakeGit();

    const result = await fixture.run(["ploi", "release"], { env: RELEASE_ENV, fetch, exec });

    assert.equal(result.code, 1);
    assert.deepEqual(fetch.requests, [], "nothing is uploaded, synced or deployed");
    assert.match(result.stderr, new RegExp(`deployment\\.state: ${deployment.state}`, "u"));
    assert.match(result.stderr, new RegExp(deployment.reason, "u"));
    if (deployment.holder) assert.match(result.stderr, /reserved by nightly pipeline/u);
    assert.match(result.stderr, /reviewed Site change/u);
  }
});

test("ploi release deploys an authorized protected Site and an ordinary one", async () => {
  for (const ops of [OPS, { ...OPS, deployment: { protected: true, state: "authorized" } }]) {
    const fixture = await site({ ops });
    const { fetch, state } = fakeProviders();

    const result = await fixture.run(["ploi", "release"], {
      env: RELEASE_ENV,
      fetch,
      exec: fakeGit(),
    });

    assert.equal(result.code, 0, result.stderr);
    assert.ok(state.deployed);
  }
});

test("gq.ops.json refuses a protected Site without an explicit, explained state", async () => {
  const cases = [
    [{ protected: true }, /deployment\.state/u],
    [{ protected: true, state: "open" }, /deployment\.state/u],
    [{ protected: true, state: "paused" }, /deployment\.reason/u],
    [{ protected: true, state: "reserved", reason: "nightly" }, /deployment\.holder/u],
    [{ protected: false, state: "authorized" }, /deployment\.protected/u],
    [{ protected: true, state: "authorized", guardedPackages: ["gq-support"] }, /guardedPackages/u],
  ];
  for (const [deployment, message] of cases) {
    const fixture = await site({ ops: { ...OPS, deployment } });
    const { fetch } = fakeProviders();

    const result = await fixture.run(["ploi", "release"], { env: RELEASE_ENV, fetch });

    assert.equal(result.code, 1, JSON.stringify(deployment));
    assert.match(result.stderr, message, JSON.stringify(deployment));
    assert.deepEqual(fetch.requests, []);
  }
});

// --- guarded packages (deployment.guardedPackages) --------------------------

const GUARDED_OPS = Object.freeze({
  ...OPS,
  deployment: { protected: true, state: "authorized", guardedPackages: ["getquick/gq-support"] },
});
const GUARDED_SCRIPT = `#!/usr/bin/env bash\nGUARDED_PACKAGES="getquick/gq-support"\necho deploy\n`;
const PUBLISHED_REFERENCE = "b".repeat(40);
// gq-support.php ("hello\n") alone, and its gq-support.files/v1 digest, from
// printf 'gq-support.php\0<sha256>\n' | sha256sum.
const SUPPORT_FILES = Object.freeze({
  "gq-support.php": "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
});
const SUPPORT_DIGEST = "335b71ade6b432f03f1858a221294a017f4d6dc1f635a504e85194dcf30b26ce";
// fakeClock's now.
const OBSERVED = "2026-10-01T09:00:00Z";

function expectationsFile(overrides = {}) {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      packages: [
        {
          name: "getquick/gq-support",
          version: "0.1.11",
          lockReference: PUBLISHED_REFERENCE,
          installPath: "web/app/plugins/gq-support",
          filesDigest: SUPPORT_DIGEST,
          ...overrides,
        },
      ],
    },
    null,
    2,
  )}\n`;
}

// A gq-support.composer-approval/v1 record, as the approval service returns it.
function approvalRecord(overrides = {}) {
  return {
    schema: "gq-support.composer-approval/v1",
    stage: "production",
    slot: "fixture",
    phase: "deploy",
    release_id: "release-0.1.11",
    package: { name: "getquick/gq-support", version: "0.1.11", zip_sha256: "f".repeat(64) },
    provenance: { source_commit: "c".repeat(40), release_run: "run-42" },
    files: SUPPORT_FILES,
    files_digest: SUPPORT_DIGEST,
    normalization: "gq-support.files/v1",
    observed_at: OBSERVED,
    ...overrides,
  };
}

// An approval adapter answering each lookup with the next of `answers` (a
// record, or an Error it rejects with), noting each request and, when given
// `fetch`, the provider requests made before it.
function scriptedApprovals(answers, fetch) {
  const requests = [];
  return {
    requests,
    async lookup(request) {
      requests.push({ ...request, before: fetch?.requests.map(requestLine) });
      const answer = answers[Math.min(requests.length - 1, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

function releaseLock({ version = "0.1.11", reference = PUBLISHED_REFERENCE } = {}) {
  return JSON.stringify({
    packages: [{ name: "getquick/gq-support", version, dist: { type: "zip", reference } }],
    "packages-dev": [],
  });
}

function guardedGit({ files = {}, script = GUARDED_SCRIPT } = {}) {
  return fakeGit({
    script,
    files: {
      "deploy/ploi/package-expectations.json": expectationsFile(),
      "apps/cms/composer.lock": releaseLock(),
      ...files,
    },
  });
}

const changesPloiSite = (lines) =>
  lines.filter(
    (line) =>
      line === "PATCH /api/servers/12/sites/34/deploy/script" ||
      line === "POST /api/servers/12/sites/34/deploy",
  );

test("a guarded Site's release refuses without an approval adapter, before any provider call", async () => {
  const fixture = await site({ ops: GUARDED_OPS });
  const { fetch } = fakeProviders();

  const result = await fixture.run(["ploi", "release"], {
    env: RELEASE_ENV,
    fetch,
    exec: guardedGit(),
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /No authenticated package approval service is configured/u);
  assert.match(result.stderr, /\(phase deploy\)/u);
  assert.match(result.stderr, /not an approval/u);
  assert.deepEqual(fetch.requests, []);
});

test("a guarded Site's release refuses missing or mismatched expectations before looking anything up", async () => {
  const cases = [
    [
      { "deploy/ploi/package-expectations.json": undefined },
      {},
      /has no deploy\/ploi\/package-expectations\.json/u,
    ],
    [
      { "apps/cms/composer.lock": releaseLock({ version: "0.1.10" }) },
      {},
      /locks getquick\/gq-support 0\.1\.10, not the expected 0\.1\.11/u,
    ],
    [
      { "apps/cms/composer.lock": releaseLock({ reference: "c".repeat(40) }) },
      {},
      /at reference c{40}, not the expected b{40}/u,
    ],
    [
      { "deploy/ploi/package-expectations.json": expectationsFile({ name: "getquick/gq-design" }) },
      {},
      /doesn't state getquick\/gq-support/u,
    ],
    [
      {},
      { script: DEPLOY_SCRIPT },
      /doesn't verify getquick\/gq-support after composer install.*run gq sync/u,
    ],
  ];
  for (const [files, options, message] of cases) {
    const fixture = await site({ ops: GUARDED_OPS });
    const { fetch } = fakeProviders();
    const approvals = scriptedApprovals([approvalRecord()]);

    const result = await fixture.run(["ploi", "release"], {
      env: RELEASE_ENV,
      fetch,
      exec: guardedGit({ files, ...options }),
      approvals,
    });

    assert.equal(result.code, 1, String(message));
    assert.match(result.stderr, message);
    assert.deepEqual(fetch.requests, []);
    assert.deepEqual(approvals.requests, []);
  }
});

test("a guarded Site's release refuses an approval that is stale, for preparation, or for other files", async () => {
  const cases = [
    [approvalRecord({ observed_at: "2026-10-01T08:50:00Z" }), /not within 5 minutes of now/u],
    [approvalRecord({ phase: "prepare" }), /is for phase prepare, not deploy/u],
    [
      approvalRecord({
        files: { ...SUPPORT_FILES, "extra.php": "0".repeat(64) },
        files_digest: "4".repeat(64),
      }),
      /says its files hash to 4{64}/u,
    ],
    [
      // Self-consistent, but not the files the Site expects.
      approvalRecord({
        files: { "gq-support.php": "1".repeat(64) },
        files_digest: "f3f43a16353df5832b31aa745cc4de1368172cea3259d51ab3eb0746169f9980",
      }),
      new RegExp(
        `approved getquick/gq-support 0\\.1\\.11 files hash to f3f43a16[0-9a-f]{56}, not the ${SUPPORT_DIGEST}`,
        "u",
      ),
    ],
  ];
  for (const [record, message] of cases) {
    const fixture = await site({ ops: GUARDED_OPS });
    const { fetch } = fakeProviders();

    const result = await fixture.run(["ploi", "release"], {
      env: RELEASE_ENV,
      fetch,
      exec: guardedGit(),
      approvals: scriptedApprovals([record]),
    });

    assert.equal(result.code, 1, String(message));
    assert.match(result.stderr, message);
    assert.deepEqual(fetch.requests, []);
  }
});

test("a guarded release looks its deploy approval up again right before changing the Ploi site, and ships the approved files", async () => {
  const fixture = await site({ ops: GUARDED_OPS });
  const { fetch, state } = fakeProviders({ state: { deployScript: GUARDED_SCRIPT } });
  const exec = guardedGit();
  const approvals = scriptedApprovals([approvalRecord()], fetch);

  const result = await fixture.run(["ploi", "release", "--composer-only"], {
    env: RELEASE_ENV,
    fetch,
    exec,
    approvals,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(approvals.requests.length, 2);
  for (const request of approvals.requests) {
    assert.deepEqual(
      { ...request, before: undefined },
      {
        phase: "deploy",
        project: "fixture",
        releaseCommit: SHA,
        package: { name: "getquick/gq-support", version: "0.1.11" },
        before: undefined,
      },
    );
  }
  // The first lookup comes before any provider call; the fresh one after the
  // upload and before the script sync or the deploy.
  assert.deepEqual(approvals.requests[0].before, []);
  assert.ok(approvals.requests[1].before.some((line) => line.startsWith("PUT ")));
  assert.deepEqual(changesPloiSite(approvals.requests[1].before), []);
  const archive = exec.calls.find(({ args }) => args[0] === "archive").args;
  const shipped = archive.find((argument) =>
    argument.startsWith("--add-virtual-file=PACKAGE_EXPECTATIONS:"),
  );
  assert.ok(shipped, archive.join("\n"));
  assert.match(
    shipped,
    new RegExp(
      `\\npackage getquick/gq-support 0\\.1\\.11 web/app/plugins/gq-support ${SUPPORT_DIGEST}\\nfile ${SUPPORT_FILES["gq-support.php"]} gq-support\\.php\\n$`,
      "u",
    ),
  );
  const put = fetch.requests.find(({ method }) => method === "PUT");
  assert.match(new URL(put.url).pathname, /\/admin\/v1\.4\.0-0123456789ab-[0-9a-f]{12}\.tar\.gz$/u);
  assert.equal(state.deployed.composer_only, "true");
});

test("a guarded release whose approval is withdrawn or changed before the deploy doesn't change the Ploi site", async () => {
  const cases = [
    [
      new Error("gq-support 0.1.11 was withdrawn"),
      /no longer approved for deploy \(gq-support 0\.1\.11 was withdrawn\); the Ploi site was not changed/u,
    ],
    [
      approvalRecord({ release_id: "release-0.1.11-b" }),
      /approval changed since this release checked it \(release_id release-0\.1\.11 → release-0\.1\.11-b\)/u,
    ],
    [
      approvalRecord({ observed_at: "2026-10-01T08:00:00Z" }),
      /no longer approved for deploy .*not within 5 minutes/u,
    ],
  ];
  for (const [fresh, message] of cases) {
    const fixture = await site({ ops: GUARDED_OPS });
    const { fetch, state } = fakeProviders({ state: { deployScript: "echo stale\n" } });

    const result = await fixture.run(["ploi", "release"], {
      env: RELEASE_ENV,
      fetch,
      exec: guardedGit(),
      approvals: scriptedApprovals([approvalRecord(), fresh]),
    });

    assert.equal(result.code, 1, String(message));
    assert.match(result.stderr, message);
    assert.deepEqual(changesPloiSite(fetch.requests.map(requestLine)), []);
    assert.equal(state.deployed, undefined);
    assert.equal(state.deployScript, "echo stale\n");
  }
});

// --- gq release package (a package redeploy through ploi release) ---------

const DEV_COMMIT = "b18a61aa565ac77618c772f1e50f4c42155cafa7";

function lockWith(version, reference) {
  return `${JSON.stringify(
    {
      packages: [{ name: "getquick/gq-design", version, source: { type: "git", reference } }],
      "packages-dev": [],
    },
    null,
    4,
  )}\n`;
}

// A content site at 1.4.0 whose CMS requires gq-design from main, locked at
// 0.4.6.
function packageSite(extra = {}) {
  const json = (data) => `${JSON.stringify(data, null, 2)}\n`;
  return site({
    ops: { ...OPS, ...extra },
    files: {
      VERSION: "1.4.0\n",
      "package.json": json({ name: "fixture", version: "1.4.0", private: true }),
      "apps/frontend/package.json": json({ name: "frontend", version: "1.4.0" }),
      "apps/cms/composer.json": json({
        require: { "getquick/gq-design": "dev-main as 0.5.99" },
      }),
      "apps/cms/composer.lock": lockWith("0.4.6", "a".repeat(40)),
    },
  });
}

// Composer (whose update writes `lock`, if any) and git: a clean tree until
// Composer has run, then the release commit the fake git of ploi release reads.
function packageExec(fixture, { lock } = {}) {
  const release = fakeGit();
  let updated = false;
  return recordingExec(async (call) => {
    const { command, args } = call;
    if (command === "sh") return {};
    if (command === "composer") {
      if (args[0] === "update") {
        if (lock) await writeFile(fixture.path("apps/cms/composer.lock"), lock);
        updated = Boolean(lock);
      }
      return {};
    }
    if (command === "git" && args[0] === "status") {
      return { stdout: updated ? " M apps/cms/composer.lock\n" : "" };
    }
    if (command === "git" && (args[0] === "add" || args[0] === "commit")) return {};
    return release(command, args);
  });
}

test("release package updates one package, commits composer.lock and deploys that commit", async () => {
  const fixture = await packageSite();
  const { fetch, state } = fakeProviders();
  const exec = packageExec(fixture, { lock: lockWith("dev-main", DEV_COMMIT) });

  const result = await fixture.run(["release", "package", "getquick/gq-design"], {
    env: RELEASE_ENV,
    fetch,
    exec,
  });

  assert.equal(result.code, 0, result.stderr);
  const commands = exec.calls.map(({ command, args }) => [command, ...args].join(" "));
  const update = commands.indexOf("composer update getquick/gq-design --no-interaction");
  const commit = commands.indexOf(
    "git commit -m Update getquick/gq-design to dev-main (b18a61aa565a)",
  );
  const released = commands.indexOf("git rev-parse HEAD^{commit}");
  assert.ok(update !== -1 && commit !== -1 && released !== -1, commands.join("\n"));
  assert.ok(update < commands.indexOf("git add --update"));
  assert.ok(commands.indexOf("git add --update") < commit);
  assert.ok(commit < released, "the release is of the new commit");
  // Composer runs in the CMS with the registry login.
  const composer = exec.calls[update];
  assert.equal(composer.cwd, fixture.path("apps/cms"));
  assert.equal(composer.env.COMPOSER_AUTH, RELEASE_ENV.COMPOSER_AUTH);
  assert.ok(!commands.some((line) => line.startsWith("git tag") || line.startsWith("git push")));
  assert.ok(state.deployed, "Ploi deployed");
  assert.match(result.stdout, /Deployed v1\.4\.0 \(0123456\)/u);
  assert.match(result.stdout, /Push the commit/u);
});

test("release package with nothing to update redeploys HEAD without committing", async () => {
  const fixture = await packageSite();
  const { fetch, state } = fakeProviders();
  const exec = packageExec(fixture);

  const result = await fixture.run(["release", "package", "getquick/gq-design"], {
    env: RELEASE_ENV,
    fetch,
    exec,
  });

  assert.equal(result.code, 0, result.stderr);
  const commands = exec.calls.map(({ command, args }) => [command, ...args].join(" "));
  assert.ok(!commands.some((line) => line.startsWith("git commit")), commands.join("\n"));
  assert.match(result.stdout, /already pins getquick\/gq-design 0\.4\.6; deploying HEAD/u);
  assert.ok(state.deployed);
});

test("release package refuses a dirty tree, an unrequired package and a malformed name", async () => {
  const fixture = await packageSite();
  const dirty = recordingExec(({ command, args }) =>
    command === "git" && args[0] === "status" ? { stdout: " M README.md\n" } : {},
  );

  const unclean = await fixture.run(["release", "package", "getquick/gq-design"], {
    env: RELEASE_ENV,
    exec: dirty,
  });
  assert.equal(unclean.code, 1);
  assert.match(unclean.stderr, /requires a clean working tree/u);
  assert.ok(!dirty.calls.some(({ command }) => command === "composer"));

  const unrequired = await fixture.run(["release", "package", "getquick/gq-support"], {
    env: RELEASE_ENV,
  });
  assert.equal(unrequired.code, 1);
  assert.equal(
    unrequired.stderr,
    "gq: apps/cms/composer.json doesn't require getquick/gq-support.\n",
  );

  const malformed = await fixture.run(["release", "package", "gq-design"], { env: RELEASE_ENV });
  assert.equal(malformed.code, 1);
  assert.equal(malformed.stderr, "gq: Usage: gq release package <composer-package>\n");
});

test("release package refuses a paused Site before Composer, a commit or a provider call", async () => {
  const fixture = await packageSite({ deployment: PAUSED });
  const { fetch } = fakeProviders();
  const exec = packageExec(fixture, { lock: lockWith("dev-main", DEV_COMMIT) });

  const result = await fixture.run(["release", "package", "getquick/gq-design"], {
    env: RELEASE_ENV,
    fetch,
    exec,
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /deployment\.state: paused/u);
  assert.deepEqual(fetch.requests, []);
  assert.ok(!exec.calls.some(({ command }) => command === "composer"));
  assert.ok(!exec.calls.some(({ args }) => args[0] === "commit"));
});

// --- guarded package preparation (release package --to / --no-deploy) --------

const SUPPORT = "getquick/gq-support";
const OLD_REF = "1".repeat(40);
const NEW_REF = "2".repeat(40);
const SUPPORT_COMPOSER = `${JSON.stringify(
  {
    name: "fixture/cms",
    // A compatible range, as a Site's own composer.json has it.
    require: { "getquick/gq-design": "0.9.4", [SUPPORT]: "^0.1.3", php: ">=8.4" },
    "minimum-stability": "dev",
  },
  null,
  2,
)}\n`;

function supportLock({ version = "0.1.11", reference = NEW_REF, design = "0.9.4", dev = [] } = {}) {
  return `${JSON.stringify(
    {
      "content-hash": `hash-${version}-${design}`,
      packages: [
        { name: "getquick/gq-design", version: design, dist: { reference: "d".repeat(40) } },
        { name: SUPPORT, version, dist: { type: "zip", reference } },
      ],
      "packages-dev": dev,
    },
    null,
    4,
  )}\n`;
}

function supportSite(extra = {}, composer = SUPPORT_COMPOSER) {
  const json = (data) => `${JSON.stringify(data, null, 2)}\n`;
  return site({
    ops: { ...OPS, ...extra },
    files: {
      VERSION: "1.4.0\n",
      "package.json": json({ name: "fixture", version: "1.4.0", private: true }),
      "apps/frontend/package.json": json({ name: "frontend", version: "1.4.0" }),
      "apps/cms/composer.json": composer,
      "apps/cms/composer.lock": supportLock({ version: "0.1.10", reference: OLD_REF }),
    },
  });
}

// Composer's update writes `lock` (and, with `composerJson`, rewrites
// composer.json); git reports the tracked files whose content changed since
// this was made, plus `extra` paths once Composer has run, and accepts add
// and commit.
function supportExec(fixture, { lock = supportLock(), extra = [], composerJson } = {}) {
  const tracked = [
    "apps/cms/composer.json",
    "apps/cms/composer.lock",
    "deploy/ploi/package-expectations.json",
  ];
  const read = (path) => readFile(fixture.path(path), "utf8").catch(() => null);
  const initial = Promise.all(tracked.map(read));
  let updated = false;
  return recordingExec(async ({ command, args }) => {
    if (command === "sh") return {};
    if (command === "composer") {
      if (args[0] === "update") {
        await writeFile(fixture.path("apps/cms/composer.lock"), lock);
        if (composerJson) await writeFile(fixture.path("apps/cms/composer.json"), composerJson);
        updated = true;
      }
      return {};
    }
    if (command === "git" && args[0] === "status") {
      const before = await initial;
      const now = await Promise.all(tracked.map(read));
      const paths = [
        ...tracked.filter((_, index) => now[index] !== before[index]),
        ...(updated ? extra : []),
      ];
      return { stdout: paths.map((path) => ` M ${path}\n`).join("") };
    }
    if (command === "git" && (args[0] === "add" || args[0] === "commit")) return {};
    return { code: 1, stderr: `unexpected ${command} ${args.join(" ")}` };
  });
}

const commandLines = (exec) => exec.calls.map(({ command, args }) => [command, ...args].join(" "));

test("release package --to locks exactly the approved version, leaving a compatible requirement alone, and calls no provider", async () => {
  const fixture = await supportSite();
  const { fetch } = fakeProviders();
  const exec = supportExec(fixture);

  const result = await fixture.run(
    [
      "release",
      "package",
      SUPPORT,
      "--to",
      "0.1.11",
      "--reference",
      NEW_REF,
      "--expect-before",
      "0.1.10",
      "--no-deploy",
    ],
    { env: RELEASE_ENV, fetch, exec },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(fetch.requests, [], "no upload, script sync or deploy");
  const lines = commandLines(exec);
  // Exactly 0.1.11, though ^0.1.3 admits newer releases too.
  assert.ok(
    lines.includes(
      `composer update ${SUPPORT} --with ${SUPPORT}:0.1.11 --no-interaction --no-install`,
    ),
    lines.join("\n"),
  );
  assert.ok(
    !lines.some((line) => /\s(-w|-W|--with-(all-)?dependencies)\b/u.test(line)),
    "never --with-dependencies",
  );
  // Lock-only: the requirement is kept byte for byte, and only the lock is committed.
  assert.equal(await readFile(fixture.path("apps/cms/composer.json"), "utf8"), SUPPORT_COMPOSER);
  assert.ok(lines.includes("git add -- apps/cms/composer.lock"), lines.join("\n"));
  assert.ok(lines.includes(`git commit -m Update ${SUPPORT} to 0.1.11`), lines.join("\n"));
  assert.ok(
    !lines.some((line) => /^git (rev-parse|archive|push|tag)/u.test(line)),
    lines.join("\n"),
  );
  assert.match(result.stdout, /without deploying: nothing was uploaded/u);
});

test("release package --to refuses a requirement that doesn't admit the version unless --pin sets it", async () => {
  for (const [constraint, message] of [
    [
      "^0.1.3",
      /requires getquick\/gq-support \^0\.1\.3, which doesn't admit 0\.2\.0; nothing changed\. Add --pin/u,
    ],
    ["dev-main as 0.1.99", /which gq can't tell admits 0\.2\.0; nothing changed\. Add --pin/u],
  ]) {
    const composer = SUPPORT_COMPOSER.replace('"^0.1.3"', JSON.stringify(constraint));
    const fixture = await supportSite({}, composer);
    const exec = supportExec(fixture, { lock: supportLock({ version: "0.2.0" }) });

    const refused = await fixture.run(
      ["release", "package", SUPPORT, "--to", "0.2.0", "--no-deploy"],
      {
        env: RELEASE_ENV,
        exec,
      },
    );

    assert.equal(refused.code, 1, constraint);
    assert.match(refused.stderr, message);
    assert.ok(!exec.calls.some(({ command }) => command === "composer"));
    assert.equal(await readFile(fixture.path("apps/cms/composer.json"), "utf8"), composer);
  }

  const fixture = await supportSite();
  const exec = supportExec(fixture, { lock: supportLock({ version: "0.2.0" }) });
  const pinned = await fixture.run(
    ["release", "package", SUPPORT, "--to", "0.2.0", "--pin", "--no-deploy"],
    { env: RELEASE_ENV, exec },
  );
  assert.equal(pinned.code, 0, pinned.stderr);
  // Only that requirement changed, formatting kept.
  assert.equal(
    await readFile(fixture.path("apps/cms/composer.json"), "utf8"),
    SUPPORT_COMPOSER.replace('"getquick/gq-support": "^0.1.3"', '"getquick/gq-support": "0.2.0"'),
  );
  assert.ok(
    commandLines(exec).includes("git add -- apps/cms/composer.json apps/cms/composer.lock"),
  );

  const unnamed = await fixture.run(["release", "package", SUPPORT, "--pin", "--no-deploy"], {
    env: RELEASE_ENV,
  });
  assert.equal(unnamed.code, 1);
  assert.match(unnamed.stderr, /--pin sets the requirement to --to's version/u);
});

test("release package --to refuses a composer.json change it didn't ask for", async () => {
  const fixture = await supportSite();
  const exec = supportExec(fixture, {
    composerJson: SUPPORT_COMPOSER.replace('"^0.1.3"', '"*"'),
  });

  const result = await fixture.run(
    ["release", "package", SUPPORT, "--to", "0.1.11", "--no-deploy"],
    { env: RELEASE_ENV, exec },
  );

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /changed apps\/cms\/composer\.json too; only apps\/cms\/composer\.lock may change/u,
  );
  assert.equal(await readFile(fixture.path("apps/cms/composer.json"), "utf8"), SUPPORT_COMPOSER);
  assert.ok(!commandLines(exec).some((line) => line.startsWith("git commit")));
});

test("release package refuses a lock update that changes another package, restoring both files", async () => {
  const cases = [
    supportLock({ design: "0.9.5" }),
    supportLock({ dev: [{ name: "pestphp/pest", version: "4.0.0" }] }),
  ];
  for (const lock of cases) {
    const fixture = await supportSite();
    const exec = supportExec(fixture, { lock });

    const result = await fixture.run(
      ["release", "package", SUPPORT, "--to", "0.1.11", "--no-deploy"],
      { env: RELEASE_ENV, exec },
    );

    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /changed other locked packages: (changed getquick\/gq-design in packages|added pestphp\/pest to packages-dev)/u,
    );
    assert.match(result.stderr, /restored; nothing was committed/u);
    assert.equal(await readFile(fixture.path("apps/cms/composer.json"), "utf8"), SUPPORT_COMPOSER);
    assert.equal(
      await readFile(fixture.path("apps/cms/composer.lock"), "utf8"),
      supportLock({ version: "0.1.10", reference: OLD_REF }),
    );
    assert.ok(!commandLines(exec).some((line) => line.startsWith("git commit")));
  }
});

test("release package refuses the wrong version or reference after the update", async () => {
  const wrongVersion = await supportSite();
  const version = await wrongVersion.run(
    ["release", "package", SUPPORT, "--to", "0.1.11", "--no-deploy"],
    {
      env: RELEASE_ENV,
      exec: supportExec(wrongVersion, { lock: supportLock({ version: "0.1.12" }) }),
    },
  );
  assert.equal(version.code, 1);
  assert.match(
    version.stderr,
    /locks getquick\/gq-support 0\.1\.12 after the update, not 0\.1\.11/u,
  );

  const wrongReference = await supportSite();
  const reference = await wrongReference.run(
    ["release", "package", SUPPORT, "--to", "0.1.11", "--reference", "3".repeat(40), "--no-deploy"],
    { env: RELEASE_ENV, exec: supportExec(wrongReference) },
  );
  assert.equal(reference.code, 1);
  assert.match(reference.stderr, new RegExp(`at reference ${NEW_REF}, not ${"3".repeat(40)}`, "u"));
  assert.equal(
    await readFile(wrongReference.path("apps/cms/composer.json"), "utf8"),
    SUPPORT_COMPOSER,
  );
});

test("release package refuses an unexpected starting version, other changed files and an unpinned guarded package", async () => {
  const fixture = await supportSite();
  const before = supportExec(fixture);
  const expected = await fixture.run(
    ["release", "package", SUPPORT, "--to", "0.1.11", "--expect-before", "0.1.9", "--no-deploy"],
    { env: RELEASE_ENV, exec: before },
  );
  assert.equal(expected.code, 1);
  assert.match(
    expected.stderr,
    /locks getquick\/gq-support 0\.1\.10, not 0\.1\.9 \(--expect-before\); nothing changed/u,
  );
  assert.ok(!before.calls.some(({ command }) => command === "composer"));

  const extra = await supportSite();
  const other = await extra.run(["release", "package", SUPPORT, "--to", "0.1.11", "--no-deploy"], {
    env: RELEASE_ENV,
    exec: supportExec(extra, { extra: ["apps/cms/auth.json"] }),
  });
  assert.equal(other.code, 1);
  assert.match(other.stderr, /changed apps\/cms\/auth\.json too/u);
  assert.equal(await readFile(extra.path("apps/cms/composer.json"), "utf8"), SUPPORT_COMPOSER);

  const guarded = await supportSite({
    deployment: { protected: true, state: "authorized", guardedPackages: [SUPPORT] },
  });
  const unpinned = await guarded.run(["release", "package", SUPPORT, "--no-deploy"], {
    env: RELEASE_ENV,
    exec: supportExec(guarded),
  });
  assert.equal(unpinned.code, 1);
  assert.match(
    unpinned.stderr,
    /is guarded \(gq\.ops\.json deployment\.guardedPackages\): name its exact version with --to/u,
  );
});

test("release package rolls a package back to an exact earlier version, lock-only, without touching its dependants", async () => {
  // A recovery drill: 0.1.12 locked, back to 0.1.11, while the theme that
  // constrains gq-support (^0.1.0) and GQ Design stay exactly as locked.
  const theme = {
    name: "getquick/getquick-theme",
    version: "0.5.1",
    require: { "getquick/gq-support": "^0.1.0" },
    dist: { reference: "e".repeat(40) },
  };
  const lock = (version, reference) =>
    `${JSON.stringify(
      {
        packages: [
          { name: "getquick/gq-design", version: "0.9.4", dist: { reference: "d".repeat(40) } },
          theme,
          { name: SUPPORT, version, dist: { type: "zip", reference } },
        ],
        "packages-dev": [],
      },
      null,
      4,
    )}\n`;
  // ^0.1.3 admits both 0.1.11 and 0.1.12: the requirement stays as it is.
  const composer = SUPPORT_COMPOSER;
  const json = (data) => `${JSON.stringify(data, null, 2)}\n`;
  const fixture = await site({
    files: {
      VERSION: "1.4.0\n",
      "package.json": json({ name: "fixture", version: "1.4.0", private: true }),
      "apps/frontend/package.json": json({ name: "frontend", version: "1.4.0" }),
      "apps/cms/composer.json": composer,
      "apps/cms/composer.lock": lock("0.1.12", NEW_REF),
    },
  });
  const { fetch } = fakeProviders();
  const exec = supportExec(fixture, { lock: lock("0.1.11", OLD_REF) });

  const result = await fixture.run(
    [
      "release",
      "package",
      SUPPORT,
      "--to",
      "0.1.11",
      "--expect-before",
      "0.1.12",
      "--reference",
      OLD_REF,
      "--no-deploy",
    ],
    { env: RELEASE_ENV, fetch, exec },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(fetch.requests, []);
  const lines = commandLines(exec);
  assert.ok(lines.includes(`git commit -m Update ${SUPPORT} to 0.1.11`));
  assert.ok(lines.includes("git add -- apps/cms/composer.lock"), lines.join("\n"));
  assert.equal(await readFile(fixture.path("apps/cms/composer.json"), "utf8"), composer);
});

// A Site guarding gq-support, and Composer moving it to 0.1.11.
const GUARDED_SUPPORT = Object.freeze({
  deployment: { protected: true, state: "authorized", guardedPackages: [SUPPORT] },
});
const prepareRecord = () => approvalRecord({ phase: "prepare" });
const guardedPrepare = (fixture, options = {}) =>
  supportExec(fixture, {
    lock: supportLock({ version: "0.1.11" }),
    ...options,
  });
const PREPARE = ["release", "package", SUPPORT, "--to", "0.1.11", "--no-deploy"];

test("release package refuses to prepare a guarded package without an approval adapter, before Composer runs", async () => {
  const fixture = await supportSite(GUARDED_SUPPORT);
  const exec = guardedPrepare(fixture);

  const result = await fixture.run(PREPARE, { env: RELEASE_ENV, exec });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /No authenticated package approval service is configured.*\(phase prepare\).*Nothing changed\./u,
  );
  assert.ok(!exec.calls.some(({ command }) => command === "composer"));
  assert.equal(await readFile(fixture.path("apps/cms/composer.json"), "utf8"), SUPPORT_COMPOSER);
});

test("release package prepares a guarded package from a fresh prepare approval and commits its expectation with the lock", async () => {
  const fixture = await supportSite(GUARDED_SUPPORT);
  const { fetch } = fakeProviders();
  const exec = guardedPrepare(fixture);
  const approvals = scriptedApprovals([prepareRecord()]);

  const result = await fixture.run(PREPARE, { env: RELEASE_ENV, fetch, exec, approvals });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(fetch.requests, [], "preparing calls no provider");
  assert.deepEqual(approvals.requests, [
    {
      phase: "prepare",
      project: "fixture",
      package: { name: SUPPORT, version: "0.1.11" },
      before: undefined,
    },
  ]);
  const lines = commandLines(exec);
  assert.ok(
    lines.includes("git add -- apps/cms/composer.lock deploy/ploi/package-expectations.json"),
    lines.join("\n"),
  );
  assert.deepEqual(
    JSON.parse(await readFile(fixture.path("deploy/ploi/package-expectations.json"), "utf8")),
    {
      schemaVersion: 1,
      packages: [
        {
          name: SUPPORT,
          version: "0.1.11",
          lockReference: NEW_REF,
          installPath: "web/app/plugins/gq-support",
          filesDigest: SUPPORT_DIGEST,
        },
      ],
    },
  );
  assert.match(result.stdout, /without deploying/u);
});

test("release package doesn't prepare a guarded package from a deploy-phase record or past a lock surprise", async () => {
  const deployPhase = await supportSite(GUARDED_SUPPORT);
  const wrongPhase = await deployPhase.run(PREPARE, {
    env: RELEASE_ENV,
    exec: guardedPrepare(deployPhase),
    approvals: scriptedApprovals([approvalRecord()]),
  });
  assert.equal(wrongPhase.code, 1);
  assert.match(wrongPhase.stderr, /is for phase deploy, not prepare\. Nothing changed\./u);

  const surprise = await supportSite(GUARDED_SUPPORT);
  const changed = await surprise.run(PREPARE, {
    env: RELEASE_ENV,
    exec: guardedPrepare(surprise, { lock: supportLock({ version: "0.1.11", design: "0.9.5" }) }),
    approvals: scriptedApprovals([prepareRecord()]),
  });
  assert.equal(changed.code, 1);
  assert.match(changed.stderr, /changed getquick\/gq-design in packages/u);
  assert.match(changed.stderr, /package-expectations\.json are restored; nothing was committed/u);
  await assert.rejects(readFile(surprise.path("deploy/ploi/package-expectations.json"), "utf8"));
});

test("release package --no-deploy prepares a commit on a paused Site without calling a provider", async () => {
  const fixture = await supportSite({ deployment: PAUSED });
  const { fetch } = fakeProviders();

  const result = await fixture.run(
    ["release", "package", SUPPORT, "--to", "0.1.11", "--no-deploy"],
    { env: RELEASE_ENV, fetch, exec: supportExec(fixture) },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(fetch.requests, []);
});

// --- Composer-only deploys ----------------------------------------------------

test("ploi release --composer-only asks the deploy script to skip WordPress and the database", async () => {
  const fixture = await site();
  const { fetch, state } = fakeProviders();

  const result = await fixture.run(["ploi", "release", "--composer-only"], {
    env: RELEASE_ENV,
    fetch,
    exec: fakeGit(),
  });

  assert.equal(result.code, 0, result.stderr);
  // Ploi hands a deploy variable to the script uppercased: $COMPOSER_ONLY.
  assert.deepEqual(Object.keys(state.deployed).sort(), [
    "archive_url",
    "composer_auth",
    "composer_only",
  ]);
  assert.equal(state.deployed.composer_only, "true");
  assert.match(result.stdout, /Composer-only/u);
});

test("release package --composer-only deploys its commit Composer-only", async () => {
  const fixture = await packageSite();
  const { fetch, state } = fakeProviders();

  const result = await fixture.run(
    ["release", "package", "getquick/gq-design", "--composer-only"],
    {
      env: RELEASE_ENV,
      fetch,
      exec: packageExec(fixture, { lock: lockWith("dev-main", DEV_COMMIT) }),
    },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.equal(state.deployed.composer_only, "true");
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

const CONSENT_TOKEN = "fixture-consent-read-token-0123456789abcdef";

test("ploi events mirrors the consent read token to the CMS, with the Frontend URL it may be sent to", async () => {
  const fixture = await site();
  const { fetch, state } = fakeProviders();
  const env = {
    PLOI_API_TOKEN: "ploi-secret",
    PUBLICATION_EVENT_SECRET: EVENT_KEY,
    CONSENT_READ_TOKEN: CONSENT_TOKEN,
  };

  const result = await fixture.run(["ploi", "events"], { env, fetch });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    state.env,
    `${READY_ENV}PUBLICATION_EVENT_SECRET='${EVENT_KEY}'\n` +
      `GETQUICK_CONSENT_READ_TOKEN='${CONSENT_TOKEN}'\n` +
      "GETQUICK_FRONTEND_URL='https://www.example.test'\n",
  );
  assert.match(result.stdout, /~ GETQUICK_CONSENT_READ_TOKEN/u);
  assert.ok(!result.stdout.includes(CONSENT_TOKEN));

  const again = await fixture.run(["ploi", "events"], { env, fetch });
  assert.match(
    again.stdout,
    /already has this Site's PUBLICATION_EVENT_SECRET, GETQUICK_CONSENT_READ_TOKEN/u,
  );
  assert.equal(fetch.requests.filter(({ method }) => method === "PATCH").length, 1);
});

test("ploi events refuses a consent read token too short for the Frontend", async () => {
  const fixture = await site();
  const { fetch, state } = fakeProviders();

  const result = await fixture.run(["ploi", "events"], {
    env: {
      PLOI_API_TOKEN: "ploi-secret",
      PUBLICATION_EVENT_SECRET: EVENT_KEY,
      CONSENT_READ_TOKEN: "short",
    },
    fetch,
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /CONSENT_READ_TOKEN must be at least 32 characters/u);
  assert.equal(state.env, READY_ENV);
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

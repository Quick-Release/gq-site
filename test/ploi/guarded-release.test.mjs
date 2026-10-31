// Protected Sites' deploys at the run() seam: the deployment policy (holds,
// and the default branch's current policy, read with the system git) and
// guarded Composer packages' deploys (approval lookups, expectations, the
// fresh lookup right before the deploy). Their preparation is
// release/package.test.mjs's. The shared Ploi and git fixture is
// test/support/ploi-release.mjs; nothing here reaches the network.
import assert from "node:assert/strict";
import test from "node:test";

import {
  APPROVAL,
  approvalRecord,
  DEPLOY_SCRIPT,
  fakeGit,
  fakeProviders,
  OPS,
  PAUSED,
  PUBLISHED_REFERENCE,
  RELEASE_ENV,
  requestLine,
  RESERVED,
  scriptedApprovals,
  SHA,
  site,
  SUPPORT_DIGEST,
  SUPPORT_FILES,
  TRUSTED_GIT,
  ARTIFACTS_REMOTE,
} from "../support/ploi-release.mjs";

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

test("ploi release holds an old commit by the default branch's current policy, and refuses an unreadable one", async () => {
  const cases = [
    // A tag that predates the hold: its own gq.ops.json has no deployment block.
    [
      { current: { ...OPS, deployment: PAUSED } },
      /the default branch's gq\.ops\.json deployment\.state: paused/u,
    ],
    [
      { current: { ...OPS, offboarded: { at: "2026-10-01T09:00:00.000Z", phase: "cut" } } },
      /fixture is offboarded \(the default branch's gq\.ops\.json offboarded\)/u,
    ],
    [
      { manifest: { ...OPS, deployment: RESERVED }, current: OPS },
      /release 0123456789ab's gq\.ops\.json deployment\.state: reserved/u,
    ],
    // Fail closed: no current policy, even for an ordinary Site.
    [
      { current: null },
      /The default branch's gq\.ops\.json can't be read .* a release refuses without it/u,
    ],
    [
      { current: { ...OPS, deployment: { protected: true } } },
      /The default branch's gq\.ops\.json can't be read \(gq\.ops\.json is invalid/u,
    ],
    [{ manifest: null }, /Release 0123456789ab has no gq\.ops\.json/u],
  ];
  for (const [options, message] of cases) {
    const fixture = await site();
    const { fetch } = fakeProviders();
    const exec = fakeGit(options);

    const result = await fixture.run(["ploi", "release"], { env: RELEASE_ENV, fetch, exec });

    assert.equal(result.code, 1, String(message));
    assert.match(result.stderr, message);
    assert.deepEqual(fetch.requests, [], "nothing is uploaded, synced or deployed");
    // Reading origin's default branch never touches the working tree.
    for (const { args } of exec.calls) {
      assert.ok(
        ["describe", "rev-parse", "show", "ls-remote", "fetch"].includes(args[0]),
        args.join(" "),
      );
    }
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
    [
      {
        protected: true,
        state: "authorized",
        guardedPackages: ["getquick/gq-support"],
        approval: { stage: "prod", slot: " fixture/production" },
      },
      /deployment\.approval\.slot must not be empty or padded/u,
    ],
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
  deployment: {
    protected: true,
    state: "authorized",
    guardedPackages: ["getquick/gq-support"],
    approval: APPROVAL,
  },
});

const GUARDED_SCRIPT = `#!/usr/bin/env bash\nGUARDED_PACKAGES="getquick/gq-support"\necho deploy\n`;

function expectationsFile(overrides = {}) {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      packages: [
        {
          name: "getquick/gq-support",
          version: "0.1.11",
          releaseId: 11,
          ...overrides,
        },
      ],
    },
    null,
    2,
  )}\n`;
}

// Both references are the published tag's commit.
function releaseLock({
  version = "0.1.11",
  reference = PUBLISHED_REFERENCE,
  dist = PUBLISHED_REFERENCE,
} = {}) {
  return JSON.stringify({
    packages: [
      {
        name: "getquick/gq-support",
        version,
        type: "wordpress-plugin",
        source: { type: "git", reference },
        dist: { type: "zip", reference: dist },
      },
    ],
    "packages-dev": [],
  });
}

// The release commit's CMS composer.json: Bedrock's installer paths.
const RELEASE_COMPOSER = JSON.stringify({
  extra: {
    "installer-paths": {
      "web/app/mu-plugins/{$name}/": ["type:wordpress-muplugin"],
      "web/app/plugins/{$name}/": ["type:wordpress-plugin"],
      "web/app/themes/{$name}/": ["type:wordpress-theme"],
    },
  },
});

function guardedGit({ files = {}, script = GUARDED_SCRIPT } = {}) {
  return fakeGit({
    script,
    manifest: GUARDED_OPS,
    files: {
      "deploy/ploi/package-expectations.json": expectationsFile(),
      "apps/cms/composer.lock": releaseLock(),
      "apps/cms/composer.json": RELEASE_COMPOSER,
      ...files,
    },
  });
}

test("a guarded Site's release refuses without an approval adapter, before any provider call", async () => {
  const fixture = await site({ ops: GUARDED_OPS });
  const { fetch } = fakeProviders();

  const result = await fixture.run(["ploi", "release"], {
    env: RELEASE_ENV,
    fetch,
    exec: guardedGit(),
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /No package approval lookup is configured/u);
  assert.match(result.stderr, /\(phase deploy\)/u);
  assert.match(result.stderr, /not an approval/u);
  assert.deepEqual(fetch.requests, []);
});

test("a guarded Site's release refuses missing expectations or deploy script guard before looking anything up", async () => {
  const cases = [
    [
      { "deploy/ploi/package-expectations.json": undefined },
      {},
      /has no deploy\/ploi\/package-expectations\.json/u,
    ],
    [
      { "deploy/ploi/package-expectations.json": expectationsFile({ name: "getquick/gq-design" }) },
      {},
      /doesn't state getquick\/gq-support/u,
    ],
    [
      {
        "deploy/ploi/package-expectations.json": expectationsFile({
          lockReference: "b".repeat(40),
        }),
      },
      {},
      /lockReference/u,
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

test("a guarded Site's release refuses a lock that isn't the approved published package", async () => {
  const cases = [
    [
      releaseLock({ version: "0.1.10" }),
      /locks getquick\/gq-support 0\.1\.10, not the approved 0\.1\.11/u,
    ],
    [
      releaseLock({ reference: "c".repeat(40) }),
      /from source reference c{40}, not b{40}, the commit the approved v0\.1\.11 tag points to/u,
    ],
    // A repacked registry ZIP doesn't make another commit the approved package.
    [releaseLock({ dist: "e".repeat(40) }), /with dist reference e{40}, not b{40}/u],
    // Where it installs comes from the release commit's Composer configuration,
    // and must be unambiguous.
    [
      releaseLock(),
      /installer-paths has 2 patterns for getquick\/gq-support/u,
      JSON.stringify({
        extra: {
          "installer-paths": {
            "web/app/plugins/{$name}/": ["type:wordpress-plugin"],
            "web/app/mu-plugins/{$name}/": ["getquick/gq-support"],
          },
        },
      }),
    ],
    [releaseLock(), /installer-paths places getquick\/gq-support nowhere/u, "{}"],
  ];
  for (const [lock, message, composer = RELEASE_COMPOSER] of cases) {
    const fixture = await site({ ops: GUARDED_OPS });
    const { fetch } = fakeProviders();

    const result = await fixture.run(["ploi", "release"], {
      env: RELEASE_ENV,
      fetch,
      exec: guardedGit({
        files: { "apps/cms/composer.lock": lock, "apps/cms/composer.json": composer },
      }),
      approvals: scriptedApprovals([approvalRecord()]),
    });

    assert.equal(result.code, 1, String(message));
    assert.match(result.stderr, message);
    assert.deepEqual(fetch.requests, []);
  }
});

test("a guarded Site's release refuses an approval that is stale, for preparation, for another release, or not exactly the contract", async () => {
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
    [approvalRecord({ release_id: 12 }), /is release 12, not release 11/u],
    [approvalRecord({ approved: true }), /Unrecognized key: "approved"/u],
    [
      (() => {
        const { published_tag: tag, ...record } = approvalRecord();
        void tag;
        return record;
      })(),
      /published_tag/u,
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
        stage: "prod",
        slot: "fixture/production",
        releaseId: 11,
        releaseCommit: SHA,
        package: { name: "getquick/gq-support", version: "0.1.11" },
        before: undefined,
      },
    );
  }
  // The first lookup comes before any provider call; the fresh one after the
  // upload and the script sync, right before the deploy request.
  assert.deepEqual(approvals.requests[0].before, []);
  assert.ok(approvals.requests[1].before.some((line) => line.startsWith("PUT ")));
  assert.ok(approvals.requests[1].before.includes("GET /api/servers/12/sites/34/deploy/script"));
  assert.ok(!approvals.requests[1].before.includes("POST /api/servers/12/sites/34/deploy"));
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
      /no longer approved for deploy \(gq-support 0\.1\.11 was withdrawn\); nothing was deployed/u,
    ],
    [
      approvalRecord({ provenance: { source_commit: "d".repeat(40), release_run: "4242" } }),
      /approval changed since this release checked it \(provenance\.source_commit\)/u,
    ],
    [
      approvalRecord({ provenance: { source_commit: "c".repeat(40), release_run: "4243" } }),
      /approval changed since this release checked it \(provenance\.release_run\)/u,
    ],
    [
      approvalRecord({ published_tag: { name: "v0.1.11", commit: "d".repeat(40) } }),
      /approval changed since this release checked it \(published_tag\.commit\)/u,
    ],
    [
      approvalRecord({ published_tag: { name: "v0.1.11-rebuilt", commit: PUBLISHED_REFERENCE } }),
      /approval changed since this release checked it \(published_tag\.name\)/u,
    ],
    [
      approvalRecord({
        package: { name: "getquick/gq-support", version: "0.1.11", zip_sha256: "0".repeat(64) },
      }),
      /approval changed since this release checked it \(package\.zip_sha256\)/u,
    ],
    [
      // Self-consistent other files: the exact file map is compared, not only the digest.
      approvalRecord({
        files: { "gq-support.php": "1".repeat(64) },
        files_digest: "f3f43a16353df5832b31aa745cc4de1368172cea3259d51ab3eb0746169f9980",
      }),
      /approval changed since this release checked it \(files\.gq-support\.php, files_digest\)/u,
    ],
    [
      approvalRecord({ stage: "staging" }),
      /no longer approved for deploy .*is for staging slot fixture\/production, not this Site's prod slot/u,
    ],
    [
      approvalRecord({ slot: "other/production" }),
      /no longer approved for deploy .*is for prod slot other\/production/u,
    ],
    [
      approvalRecord({ phase: "prepare" }),
      /no longer approved for deploy .*is for phase prepare, not deploy/u,
    ],
    [
      approvalRecord({ schema: "gq-support.composer-approval/v2" }),
      /no longer approved for deploy .*schema/u,
    ],
    [
      (() => {
        const { schema, ...record } = approvalRecord();
        void schema;
        return record;
      })(),
      /no longer approved for deploy .*schema/u,
    ],
    [approvalRecord({ cached: true }), /no longer approved for deploy .*cached/u],
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
    // The fresh lookup comes after the script sync, right before the deploy
    // request, which never happens.
    assert.ok(!fetch.requests.map(requestLine).includes("POST /api/servers/12/sites/34/deploy"));
    assert.equal(state.deployed, undefined);
  }
});

// --- guarded package preparation (release package --to / --no-deploy) --------

test("ploi release reads the policies with the system git and its own environment; in CI the default branch from ARTIFACTS_REMOTE, the token only on those two network reads, scoped to it", async () => {
  const fixture = await site();
  const { fetch } = fakeProviders();
  const exec = fakeGit();
  // A caller (Sigillo values, a Site's tools) setting git's environment.
  const injected = {
    GIT_DIR: "/elsewhere/.git",
    GIT_WORK_TREE: "/elsewhere",
    GIT_INDEX_FILE: "/elsewhere/index",
    GIT_OBJECT_DIRECTORY: "/elsewhere/objects",
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "/elsewhere/objects",
    GIT_EXEC_PATH: "/elsewhere/libexec",
    GIT_CONFIG_PARAMETERS: "'url.file:///elsewhere.insteadOf=git@github.com:'",
    GIT_CONFIG_GLOBAL: "/elsewhere/gitconfig",
    HOME: "/elsewhere",
    XDG_CONFIG_HOME: "/elsewhere/.config",
    PATH: "/site/node_modules/.bin:/usr/bin",
  };

  const result = await fixture.run(["ploi", "release"], {
    env: {
      ...RELEASE_ENV,
      ...injected,
      ARTIFACTS_TOKEN: "artifacts-secret",
      ARTIFACTS_REMOTE,
    },
    fetch,
    exec,
  });

  assert.equal(result.code, 0, result.stderr);
  const policyArgs = ({ args }) => (args[0] === "--git-dir" ? args.slice(2) : args);
  const policyReads = exec.calls.filter((call) => {
    const args = policyArgs(call);
    return (
      ["ls-remote", "fetch"].includes(args[0]) ||
      (args[0] === "show" && /:gq\.ops\.json$/u.test(args[1]))
    );
  });
  assert.equal(policyReads.length, 4);
  for (const { command, env } of policyReads) {
    assert.equal(command, TRUSTED_GIT);
    for (const [name, value] of Object.entries(injected)) {
      assert.notEqual(env[name], value, name);
    }
    assert.doesNotMatch(JSON.stringify(env), /elsewhere|node_modules/u);
    assert.equal(env.GIT_NO_REPLACE_OBJECTS, "1");
  }
  // The default branch: from ARTIFACTS_REMOTE itself, in gq's repository.
  const network = exec.calls.filter((call) => ["ls-remote", "fetch"].includes(policyArgs(call)[0]));
  for (const call of network) {
    assert.equal(call.args[0], "--git-dir");
    assert.ok(call.args.includes(ARTIFACTS_REMOTE));
    assert.ok(!call.args.includes("origin"));
  }
  // The token: only in the environment of ls-remote and fetch, as a header
  // scoped to ARTIFACTS_REMOTE, never argv.
  const carrying = exec.calls.filter(({ env }) =>
    JSON.stringify(env ?? {}).includes("artifacts-secret"),
  );
  assert.deepEqual(
    carrying.map((call) => policyArgs(call)[0]),
    ["ls-remote", "fetch"],
  );
  for (const { env } of carrying) {
    const keys = Object.entries(env).filter(([name]) => name.startsWith("GIT_CONFIG_KEY_"));
    assert.ok(keys.some(([, key]) => key === `http.${ARTIFACTS_REMOTE}.extraHeader`));
    assert.ok(!keys.some(([, key]) => key === "http.extraHeader"));
    assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  }
  for (const { args } of exec.calls) assert.ok(!args.join(" ").includes("artifacts-secret"));
});

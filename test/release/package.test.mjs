// `gq release package` at the run() seam: one Composer package updated and
// redeployed, its guarded preparation (--to, --pin, --expect-before,
// --no-deploy, lock and index guards, rollback) and a guarded package's
// approval before Composer, with the shared fixture of
// test/support/ploi-release.mjs, real git where the index matters, and real
// Composer where its scripts and plugins do. Nothing reaches the network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { approvalsFor } from "../../src/ploi/approval-command.mjs";
import { recordingExec, temporaryDirectory } from "../support/fixture-site.mjs";
import {
  APPROVAL,
  approvalRecord,
  fakeGit,
  fakeProviders,
  isGit,
  OPS,
  PAUSED,
  PUBLISHED_REFERENCE,
  RELEASE_ENV,
  scriptedApprovals,
  site,
  TRUSTED_GIT,
} from "../support/ploi-release.mjs";

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
    if (isGit(command) && args[0] === "status") {
      return { stdout: updated ? " M apps/cms/composer.lock\n" : "" };
    }
    if (isGit(command) && (args[0] === "add" || args[0] === "commit")) return {};
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
    isGit(command) && args[0] === "status" ? { stdout: " M README.md\n" } : {},
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

// --- Composer-only deploys ----------------------------------------------------

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

// Composer's own content-hash (Locker::getContentHash) of SUPPORT_COMPOSER,
// and of it with gq-support pinned at 1.0.0: the lock's, while composer.json
// stays as it is.
const SUPPORT_CONTENT_HASH = "4a7264c07d67e0904eb7dd9800ed4c63";

const PINNED_CONTENT_HASH = "b06bc3b64421561d30fb2b9004c6c648";

function supportLock({
  version = "0.1.11",
  reference = NEW_REF,
  design = "0.9.4",
  dev = [],
  source,
  contentHash = SUPPORT_CONTENT_HASH,
  metadata = {},
} = {}) {
  return `${JSON.stringify(
    {
      "content-hash": contentHash,
      packages: [
        { name: "getquick/gq-design", version: design, dist: { reference: "d".repeat(40) } },
        {
          name: SUPPORT,
          version,
          ...(source ? { source: { type: "git", reference: source } } : {}),
          dist: { type: "zip", reference },
        },
      ],
      "packages-dev": dev,
      aliases: [],
      "minimum-stability": "dev",
      "stability-flags": {},
      "prefer-stable": false,
      platform: {},
      "plugin-api-version": "2.6.0",
      ...metadata,
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
// `commitCode` is git commit's exit code, and `indexed` what `git diff
// --cached` lists (by default, what changed).
function supportExec(
  fixture,
  { lock = supportLock(), extra = [], composerJson, commitCode = 0, indexed, current } = {},
) {
  // The default branch's gq.ops.json: the Site's own unless `current` (null:
  // none) says otherwise.
  const defaultBranch = readFile(fixture.path("gq.ops.json"), "utf8").then((text) =>
    current === undefined ? text : current === null ? null : JSON.stringify(current),
  );
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
    const changed = async () => {
      const before = await initial;
      const now = await Promise.all(tracked.map(read));
      return [
        ...tracked.filter((_, index) => now[index] !== before[index]),
        ...(updated ? extra : []),
      ];
    };
    if (isGit(command) && args[0] === "status") {
      return { stdout: (await changed()).map((path) => ` M ${path}\n`).join("") };
    }
    if (isGit(command) && args[0] === "ls-remote") {
      return { stdout: `ref: refs/heads/main\tHEAD\n${"9".repeat(40)}\tHEAD\n` };
    }
    if (isGit(command) && args.join(" ") === "fetch --quiet --no-tags origin refs/heads/main") {
      return {};
    }
    if (isGit(command) && args.join(" ") === "show FETCH_HEAD:gq.ops.json") {
      const text = await defaultBranch;
      return text === null ? { code: 128, stderr: "fatal: no gq.ops.json" } : { stdout: text };
    }
    if (isGit(command) && args[0] === "diff") {
      return { stdout: (indexed ?? (await changed())).map((path) => `${path}\n`).join("") };
    }
    if (isGit(command) && (args[0] === "add" || args[0] === "reset")) return {};
    if (isGit(command) && args.includes("commit")) {
      return commitCode ? { code: commitCode, stderr: "commit failed" } : {};
    }
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
      `composer update ${SUPPORT} --with ${SUPPORT}:0.1.11 --no-interaction --no-install --no-scripts --no-plugins`,
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
  assert.ok(
    lines.includes(`git -c core.hooksPath=/dev/null commit -m Update ${SUPPORT} to 0.1.11`),
    lines.join("\n"),
  );
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
      /requires getquick\/gq-support \^0\.1\.3, which doesn't admit 1\.0\.0; nothing changed\. Add --pin/u,
    ],
    ["dev-main as 0.1.99", /which gq can't tell admits 1\.0\.0; nothing changed\. Add --pin/u],
  ]) {
    const composer = SUPPORT_COMPOSER.replace('"^0.1.3"', JSON.stringify(constraint));
    const fixture = await supportSite({}, composer);
    const exec = supportExec(fixture, { lock: supportLock({ version: "1.0.0" }) });

    const refused = await fixture.run(
      ["release", "package", SUPPORT, "--to", "1.0.0", "--no-deploy"],
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
  const exec = supportExec(fixture, {
    lock: supportLock({ version: "1.0.0", contentHash: PINNED_CONTENT_HASH }),
  });
  const pinned = await fixture.run(
    ["release", "package", SUPPORT, "--to", "1.0.0", "--pin", "--no-deploy"],
    { env: RELEASE_ENV, exec },
  );
  assert.equal(pinned.code, 0, pinned.stderr);
  // Only that requirement changed, formatting kept.
  assert.equal(
    await readFile(fixture.path("apps/cms/composer.json"), "utf8"),
    SUPPORT_COMPOSER.replace('"getquick/gq-support": "^0.1.3"', '"getquick/gq-support": "1.0.0"'),
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
  assert.ok(!commandLines(exec).some((line) => /^git (-c \S+ )?commit/u.test(line)));
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
      /changed more of apps\/cms\/composer\.lock than getquick\/gq-support: (changed getquick\/gq-design in packages|added pestphp\/pest to packages-dev)/u,
    );
    assert.match(result.stderr, /restored; nothing was committed/u);
    assert.equal(await readFile(fixture.path("apps/cms/composer.json"), "utf8"), SUPPORT_COMPOSER);
    assert.equal(
      await readFile(fixture.path("apps/cms/composer.lock"), "utf8"),
      supportLock({ version: "0.1.10", reference: OLD_REF }),
    );
    assert.ok(!commandLines(exec).some((line) => /^git (-c \S+ )?commit/u.test(line)));
  }
});

test("release package refuses any lock metadata change, and a --pin content-hash Composer wouldn't write", async () => {
  const lockOnly = [
    [
      { metadata: { aliases: [{ package: SUPPORT, version: "0.1.11.0", alias: "0.2.0" }] } },
      /changed aliases/u,
    ],
    [{ metadata: { platform: { php: "8.5" } } }, /changed platform/u],
    [{ metadata: { "stability-flags": { [SUPPORT]: 20 } } }, /changed stability-flags/u],
    [{ metadata: { "minimum-stability": "stable" } }, /changed minimum-stability/u],
    [{ metadata: { "plugin-api-version": "2.9.0" } }, /changed plugin-api-version/u],
    [{ contentHash: "0".repeat(32) }, /changed content-hash/u],
  ];
  for (const [change, message] of lockOnly) {
    const fixture = await supportSite();
    const exec = supportExec(fixture, { lock: supportLock(change) });

    const result = await fixture.run(
      ["release", "package", SUPPORT, "--to", "0.1.11", "--no-deploy"],
      { env: RELEASE_ENV, exec },
    );

    assert.equal(result.code, 1, String(message));
    assert.match(result.stderr, message);
    assert.match(result.stderr, /restored; nothing was committed/u);
    assert.equal(
      await readFile(fixture.path("apps/cms/composer.lock"), "utf8"),
      supportLock({ version: "0.1.10", reference: OLD_REF }),
    );
  }

  // --pin: the new hash must be the one Composer computes for the pinned file.
  const wrongHash = await supportSite();
  const pinned = await wrongHash.run(
    ["release", "package", SUPPORT, "--to", "1.0.0", "--pin", "--no-deploy"],
    {
      env: RELEASE_ENV,
      exec: supportExec(wrongHash, { lock: supportLock({ version: "1.0.0" }) }),
    },
  );
  assert.equal(pinned.code, 1);
  assert.match(pinned.stderr, /changed content-hash/u);
  assert.equal(await readFile(wrongHash.path("apps/cms/composer.json"), "utf8"), SUPPORT_COMPOSER);

  // ...which gq only trusts when it reproduces the lock's current hash.
  const unverifiable = await site({
    files: {
      VERSION: "1.4.0\n",
      "apps/cms/composer.json": SUPPORT_COMPOSER,
      "apps/cms/composer.lock": supportLock({ version: "0.1.10", contentHash: "f".repeat(32) }),
    },
  });
  const exec = supportExec(unverifiable);
  const refused = await unverifiable.run(
    ["release", "package", SUPPORT, "--to", "1.0.0", "--pin", "--no-deploy"],
    { env: RELEASE_ENV, exec },
  );
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /content-hash isn't the one gq computes .* nothing changed/u);
  assert.ok(!exec.calls.some(({ command }) => command === "composer"));
});

test("release package undoes its own changes when anything fails before the commit, and names what it left alone", async () => {
  // The commit itself fails: the staging of its own files is undone too.
  const failing = await supportSite();
  const failingExec = supportExec(failing, { commitCode: 1 });
  const commit = await failing.run(
    ["release", "package", SUPPORT, "--to", "0.1.11", "--no-deploy"],
    {
      env: RELEASE_ENV,
      exec: failingExec,
    },
  );
  assert.equal(commit.code, 1);
  assert.match(commit.stderr, /restored; nothing was committed/u);
  assert.ok(commandLines(failingExec).includes("git reset --quiet -- apps/cms/composer.lock"));
  assert.equal(
    await readFile(failing.path("apps/cms/composer.lock"), "utf8"),
    supportLock({ version: "0.1.10", reference: OLD_REF }),
  );

  // The index holds something else than what changed.
  const index = await supportSite();
  const indexed = await index.run(
    ["release", "package", SUPPORT, "--to", "0.1.11", "--no-deploy"],
    {
      env: RELEASE_ENV,
      exec: supportExec(index, { indexed: ["apps/cms/composer.lock", "apps/cms/auth.json"] }),
    },
  );
  assert.equal(indexed.code, 1);
  assert.match(
    indexed.stderr,
    /The index holds apps\/cms\/composer\.lock, apps\/cms\/auth\.json, not exactly apps\/cms\/composer\.lock/u,
  );
  assert.match(indexed.stderr, /restored; nothing was committed/u);

  // Another path changed: gq's own files are put back, the other is named,
  // and left alone.
  const other = await supportSite();
  const unexpected = await other.run(
    ["release", "package", SUPPORT, "--to", "0.1.11", "--no-deploy"],
    {
      env: RELEASE_ENV,
      exec: supportExec(other, { extra: ["apps/cms/auth.json"] }),
    },
  );
  assert.equal(unexpected.code, 1);
  assert.match(
    unexpected.stderr,
    /Left as they are, not gq's to restore: apps\/cms\/auth\.json\./u,
  );
  assert.equal(
    await readFile(other.path("apps/cms/composer.lock"), "utf8"),
    supportLock({ version: "0.1.10", reference: OLD_REF }),
  );
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
    deployment: {
      protected: true,
      state: "authorized",
      guardedPackages: [SUPPORT],
      approval: APPROVAL,
    },
  });
  for (const [argv, message] of [
    [
      [],
      /is guarded \(gq\.ops\.json deployment\.guardedPackages\): name its exact version with --to and the approved release with --release-id/u,
    ],
    [
      ["--to", "0.1.11"],
      /name its exact version with --to and the approved release with --release-id/u,
    ],
    // The approval record names the reference; a caller can't.
    [
      ["--to", "0.1.11", "--release-id", "11", "--reference", NEW_REF],
      /its reference comes from the approval record/u,
    ],
    [["--to", "0.1.11", "--release-id", "v11"], /--release-id takes an approved release's ID/u],
  ]) {
    const exec = supportExec(guarded);
    const refused = await guarded.run(["release", "package", SUPPORT, ...argv, "--no-deploy"], {
      env: RELEASE_ENV,
      exec,
    });
    assert.equal(refused.code, 1, argv.join(" "));
    assert.match(refused.stderr, message);
    assert.ok(!exec.calls.some(({ command }) => command === "composer"));
  }
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
  assert.ok(
    lines.includes(`git -c core.hooksPath=/dev/null commit -m Update ${SUPPORT} to 0.1.11`),
  );
  assert.ok(lines.includes("git add -- apps/cms/composer.lock"), lines.join("\n"));
  assert.equal(await readFile(fixture.path("apps/cms/composer.json"), "utf8"), composer);
});

// A Site guarding gq-support, and Composer moving it to 0.1.11.
const GUARDED_SUPPORT = Object.freeze({
  deployment: {
    protected: true,
    state: "authorized",
    guardedPackages: [SUPPORT],
    approval: APPROVAL,
  },
});

const prepareRecord = () => approvalRecord({ phase: "prepare" });

const guardedPrepare = (fixture, options = {}) =>
  supportExec(fixture, {
    lock: supportLock({
      version: "0.1.11",
      source: PUBLISHED_REFERENCE,
      reference: PUBLISHED_REFERENCE,
    }),
    ...options,
  });

const PREPARE = [
  "release",
  "package",
  SUPPORT,
  "--to",
  "0.1.11",
  "--release-id",
  "11",
  "--no-deploy",
];

test("release package refuses to prepare a guarded package without an approval adapter, before Composer runs", async () => {
  const fixture = await supportSite(GUARDED_SUPPORT);
  const exec = guardedPrepare(fixture);

  const result = await fixture.run(PREPARE, { env: RELEASE_ENV, exec });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /No package approval lookup is configured.*\(phase prepare\).*Nothing changed\./u,
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
      stage: "prod",
      slot: "fixture/production",
      releaseId: 11,
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
          releaseId: 11,
        },
      ],
    },
  );
  assert.match(result.stdout, /without deploying/u);
});

test("release package refuses a guarded package when the machine's gq-support checkout isn't the reviewed commit, before Composer runs", async () => {
  // The machine's configuration (in the user database's home, here a
  // temporary one), whose gq-support checkout isn't the reviewed commit:
  // refused before Composer runs.
  const home = await temporaryDirectory();
  const checkout = join(home, "gq-support");
  await mkdir(checkout);
  const gitEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  execFileSync("git", ["-C", checkout, "init", "--quiet"], { env: gitEnv });
  const git = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  await mkdir(join(home, ".config", "gq"), { recursive: true });
  await writeFile(
    join(home, ".config", "gq", "support-approval.json"),
    JSON.stringify({
      schemaVersion: 2,
      node: process.execPath,
      git,
      checkout,
      targets: {
        fixture: {
          ...APPROVAL,
          accountId: "account-1",
          databaseId: "db-main",
          ledgerDatabaseId: "db-ledger",
          releases: { "0.1.11": { releaseId: 11, artifactDir: home } },
        },
      },
    }),
  );
  const machine = await supportSite(GUARDED_SUPPORT);
  const machineExec = guardedPrepare(machine);
  const unpinned = await machine.run(PREPARE, {
    env: RELEASE_ENV,
    exec: machineExec,
    approvalLookup: (site) =>
      approvalsFor({ env: RELEASE_ENV, homedir: home, username: "operator", ...site }),
  });
  assert.equal(unpinned.code, 1);
  assert.match(
    unpinned.stderr,
    /the gq-support checkout isn't clean at the reviewed commit 29de3c7ec66a/u,
  );
  assert.doesNotMatch(unpinned.stderr, new RegExp(home.replaceAll("/", "\\/"), "u"));
  assert.ok(!machineExec.calls.some(({ command }) => command === "composer"));
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
  // Composer resolved 0.1.11 from another commit than the approved tag's.
  const otherCommit = await supportSite(GUARDED_SUPPORT);
  const refused = await otherCommit.run(PREPARE, {
    env: RELEASE_ENV,
    exec: guardedPrepare(otherCommit, {
      lock: supportLock({ version: "0.1.11", source: "c".repeat(40), reference: "c".repeat(40) }),
    }),
    approvals: scriptedApprovals([prepareRecord()]),
  });
  assert.equal(refused.code, 1);
  assert.match(
    refused.stderr,
    /from source reference c{40}, not b{40}, the commit the approved v0\.1\.11 tag points to/u,
  );
  assert.match(refused.stderr, /restored; nothing was committed/u);
  assert.equal(
    await readFile(otherCommit.path("apps/cms/composer.lock"), "utf8"),
    supportLock({ version: "0.1.10", reference: OLD_REF }),
  );
});

test("release package reads the default branch's current policy before Composer, an approval or a commit", async () => {
  const pausedNow = { ...OPS, deployment: PAUSED };
  const offboardedNow = { ...OPS, offboarded: { at: "2026-10-01T09:00:00.000Z", phase: "cut" } };
  const guardedNow = { ...OPS, ...GUARDED_SUPPORT };
  const cases = [
    // Deploying refuses the default branch's hold, though the working tree has none.
    [
      ["--to", "0.1.11"],
      { current: pausedNow },
      /the default branch's gq\.ops\.json deployment\.state: paused/u,
    ],
    // Preparing without deploying still refuses offboarding and an unreadable policy.
    [
      ["--to", "0.1.11", "--no-deploy"],
      { current: offboardedNow },
      /offboarded \(the default branch's gq\.ops\.json offboarded\)/u,
    ],
    [
      ["--to", "0.1.11", "--no-deploy"],
      { current: null },
      /The default branch's gq\.ops\.json can't be read/u,
    ],
    // A package the default branch guards is guarded, here too.
    [
      ["--to", "0.1.11", "--no-deploy"],
      { current: guardedNow },
      /is guarded .* name its exact version with --to and the approved release with --release-id/u,
    ],
    [
      ["--to", "0.1.11", "--no-deploy"],
      {
        current: {
          ...guardedNow,
          deployment: {
            ...GUARDED_SUPPORT.deployment,
            approval: { stage: "prod", slot: "other/production" },
          },
        },
      },
      /names approval target prod slot other\/production, but/u,
      GUARDED_SUPPORT,
    ],
  ];
  for (const [argv, options, message, extra = {}] of cases) {
    const fixture = await supportSite(extra);
    const { fetch } = fakeProviders();
    const exec = supportExec(fixture, options);
    const approvals = scriptedApprovals([approvalRecord({ phase: "prepare" })]);

    const result = await fixture.run(["release", "package", SUPPORT, ...argv], {
      env: RELEASE_ENV,
      fetch,
      exec,
      approvals,
    });

    assert.equal(result.code, 1, String(message));
    assert.match(result.stderr, message);
    assert.deepEqual(fetch.requests, []);
    assert.deepEqual(approvals.requests, []);
    assert.ok(!exec.calls.some(({ command }) => command === "composer"));
    assert.ok(!exec.calls.some(({ args }) => args.includes("commit")));
  }

  // --no-deploy still prepares on a Site the default branch holds (not a
  // deploy permission: nothing is uploaded), guarding what it guards.
  const held = await supportSite();
  const prepared = await held.run(
    ["release", "package", SUPPORT, "--to", "0.1.11", "--release-id", "11", "--no-deploy"],
    {
      env: RELEASE_ENV,
      fetch: fakeProviders().fetch,
      exec: supportExec(held, {
        current: {
          ...guardedNow,
          deployment: {
            ...GUARDED_SUPPORT.deployment,
            state: "paused",
            reason: "Controlled release",
          },
        },
        lock: supportLock({
          version: "0.1.11",
          source: PUBLISHED_REFERENCE,
          reference: PUBLISHED_REFERENCE,
        }),
      }),
      approvals: scriptedApprovals([approvalRecord({ phase: "prepare" })]),
    },
  );
  assert.equal(prepared.code, 0, prepared.stderr);
  assert.match(prepared.stdout, /without deploying: nothing was uploaded/u);
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

// --- preparation's rollback, with real git -------------------------------

// A Site in a real git repository with an origin (a local bare repository)
// whose default branch is the Site as committed; real git runs every git
// call, and only Composer is faked: its update writes `lock` and runs
// `sideEffect(root)` (another change, made while gq prepares).
async function realGitSite({ hook = null, sideEffect = async () => {} } = {}) {
  const fixture = await supportSite();
  const identity = {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.test",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.test",
  };
  const gitEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
    ...identity,
  };
  const git = (...args) =>
    execFileSync("git", ["-C", fixture.root, ...args], { env: gitEnv, encoding: "utf8" });
  git("add", "-A");
  git("commit", "--quiet", "-m", "site");
  const bare = join(await temporaryDirectory(), "origin.git");
  execFileSync("git", ["init", "--quiet", "--bare", bare], { env: gitEnv });
  git("remote", "add", "origin", bare);
  git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  execFileSync("git", ["-C", bare, "symbolic-ref", "HEAD", "refs/heads/main"], { env: gitEnv });
  if (hook) {
    await writeFile(join(fixture.root, ".git/hooks/pre-commit"), hook, { mode: 0o755 });
  }
  const { exec: realExec } = await import("../../src/exec.mjs");
  const exec = recordingExec(async ({ command, args, cwd, env }) => {
    if (command === "sh") return {};
    if (command === "composer") {
      if (args[0] === "update") {
        await writeFile(join(fixture.root, "apps/cms/composer.lock"), supportLock());
        await sideEffect(fixture.root);
      }
      return {};
    }
    return realExec(command, args, { cwd, env });
  });
  const env = { ...RELEASE_ENV, PATH: process.env.PATH, ...identity };
  return { fixture, git, exec, env };
}

test("release package with real git: a failed commit leaves the index and files as they were", async () => {
  // A real failure of the commit itself, not a hook (gq runs none): signing
  // is required and the signing program fails.
  const { fixture, git, exec, env } = await realGitSite();
  git("config", "commit.gpgsign", "true");
  git("config", "gpg.program", "/bin/false");

  const result = await fixture.run(
    ["release", "package", SUPPORT, "--to", "0.1.11", "--no-deploy"],
    {
      env,
      exec,
    },
  );

  assert.equal(result.code, 1);
  assert.match(result.stderr, /restored; nothing was committed/u);
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(git("diff", "--cached", "--name-only"), "");
  assert.equal(git("log", "--oneline").trim().split("\n").length, 1);
});

test("release package with real git: another path changed or staged meanwhile is named and left alone", async () => {
  const { fixture, git, exec, env } = await realGitSite({
    sideEffect: async (root) => {
      await writeFile(join(root, "apps/cms/auth.json"), "{}\n");
      await writeFile(join(root, "VERSION"), "9.9.9\n");
      execFileSync("git", ["-C", root, "add", "VERSION"]);
    },
  });

  const result = await fixture.run(
    ["release", "package", SUPPORT, "--to", "0.1.11", "--no-deploy"],
    {
      env,
      exec,
    },
  );

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /Left as they are, not gq's to restore: (VERSION, apps\/cms\/auth\.json|apps\/cms\/auth\.json, VERSION)\./u,
  );
  // gq's own file is back; the other changes, staged or not, are untouched.
  assert.equal(git("status", "--porcelain", "--", "apps/cms/composer.lock"), "");
  assert.equal(git("diff", "--cached", "--name-only").trim(), "VERSION");
  assert.equal(await readFile(join(fixture.root, "apps/cms/auth.json"), "utf8"), "{}\n");
  assert.equal(git("log", "--oneline").trim().split("\n").length, 1);
});

// --- the policy reads trust neither PATH nor a stray token -----------------

test("release package with real git: a git a Site puts first on PATH never reads the policy", async () => {
  const { fixture, exec, env } = await realGitSite();
  // A Site's own bin directory (outside the tree, so it stays clean), first
  // on PATH as `pnpm exec` would put node_modules/.bin.
  const bin = join(await temporaryDirectory(), "node_modules/.bin");
  const seen = join(await temporaryDirectory(), "seen");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh\necho "$*" >> ${JSON.stringify(seen)}\nexec ${TRUSTED_GIT} "$@"\n`,
    { mode: 0o755 },
  );

  const result = await fixture.run(
    ["release", "package", SUPPORT, "--to", "0.1.11", "--no-deploy"],
    {
      env: { ...env, PATH: `${bin}:${env.PATH}` },
      exec,
    },
  );

  assert.equal(result.code, 0, result.stderr);
  const used = await readFile(seen, "utf8").catch(() => "");
  // The Site's git ran its own operations (status, add, commit), never a
  // policy read.
  assert.match(used, /^status /mu);
  assert.doesNotMatch(used, /ls-remote|fetch|FETCH_HEAD|gq\.ops\.json/u);
});

// --- real Composer: the Site's own scripts, plugins and hooks don't run ------

test("release package with real Composer and git: a lock-only update runs none of the Site's scripts or hooks", async () => {
  const markers = await temporaryDirectory();
  const reference = (version) => createHash("sha1").update(version).digest("hex");
  const versions = ["0.1.10", "0.1.11", "0.1.12"].map((version) => ({
    name: SUPPORT,
    version,
    type: "wordpress-plugin",
    dist: {
      type: "zip",
      url: `https://example.invalid/gq-support-${version}.zip`,
      reference: reference(version),
    },
    source: {
      type: "git",
      url: "https://example.invalid/gq-support.git",
      reference: reference(version),
    },
  }));
  const composer = `${JSON.stringify(
    {
      name: "fixture/cms",
      repositories: [{ "packagist.org": false }, { type: "package", package: versions }],
      require: { [SUPPORT]: "^0.1.3" },
      scripts: {
        "pre-update-cmd": `touch ${join(markers, "pre-update-cmd")}`,
        "post-update-cmd": `touch ${join(markers, "post-update-cmd")}`,
      },
      config: { "allow-plugins": {} },
    },
    null,
    2,
  )}\n`;
  const json = (data) => `${JSON.stringify(data, null, 2)}\n`;
  const fixture = await site({
    files: {
      VERSION: "1.4.0\n",
      "package.json": json({ name: "fixture", version: "1.4.0", private: true }),
      "apps/frontend/package.json": json({ name: "frontend", version: "1.4.0" }),
      "apps/cms/composer.json": composer,
    },
  });
  const home = await temporaryDirectory();
  const env = {
    ...RELEASE_ENV,
    PATH: process.env.PATH,
    HOME: home,
    COMPOSER_HOME: join(home, "composer"),
    COMPOSER_CACHE_DIR: join(home, "composer-cache"),
    COMPOSER_AUTH: "{}",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.test",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.test",
  };
  const gitEnv = Object.fromEntries(
    Object.entries(env).filter(([name]) => !["COMPOSER_AUTH", "PLOI_API_TOKEN"].includes(name)),
  );
  // The Site's lock at 0.1.10, made without its scripts.
  execFileSync(
    "composer",
    [
      "update",
      "--with",
      `${SUPPORT}:0.1.10`,
      "--no-install",
      "--no-scripts",
      "--no-plugins",
      "--no-interaction",
      "--quiet",
    ],
    { cwd: fixture.path("apps/cms"), env: gitEnv },
  );
  const git = (...args) =>
    execFileSync("git", ["-C", fixture.root, ...args], { env: gitEnv, encoding: "utf8" });
  git("add", "-A");
  git("commit", "--quiet", "-m", "site");
  const origin = join(await temporaryDirectory(), "origin.git");
  execFileSync("git", ["init", "--quiet", "--bare", origin], { env: gitEnv });
  git("remote", "add", "origin", origin);
  git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  execFileSync("git", ["-C", origin, "symbolic-ref", "HEAD", "refs/heads/main"], { env: gitEnv });
  // The Site's own hook, which would run on a commit.
  await writeFile(
    fixture.path(".git/hooks/pre-commit"),
    `#!/bin/sh\ntouch ${join(markers, "pre-commit")}\n`,
    { mode: 0o755 },
  );
  const { exec } = await import("../../src/exec.mjs");

  const result = await fixture.run(
    ["release", "package", SUPPORT, "--to", "0.1.11", "--no-deploy"],
    {
      env,
      exec,
    },
  );

  assert.equal(result.code, 0, result.stderr);
  const lock = JSON.parse(await readFile(fixture.path("apps/cms/composer.lock"), "utf8"));
  assert.equal(lock.packages.find(({ name }) => name === SUPPORT).version, "0.1.11");
  assert.equal(git("log", "--format=%s", "-1").trim(), `Update ${SUPPORT} to 0.1.11`);
  assert.equal(git("status", "--porcelain"), "");
  // None of the Site's Composer scripts or git hooks ran.
  for (const marker of ["pre-update-cmd", "post-update-cmd", "pre-commit"]) {
    await assert.rejects(readFile(join(markers, marker)), { code: "ENOENT" }, marker);
  }
});

// Guarded packages: the Site's expectations file (deploy/ploi/package-expectations.json,
// v1), the approval record gq acts on (gq-support.composer-approval/v1), the
// gq-support.files/v1 digest and the lock identity check. Expected digests
// come from coreutils (printf '<path>\0<sha256>\n' ... | sha256sum), not from
// the module under test.
import assert from "node:assert/strict";
import test from "node:test";

import {
  checkApprovalRecord,
  checkLockedIdentity,
  filesDigest,
  parsePackageExpectations,
  renderServerExpectations,
  unconfiguredApprovals,
} from "../../src/ploi/package-expectations.mjs";

// gq-support.php ("hello\n"), src/a-b.php ("abc") and Z.txt ("Z").
const FILES = Object.freeze({
  "gq-support.php": "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
  "src/a-b.php": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "Z.txt": "bbeebd879e1dff6918546dc0c179fdde505f2a21591c9a9c96e36b054ec5af83",
});
const DIGEST = "57661d4dc252d72859e8ac659219b6948230f73e2916aa631a04761219bf77d3";
const NOW = Date.parse("2026-10-31T12:00:00Z");
const REQUEST = Object.freeze({ phase: "deploy", name: "getquick/gq-support", version: "0.1.11" });

function record(overrides = {}) {
  return {
    schema: "gq-support.composer-approval/v1",
    stage: "production",
    slot: "nomia",
    phase: "deploy",
    release_id: "release-0.1.11",
    package: { name: "getquick/gq-support", version: "0.1.11", zip_sha256: "f".repeat(64) },
    provenance: { source_commit: "c".repeat(40), release_run: "run-42" },
    files: FILES,
    files_digest: DIGEST,
    normalization: "gq-support.files/v1",
    observed_at: "2026-10-31T11:59:00Z",
    ...overrides,
  };
}

test("the gq-support.files/v1 digest hashes path NUL sha256 LF lines sorted by path bytes", () => {
  assert.equal(filesDigest(FILES), DIGEST);
  assert.equal(filesDigest(Object.fromEntries(Object.entries(FILES).reverse())), DIGEST);
});

test("an approval record is acted on only for its phase, package and version, fresh and self-consistent", () => {
  assert.equal(checkApprovalRecord(record(), REQUEST, NOW).files_digest, DIGEST);

  const refusals = [
    [record({ phase: "prepare" }), /is for phase prepare, not deploy/u],
    [
      record({
        package: { name: "getquick/gq-support", version: "0.1.12", zip_sha256: "f".repeat(64) },
      }),
      /approves getquick\/gq-support 0\.1\.12 instead/u,
    ],
    [record({ files: { ...FILES, "Z.txt": "0".repeat(64) } }), /says its files hash to 57661d4d/u],
    [record({ files: { ...FILES, "extra.php": "0".repeat(64) } }), /says its files hash to/u],
    [record({ observed_at: "2026-10-31T11:54:59Z" }), /not within 5 minutes of now/u],
    [record({ observed_at: "2026-10-31T12:02:00Z" }), /not within 5 minutes of now/u],
    [record({ normalization: "gq-tree-v1" }), /normalization/u],
    [record({ schema: "gq-support.composer-approval/v2" }), /schema/u],
    [record({ files: {} }), /lists no files/u],
  ];
  for (const [candidate, message] of refusals) {
    assert.throws(() => checkApprovalRecord(candidate, REQUEST, NOW), message);
  }
});

test("an approval record refuses package paths gq-support refuses", () => {
  for (const path of [
    "../wp-config.php",
    "/etc/passwd",
    "a//b",
    ".hidden",
    "a b.php",
    "src/",
    "é.php",
  ]) {
    assert.throws(
      () => checkApprovalRecord(record({ files: { [path]: "0".repeat(64) } }), REQUEST, NOW),
      /is invalid: files\./u,
      path,
    );
  }
});

test("a lookup's own approval-looking keys grant nothing", () => {
  assert.throws(
    () => checkApprovalRecord({ approved: true, signature: "x" }, REQUEST, NOW),
    /is invalid/u,
  );
  const extra = checkApprovalRecord(record({ approved: true }), REQUEST, NOW);
  assert.equal(Object.hasOwn(extra, "approved"), false);
});

test("the Site's expectations file is strict and refuses approval-looking fields", () => {
  const valid = {
    schemaVersion: 1,
    packages: [
      {
        name: "getquick/gq-support",
        version: "0.1.11",
        lockReference: "b".repeat(40),
        installPath: "web/app/plugins/gq-support",
        filesDigest: DIGEST,
      },
    ],
  };
  assert.equal(parsePackageExpectations(JSON.stringify(valid)).packages[0].filesDigest, DIGEST);
  for (const [change, message] of [
    [{ approved: true }, /approved/u],
    [{ installPath: "vendor/x" }, /installPath/u],
    [{ filesDigest: "x" }, /filesDigest/u],
  ]) {
    const candidate = { ...valid, packages: [{ ...valid.packages[0], ...change }] };
    assert.throws(() => parsePackageExpectations(JSON.stringify(candidate)), message);
  }
  assert.throws(
    () => parsePackageExpectations(JSON.stringify({ ...valid, signature: "x" })),
    /signature/u,
  );
});

test("the lock must install the expected version at the expected reference, not as a dev package", () => {
  const pkg = { name: "getquick/gq-support", version: "0.1.11", lockReference: "b".repeat(40) };
  const lock = (entry, section = "packages") => ({ [section]: [{ name: pkg.name, ...entry }] });

  checkLockedIdentity(lock({ version: "0.1.11", dist: { reference: "b".repeat(40) } }), pkg);
  checkLockedIdentity(lock({ version: "v0.1.11", source: { reference: "b".repeat(40) } }), pkg);

  assert.throws(
    () =>
      checkLockedIdentity(lock({ version: "0.1.12", dist: { reference: "b".repeat(40) } }), pkg),
    /locks getquick\/gq-support 0\.1\.12, not the expected 0\.1\.11/u,
  );
  // The source repository's main commit is not the published reference.
  assert.throws(
    () =>
      checkLockedIdentity(
        lock({
          version: "0.1.11",
          dist: { reference: "b".repeat(40) },
          source: { reference: "c".repeat(40) },
        }),
        pkg,
      ),
    /at reference b{40} \/ c{40}, not the expected b{40}/u,
  );
  assert.throws(
    () =>
      checkLockedIdentity(
        lock({ version: "0.1.11", dist: { reference: "b".repeat(40) } }, "packages-dev"),
        pkg,
      ),
    /only as a dev package/u,
  );
});

test("the server's expectations are line-based: the lock's hash, then each package and its files by path bytes", () => {
  const text = renderServerExpectations(
    [
      {
        name: "getquick/gq-support",
        version: "0.1.11",
        installPath: "web/app/plugins/gq-support",
        filesDigest: DIGEST,
        files: FILES,
      },
    ],
    "lock-text",
  );
  assert.equal(
    text,
    [
      "gq-package-expectations 1",
      // sha256 of "lock-text"
      "lock 486a33b99612507fb51379417b0e23f09dda895132650a8612a629bc53aefadb",
      `package getquick/gq-support 0.1.11 web/app/plugins/gq-support ${DIGEST}`,
      `file ${FILES["Z.txt"]} Z.txt`,
      `file ${FILES["gq-support.php"]} gq-support.php`,
      `file ${FILES["src/a-b.php"]} src/a-b.php`,
      "",
    ].join("\n"),
  );
});

test("without an approval service, every lookup refuses and says the file isn't an approval", async () => {
  await assert.rejects(
    unconfiguredApprovals.lookup({
      phase: "deploy",
      package: { name: "getquick/gq-support", version: "0.1.11" },
    }),
    /No authenticated package approval service is configured.*not an approval/u,
  );
});

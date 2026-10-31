// Guarded packages: the Site's expectations file (deploy/ploi/package-expectations.json,
// v1), the approval record gq acts on (gq-support.composer-approval/v1), the
// gq-support.files/v1 digest and the lock identity check. Expected digests
// come from coreutils (printf '<path>\0<sha256>\n' ... | sha256sum), not from
// the module under test.
import assert from "node:assert/strict";
import test from "node:test";

import {
  checkApprovalRecord,
  checkLockedRecord,
  installPathOf,
  filesDigest,
  parsePackageExpectations,
  renderServerExpectations,
  unconfiguredApprovals,
} from "../../src/ploi/package-expectations.mjs";
import { parseStrictJson } from "../../src/ploi/strict-json.mjs";

// gq-support.php ("hello\n"), src/a-b.php ("abc") and Z.txt ("Z").
const FILES = Object.freeze({
  "gq-support.php": "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
  "src/a-b.php": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "Z.txt": "bbeebd879e1dff6918546dc0c179fdde505f2a21591c9a9c96e36b054ec5af83",
});
const DIGEST = "57661d4dc252d72859e8ac659219b6948230f73e2916aa631a04761219bf77d3";
const NOW = Date.parse("2026-10-31T12:00:00Z");
const REQUEST = Object.freeze({
  stage: "prod",
  slot: "nomia/production",
  phase: "deploy",
  name: "getquick/gq-support",
  version: "0.1.11",
  releaseId: 11,
});
const TAG_COMMIT = "b".repeat(40);

function record(overrides = {}) {
  return {
    schema: "gq-support.composer-approval/v1",
    stage: "prod",
    slot: "nomia/production",
    phase: "deploy",
    release_id: 11,
    package: { name: "getquick/gq-support", version: "0.1.11", zip_sha256: "f".repeat(64) },
    provenance: { source_commit: "c".repeat(40), release_run: "4242" },
    published_tag: { name: "v0.1.11", commit: TAG_COMMIT },
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
    [
      record({ stage: "staging" }),
      /is for staging slot nomia\/production, not this Site's prod slot nomia\/production/u,
    ],
    [
      record({ slot: "ekis/production" }),
      /is for prod slot ekis\/production, not this Site's prod slot nomia\/production/u,
    ],
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
    [record({ release_id: 12 }), /is release 12, not release 11/u],
    [record({ release_id: "11" }), /release_id/u],
    [
      record({ provenance: { source_commit: "c".repeat(40), release_run: "run-42" } }),
      /release_run/u,
    ],
    [record({ published_tag: { name: "v0.1.11" } }), /published_tag\.commit/u],
    [record({ files: {} }), /lists no files/u],
  ];
  for (const [candidate, message] of refusals) {
    assert.throws(() => checkApprovalRecord(candidate, REQUEST, NOW), message);
  }
  // A record can't be checked against no target.
  assert.throws(
    () => checkApprovalRecord(record(), { ...REQUEST, slot: undefined }, NOW),
    /without the Site's approval stage and slot/u,
  );
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

test("a record has exactly the contract's keys: a missing or unknown one refuses it", () => {
  assert.throws(
    () => checkApprovalRecord({ approved: true, signature: "x" }, REQUEST, NOW),
    /is invalid/u,
  );
  assert.throws(() => checkApprovalRecord(record({ approved: true }), REQUEST, NOW), /approved/u);
  const { schema, ...unnamed } = record();
  void schema;
  assert.throws(() => checkApprovalRecord(unnamed, REQUEST, NOW), /schema/u);
  assert.throws(
    () =>
      checkApprovalRecord(
        record({ package: { name: "getquick/gq-support", version: "0.1.11" } }),
        REQUEST,
        NOW,
      ),
    /package\.zip_sha256/u,
  );
});

test("the Site's expectations file is strict and refuses approval-looking fields", () => {
  const valid = {
    schemaVersion: 1,
    packages: [
      {
        name: "getquick/gq-support",
        version: "0.1.11",
        releaseId: 11,
      },
    ],
  };
  assert.equal(parsePackageExpectations(JSON.stringify(valid)).packages[0].releaseId, 11);
  for (const [change, message] of [
    [{ approved: true }, /approved/u],
    [{ installPath: "vendor/x" }, /installPath/u],
    // Identity and contents come from the record, never from the Site.
    [{ filesDigest: DIGEST }, /filesDigest/u],
    [{ lockReference: TAG_COMMIT }, /lockReference/u],
    [{ releaseId: "11" }, /releaseId/u],
  ]) {
    const candidate = { ...valid, packages: [{ ...valid.packages[0], ...change }] };
    assert.throws(() => parsePackageExpectations(JSON.stringify(candidate)), message);
  }
  assert.throws(
    () => parsePackageExpectations(JSON.stringify({ ...valid, signature: "x" })),
    /signature/u,
  );
});

test("the lock must install the approved version with both references the published tag's commit, not as a dev package", () => {
  const approved = checkApprovalRecord(record(), REQUEST, NOW);
  const lock = (entry, section = "packages") => ({
    [section]: [{ name: "getquick/gq-support", ...entry }],
  });

  checkLockedRecord(
    lock({
      version: "0.1.11",
      source: { reference: TAG_COMMIT },
      dist: { reference: TAG_COMMIT },
    }),
    approved,
  );
  // A repacked registry ZIP doesn't make another commit the approved package.
  assert.throws(
    () =>
      checkLockedRecord(
        lock({
          version: "0.1.11",
          source: { reference: TAG_COMMIT },
          dist: { reference: "e".repeat(40) },
        }),
        approved,
      ),
    /with dist reference e{40}, not b{40}/u,
  );
  checkLockedRecord(lock({ version: "v0.1.11", source: { reference: TAG_COMMIT } }), approved);

  assert.throws(
    () =>
      checkLockedRecord(lock({ version: "0.1.12", source: { reference: TAG_COMMIT } }), approved),
    /locks getquick\/gq-support 0\.1\.12, not the approved 0\.1\.11/u,
  );
  // The gq-support source commit is not the published package's commit.
  assert.throws(
    () =>
      checkLockedRecord(
        lock({ version: "0.1.11", source: { reference: "c".repeat(40) } }),
        approved,
      ),
    /from source reference c{40}, not b{40}, the commit the approved v0\.1\.11 tag points to/u,
  );
  assert.throws(
    () => checkLockedRecord(lock({ version: "0.1.11", dist: { reference: TAG_COMMIT } }), approved),
    /from source reference \(none\)/u,
  );
  assert.throws(
    () =>
      checkLockedRecord(
        lock({ version: "0.1.11", source: { reference: TAG_COMMIT } }, "packages-dev"),
        approved,
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
    /No package approval lookup is configured.*not an approval/u,
  );
});

test("strict JSON refuses a repeated member name anywhere, and otherwise parses as JSON.parse does", () => {
  const text = '{"a":[1,{"b":"\\"x\\""}],"c":null,"d":-1.5e3,"e":true}';
  assert.deepEqual(parseStrictJson(text), JSON.parse(text));
  assert.throws(() => parseStrictJson('{"a":1,"a":2}'), /Repeated member name "a"/u);
  assert.throws(
    () => parseStrictJson('{"files":{"x.php":"1","x.php":"2"}}'),
    /Repeated member name "x\.php"/u,
  );
  assert.throws(() => parseStrictJson('{"a":1} {"a":1}'), /Unexpected text/u);
  assert.throws(() => parseStrictJson('{"a":1,}'), /Expected a member name/u);
  assert.equal(Object.getPrototypeOf(parseStrictJson('{"__proto__":{"x":1}}')), Object.prototype);
});

test("a package's install path is the one installer-paths pattern composer/installers would use", () => {
  const bedrock = {
    extra: {
      "installer-paths": {
        "web/app/mu-plugins/{$name}/": ["type:wordpress-muplugin"],
        "web/app/plugins/{$name}/": ["type:wordpress-plugin"],
        "web/app/themes/{$name}/": ["type:wordpress-theme"],
      },
    },
  };
  const support = { name: "getquick/gq-support", type: "wordpress-plugin" };
  assert.equal(installPathOf(bedrock, support), "web/app/plugins/gq-support");
  assert.equal(
    installPathOf(bedrock, { ...support, extra: { "installer-name": "support" } }),
    "web/app/plugins/support",
  );
  assert.equal(
    installPathOf(
      {
        extra: {
          "installer-paths": { "web/app/mu-plugins/{$vendor}-{$name}": ["getquick/gq-support"] },
        },
      },
      support,
    ),
    "web/app/mu-plugins/getquick-gq-support",
  );

  for (const [composer, entry, message] of [
    [bedrock, { ...support, type: "library" }, /locked as type library/u],
    [{}, support, /places getquick\/gq-support nowhere/u],
    [
      {
        extra: {
          "installer-paths": {
            ...bedrock.extra["installer-paths"],
            "web/app/plugins/x/": ["vendor:getquick"],
          },
        },
      },
      support,
      /has 2 patterns for getquick\/gq-support/u,
    ],
    [
      { extra: { "installer-paths": { "vendor/{$name}/": ["type:wordpress-plugin"] } } },
      support,
      /installs at vendor\/gq-support/u,
    ],
    [
      { extra: { "installer-paths": { "web/app/plugins/{$type}/": ["type:wordpress-plugin"] } } },
      support,
      /installs at web\/app\/plugins\/\{\$type\}/u,
    ],
  ]) {
    assert.throws(() => installPathOf(composer, entry), message);
  }
});

test("a record's stage, slot and tag name are compared exactly, never trimmed", () => {
  for (const change of [
    { stage: " prod" },
    { slot: "nomia/production " },
    { published_tag: { name: "v0.1.11 ", commit: TAG_COMMIT } },
  ]) {
    assert.throws(
      () => checkApprovalRecord(record(change), REQUEST, NOW),
      /must not be empty or padded/u,
    );
  }
});

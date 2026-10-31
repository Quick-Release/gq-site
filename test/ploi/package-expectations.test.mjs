// The guarded-package expectations contract (deploy/ploi/package-expectations.json,
// v1): its validation, the gq-tree-v1 digest and the lock identity check.
// Expected digests come from coreutils (find | LC_ALL=C sort | sha256sum),
// the tools the deploy script uses, not from the module under test.
import assert from "node:assert/strict";
import test from "node:test";

import {
  checkLockedIdentity,
  parsePackageExpectations,
  renderServerExpectations,
  treeDigest,
  unconfiguredApprovals,
} from "../../src/ploi/package-expectations.mjs";

// A tree of gq-support.php ("hello\n"), src/a b.php ("abc") and Z.txt ("Z").
export const FILES = Object.freeze([
  {
    path: "gq-support.php",
    sha256: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
  },
  {
    path: "src/a b.php",
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  },
  { path: "Z.txt", sha256: "bbeebd879e1dff6918546dc0c179fdde505f2a21591c9a9c96e36b054ec5af83" },
]);
const DIGEST = "b63f13b4a4b3da7f94a6f27e00506c7a6a051d3e542e5c9a1531d1d4040a7bdb";
const TAG_COMMIT = "a".repeat(40);
const REFERENCE = "b".repeat(40);

function contract(overrides = {}, tree = {}) {
  return {
    schemaVersion: 1,
    packages: [
      {
        name: "getquick/gq-support",
        version: "0.2.0",
        tag: "v0.2.0",
        tagCommit: TAG_COMMIT,
        lockReference: REFERENCE,
        installPath: "web/app/plugins/gq-support",
        tree: { normalization: "gq-tree-v1", digest: DIGEST, files: FILES, ...tree },
        ...overrides,
      },
    ],
  };
}

test("the gq-tree-v1 digest is sha256sum's listing of the files sorted by their bytes", () => {
  assert.equal(treeDigest(FILES), DIGEST);
  assert.equal(treeDigest([...FILES].reverse()), DIGEST);
});

test("an expectations file is accepted only when its digest matches its files", () => {
  assert.equal(
    parsePackageExpectations(JSON.stringify(contract())).packages[0].tree.digest,
    DIGEST,
  );

  assert.throws(
    () => parsePackageExpectations(JSON.stringify(contract({}, { digest: "0".repeat(64) }))),
    /tree\.digest is 0{64}, but its files hash to b63f13b4/u,
  );
  const changed = FILES.map((file, index) =>
    index === 0 ? { ...file, sha256: "1".repeat(64) } : file,
  );
  assert.throws(
    () => parsePackageExpectations(JSON.stringify(contract({}, { files: changed }))),
    /its files hash to/u,
  );
});

test("an expectations file refuses unsafe paths, unknown keys and approval-looking fields", () => {
  for (const path of ["../wp-config.php", "/etc/passwd", "a//b", "./a", "a\\b", "a\nb"]) {
    assert.throws(
      () =>
        parsePackageExpectations(
          JSON.stringify(contract({}, { files: [{ path, sha256: FILES[0].sha256 }] })),
        ),
      /relative POSIX path/u,
      path,
    );
  }
  assert.throws(
    () => parsePackageExpectations(JSON.stringify(contract({ approved: true }))),
    /approved/u,
  );
  assert.throws(
    () => parsePackageExpectations(JSON.stringify({ ...contract(), signature: "x" })),
    /signature/u,
  );
  assert.throws(
    () => parsePackageExpectations(JSON.stringify(contract({ installPath: "vendor/x" }))),
    /installPath/u,
  );
  assert.throws(
    () => parsePackageExpectations(JSON.stringify({ ...contract(), schemaVersion: 2 })),
    /schemaVersion/u,
  );
});

test("the lock must install the expected version at the expected reference, not as a dev package", () => {
  const [pkg] = contract().packages;
  const lock = (entry, section = "packages") => ({ [section]: [{ name: pkg.name, ...entry }] });

  checkLockedIdentity(lock({ version: "0.2.0", dist: { reference: REFERENCE } }), pkg);
  checkLockedIdentity(lock({ version: "v0.2.0", source: { reference: REFERENCE } }), pkg);

  assert.throws(
    () => checkLockedIdentity(lock({ version: "0.2.1", dist: { reference: REFERENCE } }), pkg),
    /locks getquick\/gq-support 0\.2\.1, not the expected 0\.2\.0/u,
  );
  // The source repository's main commit is not the published reference.
  assert.throws(
    () =>
      checkLockedIdentity(
        lock({
          version: "0.2.0",
          dist: { reference: REFERENCE },
          source: { reference: "c".repeat(40) },
        }),
        pkg,
      ),
    /at reference b{40} \/ c{40}, not the expected b{40}/u,
  );
  assert.throws(
    () => checkLockedIdentity(lock({ version: "0.2.0" }), pkg),
    /at reference \(none\)/u,
  );
  assert.throws(
    () =>
      checkLockedIdentity(
        lock({ version: "0.2.0", dist: { reference: REFERENCE } }, "packages-dev"),
        pkg,
      ),
    /only as a dev package/u,
  );
});

test("the server's expectations are line-based: the lock's hash, then each package and its files in order", () => {
  const text = renderServerExpectations(contract(), "lock-text");
  assert.equal(
    text,
    [
      "gq-package-expectations 1",
      // sha256 of "lock-text"
      "lock 486a33b99612507fb51379417b0e23f09dda895132650a8612a629bc53aefadb",
      `package getquick/gq-support 0.2.0 web/app/plugins/gq-support ${DIGEST}`,
      `file ${FILES[2].sha256} Z.txt`,
      `file ${FILES[0].sha256} gq-support.php`,
      `file ${FILES[1].sha256} src/a b.php`,
      "",
    ].join("\n"),
  );
});

test("without an approval service, every confirmation refuses and says the file isn't an approval", async () => {
  await assert.rejects(
    unconfiguredApprovals.confirm({
      package: { name: "getquick/gq-support", version: "0.2.0", tag: "v0.2.0" },
    }),
    /No authenticated package approval service is configured.*not an approval/u,
  );
});

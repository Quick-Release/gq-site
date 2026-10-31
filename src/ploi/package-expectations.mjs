// Guarded Composer packages (gq.ops.json deployment.guardedPackages): what a
// deploy of such a Site checks before anything is uploaded, and what it hands
// the server to check again after `composer install`.
//
// deploy/ploi/package-expectations.json (contract v1, see
// docs/reference/package-expectations.md) states, for each guarded package,
// the published version and its identity (tag, tag commit, the reference
// composer.lock records) and the exact normalized file tree it installs. It
// is an EXPECTATION, not an approval: anyone with write access to the Site
// can edit it. Authority comes from the approval service (`approvals`), an
// authenticated boundary gq-site does not implement: until one is wired into
// run(), every guarded deploy refuses (unconfiguredApprovals).
//
// The tree is compared, not an archive digest: the registry may repack a
// package's ZIP, so its bytes (and dist.shasum) can differ while the files
// are the same. The source repository's main commit differs from the
// published tag commit and is never compared with the lock.
import { createHash } from "node:crypto";
import { z } from "zod";

import { COMPOSER_PACKAGE_NAME } from "../manifest/schema.mjs";

export const PACKAGE_EXPECTATIONS_PATH = "deploy/ploi/package-expectations.json";
// The release archive's root file the deploy script verifies installs against.
export const SERVER_EXPECTATIONS_FILE = "PACKAGE_EXPECTATIONS";
export const PACKAGE_EXPECTATIONS_SCHEMA_VERSION = 1;
// Regular files only, relative POSIX paths sorted by their bytes, one
// "<sha256>  <path>\n" line each (sha256sum's output); the digest is the
// sha256 of those lines. Directories are implied; a symlink or any other
// non-regular file fails the check.
export const TREE_NORMALIZATION = "gq-tree-v1";

const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const REFERENCE = /^[0-9A-Za-z._-]{7,128}$/u;
// Composer installers' WordPress paths, relative to apps/cms.
const INSTALL_PATH = /^web\/app\/(plugins|mu-plugins|themes)\/[A-Za-z0-9][\w.-]*$/u;

const treePath = z
  .string()
  .refine(
    (path) =>
      path.length > 0 &&
      !path.startsWith("/") &&
      !path.includes("\\") &&
      ![...path].some((character) => character.charCodeAt(0) < 0x20 || character === "\u007f") &&
      path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "must be a relative POSIX path without empty, . or .. parts, backslashes or control characters",
  );

const expectation = z.strictObject({
  name: z.string().regex(COMPOSER_PACKAGE_NAME, "must be a Composer package name"),
  version: z.string().regex(VERSION, "must be an exact version like 1.2.3"),
  tag: z.string().trim().min(1),
  tagCommit: z.string().regex(COMMIT, "must be the published tag's 40-character commit"),
  lockReference: z.string().regex(REFERENCE, "must be the reference composer.lock records"),
  installPath: z.string().regex(INSTALL_PATH, "must be web/app/<plugins|mu-plugins|themes>/<slug>"),
  tree: z.strictObject({
    normalization: z.literal(TREE_NORMALIZATION),
    digest: z.string().regex(SHA256, "must be a sha256 hex digest"),
    files: z.array(z.strictObject({ path: treePath, sha256: z.string().regex(SHA256) })).min(1),
  }),
  // Informational only: the source repository's commit the release was built
  // from. Never compared with the lock or the installed files.
  sourceCommit: z.string().regex(COMMIT).optional(),
});

const contract = z.strictObject({
  schemaVersion: z.literal(PACKAGE_EXPECTATIONS_SCHEMA_VERSION),
  packages: z.array(expectation).min(1),
});

// The validated contract in `text`; throws naming `source` and the problem.
export function parsePackageExpectations(text, source = PACKAGE_EXPECTATIONS_PATH) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source} isn't valid JSON: ${error.message}`, { cause: error });
  }
  const result = contract.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(
      `${source} is invalid: ${[...issue.path].join(".") || "(root)"} ${issue.message}.`,
    );
  }
  const names = new Set();
  for (const pkg of result.data.packages) {
    if (names.has(pkg.name)) throw new Error(`${source} lists ${pkg.name} twice.`);
    names.add(pkg.name);
    const paths = new Set();
    for (const { path } of pkg.tree.files) {
      if (paths.has(path)) throw new Error(`${source} lists ${pkg.name}'s ${path} twice.`);
      paths.add(path);
    }
    const digest = treeDigest(pkg.tree.files);
    if (digest !== pkg.tree.digest) {
      throw new Error(
        `${source}: ${pkg.name}'s tree.digest is ${pkg.tree.digest}, but its files hash to ${digest} (${TREE_NORMALIZATION}).`,
      );
    }
  }
  return result.data;
}

// The gq-tree-v1 listing of `files` ([{ path, sha256 }]).
export function treeListing(files) {
  return [...files]
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
    .map(({ path, sha256 }) => `${sha256}  ${path}\n`)
    .join("");
}

// The gq-tree-v1 digest of `files`.
export function treeDigest(files) {
  return sha256(treeListing(files));
}

// Throws unless `lock` (a parsed composer.lock) installs `pkg` exactly as the
// expectation states: in `packages` (a --no-dev install skips packages-dev),
// at its version, with every reference the lock records equal to
// lockReference.
export function checkLockedIdentity(lock, pkg, lockPath = "apps/cms/composer.lock") {
  const entry = (lock.packages ?? []).find((candidate) => candidate.name === pkg.name);
  if (!entry) {
    const dev = (lock["packages-dev"] ?? []).some((candidate) => candidate.name === pkg.name);
    throw new Error(
      dev
        ? `${lockPath} locks ${pkg.name} only as a dev package, which the server doesn't install.`
        : `${lockPath} doesn't lock ${pkg.name}.`,
    );
  }
  const version = String(entry.version).replace(/^v(?=\d)/u, "");
  if (version !== pkg.version) {
    throw new Error(
      `${lockPath} locks ${pkg.name} ${entry.version}, not the expected ${pkg.version}.`,
    );
  }
  const references = [entry.dist?.reference, entry.source?.reference].filter(Boolean);
  if (references.length === 0 || references.some((reference) => reference !== pkg.lockReference)) {
    throw new Error(
      `${lockPath} locks ${pkg.name} at reference ${references.join(" / ") || "(none)"}, not the expected ${pkg.lockReference}.`,
    );
  }
}

// The PACKAGE_EXPECTATIONS file the deploy script reads: line-based, so it
// needs no JSON parser on the server.
export function renderServerExpectations(expectations, lockText) {
  const lines = [
    `gq-package-expectations ${PACKAGE_EXPECTATIONS_SCHEMA_VERSION}`,
    `lock ${sha256(lockText)}`,
  ];
  for (const pkg of expectations.packages) {
    lines.push(`package ${pkg.name} ${pkg.version} ${pkg.installPath} ${pkg.tree.digest}`);
    for (const line of treeListing(pkg.tree.files).trimEnd().split("\n")) {
      lines.push(`file ${line.slice(0, 64)} ${line.slice(66)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

// What the approval service is asked about one package: the published
// identity and tree a deploy would install on `project`, at release commit
// `releaseCommit`.
export function approvalRequest({ project, releaseCommit, pkg }) {
  return {
    project,
    releaseCommit,
    package: {
      name: pkg.name,
      version: pkg.version,
      tag: pkg.tag,
      tagCommit: pkg.tagCommit,
      lockReference: pkg.lockReference,
      installPath: pkg.installPath,
      tree: {
        normalization: pkg.tree.normalization,
        digest: pkg.tree.digest,
        fileCount: pkg.tree.files.length,
      },
    },
  };
}

// The approval seam: `confirm(request)` resolves when an authenticated
// service confirms the request's package is approved for the project, and
// rejects otherwise. gq-site has no such service yet, so this one refuses.
export const unconfiguredApprovals = Object.freeze({
  async confirm({ package: pkg }) {
    throw new Error(
      `No authenticated package approval service is configured, so gq can't confirm ${pkg.name} ${pkg.version} (${pkg.tag}) is approved; a guarded deploy refuses. ${PACKAGE_EXPECTATIONS_PATH} is an expectation the server checks, not an approval.`,
    );
  },
});

// For a release of a Site guarding `guarded` packages at commit `sha`: reads
// the expectations and composer.lock from that commit through `show(path)`,
// checks every guarded package is expected and locked as expected, asks
// `approvals` to confirm each, and resolves to the PACKAGE_EXPECTATIONS text
// the archive ships. Throws, before anything is uploaded, on any failure.
export async function prepareGuardedRelease({ project, guarded, sha, show, approvals }) {
  const read = async (path, why) => {
    try {
      return await show(path);
    } catch {
      throw new Error(
        `The release commit ${sha.slice(0, 12)} has no ${path}, which ${why}; nothing was uploaded or deployed.`,
      );
    }
  };
  const why = `a Site guarding ${guarded.join(", ")} needs`;
  const expectations = parsePackageExpectations(await read(PACKAGE_EXPECTATIONS_PATH, why));
  const lockText = await read("apps/cms/composer.lock", why);
  const lock = JSON.parse(lockText);
  for (const name of guarded) {
    const pkg = expectations.packages.find((candidate) => candidate.name === name);
    if (!pkg) {
      throw new Error(
        `${PACKAGE_EXPECTATIONS_PATH} doesn't state ${name}, which gq.ops.json guards.`,
      );
    }
    checkLockedIdentity(lock, pkg);
  }
  for (const pkg of expectations.packages) {
    if (!guarded.includes(pkg.name)) checkLockedIdentity(lock, pkg);
    await approvals.confirm(approvalRequest({ project, releaseCommit: sha, pkg }));
  }
  return renderServerExpectations(expectations, lockText);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

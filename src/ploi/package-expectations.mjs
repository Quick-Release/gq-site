// Guarded Composer packages (gq.ops.json deployment.guardedPackages): what a
// release of such a Site checks before it changes anything, and what it hands
// the server to check again after `composer install`.
//
// Two inputs, kept apart (docs/reference/package-expectations.md):
//
// - deploy/ploi/package-expectations.json, the Site's reviewed EXPECTATION
//   (contract v1): each guarded package's version, the approved release it
//   intends (the release ID the approval lookup takes) and where it installs.
//   Anyone who can change the Site can edit it, so it is never authority.
// - An approval record (gq-support.composer-approval/v1) that `approvals`, an
//   injected adapter for an authenticated, read-only approval service, looks
//   up. It is the only authority, and its exact file list is what the server
//   verifies. gq-site has no such adapter: unconfiguredApprovals refuses, so
//   every guarded preparation and deploy refuses until one is wired into run().
//
// A deploy looks a record up (phase "deploy") before it uploads anything and
// looks it up again, fresh, immediately before it changes the Ploi site; a
// lookup that fails, or a record that changed, is stale or is for another
// phase, stops it. A "prepare" record never authorizes an install.
//
// Identity: the record's files are the approved contents. The registry may
// repack a ZIP, so its bytes can differ while the files are the same; the
// source repository's main commit is not the published package's identity
// and is never compared with the lock.
import { createHash } from "node:crypto";
import { z } from "zod";

import { COMPOSER_PACKAGE_NAME } from "../manifest/schema.mjs";

export const PACKAGE_EXPECTATIONS_PATH = "deploy/ploi/package-expectations.json";
export const PACKAGE_EXPECTATIONS_SCHEMA_VERSION = 1;
// The release archive's root file the deploy script verifies installs against.
export const SERVER_EXPECTATIONS_FILE = "PACKAGE_EXPECTATIONS";
export const APPROVAL_SCHEMA = "gq-support.composer-approval/v1";
// gq-support's filesDigest: every regular file, ASCII paths relative to the
// package root, the SHA-256 of each file's raw bytes, and the SHA-256 of the
// "<path>\0<sha256>\n" lines sorted by path.
export const FILES_NORMALIZATION = "gq-support.files/v1";
export const APPROVAL_PHASES = ["prepare", "deploy"];
// How old an approval record may be when gq acts on it, and how far in the
// future its observed_at may be (clock skew).
export const APPROVAL_MAX_AGE_MS = 5 * 60 * 1000;
const APPROVAL_MAX_SKEW_MS = 60 * 1000;
const MAX_FILES = 2000;

// gq-support's own path rule: segments of letters, digits, ., _ and -, not
// starting with a dot; so no traversal, spaces or shell syntax.
export const PACKAGE_FILE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
// Composer installers' WordPress paths, relative to apps/cms.
const INSTALL_PATH = /^web\/app\/(plugins|mu-plugins|themes)\/[A-Za-z0-9][\w.-]*$/u;
const text = z.string().trim().min(1);

// The Site's reviewed expectation: which package version and which approved
// release (its release ID, the approval service's lookup key) it intends.
// Identity and contents come only from the record, and where Composer
// installs the package from the release commit's own Composer configuration.
const expectation = z.strictObject({
  name: z.string().regex(COMPOSER_PACKAGE_NAME, "must be a Composer package name"),
  version: z.string().regex(VERSION, "must be an exact version like 1.2.3"),
  releaseId: z.number().int().positive(),
});

const expectations = z.strictObject({
  schemaVersion: z.literal(PACKAGE_EXPECTATIONS_SCHEMA_VERSION),
  packages: z.array(expectation).min(1),
});

// The approval record (gq-support.composer-approval/v1): exactly these keys;
// a missing or unknown one refuses it.
const approvalRecord = z.strictObject({
  schema: z.literal(APPROVAL_SCHEMA),
  stage: text,
  slot: text,
  phase: z.enum(APPROVAL_PHASES),
  release_id: z.number().int().positive(),
  package: z.strictObject({
    name: z.string().regex(COMPOSER_PACKAGE_NAME),
    version: z.string().regex(VERSION),
    zip_sha256: z.string().regex(SHA256),
  }),
  provenance: z.strictObject({
    source_commit: z.string().regex(COMMIT),
    release_run: z.string().regex(/^[1-9]\d*$/u, "must be a GitHub Actions run id"),
  }),
  published_tag: z.strictObject({ name: text, commit: z.string().regex(COMMIT) }),
  files: z
    .record(
      z.string().regex(PACKAGE_FILE_PATH, "must be a relative package path"),
      z.string().regex(SHA256),
    )
    .refine((files) => Object.keys(files).length > 0, "lists no files")
    .refine(
      (files) => Object.keys(files).length <= MAX_FILES,
      `lists more than ${MAX_FILES} files`,
    ),
  files_digest: z.string().regex(SHA256),
  normalization: z.literal(FILES_NORMALIZATION),
  observed_at: z.iso.datetime({ offset: true }),
});

// The validated Site expectations in `json`; throws naming `source`.
export function parsePackageExpectations(json, source = PACKAGE_EXPECTATIONS_PATH) {
  const data = parseWith(expectations, parseJson(json, source), source);
  const names = new Set();
  for (const pkg of data.packages) {
    if (names.has(pkg.name)) throw new Error(`${source} lists ${pkg.name} twice.`);
    names.add(pkg.name);
  }
  return data;
}

// The Site expectations file holding `packages`, as gq writes it.
export function packageExpectationsText(packages) {
  const sorted = [...packages].sort((left, right) => left.name.localeCompare(right.name));
  return `${JSON.stringify(
    { schemaVersion: PACKAGE_EXPECTATIONS_SCHEMA_VERSION, packages: sorted },
    null,
    2,
  )}\n`;
}

// The gq-support.files/v1 digest of `files` ({ path: sha256 }).
export function filesDigest(files) {
  return sha256(
    sortedPaths(files)
      .map((path) => `${path}\0${files[path]}\n`)
      .join(""),
  );
}

// The approval record `record` as gq may act on it for `request` at `now`
// (ms): a record for exactly the Site's reviewed stage and slot, the same
// phase, package, exact version and (when asked for one) release ID, whose files hash to its files_digest, observed within
// APPROVAL_MAX_AGE_MS. Throws naming the problem otherwise.
export function checkApprovalRecord(record, { stage, slot, phase, name, version, releaseId }, now) {
  const label = `The approval record for ${name} ${version}`;
  if (!stage || !slot) {
    throw new Error(`${label} can't be checked without the Site's approval stage and slot.`);
  }
  const data = parseWith(approvalRecord, record, label);
  if (data.stage !== stage || data.slot !== slot) {
    throw new Error(
      `${label} is for ${data.stage} slot ${data.slot}, not this Site's ${stage} slot ${slot}.`,
    );
  }
  if (data.phase !== phase) throw new Error(`${label} is for phase ${data.phase}, not ${phase}.`);
  if (data.package.name !== name || data.package.version !== version) {
    throw new Error(`${label} approves ${data.package.name} ${data.package.version} instead.`);
  }
  if (releaseId !== undefined && data.release_id !== releaseId) {
    throw new Error(`${label} is release ${data.release_id}, not release ${releaseId}.`);
  }
  const digest = filesDigest(data.files);
  if (digest !== data.files_digest) {
    throw new Error(
      `${label} says its files hash to ${data.files_digest}, but they hash to ${digest}.`,
    );
  }
  const age = now - Date.parse(data.observed_at);
  if (age > APPROVAL_MAX_AGE_MS || age < -APPROVAL_MAX_SKEW_MS) {
    throw new Error(
      `${label} was observed at ${data.observed_at}, not within ${APPROVAL_MAX_AGE_MS / 60000} minutes of now; gq acts only on a fresh lookup.`,
    );
  }
  return data;
}

// Asks `approvals` for a record and checks it (checkApprovalRecord).
export async function lookUpApproval(approvals, request, clock) {
  const record = await approvals.lookup(request);
  return checkApprovalRecord(
    record,
    {
      stage: request.stage,
      slot: request.slot,
      phase: request.phase,
      releaseId: request.releaseId,
      ...request.package,
    },
    clock.now(),
  );
}

// Throws unless `lock` (a parsed composer.lock) installs `record`'s package:
// in `packages` (a --no-dev install skips packages-dev), at its version, with
// source.reference (and dist.reference, when there is a dist) the commit its
// published tag points to. The record's provenance.source_commit is the
// gq-support source commit, never compared with the lock, and the registry's
// dist ZIP bytes are never compared with zip_sha256: the registry may repack
// them, but that doesn't make another commit the approved package.
export function checkLockedRecord(lock, record, lockPath = "apps/cms/composer.lock") {
  const { name, version } = record.package;
  const entry = lockedEntry(lock, name);
  if (!entry) {
    const dev = (lock["packages-dev"] ?? []).some((candidate) => candidate.name === name);
    throw new Error(
      dev
        ? `${lockPath} locks ${name} only as a dev package, which the server doesn't install.`
        : `${lockPath} doesn't lock ${name}.`,
    );
  }
  if (normaliseVersion(entry.version) !== version) {
    throw new Error(`${lockPath} locks ${name} ${entry.version}, not the approved ${version}.`);
  }
  // Both of the lock's references must be the published tag's commit: a
  // repacked registry ZIP doesn't make another commit the same package.
  const commit = record.published_tag.commit;
  const reference = entry.source?.reference;
  if (reference !== commit) {
    throw new Error(
      `${lockPath} locks ${name} from source reference ${reference ?? "(none)"}, not ${commit}, the commit the approved ${record.published_tag.name} tag points to.`,
    );
  }
  if (entry.dist && entry.dist.reference !== commit) {
    throw new Error(
      `${lockPath} locks ${name} with dist reference ${entry.dist.reference ?? "(none)"}, not ${commit}, the commit the approved ${record.published_tag.name} tag points to.`,
    );
  }
  return entry;
}

// The WordPress package types composer/installers places.
const WORDPRESS_TYPES = new Set(["wordpress-plugin", "wordpress-muplugin", "wordpress-theme"]);

// Where Composer installs the lock entry `entry` under the CMS composer.json
// `composer` (both from the release commit), as composer/installers decides
// it: the extra.installer-paths pattern that names the package, its
// `type:<type>` or its `vendor:<vendor>`, with {$name} (the package's
// installer-name, else its name) and {$vendor} filled in. Throws unless
// exactly one pattern applies and the result is a WordPress plugin, must-use
// plugin or theme directory.
export function installPathOf(composer, entry, composerPath = "apps/cms/composer.json") {
  const [vendor, name] = entry.name.split("/");
  if (!WORDPRESS_TYPES.has(entry.type)) {
    throw new Error(
      `${entry.name} is locked as type ${entry.type ?? "(none)"}, not a WordPress plugin or theme gq can place.`,
    );
  }
  const paths = composer?.extra?.["installer-paths"];
  const matching = Object.entries(paths && typeof paths === "object" ? paths : {}).filter(
    ([, selectors]) =>
      Array.isArray(selectors) &&
      (selectors.includes(entry.name) ||
        selectors.includes(`type:${entry.type}`) ||
        selectors.includes(`vendor:${vendor}`)),
  );
  if (matching.length !== 1) {
    throw new Error(
      matching.length === 0
        ? `${composerPath}'s extra.installer-paths places ${entry.name} nowhere; gq needs exactly one pattern to know where it installs.`
        : `${composerPath}'s extra.installer-paths has ${matching.length} patterns for ${entry.name}; gq needs exactly one to know where it installs.`,
    );
  }
  const installerName = entry.extra?.["installer-name"];
  const path = matching[0][0]
    .replaceAll("{$name}", typeof installerName === "string" ? installerName : name)
    .replaceAll("{$vendor}", vendor)
    .replace(/\/+$/u, "");
  if (!INSTALL_PATH.test(path)) {
    throw new Error(
      `${entry.name} installs at ${path}, not a web/app/plugins, mu-plugins or themes directory gq can verify.`,
    );
  }
  return path;
}

// The PACKAGE_EXPECTATIONS file the deploy script reads: line-based, so the
// server needs no JSON parser. `packages` are [{ name, version, installPath,
// files, filesDigest }], the files from approval records.
export function renderServerExpectations(packages, lockText) {
  const lines = [
    `gq-package-expectations ${PACKAGE_EXPECTATIONS_SCHEMA_VERSION}`,
    `lock ${sha256(lockText)}`,
  ];
  for (const pkg of packages) {
    lines.push(`package ${pkg.name} ${pkg.version} ${pkg.installPath} ${pkg.filesDigest}`);
    for (const path of sortedPaths(pkg.files)) lines.push(`file ${pkg.files[path]} ${path}`);
  }
  return `${lines.join("\n")}\n`;
}

// The approval seam. `lookup({ phase, project, stage, slot, releaseId,
// releaseCommit?, package: { name, version } })` (stage and slot: the Site's
// reviewed gq.ops.json deployment.approval) resolves to the approval service's current
// gq-support.composer-approval/v1 record for that release and phase, or
// rejects when there is none (not approved, withdrawn, unreadable). Without a
// configured adapter (approval-command.mjs), this one refuses.
export const unconfiguredApprovals = Object.freeze({
  async lookup({ phase, package: pkg }) {
    throw new Error(
      `No package approval lookup is configured, so gq can't look up ${pkg.name} ${pkg.version} (phase ${phase}); a guarded package refuses. ${PACKAGE_EXPECTATIONS_PATH} is an expectation, not an approval.`,
    );
  },
});

// For a release of a Site guarding `guarded` packages at commit `sha`: reads
// the expectations and composer.lock from that commit through `show(path)`,
// looks up each guarded package's deploy approval for the release the Site
// expects, and checks the lock installs exactly that record's package.
// Resolves to { expectations: the PACKAGE_EXPECTATIONS text, records }.
// Throws, before anything is uploaded, on any failure.
export async function prepareGuardedRelease({
  project,
  target,
  guarded,
  sha,
  show,
  approvals,
  clock,
}) {
  const read = async (path) => {
    try {
      return await show(path);
    } catch {
      throw new Error(
        `The release commit ${sha.slice(0, 12)} has no ${path}, which a Site guarding ${guarded.join(", ")} needs; nothing was uploaded or deployed.`,
      );
    }
  };
  const expected = parsePackageExpectations(await read(PACKAGE_EXPECTATIONS_PATH));
  const lockText = await read("apps/cms/composer.lock");
  const lock = JSON.parse(lockText);
  const packages = guarded.map((name) => {
    const pkg = expected.packages.find((candidate) => candidate.name === name);
    if (!pkg) {
      throw new Error(
        `${PACKAGE_EXPECTATIONS_PATH} doesn't state ${name}, which gq.ops.json guards.`,
      );
    }
    return pkg;
  });
  const composer = JSON.parse(await read("apps/cms/composer.json"));
  const records = [];
  const shipped = [];
  for (const pkg of packages) {
    const record = await lookUpApproval(approvals, deployRequest(project, target, sha, pkg), clock);
    const entry = checkLockedRecord(lock, record);
    records.push(record);
    shipped.push({
      ...pkg,
      installPath: installPathOf(composer, entry),
      files: record.files,
      filesDigest: record.files_digest,
    });
  }
  return { expectations: renderServerExpectations(shipped, lockText), records };
}

// Runs every deploy lookup again, fresh, immediately before a release's
// deploy request: each must succeed and match the record the release checked
// in every field but observed_at. Throws otherwise.
export async function revalidateGuardedRelease({
  project,
  target,
  sha,
  records,
  approvals,
  clock,
}) {
  for (const before of records) {
    const pkg = { ...before.package, releaseId: before.release_id };
    let now;
    try {
      now = await lookUpApproval(approvals, deployRequest(project, target, sha, pkg), clock);
    } catch (error) {
      throw new Error(
        `${pkg.name} ${pkg.version} is no longer approved for deploy (${error.message}); nothing was deployed.`,
        { cause: error },
      );
    }
    const changed = differingFields(before, now).filter((field) => field !== "observed_at");
    if (changed.length > 0) {
      throw new Error(
        `${pkg.name} ${pkg.version}'s approval changed since this release checked it (${changed.join(", ")}); nothing was deployed.`,
      );
    }
  }
}

function deployRequest(project, { stage, slot }, releaseCommit, { name, version, releaseId }) {
  return {
    phase: "deploy",
    project,
    stage,
    slot,
    releaseId,
    releaseCommit,
    package: { name, version },
  };
}

// The dotted paths at which two parsed records differ.
function differingFields(left, right, prefix = "") {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].flatMap((key) => {
    const [a, b] = [left[key], right[key]];
    if (a && b && typeof a === "object" && typeof b === "object") {
      return differingFields(a, b, `${prefix}${key}.`);
    }
    return a === b ? [] : [`${prefix}${key}`];
  });
}

function lockedEntry(lock, name) {
  return (lock.packages ?? []).find((candidate) => candidate.name === name);
}

function normaliseVersion(version) {
  return String(version).replace(/^v(?=\d)/u, "");
}

// Paths sorted by UTF-16 code unit, which is byte order for these ASCII
// paths, as gq-support sorts them.
function sortedPaths(files) {
  return Object.keys(files).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function parseJson(json, source) {
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new Error(`${source} isn't valid JSON: ${error.message}`, { cause: error });
  }
}

function parseWith(schema, value, source) {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(
      `${source} is invalid: ${[...issue.path].join(".") || "(root)"} ${issue.message}.`,
    );
  }
  return result.data;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

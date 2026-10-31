import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CMS_PATH, composerDependencyChange } from "../cms/local.mjs";
import { COMPOSER_PACKAGE_NAME } from "../manifest/schema.mjs";
import { loadSiteSettings } from "../manifest/site-settings.mjs";
import { assertDeploymentAllowed, guardedPackages } from "../ploi/deployment-policy.mjs";
import {
  PACKAGE_EXPECTATIONS_PATH,
  lockedReference,
  lookUpApproval,
  packageExpectationsText,
  parsePackageExpectations,
} from "../ploi/package-expectations.mjs";
import { runRelease } from "../ploi/release.mjs";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const BUMP_KINDS = new Set(["major", "minor", "fix", "patch"]);
const COMPOSER_NAME = COMPOSER_PACKAGE_NAME;
const COMPOSER_JSON = `${CMS_PATH}/composer.json`;
const COMPOSER_LOCK = `${CMS_PATH}/composer.lock`;
// A lock reference (a commit or a dist hash): no whitespace or shell syntax.
const REFERENCE = /^[0-9A-Za-z._-]{7,128}$/u;

// Command → [usage, the options it accepts].
const RELEASE_COMMANDS = new Map([
  ["version check", ["gq version check [version]", []]],
  ["version sync", ["gq version sync [version]", []]],
  ["release prepare", ["gq release prepare [version]", []]],
  ["release tag", ["gq release tag [version]", []]],
  ["release push", ["gq release push <major|minor|fix>", []]],
  [
    "release package",
    [
      "gq release package <composer-package> [--to <version>] [--reference <ref>] [--expect-before <version>] [--no-deploy | --composer-only]",
      ["to", "reference", "expectBefore", "noDeploy", "composerOnly"],
    ],
  ],
]);

export const RELEASE_USAGE = [...RELEASE_COMMANDS.values()].map(([usage]) => usage);

export function isReleaseCommand(command) {
  return command[0] === "version" || command[0] === "release";
}

// Resolves a release command's name and the options it accepts, checking its
// shape (and push's bump kind) before any project is loaded, so the CLI can
// validate its options like any other command's.
export function releaseCommandOptions(parsed) {
  const [group, action, argument, ...extra] = parsed.command;
  const name = `${group} ${action ?? ""}`.trim();
  const entry = RELEASE_COMMANDS.get(name);
  if (!entry || extra.length > 0) {
    throw new Error(`Unknown command: ${parsed.command.join(" ")}. Run gq --help.`);
  }
  const [usage, allowedOptions] = entry;
  if (name === "release push" && !BUMP_KINDS.has(argument ?? "")) {
    throw new Error(`Usage: ${usage}`);
  }
  if (name === "release package" && !COMPOSER_NAME.test(argument ?? "")) {
    throw new Error("Usage: gq release package <composer-package>");
  }
  return { command: name, allowedOptions };
}

// Runs a command that releaseCommandOptions() has already accepted.
export async function runReleaseCommand({
  parsed,
  context,
  env,
  fetch,
  exec,
  io,
  interactive,
  approvals,
  clock,
}) {
  const argument = parsed.command[2];
  const release = createRelease({
    config: await loadSiteSettings(context),
    root: context.projectRoot,
    env,
    exec,
    io,
  });
  const command = parsed.command.slice(0, 2).join(" ");

  if (command === "release push") {
    await release.push(argument);
    return;
  }
  if (command === "release package") {
    return releasePackage(argument, {
      release,
      parsed,
      context,
      env,
      fetch,
      exec,
      io,
      interactive,
      approvals,
      clock,
    });
  }
  if (command === "release tag") {
    await release.tag(argument || (await release.readVersion()));
    return;
  }

  const version = argument || (await release.readVersion());
  assertVersion(version);
  if (command === "release prepare") {
    await release.writeVersion(version);
  }
  if (command !== "version check") {
    await release.sync(version);
  }
  await release.check(version);
  if (command === "release prepare") {
    io.out(
      `Prepared release ${version}. Commit the synced files, then run: gq release tag ${version}`,
    );
  }
}

function assertVersion(version) {
  if (!SEMVER.test(version)) {
    throw new Error(`Expected a semver version, received "${version}".`);
  }
}

function createRelease({ config, root, env, exec, io }) {
  const at = (path) => join(root, path);
  const readJson = async (path) => JSON.parse(await readFile(at(path), "utf8"));
  const writeJson = (path, data) => writeFile(at(path), `${JSON.stringify(data, null, 2)}\n`);

  // A command whose output the user watches (checks, commits, pushes).
  async function runCommand(command, args, { cwd, env: commandEnv = env } = {}) {
    const { code } = await exec(command, args, {
      cwd: cwd ? at(cwd) : root,
      env: commandEnv,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    if (code !== 0) {
      throw new Error(`${[command, ...args].join(" ")} exited with code ${code}.`);
    }
  }

  // A git query whose output the release reads.
  async function git(args) {
    const { code, stdout, stderr } = await exec("git", args, { cwd: root, env });
    if (code !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${stderr.trim() || `exit code ${code}`}`);
    }
    return stdout.trim();
  }

  async function readVersion() {
    return (await readFile(at(config.versionFile), "utf8")).trim();
  }

  async function writeVersion(version) {
    await writeFile(at(config.versionFile), `${version}\n`);
  }

  async function sync(version) {
    for (const path of config.jsonFiles) {
      const data = await readJson(path);
      data.version = version;
      await writeJson(path, data);
    }

    for (const file of config.textFiles) {
      let content = await readFile(at(file.path), "utf8");
      for (const { regexp, replacement } of file.patterns) {
        if (!regexp.test(content)) {
          throw new Error(`${file.path} is missing expected version pattern ${regexp}.`);
        }
        content = content.replace(regexp, () => replacement(version));
      }
      await writeFile(at(file.path), content);
    }

    io.out(`Synced project version ${version}.`);
  }

  async function check(version) {
    const mismatches = [];

    for (const path of config.jsonFiles) {
      const data = await readJson(path);
      if (data.version !== version) mismatches.push(`${path}: ${data.version || "[missing]"}`);
    }

    for (const file of config.textFiles) {
      const content = await readFile(at(file.path), "utf8");
      for (const pattern of file.patterns) {
        const expected = pattern.replacement(version);
        if (!content.includes(expected)) mismatches.push(`${file.path}: missing "${expected}"`);
      }
    }

    if (mismatches.length > 0) {
      throw new Error(
        `Version drift detected for ${version}:\n${mismatches.map((line) => `  - ${line}`).join("\n")}`,
      );
    }

    io.out(`All project packages are synced at ${version}.`);
  }

  async function tag(version) {
    assertVersion(version);
    await check(version);
    if (await git(["status", "--porcelain"])) {
      throw new Error("Release tagging requires a clean working tree.");
    }
    await createTag(version);
  }

  async function createTag(version) {
    const name = `v${version}`;
    await runCommand("git", ["tag", "-a", name, "-m", `Release ${name}`]);
    io.out(`Created ${name}. Push it with: git push origin ${name}`);
  }

  async function push(kind) {
    const branch = await releaseBranch(kind);
    const currentVersion = await readVersion();
    assertVersion(currentVersion);

    const nextVersion = bumpVersion(currentVersion, kind);
    if (await git(["tag", "--list", `v${nextVersion}`])) {
      throw new Error(`Release tag v${nextVersion} already exists.`);
    }
    await writeVersion(nextVersion);
    await sync(nextVersion);
    await updateChangelog(nextVersion);
    await check(nextVersion);
    await runChecks();
    await commit(nextVersion);
    await pushRelease(branch, nextVersion);
    io.out(`Pushed ${kind === "patch" ? "fix" : kind} release ${nextVersion}.`);
  }

  async function updateChangelog(version) {
    const previousTag = (
      await git(["tag", "--merged", "HEAD", "--list", "v[0-9]*", "--sort=-v:refname"])
    )
      .split(/\r?\n/)
      .map((name) => name.trim())
      .find((name) => /^v\d+\.\d+\.\d+/.test(name));
    const log = await git([
      "log",
      previousTag ? `${previousTag}..HEAD` : "HEAD",
      "--pretty=format:%h %s",
    ]);
    const commits = log ? log.split(/\r?\n/) : [];
    const previousRelease = previousTag || "initial release";
    const lines = [
      `## v${version} - ${new Date().toISOString().slice(0, 10)}`,
      "",
      `Previous release: ${previousRelease}`,
      "",
      ...(commits.length
        ? commits.map((message) => `- ${message}`)
        : ["- No commit messages recorded."]),
      "",
    ];

    let changelog;
    try {
      changelog = await readFile(at(config.changelogPath), "utf8");
    } catch {
      changelog = "# Changelog\n";
    }
    const normalized = changelog.trimEnd();
    const next = normalized.startsWith("# Changelog")
      ? normalized.replace(/^# Changelog\s*/, `# Changelog\n\n${lines.join("\n")}\n`)
      : `# Changelog\n\n${lines.join("\n")}\n${normalized}`;

    await writeFile(at(config.changelogPath), `${next.trimEnd()}\n`);
    io.out(`Updated ${config.changelogPath} from ${previousRelease} to v${version}.`);
  }

  async function runChecks() {
    for (const check of config.checks) {
      await runCommand(check.cmd, check.args, {
        cwd: check.cwd,
        env: check.env ? { ...env, ...check.env } : env,
      });
    }
  }

  async function commit(version) {
    await runCommand("git", ["add", ...config.releasePaths]);
    if (!(await git(["diff", "--cached", "--name-only"]))) {
      throw new Error("No release changes were staged.");
    }
    await runCommand("git", ["commit", "-m", `Release v${version}`]);
    await createTag(version);
  }

  // The branch a release pushes: HEAD's, which must be the default branch
  // (origin/HEAD, else main) so the release commit lands where CI deploys from.
  async function releaseBranch(kind) {
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!branch || branch === "HEAD") {
      throw new Error("Cannot push release from a detached HEAD.");
    }
    const defaultBranch = await readDefaultBranch();
    if (branch !== defaultBranch) {
      throw new Error(
        `Release push must run on the default branch ${defaultBranch}, but HEAD is on ${branch}. ` +
          `Merge the branch into ${defaultBranch}, then run: git switch ${defaultBranch} && gq release push ${kind}`,
      );
    }
    return branch;
  }

  async function readDefaultBranch() {
    const { code, stdout } = await exec(
      "git",
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      { cwd: root, env },
    );
    const ref = code === 0 ? stdout.trim() : "";
    return ref.startsWith("origin/") ? ref.slice("origin/".length) : "main";
  }

  async function pushRelease(branch, version) {
    await runCommand("git", ["push", "origin", branch]);
    await runCommand("git", ["push", "origin", `v${version}`]);
  }

  // Every tracked file that changed: from a clean tree, composer.lock and
  // what the version sync wrote. Composer's installs are ignored or untracked.
  async function stage() {
    await runCommand("git", ["add", "--update"]);
  }

  return { readVersion, writeVersion, sync, check, tag, push, git, runCommand, stage };
}

// `gq release package <composer-package>`: a fast redeploy of one Composer
// package. Updates just that package in apps/cms/composer.lock (with the
// registry login, like `gq cms composer update`), prepares the release at the
// current VERSION, commits, and deploys that commit with `gq ploi release`.
// Nothing is pushed, tagged or bumped: the archive is keyed by the commit, so
// each redeploy is its own. Resolves to the Ploi release's exit code.
//
// Guarded preparation: --to <version> pins the package exactly in
// composer.json first, --expect-before <version> refuses unless the lock
// holds that version now, --reference <ref> requires the lock's reference
// after the update, and --no-deploy commits without deploying (nothing is
// uploaded and no provider is called). Any of them runs Composer with
// --no-install (only the lock changes) and refuses, restoring composer.json
// and composer.lock, when the update changes any other locked package, the
// version or the reference isn't the one asked for, or a file other than
// those two changed. A package in gq.ops.json deployment.guardedPackages is
// only ever prepared this way, with --to, and only once the approval service
// returns a fresh phase "prepare" record for that exact version (looked up
// before Composer runs; without a service it refuses). Its entry in
// deploy/ploi/package-expectations.json then takes the approved files' digest
// and the lock's new reference, and is committed with the lock. Preparing
// isn't permission to deploy: the deploy looks the approval up again.
async function releasePackage(
  name,
  { release, parsed, context, env, fetch, exec, io, interactive, approvals, clock },
) {
  const root = context.projectRoot;
  const options = packageOptions(parsed, name, context.config);
  // A held Site refuses before Composer runs or anything is committed;
  // preparing a commit without deploying it is still allowed.
  if (!options.noDeploy) assertDeploymentAllowed(context.config);
  const composerPath = join(root, COMPOSER_JSON);
  const lockPath = join(root, COMPOSER_LOCK);
  const composerText = await readFile(composerPath, "utf8");
  const composer = JSON.parse(composerText);
  if (!Object.hasOwn(composer.require ?? {}, name)) {
    throw new Error(`${CMS_PATH}/composer.json doesn't require ${name}.`);
  }
  if (await release.git(["status", "--porcelain"])) {
    throw new Error("gq release package requires a clean working tree: it commits composer.lock.");
  }
  const lockText = await readFile(lockPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const beforeLock = lockText === null ? {} : JSON.parse(lockText);
  const before = lockedPackage(beforeLock, name);
  if (options.expectBefore && normaliseVersion(before?.version) !== options.expectBefore) {
    throw new Error(
      `${COMPOSER_LOCK} locks ${name} ${describePackage(before)}, not ${options.expectBefore} (--expect-before); nothing changed.`,
    );
  }
  if (options.guarded && !before) {
    throw new Error(`${COMPOSER_LOCK} doesn't lock ${name}; nothing changed.`);
  }
  // A guarded package moves only to a version the approval service approves
  // for preparation, asked before Composer runs; without a service, never.
  const expectationsPath = join(root, PACKAGE_EXPECTATIONS_PATH);
  const expectationsText = options.guardedPackage
    ? await readFile(expectationsPath, "utf8").catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      })
    : null;
  const approval = options.guardedPackage
    ? await lookUpApproval(
        approvals,
        {
          phase: "prepare",
          project: context.config.project,
          package: { name, version: options.to },
        },
        clock,
      ).catch((error) => {
        error.message += " Nothing changed.";
        throw error;
      })
    : null;

  // Put back what this command changed, when a guard refuses the result.
  const restore = async () => {
    await writeFile(composerPath, composerText);
    if (lockText === null) await rm(lockPath, { force: true });
    else await writeFile(lockPath, lockText);
    if (!options.guardedPackage) return;
    if (expectationsText === null) await rm(expectationsPath, { force: true });
    else await writeFile(expectationsPath, expectationsText);
  };
  const restored = options.guardedPackage
    ? `${COMPOSER_JSON}, ${COMPOSER_LOCK} and ${PACKAGE_EXPECTATIONS_PATH} are restored`
    : `${COMPOSER_JSON} and ${COMPOSER_LOCK} are restored`;
  const allowed = new Set([
    COMPOSER_JSON,
    COMPOSER_LOCK,
    ...(options.guardedPackage ? [PACKAGE_EXPECTATIONS_PATH] : []),
  ]);

  io.out(`Updating ${name} in ${COMPOSER_LOCK}.`);
  let after;
  try {
    if (options.to) {
      await writeFile(composerPath, pinRequirement(composerText, name, options.to));
    }
    await composerDependencyChange(
      join(root, CMS_PATH),
      ["update", name, "--no-interaction", ...(options.guarded ? ["--no-install"] : [])],
      { exec, env, stdio: "inherit" },
    );
    const afterLock = await readLockFile(root);
    after = lockedPackage(afterLock, name);
    if (!after) throw new Error(`${COMPOSER_LOCK} has no ${name} after composer update.`);
    if (options.guarded) checkLockChange(beforeLock, afterLock, name, options);
    // The Site's expectation follows: the approved files' digest and the
    // reference the lock now records, for review with the lock change.
    if (approval) {
      const existing = expectationsText ? parsePackageExpectations(expectationsText).packages : [];
      const previous = existing.find((pkg) => pkg.name === name);
      const entry = {
        name,
        version: options.to,
        lockReference: lockedReference(afterLock, name),
        installPath: previous?.installPath ?? `web/app/plugins/${name.split("/")[1]}`,
        filesDigest: approval.files_digest,
      };
      await writeFile(
        expectationsPath,
        packageExpectationsText([...existing.filter((pkg) => pkg.name !== name), entry]),
      );
    }
  } catch (error) {
    if (options.guarded) {
      await restore();
      error.message += ` ${restored}; nothing was committed.`;
    }
    throw error;
  }

  const version = await release.readVersion();
  assertVersion(version);
  await release.sync(version);
  await release.check(version);

  const changed = changedPaths(await release.git(["status", "--porcelain"]));
  if (changed.length > 0) {
    if (options.guarded) {
      const unexpected = changed.filter((path) => !allowed.has(path));
      if (unexpected.length > 0) {
        await restore();
        throw new Error(
          `Preparing ${name} changed ${unexpected.join(", ")} too; only ${[...allowed].join(", ")} may change. ${restored}; nothing was committed.`,
        );
      }
      await release.runCommand("git", ["add", "--", ...changed]);
    } else {
      await release.stage();
    }
    await release.runCommand("git", [
      "commit",
      "-m",
      `Update ${name} to ${describePackage(after)}`,
    ]);
  } else if (options.noDeploy) {
    io.out(`${COMPOSER_LOCK} already pins ${name} ${describePackage(before)}; nothing to prepare.`);
    return 0;
  } else {
    io.out(`${COMPOSER_LOCK} already pins ${name} ${describePackage(before)}; deploying HEAD.`);
  }

  if (options.noDeploy) {
    io.out(
      `Prepared "Update ${name} to ${describePackage(after)}" without deploying: nothing was uploaded and no provider was called. Push it for review; the reviewed commit deploys through the Site's release path.`,
    );
    return 0;
  }

  const code = await runRelease({
    context,
    parsed: { ref: "HEAD", composerOnly: options.composerOnly },
    env,
    fetch,
    exec,
    io,
    interactive,
    approvals,
    clock,
  });
  if (code === 0) {
    io.out("Deployed. Push the commit to the default branch so the site's history keeps it.");
  }
  return code;
}

// release package's options, checked before anything runs.
function packageOptions(parsed, name, ops) {
  const options = {
    to: parsed.to,
    reference: parsed.reference,
    expectBefore: parsed.expectBefore,
    noDeploy: Boolean(parsed.noDeploy),
    composerOnly: Boolean(parsed.composerOnly),
  };
  for (const [option, value] of [
    ["--to", options.to],
    ["--expect-before", options.expectBefore],
  ]) {
    if (value !== undefined && !SEMVER.test(value)) {
      throw new Error(`${option} takes an exact version like 1.2.3, not "${value}".`);
    }
  }
  if (options.reference !== undefined && !REFERENCE.test(options.reference)) {
    throw new Error(`--reference takes a lock reference (a commit), not "${options.reference}".`);
  }
  if (options.noDeploy && options.composerOnly) {
    throw new Error("--composer-only is how a deploy runs; --no-deploy doesn't deploy.");
  }
  options.guardedPackage = guardedPackages(ops).includes(name);
  if (options.guardedPackage && !options.to) {
    throw new Error(
      `${name} is guarded (gq.ops.json deployment.guardedPackages): name its exact version with --to.`,
    );
  }
  options.guarded = Boolean(
    options.to || options.reference || options.expectBefore || options.noDeploy,
  );
  return options;
}

// composer.json's text with only `name`'s require constraint set to `to`.
function pinRequirement(text, name, to) {
  const json = JSON.parse(text);
  const from = json.require[name];
  if (from === to) return text;
  const block = /("require"\s*:\s*\{)([^{}]*)(\})/u.exec(text);
  const pattern = new RegExp(`("${escapeRegExp(name)}"\\s*:\\s*)"${escapeRegExp(from)}"`, "gu");
  const matches = block?.[2].match(pattern) ?? [];
  if (matches.length !== 1) {
    throw new Error(`Can't find exactly one ${name} requirement to change in ${COMPOSER_JSON}.`);
  }
  const body = block[2].replace(pattern, (_, key) => `${key}${JSON.stringify(to)}`);
  const output =
    text.slice(0, block.index) +
    block[1] +
    body +
    block[3] +
    text.slice(block.index + block[0].length);
  const expected = { ...json, require: { ...json.require, [name]: to } };
  if (JSON.stringify(JSON.parse(output)) !== JSON.stringify(expected)) {
    throw new Error(`Can't change only ${name}'s requirement in ${COMPOSER_JSON}.`);
  }
  return output;
}

// Refuses a lock update that changed anything but `name`, or left `name` at
// another version or reference than the options ask for.
function checkLockChange(before, after, name, { to, reference }) {
  const problems = [];
  for (const section of ["packages", "packages-dev"]) {
    const entries = (lock) =>
      new Map(
        (lock[section] ?? [])
          .filter((entry) => entry.name !== name)
          .map((entry) => [entry.name, JSON.stringify(entry)]),
      );
    const [was, now] = [entries(before), entries(after)];
    for (const [other, entry] of now) {
      if (!was.has(other)) problems.push(`added ${other} to ${section}`);
      else if (was.get(other) !== entry) problems.push(`changed ${other} in ${section}`);
    }
    for (const other of was.keys()) {
      if (!now.has(other)) problems.push(`removed ${other} from ${section}`);
    }
  }
  const sectionOf = (lock) =>
    (lock.packages ?? []).some((entry) => entry.name === name) ? "packages" : "packages-dev";
  if (sectionOf(before) !== sectionOf(after)) {
    problems.push(`moved ${name} to ${sectionOf(after)}`);
  }
  if (problems.length > 0) {
    throw new Error(
      `composer update ${name} changed other locked packages: ${problems.join(", ")}.`,
    );
  }
  const entry = lockedPackage(after, name);
  if (to && normaliseVersion(entry.version) !== to) {
    throw new Error(`${COMPOSER_LOCK} locks ${name} ${entry.version} after the update, not ${to}.`);
  }
  if (reference) {
    const references = [entry.dist?.reference, entry.source?.reference].filter(Boolean);
    if (references.length === 0 || references.some((value) => value !== reference)) {
      throw new Error(
        `${COMPOSER_LOCK} locks ${name} at reference ${references.join(" / ") || "(none)"}, not ${reference}.`,
      );
    }
  }
}

// The paths `git status --porcelain` lists (a rename's new path). The
// output may come trimmed, so the status column is one or two characters.
function changedPaths(status) {
  return status
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) =>
      line
        .replace(/^[ MTADRCU?!]{1,2} /u, "")
        .split(" -> ")
        .at(-1),
    );
}

function normaliseVersion(version) {
  return typeof version === "string" ? version.replace(/^v(?=\d)/u, "") : version;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function readLockFile(root) {
  try {
    return JSON.parse(await readFile(join(root, COMPOSER_LOCK), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function lockedPackage(lock, name) {
  return [...(lock.packages ?? []), ...(lock["packages-dev"] ?? [])].find(
    (pkg) => pkg.name === name,
  );
}

// `0.4.6`, or `dev-main (b18a61aa565a)` for a branch.
function describePackage(pkg) {
  if (!pkg) return "(not locked)";
  const reference = pkg.source?.reference ?? pkg.dist?.reference;
  return pkg.version.startsWith("dev-") && reference
    ? `${pkg.version} (${reference.slice(0, 12)})`
    : pkg.version;
}

function bumpVersion(version, kind) {
  const [major, minor, patch] = version
    .split(/[+-]/)[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

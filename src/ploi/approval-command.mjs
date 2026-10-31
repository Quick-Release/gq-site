// The package approval lookup adapter: runs gq-support's read-only Operator
// CLI, exactly as its reviewed `operator` script does, from a gq-support
// checkout clean at OPERATOR_COMMIT:
//
//   <node> --import <checkout>/worker/node_modules/alchemy/bin/register-oxc.js \
//     scripts/operator.ts composer-approval <slot> <release-id> <artifact-dir> <prepare|deploy> \
//     --stage <stage> --account-id <id> --database-id <id> --ledger-database-id <id>
//
// in <checkout>/worker. Nothing about the command is configurable: no
// command, argument or entry point comes from configuration.
//
// Trust comes only from the Operator's machine, never from a Site or the
// environment gq runs in (which `gq sigillo run` and a Site's own tools can
// set): the configuration is APPROVAL_CONFIG_FILE under the home directory
// of the user running gq, as the system's user database has it
// (os.userInfo), never HOME, XDG_CONFIG_HOME, a Site's .env or Sigillo
// values. An environment that tries to select another configuration
// (APPROVAL_CONFIG_VARIABLE) is refused, not ignored. The configuration
// names absolute `node` and `git` executables and the checkout, all outside
// the Site, and binds each project to its approval target and the releases
// it may look up.
//
// Before each lookup, with that `git` and a fixed environment (no PATH a
// Site could shadow, no user or system git configuration, no hooks or
// fsmonitor): the checkout's HEAD must be OPERATOR_COMMIT, its work tree
// clean (untracked files count), no file flagged assume-unchanged or
// skip-worktree, every tracked file's bytes equal to the pinned tree's blobs
// (hashed here, whatever the index says), and worker/scripts/operator.ts a
// tracked regular file. Its dependencies (node_modules, ignored by git) are a
// trusted prerequisite the Operator installs with
// `pnpm install --frozen-lockfile` at that commit: gq checks pnpm recorded
// installing exactly the tracked pnpm-lock.yaml, that the loader resolves
// inside the checkout's node_modules, and that no other node_modules could
// shadow the entry point's imports. That is evidence of the install, not a
// verification of every installed file.
//
// The command runs without a shell, in its own process group, bounded in
// time and in stdout and stderr (bounded-process.mjs), with a fixed
// environment: HOME and the user from the user database, PATH from the
// configured node's directory and /usr/bin:/bin, a fixed locale and TMPDIR.
// Its logins are the Operator's own Wrangler and gh ones under that HOME; gq
// holds no key or secret. No saved record is ever accepted: every lookup
// runs the command. Refusals are fixed messages naming no configured path
// and carrying no command output.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";

import { z } from "zod";

import { runBounded } from "./bounded-process.mjs";
import { unconfiguredApprovals } from "./package-expectations.mjs";
import { parseStrictJson } from "./strict-json.mjs";
import { isolatedGitEnvironment } from "./trusted-git.mjs";

// The reviewed gq-support commit whose Operator CLI gq trusts: gq-support PR
// 154's merge. A new pin is a reviewed gq-site change.
export const OPERATOR_COMMIT = "29de3c7ec66ad96d6726bae20766c2acc7fcc312";
// That commit's tree: what is compared, whatever replacement or graft could
// make "HEAD" or the commit name another tree.
export const OPERATOR_TREE = "cf7691365b81673b35a62f6f54635cc5cd329364";
// The pinned commit's `operator` script, relative to its checkout.
export const OPERATOR_DIRECTORY = "worker";
export const OPERATOR_ENTRY = "worker/scripts/operator.ts";
export const OPERATOR_LOADER = "worker/node_modules/alchemy/bin/register-oxc.js";
// Where the pinned commit's pnpm workspace installs dependencies: the root
// and its two packages (pnpm-workspace.yaml: plugin/app, worker).
export const DEPENDENCY_DIRECTORIES = Object.freeze([
  "node_modules/",
  "worker/node_modules/",
  "plugin/app/node_modules/",
]);
export const APPROVAL_CONFIG_FILE = ".config/gq/support-approval.json";
export const APPROVAL_CONFIG_VARIABLE = "GQ_SUPPORT_APPROVAL_CONFIG";
// The one package the Operator CLI approves.
export const OPERATOR_PACKAGE = "getquick/gq-support";
export const APPROVAL_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;

// A string with no surrounding whitespace: compared exactly, never trimmed.
const exact = z.string().regex(/^\S(?:.*\S)?$/u, "must not be empty or padded");
const absolute = exact.refine((path) => isAbsolute(path), "must be an absolute path");
const configSchema = z.strictObject({
  schemaVersion: z.literal(2),
  node: absolute,
  git: absolute,
  checkout: absolute,
  targets: z.record(
    exact,
    z.strictObject({
      stage: exact,
      slot: exact,
      accountId: exact,
      databaseId: exact,
      ledgerDatabaseId: exact,
      // gq-support version -> the approved release it is, and where its
      // downloaded release artifact is.
      releases: z.record(
        exact,
        z.strictObject({ releaseId: z.number().int().positive(), artifactDir: absolute }),
      ),
    }),
  ),
});

// The approvals adapter this machine configures for `project` (whose Site is
// at `projectRoot`): unconfiguredApprovals without a configuration file,
// else a command adapter, or one that refuses every lookup when the
// configuration can't be trusted. `env` is only checked for an attempt to
// select another configuration; `homedir` and `username` default to the
// user database's.
export function approvalsFor({
  env,
  project,
  projectRoot,
  operatorCommit = OPERATOR_COMMIT,
  operatorTree = OPERATOR_TREE,
  homedir = userInfo().homedir,
  username = userInfo().username,
}) {
  if (env[APPROVAL_CONFIG_VARIABLE] !== undefined) {
    return refusing(
      `${APPROVAL_CONFIG_VARIABLE} is set, but only ~/${APPROVAL_CONFIG_FILE} of the user running gq configures the lookup`,
    );
  }
  if (!homedir || !isAbsolute(homedir)) return unconfiguredApprovals;
  const path = join(homedir, APPROVAL_CONFIG_FILE);
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return unconfiguredApprovals;
    return refusing("the approval configuration can't be read");
  }
  const site = realpathOrNull(projectRoot);
  if (!site || inside(realpathOrNull(path) ?? path, site)) {
    return refusing(
      "the approval configuration is inside the Site, which can't configure its own approvals",
    );
  }
  let config;
  try {
    config = configSchema.parse(parseStrictJson(source));
  } catch {
    return refusing("the approval configuration isn't valid");
  }
  const target = Object.hasOwn(config.targets, project) ? config.targets[project] : null;
  if (!target) {
    return refusing(`the approval configuration binds no approval target for ${project}`);
  }
  for (const [name, configured] of [
    ["node", config.node],
    ["git", config.git],
    ["checkout", config.checkout],
    ...Object.values(target.releases).map(({ artifactDir }) => ["artifact directory", artifactDir]),
  ]) {
    const real = realpathOrNull(configured);
    if (!real) return refusing(`the approval configuration's ${name} doesn't exist`);
    if (inside(real, site)) {
      return refusing(`the approval configuration's ${name} is inside the Site`);
    }
  }
  return createCommandApprovals({
    node: config.node,
    git: config.git,
    checkout: config.checkout,
    target,
    operatorCommit,
    operatorTree,
    homedir,
    username,
  });
}

// A lookup adapter running the pinned Operator CLI from `checkout` for
// `target`, with the `node` and `git` executables given.
export function createCommandApprovals({
  node,
  git,
  checkout,
  target,
  operatorCommit = OPERATOR_COMMIT,
  operatorTree = OPERATOR_TREE,
  homedir,
  username,
  timeoutMs = APPROVAL_TIMEOUT_MS,
}) {
  const env = {
    HOME: homedir,
    USER: username,
    LOGNAME: username,
    PATH: `${dirname(node)}:/usr/bin:/bin`,
    LANG: "C.UTF-8",
    TMPDIR: "/tmp",
  };
  return {
    async lookup({ phase, stage, slot, releaseId, package: pkg }) {
      const label = `The approval lookup for ${pkg.name} ${pkg.version} (release ${releaseId}, phase ${phase})`;
      if (!Number.isSafeInteger(releaseId) || releaseId < 1) {
        throw new Error(`${label} needs the approved release's ID.`);
      }
      if (pkg.name !== OPERATOR_PACKAGE) {
        throw new Error(`${label} refused: the Operator CLI approves only ${OPERATOR_PACKAGE}.`);
      }
      const release = Object.hasOwn(target.releases, pkg.version)
        ? target.releases[pkg.version]
        : null;
      if (!release || release.releaseId !== releaseId) {
        throw new Error(
          `${label} refused: this machine binds ${release ? `release ${release.releaseId}` : "no release"} for ${pkg.name} ${pkg.version}.`,
        );
      }
      if (stage !== target.stage || slot !== target.slot) {
        throw new Error(
          `${label} refused: this Site names ${stage} slot ${slot}, but this machine binds ${target.stage} slot ${target.slot} for it.`,
        );
      }
      const loader = await requireReviewedCheckout({
        git,
        checkout,
        commit: operatorCommit,
        tree: operatorTree,
        homedir,
        label,
      });
      let result;
      try {
        result = await runBounded(
          node,
          [
            "--import",
            loader,
            "scripts/operator.ts",
            "composer-approval",
            target.slot,
            String(releaseId),
            release.artifactDir,
            phase,
            "--stage",
            target.stage,
            "--account-id",
            target.accountId,
            "--database-id",
            target.databaseId,
            "--ledger-database-id",
            target.ledgerDatabaseId,
          ],
          {
            cwd: join(checkout, OPERATOR_DIRECTORY),
            env,
            timeoutMs,
            maxBytes: MAX_OUTPUT_BYTES,
          },
        );
      } catch (error) {
        // runBounded's messages are fixed ("timed out"): no command output.
        throw new Error(`${label} ${error.message}.`, { cause: error });
      }
      if (result.code !== 0) throw new Error(`${label} refused (exit ${result.code}).`);
      let record;
      try {
        record = parseStrictJson(result.stdout);
      } catch {
        throw new Error(`${label} didn't print one JSON record.`);
      }
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        throw new Error(`${label} didn't print one JSON record.`);
      }
      return record;
    },
  };
}

// Refuses unless `checkout` is a git work tree at exactly `commit`, clean,
// with the Operator entry point a tracked regular file and its dependencies
// installed from the tracked lockfile. Resolves to the loader's real path.
async function requireReviewedCheckout({
  git,
  checkout,
  commit,
  tree: pinnedTree,
  homedir,
  label,
}) {
  const refuse = (what) => new Error(`${label} refused: the gq-support checkout ${what}.`);
  const run = async (args) => {
    const result = await runBounded(
      git,
      [
        // No replacement object (also GIT_NO_REPLACE_OBJECTS in the
        // environment; grafts are refused below), no fsmonitor or hooks.
        "--no-replace-objects",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        checkout,
        ...args,
      ],
      {
        env: isolatedGitEnvironment({ homedir, path: "/usr/bin:/bin" }),
        timeoutMs: GIT_TIMEOUT_MS,
        maxBytes: 16 * 1024 * 1024,
      },
    );
    if (result.code !== 0) throw new Error("git failed");
    return result.stdout;
  };
  let head;
  let headTree;
  let replacements;
  let gitDir;
  let status;
  let flags;
  let tree;
  let ignored;
  try {
    head = (await run(["rev-parse", "HEAD"])).trim();
    headTree = (await run(["rev-parse", "HEAD^{tree}"])).trim();
    replacements = await run(["for-each-ref", "refs/replace"]);
    gitDir = (await run(["rev-parse", "--absolute-git-dir"])).trim();
    status = await run(["status", "--porcelain", "--untracked-files=normal"]);
    flags = await run(["ls-files", "-v"]);
    tree = await run(["ls-tree", "-r", "-z", pinnedTree]);
    ignored = await run([
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ]);
  } catch {
    head = null;
  }
  // Neither a replacement object nor a graft may stand in for the pin.
  if (head && (replacements !== "" || existsSync(join(gitDir, "info/grafts")))) {
    throw refuse("has replacement objects or grafts, which could stand in for the reviewed commit");
  }
  if (head !== commit || headTree !== pinnedTree || status !== "") {
    throw refuse(`isn't clean at the reviewed commit ${commit.slice(0, 12)}`);
  }
  // `git status` doesn't look at files flagged assume-unchanged (a lowercase
  // tag) or skip-worktree (S): no index flag but H is accepted.
  if (flags.split("\n").some((line) => line !== "" && !line.startsWith("H "))) {
    throw refuse("has files git status wouldn't check (assume-unchanged or skip-worktree)");
  }
  // And every file of the pinned tree is compared, byte for byte, with its
  // blob, hashed here: whatever git's index, configuration, attributes or
  // filters say (a smudged or converted file differs, and refuses).
  const entries = tree
    .split("\0")
    .filter(Boolean)
    .map((line) => /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.+)$/su.exec(line));
  if (entries.some((match) => !match)) throw refuse("has a tree gq can't read");
  for (const [, mode, type, blob, path] of entries) {
    const full = join(checkout, path);
    let bytes;
    try {
      if (type !== "blob") throw new Error("not a file");
      if (mode === "120000") bytes = Buffer.from(readlinkSync(full));
      else if (mode === "100644" || mode === "100755") {
        if (!lstatSync(full).isFile()) throw new Error("not a regular file");
        bytes = readFileSync(full);
      } else throw new Error("unexpected mode");
    } catch {
      throw refuse(`doesn't hold ${path} as the reviewed commit has it`);
    }
    if (gitBlob(bytes) !== blob) {
      throw refuse(`doesn't hold ${path} as the reviewed commit has it`);
    }
  }
  const entry = entries.find(([, , , , path]) => path === OPERATOR_ENTRY);
  if (!entry || !["100644", "100755"].includes(entry[1])) {
    throw refuse(`doesn't track ${OPERATOR_ENTRY} as a regular file`);
  }
  // Ignored dependencies are a trusted prerequisite, but only where pnpm
  // installs them: a node_modules elsewhere could shadow the entry point's
  // imports.
  const strays = ignored
    .split("\0")
    .filter(Boolean)
    .filter(
      (path) => /(^|\/)node_modules(\/|$)/u.test(path) && !DEPENDENCY_DIRECTORIES.includes(path),
    );
  if (strays.length > 0) {
    throw refuse("has node_modules outside its workspace dependency directories");
  }
  let installed;
  try {
    installed = readFileSync(join(checkout, "node_modules/.pnpm/lock.yaml")).equals(
      readFileSync(join(checkout, "pnpm-lock.yaml")),
    );
  } catch {
    installed = false;
  }
  if (!installed) throw refuse("isn't installed from its pnpm-lock.yaml");
  const loader = realpathOrNull(join(checkout, OPERATOR_LOADER));
  const modules = realpathOrNull(join(checkout, "node_modules"));
  if (!loader || !modules || !inside(loader, modules)) {
    throw refuse("has no installed Operator loader");
  }
  return loader;
}

// The git blob id of `bytes`.
function gitBlob(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function refusing(reason) {
  return {
    async lookup() {
      throw new Error(
        `The package approval lookup can't be trusted: ${reason}; a guarded package refuses.`,
      );
    },
  };
}

function realpathOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function inside(path, root) {
  const rest = relative(root, path);
  return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
}

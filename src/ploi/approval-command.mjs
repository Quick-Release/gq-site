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
// clean (untracked files count), and worker/scripts/operator.ts a tracked
// regular file. Its dependencies (node_modules, ignored by git) are a trusted
// prerequisite the Operator installs with `pnpm install --frozen-lockfile`
// at that commit: gq checks pnpm recorded installing exactly the tracked
// pnpm-lock.yaml and that the loader resolves inside the checkout's
// node_modules, which is evidence of the install, not a verification of
// every installed file.
//
// The command runs without a shell, in its own process group, bounded in
// time and in stdout and stderr (bounded-process.mjs), with a fixed
// environment: HOME and the user from the user database, PATH from the
// configured node's directory and /usr/bin:/bin, a fixed locale and TMPDIR.
// Its logins are the Operator's own Wrangler and gh ones under that HOME; gq
// holds no key or secret. No saved record is ever accepted: every lookup
// runs the command. Refusals are fixed messages naming no configured path
// and carrying no command output.
import { readFileSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";

import { z } from "zod";

import { runBounded } from "./bounded-process.mjs";
import { unconfiguredApprovals } from "./package-expectations.mjs";
import { parseStrictJson } from "./strict-json.mjs";

// The reviewed gq-support commit whose Operator CLI gq trusts: gq-support PR
// 154's merge. A new pin is a reviewed gq-site change.
export const OPERATOR_COMMIT = "29de3c7ec66ad96d6726bae20766c2acc7fcc312";
// The pinned commit's `operator` script, relative to its checkout.
export const OPERATOR_DIRECTORY = "worker";
export const OPERATOR_ENTRY = "worker/scripts/operator.ts";
export const OPERATOR_LOADER = "worker/node_modules/alchemy/bin/register-oxc.js";
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
async function requireReviewedCheckout({ git, checkout, commit, homedir, label }) {
  const refuse = (what) => new Error(`${label} refused: the gq-support checkout ${what}.`);
  const run = async (args) => {
    const result = await runBounded(
      git,
      ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", checkout, ...args],
      {
        env: {
          HOME: homedir,
          PATH: "/usr/bin:/bin",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          LANG: "C.UTF-8",
        },
        timeoutMs: GIT_TIMEOUT_MS,
        maxBytes: 1024 * 1024,
      },
    );
    if (result.code !== 0) throw new Error("git failed");
    return result.stdout;
  };
  let head;
  let status;
  let entry;
  try {
    head = (await run(["rev-parse", "HEAD"])).trim();
    status = await run(["status", "--porcelain", "--untracked-files=normal"]);
    entry = await run(["ls-files", "--stage", "--", OPERATOR_ENTRY]);
  } catch {
    head = null;
  }
  if (head !== commit || status !== "") {
    throw refuse(`isn't clean at the reviewed commit ${commit.slice(0, 12)}`);
  }
  if (!/^100(644|755) [0-9a-f]{40} 0\t/u.test(entry)) {
    throw refuse(`doesn't track ${OPERATOR_ENTRY} as a regular file`);
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

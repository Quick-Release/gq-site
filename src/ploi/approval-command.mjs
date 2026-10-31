// The package approval lookup adapter: runs gq-support's read-only Operator
// CLI from a reviewed gq-support checkout, with the Operator's own
// Cloudflare and GitHub logins:
//
//   <command> [<args>...] composer-approval <slot> <release-id> <artifact-dir> <prepare|deploy>
//     --stage <stage> --account-id <id> --database-id <id> --ledger-database-id <id>
//
// Trust comes only from the Operator's machine, never from a Site: only
// bin/gq.mjs wires this adapter in, from its own process environment, and
// the configuration is the file GQ_SUPPORT_APPROVAL_CONFIG names (an
// absolute path), else APPROVAL_CONFIG_FILE under XDG_CONFIG_HOME (else
// HOME/.config); outside the Site, never a Site's .env, ops.env, Sigillo
// values or gq.ops.json. It names an absolute command and the gq-support
// checkout it runs in, both outside the Site; the checkout must be clean at
// OPERATOR_COMMIT, the reviewed gq-support commit. It binds each project to
// its approval target: stage, slot, Cloudflare account, main and ledger
// database IDs, and for each gq-support version it may look up, the approved
// release's ID and its downloaded artifact directory. A lookup refuses unless
// the Site's reviewed gq.ops.json deployment.approval names that same stage
// and slot, and the request names that version and release. No saved record
// is ever accepted: every lookup runs the CLI. Its logins are the Operator's
// own Wrangler and gh ones; gq holds no key or secret for it. Refusals name
// no path from the configuration.
//
// The command runs without a shell, in its own process group, for at most
// APPROVAL_TIMEOUT_MS and MAX_OUTPUT_BYTES of output (bounded-process.mjs),
// with only the environment its logins need: no Composer, Ploi, R2 or other
// deploy credentials. Every refusal is a fixed message: none carries the
// command's own output. The caller checks the record itself
// (package-expectations.mjs checkApprovalRecord).
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { z } from "zod";

import { runBounded } from "./bounded-process.mjs";
import { unconfiguredApprovals } from "./package-expectations.mjs";
import { parseStrictJson } from "./strict-json.mjs";

// The reviewed gq-support commit whose Operator CLI gq trusts: gq-support PR
// 154's merge. A new pin is a reviewed gq-site change.
export const OPERATOR_COMMIT = "29de3c7ec66ad96d6726bae20766c2acc7fcc312";
export const APPROVAL_CONFIG_FILE = "gq/support-approval.json";
export const APPROVAL_CONFIG_VARIABLE = "GQ_SUPPORT_APPROVAL_CONFIG";
// The one package the Operator CLI approves.
export const OPERATOR_PACKAGE = "getquick/gq-support";
export const APPROVAL_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
// What the CLI's Wrangler and gh logins and its runtime need, and nothing
// else: never a Site's or a deploy's credentials.
export const CHILD_ENVIRONMENT = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

const text = z.string().trim().min(1);
const absolute = text.refine((path) => isAbsolute(path), "must be an absolute path");
const configSchema = z.strictObject({
  schemaVersion: z.literal(1),
  command: absolute,
  args: z.array(z.string()).default([]),
  checkout: absolute,
  targets: z.record(
    text,
    z.strictObject({
      stage: text,
      slot: text,
      accountId: text,
      databaseId: text,
      ledgerDatabaseId: text,
      // gq-support version -> the approved release it is, and where its
      // downloaded release artifact is.
      releases: z.record(
        text,
        z.strictObject({ releaseId: z.number().int().positive(), artifactDir: absolute }),
      ),
    }),
  ),
});

// The approvals adapter this machine configures for `project` (whose Site is
// at `projectRoot`), from the invoking process's environment `env`:
// unconfiguredApprovals without a configuration file, else a command
// adapter, or one that refuses every lookup when the configuration can't be
// trusted.
export function approvalsFor({ env, project, projectRoot, operatorCommit = OPERATOR_COMMIT }) {
  const explicit = env[APPROVAL_CONFIG_VARIABLE]?.trim();
  if (explicit && !isAbsolute(explicit)) {
    return refusing(`${APPROVAL_CONFIG_VARIABLE} isn't an absolute path`);
  }
  const base = env.XDG_CONFIG_HOME?.trim() || (env.HOME?.trim() && join(env.HOME, ".config"));
  const path = explicit || (base && isAbsolute(base) ? join(base, APPROVAL_CONFIG_FILE) : null);
  if (!path) return unconfiguredApprovals;
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" && !explicit) return unconfiguredApprovals;
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
  if (!target)
    return refusing(`the approval configuration binds no approval target for ${project}`);
  for (const [name, configured] of [
    ["command", config.command],
    ["checkout", config.checkout],
    ...Object.values(target.releases).map(({ artifactDir }) => ["artifact directory", artifactDir]),
  ]) {
    const real = realpathOrNull(configured);
    if (!real) return refusing(`the approval configuration's ${name} doesn't exist`);
    if (inside(real, site))
      return refusing(`the approval configuration's ${name} is inside the Site`);
  }
  return createCommandApprovals({
    command: config.command,
    args: config.args,
    checkout: config.checkout,
    target,
    operatorCommit,
    env: childEnvironment(env),
  });
}

// A lookup adapter running the Operator CLI from `checkout` for `target`.
export function createCommandApprovals({
  command,
  args = [],
  checkout,
  target,
  operatorCommit = OPERATOR_COMMIT,
  env,
  timeoutMs = APPROVAL_TIMEOUT_MS,
}) {
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
      await requireReviewedCheckout(checkout, operatorCommit, env, label);
      let result;
      try {
        result = await runBounded(
          command,
          [
            ...args,
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
          { cwd: checkout, env, timeoutMs, maxBytes: MAX_OUTPUT_BYTES },
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

// Refuses unless `checkout` is a git work tree at exactly `commit` with no
// tracked or untracked change (ignored files, such as dependencies, aside).
async function requireReviewedCheckout(checkout, commit, env, label) {
  const git = async (args) => {
    const result = await runBounded("git", ["-C", checkout, ...args], {
      env,
      timeoutMs: GIT_TIMEOUT_MS,
      maxBytes: 1024 * 1024,
    });
    if (result.code !== 0) throw new Error("git failed");
    return result.stdout;
  };
  let head;
  let status;
  try {
    head = (await git(["rev-parse", "HEAD"])).trim();
    status = await git(["status", "--porcelain", "--untracked-files=normal"]);
  } catch {
    head = null;
  }
  if (head !== commit || status !== "") {
    throw new Error(
      `${label} refused: the gq-support checkout isn't clean at the reviewed commit ${commit.slice(0, 12)}.`,
    );
  }
}

function childEnvironment(env) {
  return Object.fromEntries(
    CHILD_ENVIRONMENT.filter((name) => typeof env[name] === "string").map((name) => [
      name,
      env[name],
    ]),
  );
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

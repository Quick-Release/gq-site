// The package approval lookup adapter: runs gq-support's Operator CLI
//
//   <command> [<args>...] composer-approval <slot> <release-id> <artifact-dir> <prepare|deploy>
//     --stage <stage> --account-id <id> --database-id <id> --ledger-database-id <id>
//
// with the Operator's own Cloudflare and GitHub logins (read-only; see
// docs/reference/package-expectations.md). No shell: each value is one
// argument. The lookup takes at most `timeoutMs`, and its output at most
// MAX_OUTPUT_BYTES. A non-zero exit, output that isn't exactly one JSON
// object, or a record for another stage or slot rejects; the caller checks
// the record itself (package-expectations.mjs checkApprovalRecord). Nothing
// the caller types is ever taken as an approval.
//
// Configuration: the Site names its own approval slot and stage in
// gq.ops.json (deployment.approval), a reviewed change. The Operator's machine
// names the command and the approval service's IDs in the environment:
// GQ_SUPPORT_APPROVAL_COMMAND (an executable path; without it no lookup is
// configured and every guarded package refuses), GQ_SUPPORT_APPROVAL_ARGS (a
// JSON array of arguments before `composer-approval`, optional),
// GQ_SUPPORT_APPROVAL_CWD (optional), GQ_SUPPORT_ACCOUNT_ID,
// GQ_SUPPORT_DATABASE_ID, GQ_SUPPORT_LEDGER_DATABASE_ID and
// GQ_SUPPORT_ARTIFACT_DIR (the downloaded release artifact).
import { unconfiguredApprovals } from "./package-expectations.mjs";

export const APPROVAL_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const REQUIRED = {
  accountId: "GQ_SUPPORT_ACCOUNT_ID",
  databaseId: "GQ_SUPPORT_DATABASE_ID",
  ledgerDatabaseId: "GQ_SUPPORT_LEDGER_DATABASE_ID",
  artifactDir: "GQ_SUPPORT_ARTIFACT_DIR",
};

// The approvals adapter for `ops` (a validated manifest) and `settings` (the
// layered environment): unconfiguredApprovals without
// GQ_SUPPORT_APPROVAL_COMMAND, else a command adapter that refuses every
// lookup while any of its settings is missing.
export function approvalsFromSettings(ops, settings, { exec, env, resolvePath = (path) => path }) {
  const command = settings.GQ_SUPPORT_APPROVAL_COMMAND?.trim();
  if (!command) return unconfiguredApprovals;
  const missing = [];
  const approval = ops.deployment?.approval;
  if (!approval) missing.push("gq.ops.json deployment.approval");
  const values = {};
  for (const [key, name] of Object.entries(REQUIRED)) {
    values[key] = settings[name]?.trim();
    if (!values[key]) missing.push(name);
  }
  let args = [];
  if (settings.GQ_SUPPORT_APPROVAL_ARGS?.trim()) {
    try {
      args = JSON.parse(settings.GQ_SUPPORT_APPROVAL_ARGS);
    } catch {
      args = null;
    }
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
      missing.push("GQ_SUPPORT_APPROVAL_ARGS as a JSON array of strings");
    }
  }
  if (missing.length > 0) {
    return {
      async lookup() {
        throw new Error(
          `The package approval lookup is configured but lacks ${missing.join(", ")}; a guarded package refuses.`,
        );
      },
    };
  }
  const cwd = settings.GQ_SUPPORT_APPROVAL_CWD?.trim();
  return createCommandApprovals({
    command: resolvePath(command),
    args,
    cwd: cwd ? resolvePath(cwd) : undefined,
    slot: approval.slot,
    stage: approval.stage,
    ...values,
    artifactDir: resolvePath(values.artifactDir),
    exec,
    env,
  });
}

// A lookup adapter that runs the Operator CLI (see the top of this file).
export function createCommandApprovals({
  command,
  args = [],
  cwd,
  slot,
  stage,
  accountId,
  databaseId,
  ledgerDatabaseId,
  artifactDir,
  exec,
  env,
  timeoutMs = APPROVAL_TIMEOUT_MS,
}) {
  return {
    async lookup({ phase, releaseId, package: pkg }) {
      const label = `The approval lookup for ${pkg.name} ${pkg.version} (release ${releaseId}, phase ${phase})`;
      if (!Number.isSafeInteger(releaseId) || releaseId < 1) {
        throw new Error(`${label} needs the approved release's ID.`);
      }
      const argv = [
        ...args,
        "composer-approval",
        slot,
        String(releaseId),
        artifactDir,
        phase,
        "--stage",
        stage,
        "--account-id",
        accountId,
        "--database-id",
        databaseId,
        "--ledger-database-id",
        ledgerDatabaseId,
      ];
      let result;
      try {
        result = await exec(command, argv, { cwd, env, timeout: timeoutMs });
      } catch (error) {
        throw new Error(`${label} couldn't run: ${error.message}`, { cause: error });
      }
      if (result.code !== 0) {
        const detail = tail(result.stderr) || `exit ${result.code}`;
        throw new Error(`${label} refused: ${detail}`);
      }
      if (Buffer.byteLength(result.stdout ?? "") > MAX_OUTPUT_BYTES) {
        throw new Error(`${label} printed more than ${MAX_OUTPUT_BYTES} bytes.`);
      }
      let record;
      try {
        record = JSON.parse(result.stdout);
      } catch {
        throw new Error(`${label} didn't print one JSON record.`);
      }
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        throw new Error(`${label} didn't print one JSON record.`);
      }
      if (record.stage !== stage || record.slot !== slot) {
        throw new Error(
          `${label} returned a record for ${record.stage}/${record.slot}, not ${stage}/${slot}.`,
        );
      }
      return record;
    },
  };
}

// The last lines of a refusal, bounded.
function tail(text = "") {
  return text.trim().split("\n").slice(-5).join(" ").slice(-500);
}

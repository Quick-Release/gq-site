// The package approval lookup adapter: gq-support's Operator CLI run with
// exact argv, no shell, bounded time and output, and every failure a refusal.
import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_OUTPUT_BYTES,
  approvalsFromSettings,
  createCommandApprovals,
} from "../../src/ploi/approval-command.mjs";
import { unconfiguredApprovals } from "../../src/ploi/package-expectations.mjs";
import { recordingExec } from "../support/fixture-site.mjs";

const CONFIG = Object.freeze({
  command: "/opt/gq-support/operator",
  args: ["--filter", "gq-support-worker", "operator"],
  cwd: "/opt/gq-support",
  slot: "nomia/production",
  stage: "prod",
  accountId: "account-1",
  databaseId: "db-main",
  ledgerDatabaseId: "db-ledger",
  artifactDir: "/data/artifacts/gq-support-0.1.11",
});
const REQUEST = Object.freeze({
  phase: "deploy",
  releaseId: 11,
  package: { name: "getquick/gq-support", version: "0.1.11" },
});
const RECORD = Object.freeze({
  schema: "gq-support.composer-approval/v1",
  stage: "prod",
  slot: "nomia/production",
});

function adapter(respond, overrides = {}) {
  const exec = recordingExec(respond);
  return {
    exec,
    approvals: createCommandApprovals({ ...CONFIG, exec, env: { PATH: "/usr/bin" }, ...overrides }),
  };
}

test("the adapter runs the Operator CLI with exact argv and returns its one JSON record", async () => {
  const { exec, approvals } = adapter(() => ({ stdout: `${JSON.stringify(RECORD)}\n` }));

  assert.deepEqual(await approvals.lookup(REQUEST), RECORD);
  assert.equal(exec.calls.length, 1);
  const [call] = exec.calls;
  assert.equal(call.command, "/opt/gq-support/operator");
  assert.deepEqual(call.args, [
    "--filter",
    "gq-support-worker",
    "operator",
    "composer-approval",
    "nomia/production",
    "11",
    "/data/artifacts/gq-support-0.1.11",
    "deploy",
    "--stage",
    "prod",
    "--account-id",
    "account-1",
    "--database-id",
    "db-main",
    "--ledger-database-id",
    "db-ledger",
  ]);
  assert.equal(call.cwd, "/opt/gq-support");
  assert.equal(exec.options[0].timeout, 120_000);
});

test("the adapter refuses a non-zero exit, output that isn't one JSON record, too much output, or another slot", async () => {
  const cases = [
    [() => ({ code: 1, stderr: "release 11 is withdrawn\n" }), /refused: release 11 is withdrawn/u],
    [() => ({ stdout: "not json" }), /didn't print one JSON record/u],
    [
      () => ({ stdout: `${JSON.stringify(RECORD)}\n${JSON.stringify(RECORD)}` }),
      /didn't print one JSON record/u,
    ],
    [() => ({ stdout: "[]" }), /didn't print one JSON record/u],
    [() => ({ stdout: " ".repeat(MAX_OUTPUT_BYTES + 1) }), /printed more than/u],
    [
      () => ({ stdout: JSON.stringify({ ...RECORD, slot: "ekis/production" }) }),
      /record for prod\/ekis\/production, not prod\/nomia\/production/u,
    ],
    [
      () => {
        throw new Error("spawn ETIMEDOUT");
      },
      /couldn't run: spawn ETIMEDOUT/u,
    ],
  ];
  for (const [respond, message] of cases) {
    const { approvals } = adapter(respond);
    await assert.rejects(approvals.lookup(REQUEST), message);
  }
  const { exec, approvals } = adapter(() => ({ stdout: JSON.stringify(RECORD) }));
  await assert.rejects(
    approvals.lookup({ ...REQUEST, releaseId: undefined }),
    /needs the approved release's ID/u,
  );
  assert.deepEqual(exec.calls, []);
});

test("without a configured command there is no lookup, and a partial configuration refuses every lookup", async () => {
  const ops = { deployment: { approval: { slot: "nomia/production", stage: "prod" } } };
  const exec = recordingExec(() => ({ stdout: JSON.stringify(RECORD) }));

  assert.equal(approvalsFromSettings(ops, {}, { exec }), unconfiguredApprovals);

  const partial = approvalsFromSettings(
    {},
    { GQ_SUPPORT_APPROVAL_COMMAND: "/opt/op", GQ_SUPPORT_APPROVAL_ARGS: "--filter" },
    { exec },
  );
  await assert.rejects(
    partial.lookup(REQUEST),
    /lacks gq\.ops\.json deployment\.approval, GQ_SUPPORT_ACCOUNT_ID, GQ_SUPPORT_DATABASE_ID, GQ_SUPPORT_LEDGER_DATABASE_ID, GQ_SUPPORT_ARTIFACT_DIR, GQ_SUPPORT_APPROVAL_ARGS as a JSON array of strings; a guarded package refuses/u,
  );
  assert.deepEqual(exec.calls, []);

  const configured = approvalsFromSettings(
    ops,
    {
      GQ_SUPPORT_APPROVAL_COMMAND: "/opt/op",
      GQ_SUPPORT_APPROVAL_ARGS: '["operator"]',
      GQ_SUPPORT_ACCOUNT_ID: "account-1",
      GQ_SUPPORT_DATABASE_ID: "db-main",
      GQ_SUPPORT_LEDGER_DATABASE_ID: "db-ledger",
      GQ_SUPPORT_ARTIFACT_DIR: "artifacts",
    },
    { exec, env: {}, resolvePath: (path) => `/site/${path}`.replace("/site//", "/") },
  );
  assert.deepEqual(await configured.lookup({ ...REQUEST, phase: "prepare" }), RECORD);
  assert.deepEqual(exec.calls[0].args.slice(0, 5), [
    "operator",
    "composer-approval",
    "nomia/production",
    "11",
    "/site/artifacts",
  ]);
  assert.equal(exec.calls[0].args[5], "prepare");
});

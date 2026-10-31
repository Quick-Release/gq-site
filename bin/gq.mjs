#!/usr/bin/env node

import { lookup } from "node:dns/promises";

import { exec } from "../src/exec.mjs";
import { approvalsFor } from "../src/ploi/approval-command.mjs";
import { run } from "../src/run.mjs";

process.exitCode = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  fetch: globalThis.fetch,
  exec,
  lookup,
  // A guarded package's approval: the Operator CLI this machine configures
  // (docs/reference/package-expectations.md), never anything a Site holds;
  // without that configuration, guarded packages refuse.
  approvalLookup: (site) => approvalsFor({ env: process.env, ...site }),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
});

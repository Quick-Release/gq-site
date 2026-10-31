import { setTimeout } from "node:timers/promises";

import { log } from "@clack/prompts";
import { runCli } from "./cli/dispatch.mjs";

// The whole CLI behind one in-process call: every provider request goes
// through `fetch`, every child process through `exec` (except the approval
// lookup's own bounded process, which only the adapter `approvalLookup`
// builds runs), every DNS lookup through `lookup` (node:dns/promises'
// signature), every wait through `clock` ({ now(), sleep(ms) }), the input a
// command reads (git's credential request) from `stdin`, and a guarded
// package's approval record through `approvals` ({ lookup }), else the
// adapter `approvalLookup({ project, projectRoot })` builds for the Site,
// only when a lookup happens, else none, so a guarded package refuses. Every
// value a command needs from its surroundings comes from `cwd` and `env`; no
// command reads the process's own environment or directory. bin/gq.mjs is
// the only caller that wires in the real ones, the Operator CLI's
// approvalLookup among them. Resolves to the process exit code.
export async function run(
  argv,
  {
    cwd,
    env = {},
    fetch = unavailable("fetch"),
    exec = unavailable("exec"),
    lookup = unavailable("lookup"),
    clock = SYSTEM_CLOCK,
    approvals,
    approvalLookup,
    stdin,
    stdout,
    stderr,
    interactive = false,
  } = {},
) {
  if (typeof cwd !== "string" || cwd === "") throw new TypeError("run() requires a cwd.");
  if (typeof stdout?.write !== "function" || typeof stderr?.write !== "function") {
    throw new TypeError("run() requires stdout and stderr streams.");
  }
  const io = {
    stdout,
    stderr,
    out: (line) => stdout.write(`${line}\n`),
    err: (line) => stderr.write(`${line}\n`),
  };

  try {
    return (
      (await runCli(argv, {
        cwd,
        env,
        fetch,
        exec,
        lookup,
        clock,
        approvals,
        approvalLookup,
        stdin,
        io,
        interactive,
      })) ?? 0
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (interactive) log.error(message);
    else io.err(`gq: ${message}`);
    return 1;
  }
}

const SYSTEM_CLOCK = { now: () => Date.now(), sleep: (ms) => setTimeout(ms) };

function unavailable(name) {
  return () => {
    throw new Error(`run() was called without ${name}, and this command needs it.`);
  };
}

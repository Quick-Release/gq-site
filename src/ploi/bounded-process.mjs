// Runs a trusted local command with hard bounds, for the package approval
// lookup: no shell, its own process group (so a descendant can't keep it
// alive or hold its pipes open), at most `timeoutMs`, and at most `maxBytes`
// each of stdout and stderr, streamed and counted as it arrives. When the
// command exits, or a bound is hit, the whole group is killed and its pipes
// closed. stderr is counted and discarded: a refusal never carries the
// command's own output.
//
// Resolves to { code, stdout } (code null when a signal ended it); rejects
// with a fixed message ("timed out", "printed too much", "couldn't start").
import { spawn } from "node:child_process";

// The process groups still running: if gq itself exits or is interrupted or
// terminated meanwhile, they are killed first, then the signal takes its
// usual effect. The handlers are installed only while a group runs.
const groups = new Set();
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

function killGroups() {
  for (const pid of groups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function onSignal(signal) {
  killGroups();
  groups.clear();
  uninstall();
  process.kill(process.pid, signal);
}

function track(pid) {
  if (groups.size === 0) {
    process.on("exit", killGroups);
    for (const signal of SIGNALS) process.on(signal, onSignal);
  }
  groups.add(pid);
}

function untrack(pid) {
  if (groups.delete(pid) && groups.size === 0) uninstall();
}

function uninstall() {
  process.removeListener("exit", killGroups);
  for (const signal of SIGNALS) process.removeListener(signal, onSignal);
}

export async function runBounded(command, args, { cwd, env, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      reject(new Error("couldn't start"));
      return;
    }
    if (child.pid) track(child.pid);
    let settled = false;
    const settle = (finish) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid) untrack(child.pid);
      finish();
    };
    const chunks = [];
    let bytes = 0;
    let failure = null;
    let exitCode = null;
    const killGroup = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is already gone.
      }
    };
    const stop = (reason) => {
      failure ??= reason;
      killGroup();
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => stop("timed out"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) stop("printed too much");
      else chunks.push(chunk);
    });
    let errorBytes = 0;
    child.stderr.on("data", (chunk) => {
      errorBytes += chunk.length;
      if (errorBytes > maxBytes) stop("printed too much");
    });
    child.on("error", () => {
      killGroup();
      settle(() => reject(new Error(failure ?? "couldn't start")));
    });
    // Its descendants go with it, so nothing holds its pipes open after.
    child.on("exit", (code) => {
      exitCode = code;
      killGroup();
    });
    child.on("close", () => {
      settle(() => {
        if (failure) reject(new Error(failure));
        else resolve({ code: exitCode, stdout: Buffer.concat(chunks).toString("utf8") });
      });
    });
  });
}

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

export async function runBounded(command, args, { cwd, env, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      reject(new Error("couldn't start"));
      return;
    }
    let settled = false;
    const settle = (finish) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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

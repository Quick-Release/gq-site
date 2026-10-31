// The bounded subprocess the package approval lookup runs: real processes,
// so a runaway writer, a hung command and a descendant holding the pipe open
// are what they would be in use.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";

import { runBounded } from "../../src/ploi/bounded-process.mjs";
import { temporaryDirectory } from "../support/fixture-site.mjs";

const ENV = { PATH: process.env.PATH };

async function script(source) {
  const directory = await temporaryDirectory();
  const path = join(directory, "script.mjs");
  await writeFile(path, source);
  return { directory, path };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a bounded command resolves to its exit code and stdout, discarding stderr", async () => {
  const { path } = await script(
    'process.stdout.write("{\\"ok\\":true}"); process.stderr.write("secret detail"); process.exitCode = 3;',
  );
  assert.deepEqual(
    await runBounded(process.execPath, [path], { env: ENV, timeoutMs: 10_000, maxBytes: 1024 }),
    { code: 3, stdout: '{"ok":true}' },
  );
});

test("a runaway writer is killed as soon as it passes the output bound", async () => {
  const { path } = await script(
    'const block = "x".repeat(65536); setInterval(() => process.stdout.write(block), 0);',
  );
  const started = Date.now();
  await assert.rejects(
    runBounded(process.execPath, [path], { env: ENV, timeoutMs: 20_000, maxBytes: 1024 * 1024 }),
    /^Error: printed too much$/u,
  );
  assert.ok(Date.now() - started < 10_000, "it didn't wait for the timeout");
});

test("a runaway stderr writer is killed too, its output never kept", async () => {
  const { path } = await script(
    'const block = "secret".repeat(10000); setInterval(() => process.stderr.write(block), 0);',
  );
  await assert.rejects(
    runBounded(process.execPath, [path], { env: ENV, timeoutMs: 20_000, maxBytes: 1024 * 1024 }),
    /^Error: printed too much$/u,
  );
});

test("a hung command and its descendants are killed at the timeout", async () => {
  const { directory, path } = await script(`
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
    writeFileSync(${JSON.stringify("PID")}, String(child.pid));
    setInterval(() => {}, 1000);
  `);
  await assert.rejects(
    runBounded(process.execPath, [path], {
      cwd: directory,
      env: ENV,
      timeoutMs: 1000,
      maxBytes: 1024,
    }),
    /^Error: timed out$/u,
  );
  const grandchild = Number(await readFile(join(directory, "PID"), "utf8"));
  await sleep(100);
  assert.equal(alive(grandchild), false, "the descendant is gone");
});

test("a descendant left holding the pipe doesn't keep the lookup open after the command exits", async () => {
  const { directory, path } = await script(`
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
    writeFileSync(${JSON.stringify("PID")}, String(child.pid));
    process.stdout.write("done");
    process.exit(0);
  `);
  const started = Date.now();
  const result = await runBounded(process.execPath, [path], {
    cwd: directory,
    env: ENV,
    timeoutMs: 20_000,
    maxBytes: 1024,
  });
  assert.deepEqual(result, { code: 0, stdout: "done" });
  assert.ok(Date.now() - started < 10_000, "it didn't wait for the timeout");
  const grandchild = Number(await readFile(join(directory, "PID"), "utf8"));
  await sleep(100);
  assert.equal(alive(grandchild), false, "the descendant is gone");
});

test("a command that can't start rejects with a fixed message", async () => {
  await assert.rejects(
    runBounded("/nonexistent/operator", [], { env: ENV, timeoutMs: 1000, maxBytes: 1024 }),
    /^Error: couldn't start$/u,
  );
});

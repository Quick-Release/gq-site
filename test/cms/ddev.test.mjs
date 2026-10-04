import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  localCmsLinks,
  processGroupAlive,
  readDdevStart,
  signalProcessGroup,
} from "../../src/cms/ddev.mjs";

// Lombardi's ddev.test.mjs: the real gq bin, with a fake `ddev` on PATH, so the
// background worker really detaches, claims its job and reports through it.
const script = fileURLToPath(new URL("../../bin/gq.mjs", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "getquick-background-"));
  const cms = join(root, "apps/cms");
  const bin = join(root, "bin");
  const gate = join(root, "ready-gate");
  const calls = join(root, "calls.log");
  const jobs = [];
  mkdirSync(cms, { recursive: true });
  mkdirSync(bin);
  writeFileSync(
    join(root, "gq.ops.json"),
    JSON.stringify({ schemaVersion: 1, project: "fixture", variant: "content" }),
  );
  writeFileSync(
    join(cms, ".env.example"),
    "WP_ENV='local'\nWP_HOME='https://fallback-admin.ddev.site'\nWP_SITEURL=\"${WP_HOME}/wp\"\n",
  );
  writeFileSync(
    join(bin, "ddev"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'start') {
  console.log('Starting fake DDEV');
  if (process.env.FAKE_FAIL === '1') { console.error('Intentional startup failure'); process.exit(7); }
  const poll = setInterval(() => {
    if (fs.existsSync(process.env.FAKE_GATE)) { clearInterval(poll); console.log('Fake DDEV ready'); }
  }, 20);
} else if (args[0] === 'describe') {
  if (process.env.FAKE_NO_DESCRIBE === '1') process.exit(1);
  // A slow Docker: describe answers only after FAKE_DESCRIBE_DELAY_MS.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_DESCRIBE_DELAY_MS || 0));
  console.log(JSON.stringify({ raw: { primary_url: process.env.FAKE_URL || 'http://fixture-test.ddev.site', dbinfo: { host: 'db', dbname: 'db', username: 'db', password: 'db' } } }));
}
`,
    { mode: 0o755 },
  );
  // A job that already finished may linger as a zombie until launchd or init
  // reaps it; wait only until nothing in its group still runs.
  t.after(async () => {
    for (const pid of jobs) {
      signalProcessGroup(pid, "SIGKILL");
      await waitFor(() => !processGroupAlive(pid));
    }
    rmSync(root, { recursive: true, force: true });
  });
  const environment = (extra = {}) => ({
    ...process.env,
    CI: "",
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_GATE: gate,
    FAKE_CALLS: calls,
    ...extra,
  });
  const track = (result) => {
    const launched = /launched in background \(PID (\d+)\)/u.exec(result.stdout);
    if (launched) jobs.push(Number(launched[1]));
    return result;
  };
  const invokeAsync = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, "cms", ...args], {
        cwd: root,
        env: environment(),
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (status) => resolve(track({ status, stdout, stderr })));
    });
  const invoke = (args, extra = {}) => {
    const result = spawnSync(process.execPath, [script, "cms", ...args], {
      cwd: root,
      env: environment(extra),
      encoding: "utf8",
      timeout: 10_000,
    });
    return track(result);
  };
  const invocations = () =>
    existsSync(calls)
      ? readFileSync(calls, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  return { root, cms, gate, calls, invoke, invokeAsync, invocations };
}

// A detached group whose only member is a zombie: its parent, blocked forever,
// never reaps it. Darwin then answers EPERM to any signal sent to the group.
async function zombieGroup(t) {
  const holder = spawn(
    process.execPath,
    [
      "-e",
      `const child = require("node:child_process").spawn(process.execPath, ["-e", ""], { detached: true, stdio: "ignore" });
child.once("spawn", () => {
  require("node:fs").writeSync(1, child.pid + "\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
});`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  t.after(() => holder.kill("SIGKILL"));
  const pgid = await new Promise((resolve, reject) => {
    holder.stdout.once("data", (chunk) => resolve(Number(String(chunk).trim())));
    holder.once("error", reject);
  });
  await waitFor(
    () =>
      spawnSync("ps", ["-o", "stat=", "-p", String(pgid)], {
        encoding: "utf8",
      }).stdout.trim()[0] === "Z",
  );
  return pgid;
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (predicate()) return;
    await sleep(20);
  }
  assert.fail("Background job did not reach the expected state");
}

test("local CMS links preserve the actual scheme/port without suggesting production or credential-bearing URLs", () => {
  assert.deepEqual(localCmsLinks("https://fixture-admin.ddev.site:8443/old-path?token=ignored"), {
    admin: "https://fixture-admin.ddev.site:8443/wp/wp-admin/",
    graphql: "https://fixture-admin.ddev.site:8443/wp/graphql",
  });
  for (const value of [
    undefined,
    "bad URL",
    "https://admin.example.com",
    "javascript:alert(1)",
    "ftp://localhost",
    "https://user:secret@fixture-admin.ddev.site",
  ]) {
    assert.equal(localCmsLinks(value), null);
  }
});

test("the startup panel falls back to the checked-in local URL when DDEV cannot describe the project", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.cms, ".env"), "WP_HOME='https://admin.example.com'\n");
  const result = f.invoke(["start"], { FAKE_NO_DESCRIBE: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /https:\/\/fallback-admin.ddev.site\/wp\/wp-admin\//u);
  assert.doesNotMatch(result.stdout, /admin.example.com/u);
  writeFileSync(f.gate, "ready");
  await waitFor(() => readDdevStart(f.cms)?.phase === "failed");
});

test("the startup panel waits for a slow DDEV's own URL", async (t) => {
  const f = fixture(t);
  const result = f.invoke(["start"], { FAKE_DESCRIBE_DELAY_MS: "1500" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /http:\/\/fixture-test.ddev.site\/wp\/wp-admin\//u);
  assert.doesNotMatch(result.stdout, /fallback-admin/u);
  writeFileSync(f.gate, "ready");
  await waitFor(() => readDdevStart(f.cms)?.phase === "ready");
});

test("default startup returns before DDEV is ready, persists logs, and marks readiness after env setup", async (t) => {
  const f = fixture(t);
  const result = f.invoke(["start", "--skip-confirmation"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /launched in background/u);
  assert.match(result.stdout, /Fixture CMS/u);
  assert.match(result.stdout, /Open local CMS/u);
  assert.match(result.stdout, /http:\/\/fixture-test.ddev.site\/wp\/wp-admin\//u);
  assert.match(result.stdout, /http:\/\/fixture-test.ddev.site\/wp\/graphql/u);
  assert.match(result.stdout, /URLs are available once ready/u);
  assert.equal(readDdevStart(f.cms).phase, "starting");
  assert.equal(existsSync(join(f.cms, ".env")), false);
  await waitFor(() => f.invocations().some(([action]) => action === "start"));
  writeFileSync(f.gate, "ready");
  await waitFor(() => readDdevStart(f.cms)?.phase === "ready");
  assert.match(
    readFileSync(join(f.cms, ".env"), "utf8"),
    /WP_HOME='http:\/\/fixture-test.ddev.site'/u,
  );
  const log = readFileSync(join(f.cms, ".local-plugins/ddev-start.log"), "utf8");
  assert.match(log, /Fake DDEV ready/u);
  assert.match(log, /WordPress: http:\/\/fixture-test.ddev.site\/wp\/wp-admin/u);
  assert.deepEqual(
    f.invocations().find(([action]) => action === "start"),
    ["start", "--skip-confirmation"],
  );
  assert.match(f.invoke(["status"]).stdout, /Last DDEV startup: ready/u);
});

test("a second start reuses the in-progress job rather than starting DDEV twice", async (t) => {
  const f = fixture(t);
  assert.equal(f.invoke(["start"]).status, 0);
  const initial = readDdevStart(f.cms);
  const second = f.invoke(["start"]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already running/u);
  assert.equal(readDdevStart(f.cms).id, initial.id);
  await waitFor(() => f.invocations().some(([action]) => action === "start"));
  assert.equal(f.invocations().filter(([action]) => action === "start").length, 1);
  writeFileSync(f.gate, "ready");
  await waitFor(() => readDdevStart(f.cms)?.phase === "ready");
});

test("background failure is retained in status and logs instead of reporting ready", async (t) => {
  const f = fixture(t);
  assert.equal(f.invoke(["start"], { FAKE_FAIL: "1" }).status, 0);
  await waitFor(() => readDdevStart(f.cms)?.phase === "failed");
  assert.match(readDdevStart(f.cms).message, /exit 7/u);
  assert.equal(existsSync(join(f.cms, ".env")), false);
  assert.match(
    readFileSync(join(f.cms, ".local-plugins/ddev-start.log"), "utf8"),
    /Intentional startup failure/u,
  );
  assert.equal(f.invoke(["status"]).status, 1);
});

test("foreground mode waits, forwards no internal flags, and propagates failure", (t) => {
  const f = fixture(t);
  writeFileSync(f.gate, "ready");
  const result = f.invoke(["start", "--foreground"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Fake DDEV ready/u);
  assert.equal(readDdevStart(f.cms), null);
  assert.equal(existsSync(join(f.cms, ".env")), true);
  assert.deepEqual(JSON.parse(readFileSync(f.calls, "utf8").split("\n")[0]), ["start"]);
  assert.equal(f.invoke(["start", "--foreground"], { FAKE_FAIL: "1" }).status, 7);
});

test("stop cancels pending background startup before stopping DDEV services", async (t) => {
  const f = fixture(t);
  assert.equal(f.invoke(["start"]).status, 0);
  await waitFor(() => f.invocations().some(([action]) => action === "start"));
  const result = f.invoke(["stop"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readDdevStart(f.cms).phase, "cancelled");
  const calls = f.invocations().filter(([action]) => action !== "describe");
  assert.deepEqual(calls, [["start"], ["stop"]]);
  assert.equal(existsSync(join(f.cms, ".env")), false);
});

test("simultaneous start commands wait for PID publication and reuse a single job", async (t) => {
  const f = fixture(t);
  const results = await Promise.all([f.invokeAsync(["start"]), f.invokeAsync(["start"])]);
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  assert.equal(
    results.filter((result) => result.stdout.includes("launched in background")).length,
    1,
  );
  assert.equal(results.filter((result) => result.stdout.includes("already running")).length, 1);
  await waitFor(() => f.invocations().some(([action]) => action === "start"));
  assert.equal(f.invocations().filter(([action]) => action === "start").length, 1);
  writeFileSync(f.gate, "ready");
  await waitFor(() => readDdevStart(f.cms)?.phase === "ready");
});

test("status reconciles a killed worker to failure rather than reporting starting forever", async (t) => {
  const f = fixture(t);
  assert.equal(f.invoke(["start"]).status, 0);
  await waitFor(() => f.invocations().some(([action]) => action === "start"));
  const { pid } = readDdevStart(f.cms);
  process.kill(-pid, "SIGKILL");
  await waitFor(() => !processGroupAlive(pid));
  const result = f.invoke(["status"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /worker exited before completion/u);
  assert.equal(readDdevStart(f.cms).phase, "failed");
});

test("log-open failure is terminal and does not prevent an immediate retry", async (t) => {
  const f = fixture(t);
  const log = join(f.cms, ".local-plugins/ddev-start.log");
  mkdirSync(log, { recursive: true });
  const failed = f.invoke(["start"]);
  assert.equal(failed.status, 1);
  assert.equal(readDdevStart(f.cms).phase, "failed");
  assert.match(readDdevStart(f.cms).message, /EISDIR/u);
  rmSync(log, { recursive: true });
  const retry = f.invoke(["start"]);
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /launched in background/u);
  writeFileSync(f.gate, "ready");
  await waitFor(() => readDdevStart(f.cms)?.phase === "ready");
});

test("a group of only zombies is not alive, and signalling it does not throw", async (t) => {
  const pgid = await zombieGroup(t);
  if (process.platform === "darwin") assert.throws(() => process.kill(-pgid, 0), { code: "EPERM" });
  assert.equal(processGroupAlive(pgid), false);
  assert.doesNotThrow(() => signalProcessGroup(pgid, "SIGKILL"));
});

test("stop treats a job whose group is only zombies as exited rather than failing", async (t) => {
  const f = fixture(t);
  const pgid = await zombieGroup(t);
  mkdirSync(join(f.cms, ".local-plugins"));
  writeFileSync(
    join(f.cms, ".local-plugins/ddev-start.json"),
    JSON.stringify({
      id: "zombie",
      pid: pgid,
      phase: "starting",
      startedAt: new Date().toISOString(),
    }),
  );
  const result = f.invoke(["stop"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readDdevStart(f.cms).phase, "failed");
  assert.deepEqual(f.invocations(), [["stop"]]);
});

test("a group owned by another user is alive, and signalling it surfaces EPERM", (t) => {
  const uid = process.getuid();
  const owners = new Map();
  for (const line of spawnSync("ps", ["-A", "-o", "pgid=,uid="], { encoding: "utf8" })
    .stdout.trim()
    .split("\n")) {
    const [pgid, owner] = line.trim().split(/\s+/u).map(Number);
    owners.set(pgid, [...(owners.get(pgid) ?? []), owner]);
  }
  const foreign = [...owners].find(
    ([pgid, members]) => pgid > 1 && members.every((owner) => owner !== uid),
  )?.[0];
  if (uid === 0 || foreign === undefined) return t.skip("no group owned only by another user");
  assert.equal(processGroupAlive(foreign), true);
  assert.throws(() => signalProcessGroup(foreign, 0), { code: "EPERM" });
});

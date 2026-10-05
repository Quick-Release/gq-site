// DDEV for the site's local CMS: start, stop and describe, with `start` running in the background by default. A
// detached gq worker (`gq cms start --background-job <id>`) starts DDEV and
// wires apps/cms/.env, recording its phase in .local-plugins/ddev-start.json
// and its output in ddev-start.log, so `gq cms status` can report ready or
// failed long after the launcher returned.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { parseDotenv } from "../dotenv-text.mjs";
import { createReporter } from "../cli/reporter.mjs";
import { syncLocalDesign, withCmsLocalOperation } from "./local-design.mjs";
import { CMS_PATH, commandExists, describeDdev, ensureCmsEnv, localEnvDefaults } from "./local.mjs";

const GQ_BIN = fileURLToPath(new URL("../../bin/gq.mjs", import.meta.url));

export function ddevStartPaths(cmsRoot) {
  const directory = join(cmsRoot, ".local-plugins");
  return {
    directory,
    log: join(directory, "ddev-start.log"),
    status: join(directory, "ddev-start.json"),
  };
}

export function readDdevStart(cmsRoot) {
  try {
    return JSON.parse(readFileSync(ddevStartPaths(cmsRoot).status, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function writeStatus(cmsRoot, status) {
  const paths = ddevStartPaths(cmsRoot);
  mkdirSync(paths.directory, { recursive: true });
  const temporary = `${paths.status}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, paths.status);
}

function reportDdevStart(cmsRoot, id, phase, message) {
  const current = readDdevStart(cmsRoot);
  if (current?.id !== id) throw new Error("This DDEV startup was replaced by a newer job.");
  writeStatus(cmsRoot, {
    ...current,
    pid: process.pid,
    phase,
    ...(phase === "starting" ? {} : { finishedAt: new Date().toISOString() }),
    ...(message ? { message } : {}),
  });
}

async function claimDdevStart(cmsRoot, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = readDdevStart(cmsRoot);
    if (current?.id !== id) throw new Error("This DDEV startup was replaced by a newer job.");
    if (current.pid === process.pid) {
      reportDdevStart(cmsRoot, id, "starting");
      return;
    }
    await sleep(10);
  }
  throw new Error("The background launcher did not publish this worker's PID.");
}

function isStarting(status) {
  if (status?.phase !== "starting") return false;
  // The parent publishes the job before spawning; let its worker claim the PID.
  if (status.pid === null) return Date.now() - Date.parse(status.startedAt) < 30_000;
  if (!Number.isInteger(status.pid) || status.pid <= 0) return false;
  return processGroupAlive(status.pid);
}

// Whether any process in the group still runs, meaning a member that is not a
// zombie or exiting. Signal 0 alone cannot say: a zombie whose parent has not
// reaped it yet (a worker the launcher's exit left to launchd or init, or one
// in a container whose PID 1 is not an init, like the CI sandbox) stays in its
// group. Linux counts it as reachable, while Darwin's killpg1 skips zombies and
// members part-way through exit, and so answers EPERM for a group of only
// those, as it does for another user's group. The process table tells these
// apart.
export function processGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code !== "EPERM") throw error;
  }
  return !nothingRunsInGroup(pgid);
}

// Signals the group, which is a no-op once it has exited, even before its
// zombies are reaped. Another user's group still fails with EPERM.
export function signalProcessGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if (error.code === "ESRCH") return;
    if (error.code === "EPERM" && !processGroupAlive(pgid)) return;
    throw error;
  }
}

function nothingRunsInGroup(pgid) {
  if (process.platform === "darwin") return nothingRunsInDarwinGroup(pgid);
  if (process.platform !== "linux") return false;
  let entries;
  try {
    entries = readdirSync("/proc").filter((entry) => /^\d+$/u.test(entry));
  } catch {
    return false;
  }
  return !entries.some((pid) => {
    let stat;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      return false;
    }
    // "pid (comm) state ppid pgrp …"; comm may itself contain ") ".
    const [state, , pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(pgrp) === pgid && state !== "Z" && state !== "X";
  });
}

// `ps -g` lists every member of the group, any user's, marking zombies "Z" and
// members part-way through exit "E".
function nothingRunsInDarwinGroup(pgid) {
  const { stdout, error } = spawnSync("/bin/ps", ["-o", "stat=", "-g", String(pgid)], {
    encoding: "utf8",
  });
  if (error) return false;
  return !stdout.split("\n").some((stat) => stat.trim() && !/[ZE]/u.test(stat));
}

async function startupOperation(cmsRoot, action) {
  for (let attempt = 0; attempt < 250; attempt++) {
    try {
      return await withCmsLocalOperation(cmsRoot, "ddev-start", action);
    } catch (error) {
      if (error.code !== "CMS_LOCAL_OPERATION_BUSY" || attempt === 249) throw error;
      await sleep(20);
    }
  }
}

// Only reconcile under the launcher mutex, so this cannot overwrite a new job.
function reconcileDdevStart(cmsRoot) {
  const current = readDdevStart(cmsRoot);
  if (current?.phase === "starting" && !isStarting(current)) {
    const failed = {
      ...current,
      phase: "failed",
      finishedAt: new Date().toISOString(),
      message: "Startup worker exited before completion; inspect the startup log.",
    };
    writeStatus(cmsRoot, failed);
    return failed;
  }
  return current;
}

function inspectDdevStart(cmsRoot) {
  return startupOperation(cmsRoot, () => reconcileDdevStart(cmsRoot));
}

function cancelDdevStart(cmsRoot) {
  return startupOperation(cmsRoot, async () => {
    const current = reconcileDdevStart(cmsRoot);
    if (!current || !isStarting(current)) return;
    if (!current.pid) throw new Error("Startup is still launching; retry gq cms stop shortly.");
    signalProcessGroup(current.pid, "SIGTERM");
    for (let attempt = 0; attempt < 100 && processGroupAlive(current.pid); attempt++)
      await sleep(20);
    if (processGroupAlive(current.pid)) signalProcessGroup(current.pid, "SIGKILL");
    writeStatus(cmsRoot, { ...current, phase: "cancelled", finishedAt: new Date().toISOString() });
  });
}

// Starts the worker as its own process group, through run()'s exec.
function launchDdevStart(cmsRoot, args, { exec, env }) {
  return startupOperation(cmsRoot, async () => {
    const paths = ddevStartPaths(cmsRoot);
    const current = reconcileDdevStart(cmsRoot);
    if (isStarting(current)) return { ...paths, pid: current.pid, alreadyStarting: true };
    const id = randomUUID();
    writeStatus(cmsRoot, { id, pid: null, phase: "starting", startedAt: new Date().toISOString() });
    try {
      const { pid } = await exec(
        process.execPath,
        [GQ_BIN, "cms", "start", "--background-job", id, ...args],
        { cwd: cmsRoot, env, background: { log: paths.log } },
      );
      // The worker waits for this publication before updating job status.
      writeStatus(cmsRoot, {
        id,
        pid: pid ?? null,
        phase: "starting",
        startedAt: new Date().toISOString(),
      });
      return { ...paths, pid, alreadyStarting: false };
    } catch (error) {
      reportDdevStart(cmsRoot, id, "failed", error.message);
      throw error;
    }
  });
}

// Never suggest a live admin URL or expose credentials from a copied config.
export function localCmsLinks(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const local =
      url.hostname.endsWith(".ddev.site") ||
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!local || !["http:", "https:"].includes(url.protocol) || url.username || url.password)
      return null;
    return {
      admin: `${url.origin}/wp/wp-admin/`,
      graphql: `${url.origin}/wp/graphql`,
    };
  } catch {
    return null;
  }
}

// How long the startup panel waits for `ddev describe`: it asks Docker, which
// can take a few seconds on a busy machine. It runs beside the launch, so it
// only holds up the panel, never startup itself.
const DESCRIBE_TIMEOUT_MS = 5_000;

async function cmsDevLinks(cmsRoot, { exec, env }) {
  // DDEV reports the actual scheme/host, even for many stopped projects.
  // Bounded, so a DDEV that hangs can't hold up the panel.
  const result = await exec("ddev", ["describe", "-j"], {
    cwd: cmsRoot,
    env,
    timeout: DESCRIBE_TIMEOUT_MS,
  });
  if (result.code === 0) {
    try {
      const payload = JSON.parse(result.stdout);
      const project = Array.isArray(payload) ? payload[0] : (payload?.raw ?? payload);
      const urls = Array.isArray(project?.urls) ? project.urls : [];
      for (const value of [project?.primary_url, project?.httpsurl, project?.httpurl, ...urls]) {
        const links = localCmsLinks(value);
        if (links) return links;
      }
    } catch {
      // A fresh/unavailable project still has its checked-in local URL below.
    }
  }
  const example = join(cmsRoot, ".env.example");
  return existsSync(example)
    ? localCmsLinks(parseDotenv(readFileSync(example, "utf8")).WP_HOME)
    : null;
}

function title(project) {
  return `${project.charAt(0).toUpperCase()}${project.slice(1)} CMS`;
}

// `args` is everything after the action, verbatim; what gq doesn't use goes to
// DDEV. Resolves to the exit code.
export async function runDdevCommand(action, args, { context, env, exec, io, interactive }) {
  args = [...args];
  const foreground = args.includes("--foreground");
  const workerFlag = args.indexOf("--background-job");
  const workerId = workerFlag < 0 ? null : args.splice(workerFlag, 2)[1];
  if (workerFlag >= 0 && (!workerId || action !== "start")) {
    throw new Error("Invalid background startup job.");
  }
  const cmsRoot = join(context.projectRoot, CMS_PATH);
  const paths = ddevStartPaths(cmsRoot);

  if (action === "status") {
    const status = await inspectDdevStart(cmsRoot);
    io.out(
      status
        ? `Last DDEV startup: ${status.phase}${status.pid ? ` (PID ${status.pid})` : ""}`
        : "No background DDEV startup recorded.",
    );
    if (status?.message) io.out(status.message);
    io.out(`Log: ${paths.log}`);
    return status?.phase === "failed" ? 1 : 0;
  }

  try {
    if (workerId) await claimDdevStart(cmsRoot, workerId);
    if (!(await commandExists(exec, "ddev", env))) {
      throw new Error("DDEV is required. Install it from https://ddev.com/get-started/");
    }
    const ddevArgs = args.filter((arg) => arg !== "--foreground");
    if (action === "start" && !foreground && !workerId) {
      await launchInBackground(cmsRoot, ddevArgs, { context, env, exec, io, interactive });
      return 0;
    }

    // This whole sequence runs in the worker (or foreground mode), in order.
    // Do not background link repair or autoload refresh separately from DDEV.
    if (action === "start") syncLocalDesign(cmsRoot, env);
    if (action === "stop") await cancelDdevStart(cmsRoot);
    const result = await exec("ddev", [action, ...ddevArgs], {
      cwd: cmsRoot,
      env,
      stdio: "inherit",
    });
    if (result.code !== 0) {
      const message = `DDEV ${action} failed (exit ${result.code}).`;
      if (workerId) reportDdevStart(cmsRoot, workerId, "failed", message);
      io.err(`gq: ${message}`);
      return result.code;
    }

    if (action === "start") {
      const {
        created,
        changed,
        env: cmsEnv,
      } = ensureCmsEnv(
        cmsRoot,
        await describeDdev(exec, cmsRoot, env),
        localEnvDefaults(context.config),
      );
      if (created) io.out(`Created ${CMS_PATH}/.env from .env.example.`);
      if (changed.length > 0) io.out(`Set ${changed.join(", ")} in ${CMS_PATH}/.env from DDEV.`);
      io.out(`WordPress: ${cmsEnv.WP_HOME}/wp/wp-admin`);
      if (workerId) reportDdevStart(cmsRoot, workerId, "ready");
    }
    return 0;
  } catch (error) {
    if (workerId) reportDdevStart(cmsRoot, workerId, "failed", error.message);
    throw error;
  }
}

async function launchInBackground(cmsRoot, ddevArgs, { context, env, exec, io, interactive }) {
  const ui = createReporter(io, interactive);
  ui.intro(title(context.config.project));
  const spin = ui.spinner();
  spin.start("Preparing background startup");
  try {
    // The lookup runs beside the launch, so a slow DDEV doesn't delay startup.
    const [links, launched] = await Promise.all([
      cmsDevLinks(cmsRoot, { exec, env }),
      launchDdevStart(cmsRoot, ddevArgs, { exec, env }),
    ]);
    spin.stop(
      `${launched.alreadyStarting ? "DDEV startup already running" : "DDEV startup launched in background"}${launched.pid ? ` (PID ${launched.pid})` : ""}.`,
    );
    if (links) {
      // Log rows do not hard-wrap URLs like note boxes can; terminals can
      // recognize the complete links even in a narrow window.
      ui.step("Open local CMS");
      ui.info(`Admin    ${links.admin}`);
      ui.info(`GraphQL  ${links.graphql}`);
    } else {
      ui.warn("Local URL unavailable; run gq cms describe after startup.");
    }
    const log = relative(context.projectRoot, launched.log);
    ui.note(
      `Status    gq cms status\nServices  gq cms describe\nLog       ${log}\nFollow    tail -f ${log}`,
      "Background startup",
    );
    ui.outro("Startup continues in the background. URLs are available once ready.");
  } catch (error) {
    spin.error("Could not launch background startup");
    ui.outro("Inspect the error below; no ready state was reported.");
    throw error;
  }
}

// Test harness for the run() seam: a temporary git repository holding a
// gq.ops.json, plus recording fakes for fetch and exec. Nothing here touches
// the network, real credentials, or the caller's own environment.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";
import { run } from "../../src/index.mjs";

export const FIXTURE_OPS = Object.freeze({
  schemaVersion: 1,
  project: "fixture",
  variant: "content",
  ploi: { serverId: "12", siteId: "34" },
  cloudflare: {
    accountId: "account-1",
    zoneName: "example.test",
  },
});

const temporaryDirectories = [];
after(() =>
  Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  ),
);

export async function temporaryDirectory() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "gq-site-")));
  temporaryDirectories.push(directory);
  return directory;
}

// `ops: null` leaves gq.ops.json out; `files` maps site-relative paths to contents.
export async function createFixtureSite({ ops = FIXTURE_OPS, files = {} } = {}) {
  const root = await temporaryDirectory();
  // Without git's GIT_DIR and the like (set when a git hook runs the tests),
  // which would make this reinitialise the caller's repository instead.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  execFileSync("git", ["init", "--quiet", root], { env });
  if (ops !== null) await writeSiteFile(root, "gq.ops.json", `${JSON.stringify(ops, null, 2)}\n`);
  for (const [path, content] of Object.entries(files)) await writeSiteFile(root, path, content);

  return {
    root,
    path: (...segments) => join(root, ...segments),
    run: (argv, options = {}) => runGq(argv, { cwd: root, ...options }),
  };
}

async function writeSiteFile(root, path, content) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

// Records every request. `respond` returns a Response or a JSON-able payload;
// by default any request fails the command, so a stray call is visible.
export function recordingFetch(respond = unexpectedRequest) {
  const requests = [];
  async function fetch(url, init = {}) {
    const request = {
      url: String(url),
      method: init.method ?? "GET",
      headers: { ...init.headers },
      body: init.body,
    };
    requests.push(request);
    const result = await respond(request);
    return result instanceof Response ? result : json(result);
  }
  fetch.requests = requests;
  return fetch;
}

function unexpectedRequest(request) {
  throw new Error(`Unexpected request: ${request.method} ${request.url}`);
}

export function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// A clock whose sleep() returns at once and moves now() on by what it slept;
// `sleeps` records each wait (ms).
export function fakeClock(start = Date.parse("2026-10-01T09:00:00Z")) {
  let now = start;
  const sleeps = [];
  return {
    now: () => now,
    async sleep(ms) {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

// Records every child process; `respond` may override { code, stdout, stderr }.
// `options` keeps each call's full options (stdio, streams) beside `calls`.
export function recordingExec(respond = () => ({})) {
  const calls = [];
  const recordedOptions = [];
  async function exec(command, args, options = {}) {
    const call = { command, args, cwd: options.cwd, env: options.env, input: options.input };
    calls.push(call);
    recordedOptions.push(options);
    return { code: 0, stdout: "", stderr: "", ...(await respond(call)) };
  }
  exec.calls = calls;
  exec.options = recordedOptions;
  return exec;
}

// gq through run(), as the bin runs it. Its waits (a freshly minted R2 key,
// Ploi deleting a site) go by `clock`: a fake one unless the test passes its
// own, so no test sleeps for real.
export async function runGq(
  argv,
  {
    cwd,
    env = {},
    fetch = recordingFetch(),
    exec = recordingExec(),
    lookup,
    clock = fakeClock(),
    approvals,
    stdin,
    interactive = false,
  } = {},
) {
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await run(argv, {
    cwd,
    env,
    fetch,
    exec,
    lookup,
    clock,
    approvals,
    stdin,
    stdout,
    stderr,
    interactive,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text(), fetch, exec };
}

// A terminal's output as far as a prompt needs one: it never resizes.
function captureStream() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    on() {},
    off() {},
    text: () => chunks.join(""),
  };
}

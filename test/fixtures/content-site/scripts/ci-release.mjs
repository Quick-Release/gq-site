#!/usr/bin/env node

// The release step of Cloudflare CI (infra/ci/cloudflare.ci.ts): deploys the
// admin (`gq ploi release`) and then the frontend (Alchemy) for a v* tag. Prints
// its environment first (names, never values) so a failure is diagnosable
// from the step output alone.
//
// Everything goes to stderr except a short summary, printed last on stdout.
// Cloudflare Workflows keeps only the first ~1 KB of a step's result, which
// is {exitCode, logs: {stdout, stderr}}: what fits there is stdout's start.
// A failed step's error keeps the output's last 20,000 characters instead.
//
//   node scripts/ci-release.mjs --ref <sha>

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const required = [
  "PLOI_API_TOKEN",
  "RELEASES_R2_ACCESS_KEY_ID",
  "RELEASES_R2_SECRET_ACCESS_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "COMPOSER_AUTH",
];

// The Frontend's own secrets: its deploy binds them when set and warns when
// not (a site without a publication store or consent records has none).
const optional = [
  "FRONTEND_REFRESH_TOKEN",
  "PUBLICATION_EVENT_SECRET",
  "CONSENT_READ_TOKEN",
  "GQ_PREVIEW_CMS_USERNAME",
  "GQ_PREVIEW_CMS_APPLICATION_PASSWORD",
  "GQ_PREVIEW_ACCESS_CLIENT_ID",
  "GQ_PREVIEW_ACCESS_CLIENT_SECRET",
  "TURNSTILE_SECRET_KEY",
  "TURNSTILE_SITE_KEY",
  "GQ_FORMS_ACCESS_CLIENT_ID",
  "GQ_FORMS_ACCESS_CLIENT_SECRET",
];

export function missingEnvironment(environment) {
  return required.filter((name) => !environment[name]);
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return (result.stdout || result.stderr || `exit ${result.status}`).trim();
}

function isGitRepository(directory) {
  return (
    spawnSync("git", ["-C", directory, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" })
      .status === 0
  );
}

// CI's /workspace is a copy of the checkout without .git, so fetch the release
// commit from Artifacts (ARTIFACTS_REMOTE / ARTIFACTS_TOKEN come from the step's
// sourceControlCredentials) into a scratch repository for `git archive`.
export function fetchSource(ref, environment, directory = "/tmp/release-source") {
  const { ARTIFACTS_REMOTE: remote, ARTIFACTS_TOKEN: token } = environment;
  if (!remote || !token) {
    throw new Error("No git repository here and no ARTIFACTS_REMOTE/ARTIFACTS_TOKEN to fetch one.");
  }
  const steps = [
    ["init", "-q", directory],
    ["-C", directory, "remote", "add", "origin", remote],
    // The token goes in a header via env (GIT_CONFIG_*), never argv or a URL.
    ["-C", directory, "fetch", "-q", "--depth=1", "origin", ref],
  ];
  for (const args of steps) {
    const result = spawnSync("git", args, {
      stdio: ["ignore", 2, 2],
      env: {
        ...environment,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
      },
    });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  }
  return directory;
}

// Runs a stage with its output on stderr, and returns its exit status and
// output for the summary.
function run(label, command, args) {
  console.error(`\n=== ${label}: ${[command, ...args].join(" ")}`);
  return new Promise((resolve) => {
    let output = "";
    const child = spawn(command, args, { stdio: ["inherit", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        process.stderr.write(chunk);
        output += chunk;
      });
    }
    child.on("error", (error) => {
      console.error(`${label} could not start: ${error.message}`);
      resolve({ label, status: 1, output });
    });
    child.on("close", (status) => {
      if (status !== 0) console.error(`${label} failed with exit code ${status}`);
      resolve({ label, status: status ?? 1, output });
    });
  });
}

// What a stage's output says that the summary keeps: the release's header,
// the Frontend deploy guards' verdicts (✓ / ✗) and compatibility changes.
const NOTABLE = /^(Ploi release · |✓ |✗ |\S+'s compatibility (flags|date) changed)/u;
const SUMMARY_CHARACTERS = 700;

// The release's outcome in a few lines, short enough to fit in the start of
// the step's result: each stage's status, then its notable lines.
export function releaseSummary(stages, skipped = []) {
  const failed = stages.some(({ status }) => status !== 0);
  const lines = [`release: ${failed ? "failed" : "ok"}`];
  for (const { label, status, output } of stages) {
    lines.push(`${label}: ${status === 0 ? "ok" : `failed (exit ${status})`}`);
    const notable = output
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*m/gu, "")
      .split("\n")
      .map((line) => line.replace(/^[\s│┌└◇◆●▲■]+/u, "").trimEnd())
      .filter((line) => NOTABLE.test(line));
    for (const line of [...new Set(notable)]) lines.push(`  ${line}`);
  }
  for (const label of skipped) lines.push(`${label}: not run`);
  const text = lines.join("\n");
  return text.length <= SUMMARY_CHARACTERS
    ? text
    : `${text.slice(0, SUMMARY_CHARACTERS - 40)}\n… (cut: the full output is on stderr)`;
}

// An offboarded Site (gq offboard) is never released: the release would
// deploy its CMS and attach its Frontend's domain again.
function refuseOffboarded() {
  const ops = JSON.parse(readFileSync(new URL("../gq.ops.json", import.meta.url), "utf8"));
  if (ops.offboarded) {
    throw new Error(
      `${ops.project} is offboarded (gq.ops.json offboarded): a release would expose it again. If the Site is coming back, run gq offboard --restore first.`,
    );
  }
}

async function main(arguments_) {
  refuseOffboarded();
  const index = arguments_.indexOf("--ref");
  const ref = index === -1 ? null : arguments_[index + 1];
  if (!ref) throw new Error("Usage: ci-release.mjs --ref <sha>");

  console.error("=== environment");
  console.error(`node ${process.version}; ${capture("git", ["--version"])}; cwd ${process.cwd()}`);
  console.error(`ref ${ref} → commit ${capture("git", ["rev-parse", `${ref}^{commit}`])}`);
  for (const name of required) console.error(`${name}: ${process.env[name] ? "set" : "MISSING"}`);
  for (const name of optional) console.error(`${name}: ${process.env[name] ? "set" : "not set"}`);
  const missing = missingEnvironment(process.env);
  if (missing.length > 0) throw new Error(`Missing environment: ${missing.join(", ")}`);

  const gitDir = isGitRepository(process.cwd()) ? process.cwd() : fetchSource(ref, process.env);
  console.error(`release source: ${gitDir}`);

  const admin = await run("admin", "pnpm", [
    "exec",
    "gq",
    "ploi",
    "release",
    "--ref",
    ref,
    "--git-dir",
    gitDir,
  ]);
  if (admin.status !== 0) {
    console.log(releaseSummary([admin], ["frontend"]));
    return admin.status;
  }
  const frontend = await run("frontend", "pnpm", ["run", "deploy:frontend:raw"]);
  console.log(releaseSummary([admin, frontend]));
  return frontend.status;
}

if (process.argv[1]?.endsWith("ci-release.mjs")) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

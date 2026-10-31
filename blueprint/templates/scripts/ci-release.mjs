#!/usr/bin/env node

// The release step of Cloudflare CI (infra/ci/cloudflare.ci.ts): deploys the
// admin (`gq ploi release`) and then the frontend (Alchemy) for a v* tag. Prints
// its environment first (names, never values) so a failure is diagnosable
// from the step output alone.
//
//   node scripts/ci-release.mjs --ref <sha>

import { spawnSync } from "node:child_process";
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
      stdio: ["ignore", "inherit", "inherit"],
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

function run(label, command, args, env = process.env) {
  console.log(`\n=== ${label}: ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.error) {
    console.error(`${label} could not start: ${result.error.message}`);
    return 1;
  }
  if (result.status !== 0) console.error(`${label} failed with exit code ${result.status}`);
  return result.status ?? 1;
}

// An offboarded Site (gq offboard) is never released: the release would
// deploy its CMS and attach its Frontend's domain again.
function refuseOffboarded(ops) {
  if (ops.offboarded) {
    throw new Error(
      `${ops.project} is offboarded (gq.ops.json offboarded): a release would expose it again. If the Site is coming back, run gq offboard --restore first.`,
    );
  }
}

// A protected Site (gq.ops.json deployment) is released only while its
// deployment.state is "authorized": a paused or reserved one refuses before
// the CMS or the Frontend deploys. gq ploi release refuses the same way;
// a reviewed Site change lifts the hold, never a flag.
export function deploymentRefusal(ops) {
  const policy = ops.deployment;
  if (!policy || policy.state === "authorized") return null;
  const who = policy.state === "reserved" ? ` is reserved by ${policy.holder}` : " is paused";
  return (
    `${ops.project}${who} (gq.ops.json deployment.state: ${policy.state}): ${policy.reason}. ` +
    "Nothing was uploaded, synced or deployed. " +
    'A reviewed Site change that sets deployment.state to "authorized" lifts the hold.'
  );
}

function main(arguments_) {
  const ops = JSON.parse(readFileSync(new URL("../gq.ops.json", import.meta.url), "utf8"));
  refuseOffboarded(ops);
  const held = deploymentRefusal(ops);
  if (held) throw new Error(held);
  const index = arguments_.indexOf("--ref");
  const ref = index === -1 ? null : arguments_[index + 1];
  if (!ref) throw new Error("Usage: ci-release.mjs --ref <sha>");

  console.log("=== environment");
  console.log(`node ${process.version}; ${capture("git", ["--version"])}; cwd ${process.cwd()}`);
  console.log(`ref ${ref} → commit ${capture("git", ["rev-parse", `${ref}^{commit}`])}`);
  for (const name of required) console.log(`${name}: ${process.env[name] ? "set" : "MISSING"}`);
  for (const name of optional) console.log(`${name}: ${process.env[name] ? "set" : "not set"}`);
  const missing = missingEnvironment(process.env);
  if (missing.length > 0) throw new Error(`Missing environment: ${missing.join(", ")}`);

  const gitDir = isGitRepository(process.cwd()) ? process.cwd() : fetchSource(ref, process.env);
  console.log(`release source: ${gitDir}`);

  // gq ploi release reads the default branch's current policy from origin
  // (Artifacts here) with ARTIFACTS_TOKEN, which it puts in a header for
  // those git calls only, never argv or a global setting.
  const admin = run("admin", "pnpm", [
    "exec",
    "gq",
    "ploi",
    "release",
    "--ref",
    ref,
    "--git-dir",
    gitDir,
  ]);
  if (admin !== 0) return admin;
  // The Frontend's deploy needs no source control credentials.
  const { ARTIFACTS_TOKEN, ARTIFACTS_REMOTE, ...frontendEnv } = process.env;
  void ARTIFACTS_TOKEN;
  void ARTIFACTS_REMOTE;
  return run("frontend", "pnpm", ["run", "deploy:frontend:raw"], frontendEnv);
}

if (process.argv[1]?.endsWith("ci-release.mjs")) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

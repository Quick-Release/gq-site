// gq verify: runs the site's checks (its
// variant's defaults, then gq.ops.json `verify.checks`: the list
// `gq release push` runs before a release) in order, stopping at the first
// failure. One list for the pre-push hook, releases and
// CI, which runs it in a single container. The site decides what it verifies;
// this only decides what can run here.
//
//   gq verify       # locally: skips checks whose toolchain isn't here
//   gq verify --ci  # CI: every check is required

import { join } from "node:path";

import { CMS_PATH, commandExists, ddevStatus, phpToolchainAvailable } from "../cms/local.mjs";
import { loadSiteSettings } from "../manifest/site-settings.mjs";

// What a check can need, with how to get it when it's missing. A check
// declares `requires`; without it, a `composer` check needs PHP.
const REQUIREMENTS = {
  php: "install Composer and run: pnpm cms:composer",
  ddev: "start DDEV: pnpm cms:dev",
};

export function checkRequirements(check) {
  if (check.requires !== undefined) return check.requires;
  return check.cmd === "composer" ? ["php"] : [];
}

// Locally a check whose toolchain is missing is skipped (with a warning); in
// CI nothing is skipped.
export function selectChecks(checks, { ci, phpAvailable, ddevAvailable = false }) {
  if (ci) return { run: checks, skipped: [] };
  const available = { php: phpAvailable, ddev: ddevAvailable };
  const runnable = (check) => checkRequirements(check).every((name) => available[name]);
  return {
    run: checks.filter(runnable),
    skipped: checks.filter((check) => !runnable(check)),
  };
}

export async function runVerify({ ci = false }, { context, env, exec, io }) {
  const root = context.projectRoot;
  const { checks } = await loadSiteSettings(context);
  const needed = new Set(checks.flatMap(checkRequirements));
  // Only look for what some check needs, and nothing in CI.
  const available = {
    php: !ci && needed.has("php") && (await phpToolchainAvailable(exec, root, env)),
    ddev:
      !ci &&
      needed.has("ddev") &&
      (await commandExists(exec, "ddev", env)) &&
      (await ddevStatus(exec, join(root, CMS_PATH), env)) === "running",
  };
  const { run, skipped } = selectChecks(checks, {
    ci,
    phpAvailable: available.php,
    ddevAvailable: available.ddev,
  });

  // Dependencies are installed by the caller (CI's install step, or you);
  // don't let every `pnpm run` re-verify them.
  const checkEnv = { ...env, pnpm_config_verify_deps_before_run: "false" };
  const started = Date.now();
  for (const check of run) {
    const label = describeCheck(check);
    const checkStarted = Date.now();
    const { code } = await exec(check.cmd, check.args, {
      cwd: check.cwd ? join(root, check.cwd) : root,
      env: check.env ? { ...checkEnv, ...check.env } : checkEnv,
      stdio: "inherit",
    });
    if (code !== 0) {
      io.err(`\n✗ ${label} failed (${seconds(checkStarted)}s)`);
      return code;
    }
    io.out(`✓ ${label} (${seconds(checkStarted)}s)`);
  }
  for (const check of skipped) {
    const missing = checkRequirements(check).filter((name) => !available[name]);
    io.err(
      `⚠ skipped ${describeCheck(check)} — ${missing.map((name) => REQUIREMENTS[name]).join("; ")}`,
    );
  }
  const skips = skipped.length > 0 ? ` (${skipped.length} skipped)` : "";
  io.out(`\nAll ${run.length} checks passed in ${seconds(started)}s${skips}.`);
  return 0;
}

// A check as its command line, such as `pnpm run lint`.
export const describeCheck = (check) => [check.cmd, ...(check.args ?? [])].join(" ");
const seconds = (since) => ((Date.now() - since) / 1000).toFixed(1);

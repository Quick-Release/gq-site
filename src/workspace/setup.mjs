// gq setup: bootstraps a clone of a GETQUICK
// site. Installs the workspace, creates each app's ignored .env from its
// .env.example, then starts DDEV and installs Composer through the site's own
// `cms:dev:raw` and `cms:composer` scripts (the latter under its Sigillo
// registry login). A Site that installs from GitHub Packages (its .npmrc
// names npm.pkg.github.com: a commerce Site) installs with the fleet's
// read:packages token from GQ Platform `ops` (gq-platform ADR 0013), handed
// to pnpm in its environment, never a file; without access, with the
// operator's user-level npm config.
//
//   gq setup [--no-ddev]

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CMS_PATH, commandExists } from "../cms/local.mjs";
import {
  NPM_PACKAGES_TOKEN_VARIABLE,
  readPlatformRegistryCredentials,
} from "../sigillo/registry-credentials.mjs";
import { FRONTEND_PATH } from "./layout.mjs";

export async function runSetup({ noDdev = false }, { context, env, exec, io }) {
  const root = context.projectRoot;
  const step = async (command, commandArgs, stepEnv = env) =>
    (await exec(command, commandArgs, { cwd: root, env: stepEnv, stdio: "inherit" })).code;

  io.out(`[setup] Workspace: ${root}`);
  if (!(await commandExists(exec, "pnpm", env))) {
    io.err("[setup] pnpm is required. Install it from https://pnpm.io/installation");
    return 1;
  }

  io.out("[setup] Installing workspace dependencies…");
  const installEnv = await packagesInstallEnv({ context, env, exec, io });
  const installed = await step("pnpm", ["install", "--frozen-lockfile"], installEnv);
  if (installed !== 0) return installed;

  copyEnvExample(root, FRONTEND_PATH, io);
  copyEnvExample(root, CMS_PATH, io);

  if (noDdev) {
    io.out("[setup] --no-ddev: skipping DDEV and Composer.");
    printNextSteps(io);
    return 0;
  }

  if (!(await commandExists(exec, "ddev", env))) {
    io.err("[setup] ddev not found — skipping WordPress bootstrap.");
    io.err("         Install DDEV from https://ddev.com/get-started/");
    printNextSteps(io);
    return 0;
  }

  io.out(`[setup] Starting DDEV for ${CMS_PATH}…`);
  const started = await step("pnpm", ["cms:dev:raw", "--foreground"]);
  if (started !== 0) return started;

  // The GETQUICK plugins come from the private Composer registry; its login
  // is in Sigillo (dev), so this installs with the host Composer under it.
  io.out("[setup] Installing Composer dependencies (GETQUICK registry login from Sigillo)…");
  const composer = await step("pnpm", ["cms:composer"]);
  if (composer !== 0) return composer;

  io.out("\n[setup] Done.");
  printNextSteps(io);
  return 0;
}

// The install's environment: with the fleet's read:packages token for a Site
// that installs from GitHub Packages, when GQ Platform `ops` gives it.
async function packagesInstallEnv({ context, env, exec, io }) {
  let npmrc;
  try {
    npmrc = readFileSync(join(context.projectRoot, ".npmrc"), "utf8");
  } catch {
    return env;
  }
  if (!npmrc.includes("npm.pkg.github.com")) return env;
  const { values, problem } = await readPlatformRegistryCredentials({ context, env, exec });
  if (!values.GITHUB_PACKAGES_TOKEN) {
    io.err(
      `[setup] No GITHUB_PACKAGES_TOKEN from GQ Platform ops (${problem}); pnpm uses your user-level npm config for GitHub Packages.`,
    );
    return env;
  }
  io.out("[setup] GitHub Packages: the fleet's read:packages token from GQ Platform ops");
  return { ...env, [NPM_PACKAGES_TOKEN_VARIABLE]: values.GITHUB_PACKAGES_TOKEN };
}

function copyEnvExample(root, app, io) {
  const example = join(root, app, ".env.example");
  const target = join(root, app, ".env");

  if (!existsSync(example)) {
    io.err(`[setup] No ${app}/.env.example — skipping env copy.`);
    return;
  }
  if (existsSync(target)) {
    io.out(`[setup] ${app}/.env already exists — skipping.`);
    return;
  }
  copyFileSync(example, target);
  io.out(`[setup] Created ${app}/.env from .env.example`);
}

function printNextSteps(io) {
  io.out(`
Next steps:
  pnpm run doctor        — verify the workspace
  pnpm cms:dev           — start local WordPress with DDEV
  pnpm frontend:dev      — start the frontend
  pnpm check             — run the frontend type check
  pnpm deploy:frontend   — deploy the Cloudflare Worker with Alchemy
`);
}

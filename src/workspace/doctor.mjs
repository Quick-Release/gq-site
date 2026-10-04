// gq doctor (Lombardi's scripts/doctor.mjs): a GETQUICK site's workspace
// health check. The checks are shared; the site supplies their inputs: the
// Node minimum (package.json `engines.node`), the toolchain pins
// (`packageManager`, .mise.toml or .nvmrc), the files each app must have
// (the variant's defaults plus gq.ops.json `doctor.requiredFiles`), the DDEV
// project (apps/cms/.ddev/config.yaml `name`) and gq.ops.json's `sigillo` and
// `artifacts`. Missing required pieces fail it; drift only warns. Its network
// reads: the Artifacts namespace's jurisdiction, with ARTIFACTS_API_TOKEN from
// the environment or Sigillo `staging`, and each Sigillo environment's secret
// names, which no app's env file may set.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CMS_PATH, commandExists, ddevStatus, phpToolchainAvailable } from "../cms/local.mjs";
import { artifactsRemoteUrl, createArtifactsClient } from "../cloudflare/account-client.mjs";
import { jurisdictionMismatchMessage } from "../cloudflare/ci.mjs";
import { SECRETS_ENVIRONMENT } from "../cloudflare/tokens.mjs";
import { artifactsJurisdiction, MANIFEST_FILENAME } from "../manifest/schema.mjs";
import { localMediaReadiness } from "../media/readiness.mjs";
import {
  hasReleaseConfig,
  RELEASE_CONFIG_FILENAME,
  siteSettings,
} from "../manifest/site-settings.mjs";
import { sigilloSecrets } from "../sigillo/commands.mjs";
import { VERSION } from "../version.mjs";
import { appEnvFiles, secretsInEnvFiles } from "./env-secrets.mjs";
import { FRONTEND_PATH } from "./layout.mjs";

const PACKAGE_NAME = "@getquick/site";

export async function runDoctor(_options, { context, env, fetch, exec, io }) {
  const root = context.projectRoot;
  const name = context.config.project ?? "GETQUICK";
  const project = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
  const manifest = readJson(join(root, "package.json")) ?? {};
  const { requiredFiles } = siteSettings(context.config);
  const capture = async (command, commandArgs, options = {}) => {
    const result = await exec(command, commandArgs, { cwd: root, env, ...options });
    return { code: result.code, stdout: (result.stdout ?? "").trim() };
  };
  const report = createReport(io);
  const { ok, warn, fail } = report;
  let sigilloReady = false;

  io.out(`${project} workspace doctor\n`);

  // Tooling: the gq release itself, then the pinned toolchain.
  const pinned = manifest.devDependencies?.[PACKAGE_NAME] ?? manifest.dependencies?.[PACKAGE_NAME];
  if (pinned && pinned !== VERSION) {
    warn(
      `${PACKAGE_NAME} ${VERSION} is running, but package.json pins ${pinned} — run: pnpm install`,
    );
  } else ok(`${PACKAGE_NAME} ${VERSION}${pinned ? " (matches the package.json pin)" : ""}`);

  await checkNode({ root, project, manifest, capture, report });
  await checkPnpm({ manifest, exec, env, capture, report });
  if (!(await commandExists(exec, "git", env))) fail("git is not installed");
  else ok(`git ${(await capture("git", ["--version"])).stdout}`);

  // Release and verify refuse to run until it's folded in; doctor names it.
  if (await hasReleaseConfig(root)) {
    fail(
      `${RELEASE_CONFIG_FILENAME} hasn't been folded into ${MANIFEST_FILENAME} — run: gq sync --manifest`,
    );
  }

  if (Object.keys(requiredFiles).length > 0) {
    io.out("\nApps:");
    let present = true;
    for (const [app, files] of Object.entries(requiredFiles)) {
      for (const file of files) {
        if (!existsSync(join(root, app, file))) {
          fail(`${app}/${file} is missing`);
          present = false;
        }
      }
    }
    if (present) ok("every file the site's apps require is present");
  }

  io.out("\nDependencies:");
  if (existsSync(join(root, "node_modules"))) ok("workspace dependencies installed");
  else fail("node_modules is missing — run: pnpm run setup --no-ddev");
  if (!existsSync(join(root, CMS_PATH, "vendor"))) {
    warn(`${CMS_PATH}/vendor is missing — run: pnpm cms:composer`);
  } else if (!(await phpToolchainAvailable(exec, root, env))) {
    // Same condition as gq verify: without both, the PHP checks are skipped.
    warn(
      `${CMS_PATH} Composer dependencies installed, but Composer is not — pnpm verify and the pre-push hook skip the PHP checks`,
    );
  } else ok(`${CMS_PATH} Composer dependencies installed`);

  if (context.config.artifacts) {
    io.out("\nGit remotes:");
    await checkArtifactsRemote({ config: context.config, capture, report });
  }

  io.out("\nEnvironment:");
  // Env files are generated, never copied with credentials: secrets come
  // from Sigillo (checked below).
  if (existsSync(join(root, FRONTEND_PATH, ".env"))) ok(`${FRONTEND_PATH}/.env exists`);
  else {
    warn(
      `${FRONTEND_PATH}/.env is missing — run: pnpm run setup --no-ddev (it creates it from .env.example)`,
    );
  }
  if (existsSync(join(root, CMS_PATH, ".env"))) ok(`${CMS_PATH}/.env exists`);
  else {
    warn(
      `${CMS_PATH}/.env is missing — run: pnpm run setup --no-ddev (it creates it from .env.example; gq cms start points it at DDEV)`,
    );
  }

  // Local uploads only; the production prerequisite is gq media check's.
  io.out("\nMedia (local development):");
  const media = localMediaReadiness({
    ops: context.config,
    cmsEnv: readText(join(root, CMS_PATH, ".env")),
  });
  for (const { status, detail, action } of media.checks) {
    if (status === "ok") ok(detail);
    else (status === "not-ready" ? fail : warn)(action ? `${detail} — ${action}` : detail);
  }

  if (context.config.sigillo) {
    io.out("\nSecrets (Sigillo):");
    sigilloReady = await checkSigillo({ root, sigillo: context.config.sigillo, capture, report });
    await checkEnvSecrets({ context, env, exec, sigilloReady, report });
  }

  if (context.config.artifacts && context.config.cloudflare?.accountId) {
    io.out("\nCloudflare Artifacts:");
    const token = await artifactsToken({ context, env, exec, sigilloReady });
    await checkJurisdiction({ config: context.config, token, fetch, report });
  }

  io.out("\nLocal WordPress:");
  const ddevProject = ddevProjectName(root) ?? `the ${CMS_PATH} DDEV project`;
  if (!(await commandExists(exec, "ddev", env))) {
    warn("DDEV is not installed (needed for WordPress)");
  } else {
    const status = await ddevStatus(exec, join(root, CMS_PATH), env);
    if (status === null) {
      warn(`DDEV is installed but ${ddevProject} is not running — run: pnpm cms:dev`);
    } else if (status === "running") ok(`DDEV is running for ${ddevProject}`);
    else warn(`DDEV status: ${status} — run: pnpm cms:dev`);
  }

  const healthy = report.healthy();
  io.out(healthy ? "\nAll required checks passed." : "\nSome required checks need attention.");
  return healthy ? 0 : 1;
}

function createReport(io) {
  let healthy = true;
  return {
    ok: (message) => io.out(`  ✓ ${message}`),
    skip: (message) => io.out(`  · ${message}`),
    warn: (message) => io.out(`  ⚠ ${message}`),
    fail: (message) => {
      io.out(`  ✗ ${message}`);
      healthy = false;
    },
    healthy: () => healthy,
  };
}

async function checkNode({ root, project, manifest, capture, report }) {
  const version = parseVersion((await capture("node", ["--version"])).stdout);
  if (!version) return report.fail("Node.js is not available");
  const running = version.join(".");
  const minimum = parseVersion(/>=\s*(\S+)/u.exec(manifest.engines?.node ?? "")?.[1] ?? "");
  if (minimum && !meetsMinimum(version, minimum)) {
    return report.fail(`Node.js ${running} found; ${project} needs >= ${minimum.join(".")}`);
  }
  const pin = nodePin(root);
  if (!pin) return report.ok(`Node.js ${running}`);
  if (pin.version !== running) {
    return report.warn(
      `Node.js ${running} is running but ${pin.file} pins ${pin.version} — run: mise install`,
    );
  }
  report.ok(`Node.js ${running} (matches the ${pin.file} pin)`);
}

// Corepack/pnpm switch to the packageManager pin, so a mismatch means the
// switch is off and a different pnpm is doing the work.
async function checkPnpm({ manifest, exec, env, capture, report }) {
  if (!(await commandExists(exec, "pnpm", env))) return report.fail("pnpm is not installed");
  const running = (await capture("pnpm", ["--version"])).stdout;
  const pinned = /^pnpm@([^+]+)/u.exec(manifest.packageManager ?? "")?.[1];
  if (!pinned) return report.warn(`pnpm ${running} (package.json has no packageManager pin)`);
  if (running !== pinned) {
    return report.warn(
      `pnpm ${running} is running but package.json pins ${pinned} — enable corepack or install pnpm@${pinned}`,
    );
  }
  report.ok(`pnpm ${running} (matches the packageManager pin)`);
}

// Clones of a site on GitHub push to GitHub only; the CI Worker mirrors GitHub
// into Artifacts. A leftover Artifacts push URL (older setups) runs the
// pre-push hook twice. An Artifacts-only site (no github.repository) pushes
// to Artifacts only, through gq's credential helper.
async function checkArtifactsRemote({ config, capture, report }) {
  const remote = artifactsRemoteUrl({
    accountId: config.cloudflare?.accountId,
    ...config.artifacts,
  });
  const pushUrls = (await capture("git", ["remote", "get-url", "--push", "--all", "origin"]))
    .stdout;
  const helpers = (
    await capture("git", ["config", "--local", "--get-regexp", "^credential\\..*\\.helper$"])
  ).stdout;
  if (!config.github?.repository) {
    if (pushUrls !== remote || !helpers.includes(" git artifacts")) {
      return report.warn(
        "origin doesn't push to Cloudflare Artifacts through gq's credential helper (this site has no GitHub repository) — run: pnpm git:artifacts setup",
      );
    }
    return report.ok("origin pushes to Cloudflare Artifacts (no GitHub repository)");
  }
  if (pushUrls.split("\n").includes(remote)) {
    return report.warn(
      "origin still pushes to Cloudflare Artifacts too (GitHub mirrors it now) — run: pnpm git:artifacts setup",
    );
  }
  // Setups before gq git artifacts registered a site script as the helper.
  if (helpers.includes("scripts/git-artifacts.mjs")) {
    return report.warn(
      "the Artifacts credential helper runs the removed scripts/git-artifacts.mjs — run: pnpm git:artifacts setup",
    );
  }
  report.ok("origin pushes to GitHub only (the CI Worker mirrors it to Artifacts)");
}

// Resolves to whether Sigillo is ready to read secrets (installed, a real
// project, logged in).
async function checkSigillo({ root, sigillo, capture, report }) {
  const binary = join(root, "node_modules", ".bin", "sigillo");
  if (!existsSync(binary)) {
    report.warn("Sigillo CLI is missing — run: pnpm install");
    return false;
  }
  if (String(sigillo.projectId ?? "").startsWith("REPLACE_WITH_")) {
    report.warn(
      "gq.ops.json sigillo.projectId is still a placeholder — cms:dev and deploy:frontend will not run",
    );
    return false;
  }
  report.ok(`Sigillo project ${sigillo.projectId}`);
  if ((await capture(binary, ["me", "--api-url", sigillo.apiUrl])).code !== 0) {
    report.warn("Sigillo is not logged in — run: pnpm sigillo:login");
    return false;
  }
  report.ok("Sigillo is logged in");
  return true;
}

// Fails for each name an app's .env, .env.local or .dev.vars sets that one of
// the site's Sigillo environments holds: names only, no value is read.
async function checkEnvSecrets({ context, env, exec, sigilloReady, report }) {
  if (!sigilloReady) {
    return report.skip("env files not checked for Sigillo secrets: Sigillo isn't ready");
  }
  const listings = [];
  const environments = context.config.sigillo.environments ?? {};
  for (const [environment, sigilloName] of Object.entries(environments)) {
    try {
      const secrets = await sigilloSecrets({ context, env, exec }, environment);
      listings.push({ environment: secrets.name, listing: await secrets.list() });
    } catch {
      report.warn(`could not list Sigillo ${sigilloName}'s secret names`);
    }
  }
  const found = secretsInEnvFiles(appEnvFiles(context.projectRoot), listings);
  for (const { path, name, environment } of found) {
    report.fail(
      `${path} sets ${name}, a secret Sigillo ${environment} holds — remove it: gq sigillo run injects it`,
    );
  }
  if (found.length === 0 && listings.length > 0) {
    report.ok("no app's env file sets a secret Sigillo holds");
  }
}

// ARTIFACTS_API_TOKEN (gq cloudflare ci's) from the environment, or from
// Sigillo `staging` when the site maps it and Sigillo is logged in; null
// when neither has it.
async function artifactsToken({ context, env, exec, sigilloReady }) {
  if (env.ARTIFACTS_API_TOKEN) return env.ARTIFACTS_API_TOKEN;
  if (!sigilloReady || !context.config.sigillo.environments?.[SECRETS_ENVIRONMENT]) return null;
  try {
    const secrets = await sigilloSecrets({ context, env, exec }, SECRETS_ENVIRONMENT);
    return (await secrets.get("ARTIFACTS_API_TOKEN")) || null;
  } catch {
    return null;
  }
}

// Cloudflare can't move a namespace, so one outside gq.ops.json
// `artifacts.jurisdiction` keeps the Site's code where it shouldn't be.
async function checkJurisdiction({ config, token, fetch, report }) {
  const { namespace } = config.artifacts;
  const accountId = config.cloudflare.accountId;
  if (!token) {
    return report.skip(
      `Artifacts namespace ${namespace}'s jurisdiction not checked: no ARTIFACTS_API_TOKEN in the environment or Sigillo ${SECRETS_ENVIRONMENT}`,
    );
  }
  const configured = artifactsJurisdiction(config);
  let existing;
  try {
    existing = await createArtifactsClient({ accountId, token, fetch }).findNamespace(namespace);
  } catch (error) {
    return report.warn(
      `could not read Artifacts namespace ${namespace}'s jurisdiction: ${error.message}`,
    );
  }
  if (!existing) {
    return report.warn(
      `Artifacts namespace ${namespace} doesn't exist yet — run: gq cloudflare ci`,
    );
  }
  if (existing.jurisdiction !== configured) {
    return report.fail(
      jurisdictionMismatchMessage({
        accountId,
        namespace,
        current: existing.jurisdiction,
        configured,
      }),
    );
  }
  report.ok(`Artifacts namespace ${namespace} is in ${configured}, as gq.ops.json says`);
}

// The Node version .mise.toml (`node = "…"`) or .nvmrc pins, if any.
function nodePin(root) {
  const mise = readText(join(root, ".mise.toml"));
  const fromMise = mise && /^\s*node\s*=\s*["']([^"']+)["']/mu.exec(mise)?.[1];
  if (fromMise) return { file: ".mise.toml", version: fromMise.replace(/^v/u, "") };
  const nvmrc = readText(join(root, ".nvmrc"))?.trim();
  if (nvmrc) return { file: ".nvmrc", version: nvmrc.replace(/^v/u, "") };
  return null;
}

// The DDEV project's `name` from apps/cms/.ddev/config.yaml.
function ddevProjectName(root) {
  const config = readText(join(root, CMS_PATH, ".ddev", "config.yaml"));
  return config ? (/^name:\s*["']?([^"'\s]+)/mu.exec(config)?.[1] ?? null) : null;
}

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(value.trim());
  return match ? match.slice(1).map(Number) : null;
}

function meetsMinimum(actual, required) {
  for (let index = 0; index < required.length; index += 1) {
    if (actual[index] !== required[index]) return actual[index] > required[index];
  }
  return true;
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function readJson(path) {
  const text = readText(path);
  return text === null ? null : JSON.parse(text);
}

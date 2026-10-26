// gq doctor: a GETQUICK site's workspace
// health check. The checks are shared; the site supplies their inputs: the
// Node minimum (package.json `engines.node`), the toolchain pins
// (`packageManager`, .mise.toml or .nvmrc), the files each app must have
// (the variant's defaults plus gq.ops.json `doctor.requiredFiles`), the DDEV
// project (apps/cms/.ddev/config.yaml `name`) and gq.ops.json's `sigillo` and
// `artifacts`. Missing required pieces fail it; drift only warns. Reads
// Sigillo's variable names and the Artifacts namespace's jurisdiction, with
// ARTIFACTS_API_TOKEN from the environment or Sigillo `staging`, and the
// consent databases' jurisdiction (ADR 0019), with CLOUDFLARE_API_TOKEN
// from either. A Site that declares `forms` (gq-platform ADR 0009) has the
// managed form route, a content runtime that reads form descriptors, and,
// when it chose Turnstile, Turnstile's keys in Sigillo staging.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CMS_PATH, commandExists, ddevStatus, phpToolchainAvailable } from "../cms/local.mjs";
import { artifactsRemoteUrl, createArtifactsClient } from "../cloudflare/account-client.mjs";
import { jurisdictionMismatchMessage } from "../cloudflare/ci.mjs";
import { SECRETS_ENVIRONMENT } from "../cloudflare/tokens.mjs";
import {
  CONSENT_JURISDICTION,
  consentDatabaseName,
  listConsentDatabases,
} from "../frontend/consent.mjs";
import { FORMS_ROUTE, TURNSTILE_KEYS } from "../forms/readiness.mjs";
import { artifactsJurisdiction, formSpamControls, MANIFEST_FILENAME } from "../manifest/schema.mjs";
import { localMediaReadiness } from "../media/readiness.mjs";
import {
  hasReleaseConfig,
  RELEASE_CONFIG_FILENAME,
  siteSettings,
} from "../manifest/site-settings.mjs";
import { sigilloSecrets } from "../sigillo/commands.mjs";
import { VERSION } from "../version.mjs";
import { checkLocalEnvFiles } from "./env-files.mjs";
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
  if (existsSync(join(root, FRONTEND_PATH, ".env"))) ok(`${FRONTEND_PATH}/.env exists`);
  else warn(`${FRONTEND_PATH}/.env is missing — run: gq setup --no-ddev`);
  if (existsSync(join(root, CMS_PATH, ".env"))) ok(`${CMS_PATH}/.env exists`);
  else warn(`${CMS_PATH}/.env is missing — run: gq cms start`);

  // Local uploads only; the production prerequisite is gq media check's.
  io.out("\nMedia (local development):");
  const media = localMediaReadiness({
    ops: context.config,
    cmsEnv: readText(join(root, CMS_PATH, ".env")),
  });
  for (const { name, status, detail, action } of media.checks) {
    if (name === "bucket-fallback" && status === "ok") {
      ok("media missing locally is served from the configured bucket URL");
      continue;
    }
    if (status === "ok") ok(detail);
    else (status === "not-ready" ? fail : warn)(action ? `${detail} — ${action}` : detail);
  }

  if (context.config.sigillo) {
    io.out("\nSecrets (Sigillo):");
    sigilloReady = await checkSigillo({ root, sigillo: context.config.sigillo, capture, report });
    if (sigilloReady) {
      await checkLocalSecrets({ context, env, exec, requiredFiles, report });
    }
  }

  if (context.config.artifacts && context.config.cloudflare?.accountId) {
    io.out("\nCloudflare Artifacts:");
    const token = await stagingToken("ARTIFACTS_API_TOKEN", { context, env, exec, sigilloReady });
    await checkJurisdiction({ config: context.config, token, fetch, report });
  }

  if (context.config.cloudflare?.accountId && context.config.project) {
    io.out("\nConsent records (D1):");
    const token = await stagingToken("CLOUDFLARE_API_TOKEN", { context, env, exec, sigilloReady });
    await checkConsentJurisdiction({ config: context.config, token, fetch, report });
  }

  if (context.config.forms) {
    io.out("\nForms:");
    await checkForms({ context, env, exec, sigilloReady, report });
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

async function checkLocalSecrets({ context, env, exec, requiredFiles, report }) {
  const environments = new Map();
  for (const [alias, name] of Object.entries(context.config.sigillo.environments ?? {})) {
    environments.set(name, alias);
  }
  if (environments.size === 0) {
    report.fail(
      "local secret check needs a mapped Sigillo environment — configure gq.ops.json sigillo.environments",
    );
    return;
  }
  const secretNames = new Set();
  let complete = true;
  for (const [name, alias] of environments) {
    try {
      const secrets = await sigilloSecrets({ context, env, exec }, alias);
      for (const variable of (await secrets.list()).split(/\r?\n/u)) {
        if (variable.trim()) secretNames.add(variable.trim());
      }
    } catch {
      // Sigillo stderr is untrusted output and might contain secret values.
      report.fail(
        `could not list Sigillo ${name} variable names — check connectivity and access with gq sigillo secrets ${alias}`,
      );
      complete = false;
    }
  }
  if (complete) {
    await checkLocalEnvFiles({
      root: context.projectRoot,
      project: context.config.project,
      requiredFiles,
      secretNames,
      report,
    });
  }
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
    report.fail("Sigillo CLI is missing — run: pnpm install");
    return false;
  }
  if (String(sigillo.projectId ?? "").startsWith("REPLACE_WITH_")) {
    report.fail(
      "gq.ops.json sigillo.projectId is still a placeholder — cms:dev and deploy:frontend will not run",
    );
    return false;
  }
  report.ok(`Sigillo project ${sigillo.projectId}`);
  if ((await capture(binary, ["me", "--api-url", sigillo.apiUrl])).code !== 0) {
    report.fail("Sigillo is not logged in — run: pnpm sigillo:login");
    return false;
  }
  report.ok("Sigillo is logged in");
  return true;
}

// A Cloudflare token (ARTIFACTS_API_TOKEN, gq cloudflare ci's, or the
// deploy's CLOUDFLARE_API_TOKEN) from the environment, or from Sigillo
// `staging` when the site maps it and Sigillo is logged in; null when neither
// has it.
async function stagingToken(name, { context, env, exec, sigilloReady }) {
  if (env[name]) return env[name];
  if (!sigilloReady || !context.config.sigillo.environments?.[SECRETS_ENVIRONMENT]) return null;
  try {
    const secrets = await sigilloSecrets({ context, env, exec }, SECRETS_ENVIRONMENT);
    return (await secrets.get(name)) || null;
  } catch {
    return null;
  }
}

// The Site's side of headless forms: what gq sync and src/lib/content.ts
// wire, and Turnstile's keys when the Site chose it. Whether the CMS's forms
// can be sent is gq site check's (--local runs wp gq-forms status).
async function checkForms({ context, env, exec, sigilloReady, report }) {
  const root = context.projectRoot;
  if (existsSync(join(root, FORMS_ROUTE))) report.ok(`${FORMS_ROUTE} handles form posts`);
  else report.fail(`${FORMS_ROUTE} is missing — run: gq sync`);

  const runtime = join(root, FRONTEND_PATH, "src/lib/content.ts");
  const source = existsSync(runtime) ? readFileSync(runtime, "utf8") : "";
  if (/\bforms\s*:\s*(?:true|Boolean\()/u.test(source))
    report.ok("src/lib/content.ts passes forms to the content runtime");
  else {
    report.warn(
      `${FRONTEND_PATH}/src/lib/content.ts doesn't pass forms to createContentRuntime: pages carry no form descriptors, so forms don't render and posts are refused (docs/guides/forms.md)`,
    );
  }

  if (!formSpamControls(context.config).includes("turnstile")) return;
  if (!sigilloReady || !context.config.sigillo?.environments?.[SECRETS_ENVIRONMENT]) {
    return report.skip(`Turnstile's keys not checked: no Sigillo ${SECRETS_ENVIRONMENT}`);
  }
  let names;
  try {
    const secrets = await sigilloSecrets({ context, env, exec }, SECRETS_ENVIRONMENT);
    names = new Set((await secrets.list()).split(/\r?\n/u).map((name) => name.trim()));
  } catch {
    // Sigillo stderr is untrusted output and might contain secret values.
    return report.fail(`could not list Sigillo ${SECRETS_ENVIRONMENT} variable names`);
  }
  const missing = TURNSTILE_KEYS.filter((name) => !names.has(name));
  if (missing.length === 0) report.ok(`Sigillo ${SECRETS_ENVIRONMENT} has Turnstile's keys`);
  else {
    report.fail(
      `gq.ops.json forms.spam chooses Turnstile, but Sigillo ${SECRETS_ENVIRONMENT} lacks ${missing.join(" and ")} (docs/guides/forms.md)`,
    );
  }
}

// Visitors' consent records must stay in the EU (CONSENT-1 CN-R8), and
// Cloudflare can't move a D1 database: one created outside `eu` fails.
async function checkConsentJurisdiction({ config, token, fetch, report }) {
  if (!token) {
    return report.skip(
      `consent database jurisdiction not checked: no CLOUDFLARE_API_TOKEN in the environment or Sigillo ${SECRETS_ENVIRONMENT}`,
    );
  }
  let databases;
  try {
    databases = await listConsentDatabases({
      accountId: config.cloudflare.accountId,
      token,
      fetch,
      project: config.project,
    });
  } catch (error) {
    return report.warn(`could not list the consent databases: ${error.message}`);
  }
  if (databases.length === 0) {
    return report.skip(
      `no consent database yet: a Frontend deploy creates it in ${CONSENT_JURISDICTION} (${consentDatabaseName(config.project)})`,
    );
  }
  for (const { name, jurisdiction } of databases) {
    if (jurisdiction === CONSENT_JURISDICTION) {
      report.ok(`consent database ${name} is in the ${CONSENT_JURISDICTION} jurisdiction`);
      continue;
    }
    report.fail(
      `consent database ${name} is in the ${jurisdiction} jurisdiction, not ${CONSENT_JURISDICTION}: Cloudflare can't move it. ` +
        "Export its records (wrangler d1 export), delete it, redeploy the Frontend to create it in eu, and import them (docs/guides/consent.md)",
    );
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

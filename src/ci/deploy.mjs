// Deploys the site's Cloudflare CI Worker and its secrets with the Worker
// directory's own Wrangler. Runs through
// `gq sigillo run`, so every secret comes from the secret store; they reach
// Wrangler as JSON over stdin, never a file or argv.
//
//   gq ci deploy
//   gq ci runs      # recent CI Workflow runs (wrangler workflows instances list)
//
// The Worker lives in gq.ops.json `ci.directory` (default infra/ci) and is
// named `ci.worker`.

import { join } from "node:path";

import { cmsAccessHeaders } from "../cms/access.mjs";

export const DEFAULT_CI_DIRECTORY = "infra/ci";

// Worker secret ← secret-store secret. R2_* are the CI SDK's snapshot
// credentials; the releases bucket key goes in as RELEASES_R2_*.
export const workerSecrets = Object.freeze({
  CF_TOKEN: "CLOUDFLARE_API_TOKEN",
  R2_ACCESS_KEY_ID: "CI_BACKUP_R2_ACCESS_KEY_ID",
  R2_SECRET_ACCESS_KEY: "CI_BACKUP_R2_SECRET_ACCESS_KEY",
  PLOI_API_TOKEN: "PLOI_API_TOKEN",
  RELEASES_R2_ACCESS_KEY_ID: "R2_ACCESS_KEY_ID",
  RELEASES_R2_SECRET_ACCESS_KEY: "R2_SECRET_ACCESS_KEY",
  // The site's login to the GETQUICK Composer registry.
  COMPOSER_AUTH: "COMPOSER_AUTH",
});

// The GitHub → Artifacts mirror and commit statuses (`gq github setup`), for
// a site whose code lives on GitHub (gq.ops.json `github.repository`). An
// Artifacts-only site pushes to Artifacts itself and needs neither.
export const githubWorkerSecrets = Object.freeze({
  GITHUB_CI_TOKEN: "GITHUB_CI_TOKEN",
  GITHUB_WEBHOOK_SECRET: "GITHUB_WEBHOOK_SECRET",
});

// The same with the GETQUICK CI App (`gq github setup --app`, gq-platform
// ADR 0012): the Worker asks the token broker for a token per run, so it
// holds the broker's URL and its own credential instead of GITHUB_CI_TOKEN.
export const githubAppWorkerSecrets = Object.freeze({
  GQ_CI_BROKER_URL: "GQ_CI_BROKER_URL",
  GQ_CI_BROKER_TOKEN: "GQ_CI_BROKER_TOKEN",
  GITHUB_WEBHOOK_SECRET: "GITHUB_WEBHOOK_SECRET",
});

// Whether the secret store holds the Site's broker credential: App mode.
export function usesGithubApp(environment) {
  return Boolean(environment.GQ_CI_BROKER_URL?.trim() && environment.GQ_CI_BROKER_TOKEN?.trim());
}

// The release step hands these to the Frontend deploy when they are set, so a
// CI release binds the Frontend's refresh token, its publication-event secret
// and its consent read token like `pnpm deploy:frontend` does. A site without
// a publication store or consent records has none of them, and its CI
// deploys without them.
export const optionalWorkerSecrets = Object.freeze({
  FRONTEND_REFRESH_TOKEN: "FRONTEND_REFRESH_TOKEN",
  PUBLICATION_EVENT_SECRET: "PUBLICATION_EVENT_SECRET",
  CONSENT_READ_TOKEN: "CONSENT_READ_TOKEN",
  GQ_PREVIEW_CMS_USERNAME: "GQ_PREVIEW_CMS_USERNAME",
  GQ_PREVIEW_CMS_APPLICATION_PASSWORD: "GQ_PREVIEW_CMS_APPLICATION_PASSWORD",
  GQ_PREVIEW_ACCESS_CLIENT_ID: "GQ_PREVIEW_ACCESS_CLIENT_ID",
  GQ_PREVIEW_ACCESS_CLIENT_SECRET: "GQ_PREVIEW_ACCESS_CLIENT_SECRET",
  GQ_AUTH_GRAPHQL_CLIENT_ID: "GQ_AUTH_GRAPHQL_CLIENT_ID",
  GQ_AUTH_GRAPHQL_CLIENT_SECRET: "GQ_AUTH_GRAPHQL_CLIENT_SECRET",
  TURNSTILE_SECRET_KEY: "TURNSTILE_SECRET_KEY",
  TURNSTILE_SITE_KEY: "TURNSTILE_SITE_KEY",
  GQ_FORMS_ACCESS_CLIENT_ID: "GQ_FORMS_ACCESS_CLIENT_ID",
  GQ_FORMS_ACCESS_CLIENT_SECRET: "GQ_FORMS_ACCESS_CLIENT_SECRET",
  // A commerce Site's storefront Runtime secrets (gq frontend secrets;
  // Turnstile's from Cloudflare), and the read:packages token CI installs
  // @quick-release packages with. A content Site has none of them.
  GETQUICK_STOREFRONT_PROXY_SECRET: "GETQUICK_STOREFRONT_PROXY_SECRET",
  GETQUICK_AUTH_COOKIE_SECRET: "GETQUICK_AUTH_COOKIE_SECRET",
  GETQUICK_CART_SESSION_SECRET: "GETQUICK_CART_SESSION_SECRET",
  TURNSTILE_SECRET: "TURNSTILE_SECRET",
  GITHUB_PACKAGES_TOKEN: "GITHUB_PACKAGES_TOKEN",
});

export function secretsPayload(environment, { github = true } = {}) {
  // Validate the optional pair without sending it anywhere or printing values.
  cmsAccessHeaders({
    env: environment,
    origin: "https://cms.invalid",
    url: "https://cms.invalid/graphql",
  });
  const githubSecrets = usesGithubApp(environment) ? githubAppWorkerSecrets : githubWorkerSecrets;
  const required = { ...workerSecrets, ...(github ? githubSecrets : {}) };
  const missing = Object.values(required).filter((name) => !environment[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing in the secret store: ${missing.join(", ")} (see gq cloudflare ci / cloudflare releases / github setup [--app]).`,
    );
  }
  const optional = Object.entries(optionalWorkerSecrets).filter(([, from]) =>
    environment[from]?.trim(),
  );
  return JSON.stringify(
    Object.fromEntries(
      [...Object.entries(required), ...optional].map(([key, from]) => [key, environment[from]]),
    ),
  );
}

// The CI deploy token (from `gq cloudflare ci`) Wrangler and `gq github
// setup` authenticate with.
export function ciDeployToken(context) {
  const token = context.env.CI_DEPLOY_API_TOKEN;
  if (!token) {
    throw new Error(
      "CI_DEPLOY_API_TOKEN is missing; create it with gq cloudflare ci and run this through gq sigillo run.",
    );
  }
  return token;
}

// The Worker's name, its directory and Wrangler's environment: Wrangler
// authenticates with the CI deploy token only.
export function ciTarget(context, env) {
  const ops = context.config;
  const worker = ops.ci?.worker;
  const accountId = ops.cloudflare?.accountId;
  if (!worker || !accountId) {
    throw new Error("gq.ops.json ci.worker and cloudflare.accountId are required.");
  }
  const token = ciDeployToken(context);
  const directory = context.resolvePath(ops.ci.directory ?? DEFAULT_CI_DIRECTORY);
  return {
    worker,
    directory,
    wrangler: join(directory, "node_modules", ".bin", "wrangler"),
    env: {
      ...env,
      CLOUDFLARE_API_TOKEN: token,
      CLOUDFLARE_ACCOUNT_ID: accountId,
    },
  };
}

async function wrangler(exec, target, args, options) {
  const result = await exec(target.wrangler, args, {
    cwd: target.directory,
    env: target.env,
    ...options,
  });
  if (result.code !== 0) throw new Error(`wrangler ${args.slice(0, 2).join(" ")} failed`);
}

// `gq ci deploy`. Resolves to an exit code.
export async function runCiDeploy({ context, env, exec, io }) {
  const target = ciTarget(context, env);
  const payload = secretsPayload(context.env, {
    github: Boolean(context.config.github?.repository),
  });
  await wrangler(exec, target, ["deploy"], { stdio: "inherit" });
  await wrangler(exec, target, ["secret", "bulk"], {
    input: payload,
    stdout: io.stdout,
    stderr: io.stderr,
  });
  if (context.config.github?.repository && usesGithubApp(context.env)) {
    await retireGithubToken(exec, target, io);
  }
  io.out(`Deployed ${target.worker} with ${Object.keys(JSON.parse(payload)).length} secrets.`);
  return 0;
}

// A Worker moved to the App keeps the GITHUB_CI_TOKEN an earlier deploy set
// (secret bulk only adds): remove it, so no long-lived token stays bound.
async function retireGithubToken(exec, target, io) {
  const listed = await exec(target.wrangler, ["secret", "list", "--format", "json"], {
    cwd: target.directory,
    env: target.env,
  });
  if (listed.code !== 0) throw new Error("wrangler secret list failed");
  const names = JSON.parse(listed.stdout || "[]").map(({ name }) => name);
  if (!names.includes("GITHUB_CI_TOKEN")) return;
  await wrangler(
    exec,
    { ...target, env: { ...target.env, CI: "true" } },
    ["secret", "delete", "GITHUB_CI_TOKEN"],
    { stdout: io.stdout, stderr: io.stderr },
  );
  io.out("Removed GITHUB_CI_TOKEN from the Worker: it gets tokens from the GETQUICK CI broker.");
}

// `gq ci runs`. Resolves to an exit code.
export async function runCiRuns({ context, env, exec }) {
  const target = ciTarget(context, env);
  await wrangler(exec, target, ["workflows", "instances", "list", target.worker], {
    stdio: "inherit",
  });
  return 0;
}

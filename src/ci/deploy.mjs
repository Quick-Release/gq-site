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

// The release step hands these to the Frontend deploy when they are set, so a
// CI release binds the Frontend's refresh token and its publication-event
// secret like `pnpm deploy:frontend` does. A site without a publication store
// has neither, and its CI deploys without them.
export const optionalWorkerSecrets = Object.freeze({
  FRONTEND_REFRESH_TOKEN: "FRONTEND_REFRESH_TOKEN",
  PUBLICATION_EVENT_SECRET: "PUBLICATION_EVENT_SECRET",
});

export function secretsPayload(environment, { github = true } = {}) {
  const required = { ...workerSecrets, ...(github ? githubWorkerSecrets : {}) };
  const missing = Object.values(required).filter((name) => !environment[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing in the secret store: ${missing.join(", ")} (see gq cloudflare ci / cloudflare releases / github setup).`,
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
function ciTarget(context, env) {
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
  io.out(`Deployed ${target.worker} with ${Object.keys(JSON.parse(payload)).length} secrets.`);
  return 0;
}

// `gq ci runs`. Resolves to an exit code.
export async function runCiRuns({ context, env, exec }) {
  const target = ciTarget(context, env);
  await wrangler(exec, target, ["workflows", "instances", "list", target.worker], {
    stdio: "inherit",
  });
  return 0;
}

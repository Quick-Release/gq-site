// The local CMS of a GETQUICK site: the Bedrock app in apps/cms, run by DDEV.
// Every child process goes through run()'s
// `exec`, with run()'s `env`.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

import { applyEnv, parseDotenv } from "../dotenv-text.mjs";
import { runDesignCommand, withDesignRegistryInstall } from "./local-design.mjs";

// Layout: where the Bedrock app lives in a site.
export const CMS_PATH = "apps/cms";

// Astro's dev server, the default local frontend.
export const DEFAULT_LOCAL_FRONTEND_URL = "http://localhost:4321";

export async function commandExists(exec, command, env) {
  // `command -v` is a POSIX sh builtin (macOS and Linux); the name goes in as
  // $1, so it is never spliced into the script.
  const result = await exec("sh", ["-c", 'command -v "$1"', "sh", command], { env });
  return result.code === 0;
}

// Whether the site can run its PHP checks here: Composer installed and the
// CMS's Composer dependencies in apps/cms/vendor.
export async function phpToolchainAvailable(exec, root, env) {
  return existsSync(join(root, CMS_PATH, "vendor")) && (await commandExists(exec, "composer", env));
}

// The DDEV project's status ("running", "paused", …), or null when DDEV can't
// describe it — e.g. it has never been started on this machine.
export async function ddevStatus(exec, cmsRoot, env) {
  const result = await exec("ddev", ["describe", "-j"], { cwd: cmsRoot, env });
  if (result.code !== 0) return null;
  try {
    const payload = JSON.parse(result.stdout);
    const project = Array.isArray(payload) ? payload[0] : (payload?.raw ?? payload);
    return project?.status ?? "unknown";
  } catch {
    return "unknown";
  }
}

export async function describeDdev(exec, cmsRoot, env) {
  const result = await exec("ddev", ["describe", "-j"], { cwd: cmsRoot, env });
  if (result.code !== 0) throw new Error("ddev describe failed; is DDEV running?");
  return JSON.parse(result.stdout).raw;
}

// The Bedrock values DDEV decides: its database credentials and the URL it
// actually serves (http unless mkcert's local CA is installed).
export function ddevEnvValues(project) {
  const db = project.dbinfo ?? {};
  const url = project.primary_url ?? project.urls?.[0];
  if (!url || !db.host) throw new Error("ddev describe did not report a URL and database.");
  return {
    DB_NAME: db.dbname ?? "db",
    DB_USER: db.username ?? "db",
    DB_PASSWORD: db.password ?? "db",
    DB_HOST: db.host,
    WP_HOME: url.replace(/\/+$/u, ""),
  };
}

// Values a local .env gets when it has none yet; an existing value is kept.
// The media URL is the bucket's public one (read-only: no R2 credentials).
export function localEnvDefaults(ops) {
  const defaults = {
    GETQUICK_FRONTEND_URL: ops.local?.frontendUrl ?? DEFAULT_LOCAL_FRONTEND_URL,
  };
  if (ops.media?.domain) defaults.S3_UPLOADS_BUCKET_URL = `https://${ops.media.domain}`;
  return defaults;
}

// Creates apps/cms/.env from .env.example when missing, then points its
// database and URL at the DDEV project `project` (from `ddev describe`).
export function ensureCmsEnv(cmsRoot, project, defaults) {
  const envPath = join(cmsRoot, ".env");
  const created = !existsSync(envPath);
  if (created) copyFileSync(join(cmsRoot, ".env.example"), envPath);
  const source = readFileSync(envPath, "utf8");
  const current = parseDotenv(source);
  const missing = Object.fromEntries(Object.entries(defaults).filter(([key]) => !(key in current)));
  const { output, changed } = applyEnv(source, { ...missing, ...ddevEnvValues(project) });
  if (changed.length > 0) writeFileSync(envPath, output);
  return { created, changed, env: parseDotenv(output) };
}

// Why `composer install` can't run here, or null when it can.
export function installProblem({ composerAuth, hasComposer }, os = platform()) {
  if (!composerAuth) {
    return "COMPOSER_AUTH is missing: run this through gq sigillo run, which holds the GETQUICK registry login.";
  }
  if (!hasComposer) {
    return `Installing needs the host Composer (the registry login doesn't reach DDEV's container). ${
      os === "darwin"
        ? "brew install composer"
        : "sudo apt install composer, or brew install composer"
    }`;
  }
  return null;
}

// Installs exactly what composer.lock pins with the host Composer (db sync).
export function composerInstall(cmsRoot, dependencies) {
  return composerDependencyChange(cmsRoot, ["install", "--no-interaction"], dependencies);
}

// Runs a Composer command that changes dependencies (install, update,
// reinstall) with the host Composer: the GETQUICK plugins come from the
// private registry, whose login (COMPOSER_AUTH) is in run()'s env and doesn't
// reach DDEV's container. A local Design override is unlinked for Composer
// and relinked (with its autoload rebuilt) afterwards, also when Composer
// fails. A failure throws with Composer's exit code as `exitCode`. `stdio`,
// `stdout` and `stderr` go to exec as they are.
export async function composerDependencyChange(
  cmsRoot,
  args,
  { exec, env, stdio, stdout, stderr },
) {
  const problem = installProblem({
    composerAuth: env.COMPOSER_AUTH,
    hasComposer: await commandExists(exec, "composer", env),
  });
  if (problem) throw new Error(problem);
  const options = { cwd: cmsRoot, env, stdio, stdout, stderr };
  let autoload;
  const result = await withDesignRegistryInstall(
    cmsRoot,
    (override) => runDesignCommand(exec, "composer", args, override, options),
    {
      env,
      // Still under the filesystem lock, including when Composer failed.
      // No package scripts run against the checkout, only autoload discovery.
      afterRelink: async (override) => {
        autoload = await runDesignCommand(
          exec,
          "composer",
          ["dump-autoload", "--no-scripts"],
          override,
          options,
        );
      },
    },
  );
  for (const command of [result, autoload].filter(Boolean)) {
    if (command.code !== 0) {
      const error = new Error(`Composer failed (exit ${command.code}).`);
      error.exitCode = command.code;
      throw error;
    }
  }
}

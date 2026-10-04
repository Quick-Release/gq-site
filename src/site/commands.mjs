// `gq site check`: whether a new content Site's resilience guarantee holds
// (readiness.mjs, ADR 0010). The production check runs through gq sigillo run
// staging, which injects the Frontend's refresh token and event key, the Ploi
// token, the media bucket's credentials and the CMS check user's application
// password; none is printed. It runs the media upload probe, which deletes
// what it uploads; everything else is read-only. --local checks this
// machine's CMS instead: a running DDEV isn't a ready CMS. Exits 1 when not
// ready, so the result can gate a script.
//
//   gq site check [--url <frontend origin>] [--json]
//   gq site check --local [--json]

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CMS_PATH, ddevStatus } from "../cms/local.mjs";
import { relaunchWithLocalCa } from "../db/sync.mjs";
import { parseDotenv } from "../dotenv-text.mjs";
import { frontendOrigin } from "../frontend/commands.mjs";
import { siteLanguages } from "../manifest/schema.mjs";
import { localMediaReadiness } from "../media/readiness.mjs";
import { cmsReadiness, notReady, ok, result, siteReadiness } from "./readiness.mjs";

export const SITE_USAGE = [
  "gq site check [--url <frontend origin>] [--json]",
  "gq site check --local [--json]",
];

const MARKS = { ok: "✓", "not-ready": "✗", warn: "⚠", skipped: "–" };

const AREAS = {
  cms: "CMS",
  frontend: "Frontend",
  delivery: "Event delivery",
  media: "Independent media",
};

const SUMMARIES = {
  production: {
    ready:
      "Ready: published content is served from the publication store, refreshed by signed CMS events, retried and reconciled by the CMS's scheduler, and uploads are hosted independently of the CMS.",
    "not-ready":
      "Not ready: the resilience guarantee doesn't hold until the ✗ checks pass. Fix them in order; each says what to run.",
  },
  local: {
    ready:
      "The local CMS is ready for the Frontend (pnpm dev reads it live, without a publication store). That says nothing about production: run pnpm site:check.",
    "not-ready": "The local CMS isn't ready for the Frontend: fix the ✗ checks.",
  },
};

export function isSiteCommand(command) {
  return command.join(" ") === "site check";
}

export function siteCommandOptions(command) {
  return isSiteCommand(command) ? ["url", "local"] : undefined;
}

// Resolves to the exit code: 0 when ready, 1 when not.
export async function runSiteCommand({ argv, context, parsed, env, fetch, exec, io }) {
  if (parsed.local && parsed.url) {
    throw new Error(
      "--local checks this machine's CMS; --url names a deployed Frontend. Pick one.",
    );
  }
  let scope = "production";
  let readiness;
  if (parsed.local) {
    // The local CMS is https on *.ddev.site, signed by mkcert's CA.
    const relaunched = await relaunchWithLocalCa({ argv, context, env, exec });
    if (relaunched !== null) return relaunched;
    scope = "local";
    readiness = await localReadiness({ context, env, fetch, exec });
  } else {
    readiness = await siteReadiness({
      ops: context.config,
      env: context.env,
      fetch,
      origin: parsed.url ? frontendOrigin(parsed, context.config, "/") : undefined,
    });
  }

  if (parsed.json) io.out(JSON.stringify({ scope, ...readiness }, null, 2));
  else printResult(io, scope, readiness);
  return readiness.ready ? 0 : 1;
}

// This machine's CMS: DDEV running is only the start; WordPress must be
// installed with WPGraphQL and the GETQUICK fields the Frontend reads, and
// uploads must stay on disk.
async function localReadiness({ context, env, fetch, exec }) {
  const cmsRoot = join(context.projectRoot, CMS_PATH);
  const cmsEnv = await readIfPresent(join(cmsRoot, ".env"));
  const checks = [];
  const status = await ddevStatus(exec, cmsRoot, env);
  const home = cmsEnv === null ? "" : (parseDotenv(cmsEnv).WP_HOME?.trim() ?? "");
  if (status !== "running") {
    checks.push({
      area: "cms",
      ...notReady(
        "ddev",
        status
          ? `DDEV is ${status}`
          : "DDEV can't describe the CMS project: it was never started here",
        "start the local CMS: pnpm cms:dev",
      ),
    });
  } else if (!home) {
    checks.push({
      area: "cms",
      ...notReady(
        "ddev",
        `DDEV is running, but ${CMS_PATH}/.env has no WP_HOME`,
        "pnpm cms:dev points it at DDEV",
      ),
    });
  } else {
    checks.push({ area: "cms", ...ok("ddev", `DDEV is running and serves ${home}`) });
    checks.push(
      ...(await cmsReadiness({
        graphqlUrl: `${home.replace(/\/+$/u, "")}/wp/graphql`,
        fetch,
        languages: siteLanguages(context.config),
      })),
    );
  }
  const media = localMediaReadiness({ ops: context.config, cmsEnv });
  return result([...checks, ...media.checks.map((check) => ({ area: "media", ...check }))]);
}

function printResult(io, scope, { status, checks }) {
  io.out(`Site readiness (${scope === "local" ? "local development" : "production"})`);
  for (const [area, label] of Object.entries(AREAS)) {
    const inArea = checks.filter((check) => check.area === area);
    if (inArea.length === 0) continue;
    io.out(`${label}:`);
    for (const check of inArea) {
      io.out(`  ${MARKS[check.status]} ${check.name}: ${check.detail}`);
      if (check.action && check.status !== "ok") io.out(`      → ${check.action}`);
    }
  }
  io.out(SUMMARIES[scope][status]);
}

async function readIfPresent(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

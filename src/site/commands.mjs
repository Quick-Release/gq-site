// `gq site check`: whether a new content Site's resilience guarantee holds
// (readiness.mjs, ADR 0010), or a commerce Site's storefront, cart and CMS
// do (commerce-readiness.mjs, ADR 0021). The production check runs through gq sigillo run
// staging, which injects the Frontend's refresh token and event key, the Ploi
// token, the media bucket's credentials and the CMS check user's application
// password (a commerce Site's: the storefront's proxy secret and Turnstile's
// names instead of the Frontend's); none is printed. It runs the media upload probe, which deletes
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
import { siteLanguages, wordpressGraphqlUrl } from "../manifest/schema.mjs";
import { localFormsStatus } from "../forms/readiness.mjs";
import { isCommerce } from "../manifest/variant.mjs";
import { localMediaReadiness } from "../media/readiness.mjs";
import { commerceCmsReadiness, commerceSiteReadiness, themeCheck } from "./commerce-readiness.mjs";
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
  consent: "Consent and legal pages",
  forms: "Forms",
  media: "Independent media",
};

// A commerce Site's Frontend is its storefront (ADR 0017).
const COMMERCE_AREAS = { ...AREAS, frontend: "Storefront" };

const SUMMARIES = {
  production: {
    ready:
      "Ready: published content is served from the publication store, refreshed by signed CMS events, retried and reconciled by the CMS's scheduler, and uploads are hosted independently of the CMS. Every required legal page is assigned, and public pages load nothing from a third party before consent.",
    "not-ready":
      "Not ready: the resilience guarantee doesn't hold until the ✗ checks pass. Fix them in order; each says what to run.",
  },
  local: {
    ready:
      "The local CMS is ready for the Frontend (pnpm dev reads it live, without a publication store). That says nothing about production: run pnpm site:check.",
    "not-ready": "The local CMS isn't ready for the Frontend: fix the ✗ checks.",
  },
};

const COMMERCE_SUMMARIES = {
  production: {
    ready:
      "Ready: the CMS serves WooCommerce's Store API and holds the storefront's proxy secret, the storefront serves its pages uncached and carries a cart through its Worker to WooCommerce and back, its rate limiters are bound, every required legal page is assigned, public pages load nothing from a third party before consent, and uploads are hosted independently of the CMS. Payments, shipping, tax and checkout aren't checked: test an order before taking real ones.",
    "not-ready":
      "Not ready: the shop doesn't hold until the ✗ checks pass. Fix them in order; each says what to run.",
  },
  local: {
    ready:
      "The local CMS is ready for the storefront (vp dev reads its Store API). That says nothing about production: run pnpm site:check.",
    "not-ready": "The local CMS isn't ready for the storefront: fix the ✗ checks.",
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
  const commerce = isCommerce(context.config);
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
    readiness = await localReadiness({ context, env, fetch, exec, commerce });
  } else {
    readiness = await (commerce ? commerceSiteReadiness : siteReadiness)({
      ops: context.config,
      env: context.env,
      fetch,
      origin: parsed.url ? frontendOrigin(parsed, context.config, "/") : undefined,
    });
  }

  if (parsed.json) io.out(JSON.stringify({ scope, ...readiness }, null, 2));
  else printResult(io, scope, readiness, commerce);
  return readiness.ready ? 0 : 1;
}

// This machine's CMS: DDEV running is only the start; WordPress must be
// installed with WPGraphQL and the GETQUICK fields the Frontend reads (a
// commerce CMS: its Store API and the GETQUICK plugins' REST routes), and
// uploads must stay on disk. A Site with `forms` also has Gravity Forms
// active and only forms the Frontend can send (wp gq-forms status).
async function localReadiness({ context, env, fetch, exec, commerce }) {
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
    if (commerce) {
      checks.push(...(await localCommerceCms({ home, cmsRoot, context, env, fetch, exec })));
    } else
      checks.push(
        ...(await cmsReadiness({
          graphqlUrl: wordpressGraphqlUrl(context.config, { localOrigin: home }),
          env: context.env,
          cmsOrigin: context.config.domains?.admin
            ? `https://${context.config.domains.admin}`
            : home,
          fetch,
          languages: siteLanguages(context.config),
        })),
      );
    if (context.config.forms) {
      const status = await exec("ddev", ["wp", "gq-forms", "status", "--format=json"], {
        cwd: cmsRoot,
        env,
      });
      checks.push(...localFormsStatus(status).map((check) => ({ area: "forms", ...check })));
    }
  }
  const media = localMediaReadiness({ ops: context.config, cmsEnv });
  return result([...checks, ...media.checks.map((check) => ({ area: "media", ...check }))]);
}

// A local commerce CMS: its REST API, plugins and Store API as in production,
// and its theme by wp-cli (no check user locally). The proxy secret and the
// storefront are production's: vp dev has no Worker bindings.
async function localCommerceCms({ home, cmsRoot, context, env, fetch, exec }) {
  const { checks } = await commerceCmsReadiness({
    origin: new URL(home),
    env: context.env,
    fetch,
    local: true,
  });
  if (!checks.some((check) => check.name === "wordpress" && check.status === "ok")) return checks;
  const theme = await exec(
    "ddev",
    [
      "wp",
      "eval",
      'echo wp_json_encode(["stylesheet" => get_stylesheet(), "template" => get_template()]);',
    ],
    { cwd: cmsRoot, env },
  );
  let active;
  try {
    active = theme.code === 0 ? JSON.parse(theme.stdout.trim()) : null;
  } catch {
    active = null;
  }
  checks.push({
    area: "cms",
    ...(active
      ? themeCheck(active)
      : notReady(
          "theme",
          "wp-cli couldn't read the local CMS's active theme",
          "pnpm cms:dev, then check again",
        )),
  });
  return checks;
}

function printResult(io, scope, { status, checks }, commerce) {
  io.out(`Site readiness (${scope === "local" ? "local development" : "production"})`);
  for (const [area, label] of Object.entries(commerce ? COMMERCE_AREAS : AREAS)) {
    const inArea = checks.filter((check) => check.area === area);
    if (inArea.length === 0) continue;
    io.out(`${label}:`);
    for (const check of inArea) {
      io.out(`  ${MARKS[check.status]} ${check.name}: ${check.detail}`);
      if (check.action && check.status !== "ok") io.out(`      → ${check.action}`);
    }
  }
  io.out((commerce ? COMMERCE_SUMMARIES : SUMMARIES)[scope][status]);
}

async function readIfPresent(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

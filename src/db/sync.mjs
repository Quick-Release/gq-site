// Copies the live WordPress database into the local DDEV project, one way
// only (live → local) (Lombardi's scripts/db-sync.mjs and db-sync-run.mjs):
//
//   1. back up the live database to R2: a Ploi one-off script runs
//      `wp db export` on the server and uploads it through a short-lived
//      presigned PUT URL (no SSH, no R2 credentials on the server)
//   2. download that backup, check its size and checksum
//   3. install composer.lock (WordPress core and plugins), snapshot the local
//      database, then import the backup
//   4. search-replace the live admin/frontend URLs with the local ones
//   5. create (or reset) the local administrator, run `wp core update-db`,
//      install the language packs of gq.ops.json's wordpress.locale, and
//      check the site and the WordPress version
//
// Nothing here writes to the live database: the only command sent to Ploi is
// the export script, which is checked for write commands before it is sent,
// and the import only ever targets the site's DDEV project after its .env is
// confirmed to be a local DDEV one. No command of gq sends a database the
// other way.
//
//   gq db sync           # confirm, then back up and import
//   gq db sync --yes     # no prompt (non-TTY)
//   gq db backup         # back up the live database to R2 only

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  CMS_PATH,
  DEFAULT_LOCAL_FRONTEND_URL,
  commandExists,
  composerInstall,
  ddevStatus,
  describeDdev,
  ensureCmsEnv,
  localEnvDefaults,
} from "../cms/local.mjs";
import { syncLocalDesign } from "../cms/local-design.mjs";
import { createPloiServerClient } from "../ploi/server-client.mjs";
import { createR2Client } from "../r2.mjs";
import { createReporter } from "../cli/reporter.mjs";

const gqBin = fileURLToPath(new URL("../../bin/gq.mjs", import.meta.url));

// Anything that could change a database. The export script must match none
// of these; it is the one command db sync ever runs on the server.
const writeCommandPatterns = [
  /\bwp\s+db\s+(?:import|reset|query|drop|create|clean|repair|optimize)\b/u,
  /\bsearch-replace\b/u,
  /\bwp\s+(?:user|option|post|site|plugin|theme|eval)\b/u,
  /\bwp\s+core\s+(?!version\b)/u,
  /\bmysql(?:admin)?\b/u,
];

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function timestamp(date = new Date()) {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/u, "Z")
    .replaceAll(":", "-");
}

export function backupKey(prefix, database, date = new Date()) {
  return `${prefix}${database}/${timestamp(date)}.sql.gz`;
}

// Ploi's default site path is /home/<system user>/<domain>.
export function sitePath({ systemUser, domain, projectRoot = "/" }) {
  const root = projectRoot.replace(/^\/+|\/+$/gu, "");
  return `/home/${systemUser}/${domain}${root ? `/${root}` : ""}`;
}

// `<PROJECT>_DB_EXPORT`, named after gq.ops.json `project` like the deploy
// status line, so Lombardi's LOMBARDI_DB_EXPORT is unchanged.
export function exportMarker(project) {
  return `${String(project)
    .toUpperCase()
    .replace(/[^A-Z0-9]/gu, "_")}_DB_EXPORT`;
}

export function remoteExportScript({ path, uploadUrl, marker }) {
  return `set -euo pipefail
umask 077
cd ${shellQuote(`${path}/${CMS_PATH}`)}
dump="$(mktemp)"
trap 'rm -f "$dump"' EXIT
prefix="$(wp db prefix)"
wordpress="$(wp core version)"
wp db export - --single-transaction --quick | gzip -c > "$dump"
curl -fsS --retry 3 -X PUT -T "$dump" ${shellQuote(uploadUrl)}
echo "${marker}=success PREFIX=$prefix WORDPRESS=$wordpress BYTES=$(wc -c < "$dump" | tr -d ' ') SHA256=$(sha256sum "$dump" | cut -d ' ' -f 1)"
`;
}

export function assertExportOnly(script) {
  const match = writeCommandPatterns.find((pattern) => pattern.test(script));
  if (match) {
    throw new Error(`Refusing to run a server script that can write to the database (${match}).`);
  }
  return script;
}

export function parseExportMarker(output, marker) {
  const match = new RegExp(
    `${marker}=success PREFIX=(\\S+) WORDPRESS=(\\S+) BYTES=(\\d+) SHA256=([0-9a-f]{64})`,
    "u",
  ).exec(output ?? "");
  return match
    ? { prefix: match[1], wordpress: match[2], bytes: Number(match[3]), sha256: match[4] }
    : null;
}

// The import target must be this checkout's DDEV database; anything else in
// apps/cms/.env (a remote DB_HOST, a live URL, a production WP_ENV) stops the
// sync before it touches a database.
export function assertLocalTarget(env, { liveDomains }) {
  const problems = [];
  if (env.DB_HOST !== "db")
    problems.push(`DB_HOST is '${env.DB_HOST ?? ""}', expected DDEV's 'db'`);
  if (["production", "staging"].includes(env.WP_ENV)) problems.push(`WP_ENV is '${env.WP_ENV}'`);
  let host = "";
  try {
    host = new URL(env.WP_HOME).hostname;
  } catch {
    problems.push("WP_HOME is not a URL");
  }
  if (host && !host.endsWith(".ddev.site"))
    problems.push(`WP_HOME host ${host} is not *.ddev.site`);
  if (liveDomains.includes(host)) problems.push(`WP_HOME points at the live site ${host}`);
  if (problems.length > 0) {
    throw new Error(`${CMS_PATH}/.env is not a local DDEV setup: ${problems.join("; ")}.`);
  }
  return { homeUrl: env.WP_HOME.replace(/\/+$/u, ""), prefix: env.DB_PREFIX || "wp_" };
}

// Live URLs in both schemes, plain and JSON-escaped (block attributes and
// options often store `https:\/\/…`), to their local equivalents.
export function searchReplacePairs({
  liveAdminDomain,
  localAdminUrl,
  liveFrontendDomain,
  localFrontendUrl,
}) {
  const escape = (url) => url.replaceAll("/", "\\/");
  return [
    [liveAdminDomain, localAdminUrl],
    [liveFrontendDomain, localFrontendUrl],
  ].flatMap(([domain, local]) =>
    ["https", "http"].flatMap((scheme) => {
      const live = `${scheme}://${domain}`;
      return [
        [live, local],
        [escape(live), escape(local)],
      ];
    }),
  );
}

// The local administrator db sync creates or resets. `dev` / `dev` is the
// GETQUICK convention; the address is the site's (gq.ops.json
// `local.adminEmail`), since it decides what gq-config shows the admin.
export function localAdmin(ops) {
  return { login: "dev", password: "dev", email: ops.local.adminEmail };
}

// Every gq.ops.json value the command reads, checked before anything runs.
function readConfig(ops, { backupOnly }) {
  const required = [
    ["backups.bucket", ops.backups?.bucket],
    ["domains.admin", ops.domains?.admin],
    ["ploi.serverId", ops.ploi?.serverId],
    ["ploi.systemUser", ops.ploi?.systemUser],
    ["ploi.database", ops.ploi?.database],
    ["cloudflare.accountId", ops.cloudflare?.accountId],
  ];
  if (!backupOnly) {
    required.push(
      ["domains.frontend", ops.domains?.frontend],
      ["local.adminEmail", ops.local?.adminEmail],
    );
  }
  const missing = required.filter(([, value]) => !value).map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(
      `gq.ops.json ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} required.`,
    );
  }
  return {
    bucket: ops.backups.bucket,
    prefix: ops.backups.prefix ?? "db/",
    localFrontendUrl: ops.local?.frontendUrl ?? DEFAULT_LOCAL_FRONTEND_URL,
  };
}

// `gq db backup`. Resolves to an exit code.
export function runBackup(dependencies) {
  return runDatabase({ ...dependencies, backupOnly: true });
}

// `gq db sync [--yes]`. Resolves to an exit code.
export async function runSync(dependencies) {
  const relaunched = await relaunchWithLocalCa(dependencies);
  if (relaunched !== null) return relaunched;
  return runDatabase({ ...dependencies, backupOnly: false });
}

// Node reads NODE_EXTRA_CA_CERTS only at startup, and the sync ends by asking
// the local site (https on *.ddev.site, signed by mkcert's CA) for GraphQL.
// So, as Lombardi's db-sync-run.mjs did, gq relaunches itself with mkcert's
// public CA (never its private key) rather than disabling TLS checks.
// Resolves to the relaunched command's exit code, or null to go on here.
export async function relaunchWithLocalCa({ argv, context, env, exec }) {
  if (env.NODE_EXTRA_CA_CERTS) return null;
  const caRoot = await exec("mkcert", ["-CAROOT"], { env }).catch(() => null);
  const root = caRoot?.code === 0 ? caRoot.stdout.trim() : "";
  const certificate = root && join(root, "rootCA.pem");
  if (!certificate || !existsSync(certificate)) return null;
  const result = await exec(process.execPath, [gqBin, ...argv], {
    cwd: context.invocationDirectory,
    env: { ...env, NODE_EXTRA_CA_CERTS: certificate },
    stdio: "inherit",
  });
  return result.code;
}

async function runDatabase({ context, parsed, env, fetch, exec, io, interactive, backupOnly }) {
  const ops = context.config;
  const config = readConfig(ops, { backupOnly });
  const cmsRoot = join(context.projectRoot, CMS_PATH);
  const ui = createReporter(io, interactive);
  const ddev = ddevRunner(exec, cmsRoot, env, io);

  // Check the local target before anything runs on the server.
  let local;
  if (!backupOnly) {
    if (!(await commandExists(exec, "ddev", env))) {
      throw new Error("DDEV is required: https://ddev.com/get-started/");
    }
    if ((await ddevStatus(exec, cmsRoot, env)) !== "running") {
      ui.info("Starting DDEV");
      syncLocalDesign(cmsRoot, env);
      await ddev(["start"]);
    }
    const {
      created,
      changed,
      env: cmsEnv,
    } = ensureCmsEnv(cmsRoot, await describeDdev(exec, cmsRoot, env), localEnvDefaults(ops));
    if (created) ui.info(`Created ${CMS_PATH}/.env from .env.example.`);
    if (changed.length > 0) ui.info(`Set ${changed.join(", ")} in ${CMS_PATH}/.env from DDEV.`);
    local = assertLocalTarget(cmsEnv, { liveDomains: [ops.domains.admin, ops.domains.frontend] });
  }

  ui.intro(`Database sync · ${ops.domains.admin} → ${local?.homeUrl ?? "R2 backup only"}`);
  if (!backupOnly && !parsed.yes) {
    if (!interactive)
      throw new Error("Pass --yes to replace the local database non-interactively.");
    const confirmed = await ui.confirm(
      `Replace the local database with ${ops.ploi.database} from ${ops.domains.admin}? (A DDEV snapshot is taken first.)`,
    );
    if (!confirmed) {
      ui.outro("Nothing changed.");
      return 0;
    }
  }

  const r2 = createR2Client({
    accountId: ops.cloudflare.accountId,
    bucket: config.bucket,
    accessKeyId: context.env.R2_ACCESS_KEY_ID,
    secretAccessKey: context.env.R2_SECRET_ACCESS_KEY,
    fetch,
  });
  const client = createPloiServerClient({
    token: context.env.PLOI_API_TOKEN,
    serverId: ops.ploi.serverId,
    fetch,
  });
  const key = backupKey(config.prefix, ops.ploi.database);
  const step = ui.spinner();
  let workDir;

  try {
    step.start("Backing up the live database to R2");
    const backup = await exportLiveDatabase(client, ops, await r2.presignPut(key));
    step.stop(
      `Backed up the live database (${(backup.bytes / 1024 / 1024).toFixed(1)} MB) to ${key}`,
    );
    if (backupOnly) {
      ui.outro(`r2://${config.bucket}/${key}`);
      return 0;
    }
    if (backup.prefix !== local.prefix) {
      throw new Error(
        `The live table prefix is '${backup.prefix}' but ${CMS_PATH}/.env DB_PREFIX is '${local.prefix}'.`,
      );
    }

    step.start("Downloading the backup");
    workDir = await mkdtemp(join(tmpdir(), `${ops.project ?? "gq"}-db-sync-`));
    const dumpPath = join(workDir, "live.sql.gz");
    const response = await r2.get(key);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(dumpPath, { mode: 0o600 }));
    const { size } = await stat(dumpPath);
    if (size !== backup.bytes || (await sha256File(dumpPath)) !== backup.sha256) {
      throw new Error("The downloaded backup does not match what the server uploaded.");
    }
    step.stop("Downloaded and verified the backup");

    // WordPress core and plugins are files, not database rows: install
    // exactly what composer.lock pins (what a release deploys) before the
    // import, so the live data lands on the same code.
    ui.info("Installing composer.lock (WordPress core and plugins)");
    await composerInstall(cmsRoot, { exec, env, stdout: io.stdout, stderr: io.stderr });

    const snapshot = `pre-db-sync-${timestamp()}`;
    ui.info(`Snapshotting the local database as ${snapshot}`);
    await ddev(["snapshot", "--name", snapshot]);

    ui.info("Importing the live database into DDEV");
    await ddev(["import-db", `--file=${dumpPath}`]);

    ui.info("Replacing live URLs with local ones");
    for (const [from, to] of searchReplacePairs({
      liveAdminDomain: ops.domains.admin,
      localAdminUrl: local.homeUrl,
      liveFrontendDomain: ops.domains.frontend,
      localFrontendUrl: config.localFrontendUrl,
    })) {
      await ddev([
        "wp",
        "search-replace",
        from,
        to,
        "--all-tables-with-prefix",
        "--skip-columns=guid",
        "--report-changed-only",
        "--quiet",
      ]);
    }

    const admin = localAdmin(ops);
    ui.info(`Setting up the ${admin.login} administrator`);
    const exists = await exec("ddev", ["wp", "user", "get", admin.login, "--field=ID"], {
      cwd: cmsRoot,
      env,
    });
    if (exists.code === 0) {
      await ddev([
        "wp",
        "user",
        "update",
        admin.login,
        `--user_pass=${admin.password}`,
        `--user_email=${admin.email}`,
        "--role=administrator",
        "--skip-email",
        "--quiet",
      ]);
    } else {
      await ddev([
        "wp",
        "user",
        "create",
        admin.login,
        admin.email,
        "--role=administrator",
        `--user_pass=${admin.password}`,
        "--quiet",
      ]);
    }
    await ddev(["wp", "cache", "flush", "--quiet"]);
    await ddev(["wp", "rewrite", "flush", "--quiet"]);
    await ddev(["wp", "core", "update-db", "--quiet"]);
    await installLanguagePacks({ ddev, exec, cmsRoot, env, ui }, ops.wordpress?.locale);

    const localWordpress = (await ddev(["wp", "core", "version"], { capture: true })).trim();
    if (localWordpress !== backup.wordpress) {
      ui.warn(
        `composer.lock pins WordPress ${localWordpress}, but live runs ${backup.wordpress}. ` +
          "Composer can only install the locked version: pull main if live is ahead, or release if it is behind.",
      );
    }

    step.start(`Checking ${local.homeUrl}`);
    await verifyLocalSite({ ddev, fetch, homeUrl: local.homeUrl, admin });
    step.stop(
      `${local.homeUrl} serves the live content; ${admin.login} / ${admin.password} can log in`,
    );

    ui.note(
      [
        `${local.homeUrl}/wp/wp-admin — ${admin.login} / ${admin.password}`,
        `Live backup: r2://${config.bucket}/${key}`,
        `Undo: ddev snapshot restore ${snapshot} (in ${CMS_PATH})`,
      ].join("\n"),
      "Synced",
    );
    ui.outro("The local database is a copy of live.");
    return 0;
  } catch (error) {
    step.error("Database sync failed");
    throw error;
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }
}

// The live database names the site's language (WPLANG), but language packs
// are files the CMS deploy installs on the server, not rows: install
// gq.ops.json's wordpress.locale here too, or the local admin falls back to
// English. A missing plugin or theme translation only warns, as on deploy.
async function installLanguagePacks({ ddev, exec, cmsRoot, env, ui }, locale) {
  if (!locale || locale === "en_US") return;
  ui.info(`Installing the ${locale} language packs`);
  await ddev(["wp", "language", "core", "install", locale, "--quiet"]);
  for (const kind of ["plugin", "theme"]) {
    const args = ["wp", "language", kind, "install", "--all", locale, "--quiet"];
    if ((await exec("ddev", args, { cwd: cmsRoot, env })).code !== 0) {
      ui.warn(`Some ${kind} translations for ${locale} are not available.`);
    }
  }
}

// ddev in the site's CMS directory. Its output goes to run()'s streams as it
// arrives, unless `capture` asks for it back.
function ddevRunner(exec, cmsRoot, env, io) {
  return async (args, { capture = false } = {}) => {
    const result = await exec(
      "ddev",
      args,
      capture ? { cwd: cmsRoot, env } : { cwd: cmsRoot, env, stdout: io.stdout, stderr: io.stderr },
    );
    if (result.code !== 0) {
      const detail = capture ? `: ${(result.stderr || result.stdout).trim()}` : "";
      throw new Error(`ddev ${args.slice(0, 2).join(" ")} failed${detail}`);
    }
    return result.stdout;
  };
}

// Dumps the live database on the server (a Ploi one-off script, export only)
// and uploads it to `uploadUrl`, a presigned PUT; resolves to what the
// server reports: { prefix, wordpress, bytes, sha256 }.
export function exportLiveDatabase(client, ops, uploadUrl) {
  const marker = exportMarker(ops.project);
  const script = remoteExportScript({
    path: sitePath({
      systemUser: ops.ploi.systemUser,
      domain: ops.domains.admin,
      projectRoot: ops.ploi.projectRoot,
    }),
    uploadUrl,
    marker,
  });
  return runExport(client, script, { user: ops.ploi.systemUser, marker });
}

async function runExport(client, script, { user, marker, pollMs = 3000, timeoutMs = 900_000 }) {
  const started = await client.request("POST", "/scripts/run", {
    content: assertExportOnly(script),
    user,
  });
  const id = started.data?.id ?? started.id;
  if (!id) throw new Error("Ploi did not return a script execution id.");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const execution = (await client.request("GET", `/scripts/run/${id}`)).data ?? {};
    if (execution.status === "failed") throw new Error("Ploi could not run the export script.");
    if (execution.status === "finished") {
      const result = parseExportMarker(execution.output, marker);
      if (execution.exit_code === 0 && result) return result;
      const tail = (execution.output ?? "").trim().split("\n").slice(-15).join("\n");
      throw new Error(`The export failed (exit ${execution.exit_code}):\n${tail}`);
    }
    await sleep(pollMs);
  }
  throw new Error("The export did not finish within 15 minutes.");
}

// Confirms the import from both sides: WordPress (in DDEV, through the .env
// credentials) sees the local URL and a working local administrator, and the
// site answers GraphQL over HTTP from the host.
async function verifyLocalSite({ ddev, fetch, homeUrl, admin }) {
  const php = `$user = get_user_by("login", ${JSON.stringify(admin.login)});
echo wp_json_encode([
  "home" => get_option("home"),
  "dev" => $user && wp_check_password(${JSON.stringify(admin.password)}, $user->user_pass, $user->ID) && user_can($user, "manage_options"),
]);`;
  const state = JSON.parse((await ddev(["wp", "eval", php], { capture: true })).trim());
  if (state.home !== homeUrl) {
    throw new Error(
      `The home option is ${state.home}, expected ${homeUrl}; the search-replace missed it.`,
    );
  }
  if (!state.dev) {
    throw new Error(`${admin.login} / ${admin.password} is not a working administrator.`);
  }

  const response = await fetch(
    `${homeUrl}/wp/graphql?query=${encodeURIComponent("{generalSettings{url}}")}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.data?.generalSettings) {
    throw new Error(
      `${homeUrl}/wp/graphql answered ${response.status}; open ${homeUrl} to see why.`,
    );
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

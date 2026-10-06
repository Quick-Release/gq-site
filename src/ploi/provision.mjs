// Provisions a site's admin on Ploi from gq.ops.json, idempotently: system user → site → custom deployments (no
// git) → database + .env → deploy script → SSL. Every resource is looked up
// first and only created when missing; nothing that already exists is
// recreated or overwritten. Deploys are `gq ploi release` (release archive on
// R2).
//
//   gq ploi provision              # inspect, show the plan, confirm, apply
//   gq ploi provision --dry-run    # inspect and show the plan only
//   gq ploi provision --yes        # apply without prompting (CI/non-TTY)

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { updateManifest } from "../manifest/manifest.mjs";
import { createReporter } from "../cli/reporter.mjs";
import { createPloiServerClient } from "./server-client.mjs";

const placeholderPattern = /replace-me|replace-with/u;
// Layout default; gq.ops.json ploi.envTemplate overrides it.
const defaultEnvTemplate = "apps/cms/.env.production.example";

export function normalizePloiPath(value) {
  return `/${String(value ?? "")
    .trim()
    .replace(/^\/+|\/+$/gu, "")}`;
}

// `configPath` is the gq.ops.json a new site ID is recorded in (it may be one
// chosen with --config); `root` is the site root other paths resolve from.
export function readProvisionConfig(root, ops, configPath = join(root, "gq.ops.json")) {
  const ploi = ops.ploi ?? {};
  for (const key of ["serverId", "systemUser", "webDirectory", "deployScript"]) {
    if (!ploi[key]) throw new Error(`gq.ops.json ploi.${key} is required.`);
  }
  if (!ops.domains?.admin || !ops.domains?.frontend) {
    throw new Error("gq.ops.json domains.admin and domains.frontend are required.");
  }

  return {
    root,
    configPath,
    project: ops.project,
    domain: ops.domains.admin,
    frontendDomain: ops.domains.frontend,
    serverId: String(ploi.serverId),
    siteId: ploi.siteId ? String(ploi.siteId) : "",
    systemUser: ploi.systemUser,
    projectRoot: normalizePloiPath(ploi.projectRoot ?? "/"),
    webDirectory: normalizePloiPath(ploi.webDirectory),
    database: ploi.database ?? `${ops.project}_staging`,
    deployScriptPath: ploi.deployScript,
    deployScript: readFileSync(join(root, ploi.deployScript), "utf8"),
    envTemplate: readFileSync(join(root, ploi.envTemplate ?? defaultEnvTemplate), "utf8"),
  };
}

// URLs come from gq.ops.json domains, so the template's values never drift
// from the configured admin/frontend hostnames.
export function renderEnv(
  template,
  {
    database,
    password,
    adminDomain,
    frontendDomain,
    secret = () => randomBytes(48).toString("base64url"),
  },
) {
  const env = template
    .replace(/^WP_HOME=.*$/mu, `WP_HOME='https://${adminDomain}'`)
    .replace(/^GRAPHQL_CORS_ORIGINS=.*$/mu, `GRAPHQL_CORS_ORIGINS='https://${frontendDomain}'`)
    .replace(/^GETQUICK_FRONTEND_URL=.*$/mu, `GETQUICK_FRONTEND_URL='https://${frontendDomain}'`)
    .replace(/^DB_NAME=.*$/mu, `DB_NAME='${database}'`)
    .replace(/^DB_USER=.*$/mu, `DB_USER='${database}'`)
    .replace(/^DB_PASSWORD=.*$/mu, `DB_PASSWORD='${password}'`)
    .replace(/^([A-Z_]+(?:KEY|SALT))='replace-me'$/gmu, (_, key) => `${key}='${secret()}'`);
  if (placeholderPattern.test(env)) {
    throw new Error("The .env template still has placeholders after rendering.");
  }
  return env;
}

export function isEnvReady(env, database) {
  return (
    typeof env === "string" &&
    env.includes(`DB_NAME='${database}'`) &&
    !placeholderPattern.test(env)
  );
}

export async function inspect(client, config, resolveHost) {
  const server = (await client.request("GET", "")).data ?? {};
  const [users, sites, databases] = await Promise.all([
    client.list("/system-users"),
    client.list("/sites"),
    client.list("/databases"),
  ]);

  const state = {
    serverIp: server.ip_address,
    systemUser: users.find((user) => user.name === config.systemUser) ?? null,
    site: sites.find((site) => site.domain === config.domain) ?? null,
    database: databases.find((database) => database.name === config.database) ?? null,
    repository: null,
    envReady: false,
    deployScript: null,
    certificate: null,
    dnsAddresses: [],
  };

  try {
    state.dnsAddresses = (await resolveHost(config.domain, { all: true })).map(
      (entry) => entry.address,
    );
  } catch {
    state.dnsAddresses = [];
  }

  if (state.site) {
    const id = state.site.id;
    const [site, repository, env, deployScript, certificates] = await Promise.all([
      client.request("GET", `/sites/${id}`),
      client.request("GET", `/sites/${id}/repository`, undefined, { allowNotFound: true }),
      // A new site has no .env file yet; Ploi answers 404.
      client.request("GET", `/sites/${id}/env`, undefined, { allowNotFound: true }),
      client.request("GET", `/sites/${id}/deploy/script`),
      client.list(`/sites/${id}/certificates`),
    ]);
    state.site = site.data ?? state.site;
    state.repository = repository?.data?.repository ?? null;
    state.envReady = isEnvReady(env?.data ?? env?.env, config.database);
    state.deployScript = deployScript.deploy_script ?? "";
    state.certificate =
      certificates.find((certificate) => certificate.type === "letsencrypt") ?? null;
  }

  return state;
}

// Each entry: kind "ok" (already provisioned), "create"/"update" (will
// change Ploi or gq.ops.json), or "warn" (needs a human; never automated).
export function planActions(config, state) {
  const plan = [];
  const add = (kind, id, title) => plan.push({ kind, id, title });

  if (state.systemUser) add("ok", "system-user", `system user ${config.systemUser}`);
  else add("create", "system-user", `system user ${config.systemUser} (no sudo)`);

  const site = state.site;
  if (!site) {
    add(
      "create",
      "site",
      `site ${config.domain} → ${config.webDirectory}, runs as ${config.systemUser}`,
    );
  } else {
    add("ok", "site", `site ${config.domain} (${site.id})`);
    if (String(site.id) !== config.siteId) {
      add(
        "update",
        "record-site-id",
        `gq.ops.json ploi.siteId ${config.siteId || "(unset)"} → ${site.id}`,
      );
    }
    if (site.system_user !== config.systemUser) {
      add(
        "warn",
        "site-user",
        `site runs as ${site.system_user}, not ${config.systemUser}; delete and re-run to recreate it`,
      );
    }
    const drift = {};
    if (normalizePloiPath(site.web_directory) !== config.webDirectory)
      drift.web_directory = config.webDirectory;
    if (normalizePloiPath(site.project_root) !== config.projectRoot)
      drift.project_root = config.projectRoot;
    if (Object.keys(drift).length > 0) {
      add("update", "site-paths", `site paths → ${Object.values(drift).join(", ")}`);
    }
  }

  // No git host: Ploi runs the deploy script as a custom deployment and the
  // script downloads the release archive from R2 (gq ploi release).
  const custom = "custom deployments (no git; releases come from R2)";
  if (state.repository?.provider === "none") add("ok", "deployments", custom);
  else if (state.repository) {
    const linked = `${state.repository.user}/${state.repository.name}`;
    add("update", "deployments", `switch from git (${linked}) to ${custom}, keeping the site .env`);
  } else add("create", "deployments", custom);

  if (!state.database) {
    add(
      "create",
      "database",
      `database ${config.database} + site .env (generated password and salts)`,
    );
  } else if (site && state.envReady) {
    add("ok", "database", `database ${config.database} and site .env`);
  } else if (site) {
    // The password can't be read back, so recreate the database user with a
    // new one and write a fresh .env; the database and its data are kept.
    add(
      "update",
      "database-credentials",
      `database ${config.database} exists but the site .env doesn't use it: recreate its user with a new password and write the .env (data kept)`,
    );
  }

  if (site && state.deployScript?.trim() === config.deployScript.trim()) {
    add("ok", "deploy-script", `deploy script matches ${config.deployScriptPath}`);
  } else {
    add("update", "deploy-script", `deploy script ← ${config.deployScriptPath}`);
  }

  const dnsReady = Boolean(state.serverIp) && state.dnsAddresses.includes(state.serverIp);
  if (state.certificate) add("ok", "certificate", `SSL certificate (${state.certificate.status})`);
  else if (dnsReady) add("create", "certificate", `Let's Encrypt certificate for ${config.domain}`);
  else
    add(
      "warn",
      "certificate",
      `no SSL yet: ${config.domain} does not resolve to ${state.serverIp ?? "the server"}; add the DNS record, then re-run`,
    );

  return plan;
}

async function waitFor(check, { timeoutMs, intervalMs = 5000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(intervalMs);
  }
  return null;
}

export async function applyAction(action, context) {
  const { client, config, state } = context;
  const siteId = () => state.site.id;

  switch (action.id) {
    case "system-user": {
      state.systemUser = (
        await client.request("POST", "/system-users", { name: config.systemUser, sudo: false })
      ).data;
      return;
    }
    case "site": {
      const created = await client.request("POST", "/sites", {
        root_domain: config.domain,
        web_directory: config.webDirectory,
        project_root: config.projectRoot,
        system_user: config.systemUser,
      });
      state.site = created.data;
      const active = await waitFor(
        async () => {
          const site = (await client.request("GET", `/sites/${siteId()}`)).data;
          return site?.status === "active" ? site : null;
        },
        { timeoutMs: 180_000, intervalMs: context.pollMs ?? 5000 },
      );
      if (!active) throw new Error(`Site ${siteId()} did not become active within 3 minutes.`);
      state.site = active;
      await recordSiteId(config, siteId());
      return;
    }
    case "record-site-id":
      await recordSiteId(config, siteId());
      return;
    case "site-paths":
      await client.request("PATCH", `/sites/${siteId()}`, {
        web_directory: config.webDirectory,
        project_root: config.projectRoot,
      });
      return;
    case "deployments": {
      // Removing the git repository may reset the site directory, so the
      // Ploi-managed .env (database credentials, salts) is restored after.
      const envPath = `/sites/${siteId()}/env`;
      const readEnv = async () => {
        const response = await client.request("GET", envPath, undefined, { allowNotFound: true });
        return response?.data ?? response?.env ?? null;
      };
      const env = state.repository ? await readEnv() : null;
      try {
        if (state.repository) {
          await client.request("DELETE", `/sites/${siteId()}/repository`);
          // Removal is asynchronous; Ploi answers 422 until it has finished.
          const removed = await waitFor(
            async () =>
              !(
                await client.request("GET", `/sites/${siteId()}/repository`, undefined, {
                  allowNotFound: true,
                })
              )?.data?.repository,
            { timeoutMs: 120_000, intervalMs: context.pollMs ?? 5000 },
          );
          if (!removed)
            throw new Error("Ploi did not finish removing the git repository in 2 minutes.");
        }
        await client.request("POST", `/sites/${siteId()}/repository/custom-deployments`, {});
        state.repository = { provider: "none" };
      } finally {
        // Runs even if the switch failed half-way: never leave the site
        // without its .env.
        if (typeof env === "string" && env.trim() && (await readEnv()) !== env) {
          await client.request("PATCH", envPath, { content: env });
        }
      }
      return;
    }
    case "database-credentials": {
      const password = randomBytes(24).toString("base64url");
      const env = renderEnv(config.envTemplate, {
        database: config.database,
        password,
        adminDomain: config.domain,
        frontendDomain: config.frontendDomain,
      });
      const usersPath = `/databases/${state.database.id}/users`;
      const findUser = async () =>
        ((await client.request("GET", usersPath)).data ?? []).find(
          (user) => user.user === config.database,
        );
      // .env first, as for a new database: a failed run can simply be re-run.
      await client.request("PATCH", `/sites/${siteId()}/env`, { content: env });
      const existing = await findUser();
      if (existing) {
        await client.request("DELETE", `${usersPath}/${existing.id}`);
        const gone = await waitFor(async () => !(await findUser()), {
          timeoutMs: 120_000,
          intervalMs: context.pollMs ?? 5000,
        });
        if (!gone)
          throw new Error(`Ploi did not remove database user ${config.database} in 2 minutes.`);
      }
      await client.request("POST", usersPath, { user: config.database, password });
      state.envReady = true;
      return;
    }
    case "database": {
      // Write the .env before creating the database: if the database call
      // fails, a re-run regenerates both; the reverse order would lose the
      // password.
      const password = randomBytes(24).toString("base64url");
      const env = renderEnv(config.envTemplate, {
        database: config.database,
        password,
        adminDomain: config.domain,
        frontendDomain: config.frontendDomain,
      });
      await client.request("PATCH", `/sites/${siteId()}/env`, { content: env });
      state.database = (
        await client.request("POST", "/databases", {
          name: config.database,
          user: config.database,
          password,
          description: `${config.project} (${config.domain})`,
          site_id: Number(siteId()),
        })
      ).data;
      return;
    }
    case "deploy-script":
      await client.request("PATCH", `/sites/${siteId()}/deploy/script`, {
        deploy_script: config.deployScript,
      });
      return;
    case "certificate":
      await client.request("POST", `/sites/${siteId()}/certificates`, {
        type: "letsencrypt",
        certificate: config.domain,
      });
      return;
    default:
      throw new Error(`Unknown provisioning action: ${action.id}`);
  }
}

async function recordSiteId(config, siteId) {
  if (config.siteId === String(siteId)) return;
  await updateManifest(config.configPath, (manifest) => {
    manifest.ploi.siteId = String(siteId);
  });
  config.siteId = String(siteId);
}

async function latestDeployLogId(client, siteId) {
  const logs = (await client.request("GET", `/sites/${siteId}/log?per_page=5`)).data ?? [];
  return Math.max(0, ...logs.map((entry) => entry.id));
}

// Ploi runs its own stored copy of the deploy script, not the one in the
// release archive; update it when it differs. Returns whether it changed.
export async function syncDeployScript(client, siteId, script) {
  const current = (await client.request("GET", `/sites/${siteId}/deploy/script`)).deploy_script;
  if ((current ?? "").trim() === script.trim()) return false;
  await client.request("PATCH", `/sites/${siteId}/deploy/script`, { deploy_script: script });
  return true;
}

// The line the site's deploy script prints when it finishes:
// `<PROJECT>_DEPLOY_STATUS=<status> SHA=<commit>`, named after gq.ops.json
// `project` (upper-cased, other characters as `_`).
export function deployStatusMarker(project) {
  return `${String(project)
    .toUpperCase()
    .replace(/[^A-Z0-9]/gu, "_")}_DEPLOY_STATUS`;
}

// `variables` reach the deploy script as uppercased environment variables
// (e.g. { archive_url } → $ARCHIVE_URL).
export async function deploy(
  client,
  siteId,
  { project, variables = {}, pollMs = 5000, timeoutMs = 600_000 },
) {
  const marker = new RegExp(`${deployStatusMarker(project)}=(\\w+)(?:.*?\\bSHA=(\\w+))?`, "u");
  const before = await latestDeployLogId(client, siteId);
  await client.request("POST", `/sites/${siteId}/deploy`, { variables });

  return waitFor(
    async () => {
      const logs = (await client.request("GET", `/sites/${siteId}/log?per_page=5`)).data ?? [];
      const entry = logs.find((log) => log.id > before && log.type === "deploy");
      if (!entry) return null;
      const content =
        (await client.request("GET", `/sites/${siteId}/log/${entry.id}`)).data?.content ?? "";
      const match = marker.exec(content);
      return match ? { status: match[1], sha: match[2] ?? null, content } : null;
    },
    { timeoutMs, intervalMs: pollMs },
  );
}

const symbols = { ok: "✓", create: "+", update: "~", warn: "!" };

// `gq ploi provision [--dry-run] [--yes]`. Resolves to an exit code.
export async function runProvision({ context, parsed, fetch, lookup, io, interactive }) {
  const config = readProvisionConfig(context.projectRoot, context.config, context.configPath);
  const client = createPloiServerClient({
    token: context.env.PLOI_API_TOKEN,
    serverId: config.serverId,
    fetch,
  });
  const ui = createReporter(io, interactive);
  const confirmFirst = interactive && !parsed.yes;

  ui.intro(`Ploi provision · ${config.domain}`);

  const spin = ui.spinner();
  spin.start("Inspecting Ploi");
  let state;
  try {
    state = await inspect(client, config, lookup);
  } catch (error) {
    spin.error("Could not inspect Ploi");
    throw error;
  }
  spin.stop("Inspected Ploi");

  const plan = planActions(config, state);
  ui.note(plan.map((item) => `${symbols[item.kind]} ${item.title}`).join("\n"), "Plan");
  const actions = plan.filter((item) => item.kind === "create" || item.kind === "update");

  if (parsed.dryRun) {
    ui.outro(
      actions.length
        ? `Dry run: ${actions.length} change(s) pending.`
        : "Dry run: nothing to change.",
    );
    return 0;
  }

  if (actions.length === 0) {
    ui.success("Everything is already provisioned.");
  } else {
    if (!confirmFirst && !parsed.yes) {
      throw new Error("Not a TTY: re-run with --yes to apply, or --dry-run to inspect.");
    }
    if (confirmFirst && !(await ui.confirm(`Apply ${actions.length} change(s)?`))) {
      ui.cancel("Nothing was changed.");
      return 0;
    }
    const applyContext = { client, config, state };
    for (const action of actions) {
      const step = ui.spinner();
      step.start(action.title);
      try {
        await applyAction(action, applyContext);
        step.stop(`${symbols[action.kind]} ${action.title}`);
      } catch (error) {
        step.error(`${action.title} failed`);
        throw error;
      }
    }
  }

  for (const warning of plan.filter((item) => item.kind === "warn")) ui.warn(warning.title);
  ui.outro(
    actions.some((action) => action.id === "database")
      ? "Next: gq ploi release, then install WordPress at " +
          `https://${config.domain}/wp/wp-admin/install.php and release again`
      : "Deploy with: gq ploi release",
  );
  return 0;
}

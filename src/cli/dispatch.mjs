import { loadProjectContext } from "../ops/project-context.mjs";
import { createCloudflareClient } from "../cloudflare/inspection-client.mjs";
import { createPloiClient } from "../ploi/api-client.mjs";
import { printValue } from "./output.mjs";
import {
  isPloiApiCommand,
  runPloiApiCatalogCommand,
  runPloiApiCommand,
  validatePloiApiCommand,
} from "../ploi/api-command.mjs";
import { PLOI_ENDPOINTS } from "../ploi/api-endpoints.mjs";
import { chooseCommand } from "./ui.mjs";
import {
  isReleaseCommand,
  releaseCommandOptions,
  RELEASE_USAGE,
  runReleaseCommand,
} from "../release/commands.mjs";
import { isSigilloCommand, runSigilloCommand, SIGILLO_USAGE } from "../sigillo/commands.mjs";
import { CMS_USAGE, isCmsCommand, runCmsCommand } from "../cms/commands.mjs";
import {
  isPloiWorkflow,
  ploiWorkflowOptions,
  PLOI_WORKFLOW_USAGE,
  runPloiWorkflow,
} from "../ploi/commands.mjs";
import { DB_USAGE, dbCommandOptions, isDbCommand, runDbCommand } from "../db/commands.mjs";
import {
  cloudflareWorkflowOptions,
  CLOUDFLARE_WORKFLOW_USAGE,
  isCloudflareWorkflow,
  runCloudflareWorkflow,
} from "../cloudflare/commands.mjs";
import { CI_USAGE, ciCommandOptions, isCiCommand, runCiCommand } from "../ci/commands.mjs";
import {
  isMediaCommand,
  MEDIA_USAGE,
  mediaCommandOptions,
  runMediaCommand,
} from "../media/commands.mjs";
import {
  FRONTEND_USAGE,
  frontendCommandOptions,
  isFrontendCommand,
  runFrontendCommand,
} from "../frontend/commands.mjs";
import {
  isSiteCommand,
  runSiteCommand,
  siteCommandOptions,
  SITE_USAGE,
} from "../site/commands.mjs";
import {
  isWorkspaceCommand,
  runWorkspaceCommand,
  WORKSPACE_USAGE,
} from "../workspace/commands.mjs";
import { isSyncCommand, runSyncCommand, SYNC_USAGE } from "../sync/commands.mjs";
import { isNewCommand, NEW_USAGE, runNewCommand } from "../sync/new.mjs";
import { isSkillsCommand, runSkillsCommand, SKILLS_USAGE } from "../skills/commands.mjs";
import {
  isOffboardCommand,
  OFFBOARD_USAGE,
  offboardCommandOptions,
  runOffboardCommand,
} from "../offboard/commands.mjs";
import { refuseWhenOffboarded } from "../offboard/guard.mjs";
import { VERSION } from "../version.mjs";

const COMMAND_OPTIONS = new Map([
  ["context show", []],
  ["ploi servers list", []],
  ["ploi server show", ["server"]],
  ["ploi sites list", ["server"]],
  ["ploi site show", ["server", "site"]],
  ["cloudflare accounts list", []],
  ["cloudflare zones list", ["account"]],
  ["cloudflare zone show", ["account", "zone"]],
  ["cloudflare dns list", ["account", "zone", "name", "type"]],
]);

// Resolves to an exit code when the command has its own (a wrapped command's),
// otherwise to undefined for success.
export async function runCli(
  argv,
  { cwd, env, fetch, exec, lookup, clock, stdin, io, interactive },
) {
  // The Sigillo wrapper parses its own arguments: everything after `--` belongs
  // to the wrapped command, not to gq.
  if (isSigilloCommand(argv)) return runSigilloCommand(argv.slice(1), { cwd, env, exec });
  // So do the local CMS commands, whose extra arguments go to DDEV or Composer.
  if (isCmsCommand(argv)) return runCmsCommand(argv.slice(1), { cwd, env, exec, io, interactive });
  // And the workspace runners (setup, doctor, verify), with their own flags.
  if (isWorkspaceCommand(argv)) return runWorkspaceCommand(argv, { cwd, env, fetch, exec, io });
  // And gq sync, which reads a manifest older than the other commands accept.
  if (isSyncCommand(argv)) return runSyncCommand(argv.slice(1), { cwd, io });
  // And gq new, which creates the manifest instead of reading one.
  if (isNewCommand(argv)) {
    return runNewCommand(argv.slice(1), { cwd, env, exec, stdin, io, interactive });
  }
  // And gq skills update, which works from any Git repository (no manifest).
  if (isSkillsCommand(argv)) return runSkillsCommand(argv, { cwd, env, fetch, io });

  let effectiveArguments = argv;
  if (effectiveArguments.length === 0 && interactive) {
    const selected = await chooseCommand(PLOI_ENDPOINTS);
    if (!selected) return;
    effectiveArguments = selected;
  }

  const parsed = parseArguments(effectiveArguments);
  if (parsed.version) {
    io.out(VERSION);
    return;
  }
  if (parsed.help || parsed.command.length === 0) {
    printHelp(io);
    return;
  }
  validateCommand(parsed);
  if (isPloiApiCommand(parsed.command) && runPloiApiCatalogCommand(parsed, io)) {
    return;
  }

  const context = await loadProjectContext({
    cwd,
    env,
    project: parsed.project,
    config: parsed.config,
  });
  // An offboarded Site refuses whatever would expose it again (ADR 0011).
  refuseWhenOffboarded(parsed, context.config);
  const [provider, resource, action = "list"] = parsed.command;

  if (isReleaseCommand(parsed.command)) {
    await runReleaseCommand({ parsed, context, env, exec, io });
    return;
  }

  if (isPloiWorkflow(parsed.command)) {
    return runPloiWorkflow(parsed.command, {
      context,
      parsed,
      env,
      fetch,
      exec,
      lookup,
      io,
      interactive,
    });
  }

  if (isDbCommand(parsed.command)) {
    return runDbCommand(parsed.command, {
      argv: effectiveArguments,
      context,
      parsed,
      env,
      fetch,
      exec,
      io,
      interactive,
    });
  }

  if (isCloudflareWorkflow(parsed.command)) {
    return runCloudflareWorkflow(parsed.command, {
      context,
      parsed,
      env,
      fetch,
      exec,
      io,
      interactive,
    });
  }

  if (isCiCommand(parsed.command)) {
    return runCiCommand(parsed.command, {
      context,
      parsed,
      env,
      fetch,
      exec,
      stdin,
      io,
      interactive,
    });
  }

  if (isMediaCommand(parsed.command)) {
    return runMediaCommand({ context, parsed, fetch, io });
  }

  if (isFrontendCommand(parsed.command)) {
    return runFrontendCommand({ context, parsed, env, fetch, exec, io, interactive });
  }

  if (isOffboardCommand(parsed.command)) {
    return runOffboardCommand(parsed.command, {
      context,
      parsed,
      env,
      fetch,
      exec,
      clock,
      stdin,
      io,
      interactive,
    });
  }

  if (isSiteCommand(parsed.command)) {
    return runSiteCommand({ argv: effectiveArguments, context, parsed, env, fetch, exec, io });
  }

  if (provider === "context" && resource === "show") {
    printValue(io, contextSummary(context), parsed);
    return;
  }

  if (provider === "ploi") {
    if (resource === "api") {
      await runPloiApiCommand({ context, parsed, fetch, io, interactive });
    } else {
      await runPloi({ context, resource, action, parsed, fetch, io });
    }
    return;
  }

  if (provider === "cloudflare") {
    await runCloudflare({ context, resource, action, parsed, fetch, io });
    return;
  }

  throw new Error(`Unknown command: ${parsed.command.join(" ")}. Run gq --help.`);
}

async function runPloi({ context, resource, action, parsed, fetch, io }) {
  const client = createPloiClient({
    token: context.env.PLOI_API_TOKEN,
    fetchImplementation: fetch,
  });
  const serverId = parsed.server || context.env.PLOI_SERVER_ID || context.config.ploi?.serverId;
  const siteId = parsed.site || context.env.PLOI_SITE_ID || context.config.ploi?.siteId;
  let result;

  if (resource === "servers" && action === "list") {
    result = (await client.listServers()).map(presentPloiServer);
  } else if (resource === "server" && action === "show") {
    result = presentPloiServer(await client.getServer(required(serverId, "Ploi server ID")));
  } else if (resource === "sites" && action === "list") {
    result = (await client.listSites(required(serverId, "Ploi server ID"))).map(presentPloiSite);
  } else if (resource === "site" && action === "show") {
    result = presentPloiSite(
      await client.getSite(required(serverId, "Ploi server ID"), required(siteId, "Ploi site ID")),
    );
  } else {
    throw new Error(`Unknown Ploi command: ${resource || ""} ${action}. Run gq --help.`);
  }

  printValue(io, result, parsed);
}

async function runCloudflare({ context, resource, action, parsed, fetch, io }) {
  const client = createCloudflareClient({
    token: context.env.CLOUDFLARE_API_TOKEN,
    fetchImplementation: fetch,
  });
  const accountId =
    parsed.account || context.env.CLOUDFLARE_ACCOUNT_ID || context.config.cloudflare?.accountId;
  let zoneId = parsed.zone || context.env.CLOUDFLARE_ZONE_ID || context.config.cloudflare?.zoneId;
  const zoneName = context.env.CLOUDFLARE_ZONE_NAME || context.config.cloudflare?.zoneName;
  let result;

  if (resource === "accounts" && action === "list") {
    result = (await client.listAccounts()).map(presentCloudflareAccount);
  } else if (resource === "zones" && action === "list") {
    result = (await client.listZones({ "account.id": accountId, name: zoneName })).map(
      presentCloudflareZone,
    );
  } else if (resource === "zone" && action === "show") {
    zoneId = await resolveZoneId(client, { zoneId, zoneName, accountId });
    result = presentCloudflareZone(await client.getZone(zoneId));
  } else if (resource === "dns" && action === "list") {
    zoneId = await resolveZoneId(client, { zoneId, zoneName, accountId });
    result = (
      await client.listDnsRecords(zoneId, {
        name: parsed.name,
        type: parsed.type,
      })
    ).map(presentDnsRecord);
  } else {
    throw new Error(`Unknown Cloudflare command: ${resource || ""} ${action}. Run gq --help.`);
  }

  printValue(io, result, parsed);
}

async function resolveZoneId(client, { zoneId, zoneName, accountId }) {
  if (zoneId) return zoneId;
  const zones = await client.listZones({
    name: zoneName,
    "account.id": accountId,
  });
  if (zones.length !== 1) {
    throw new Error(
      `Expected exactly one matching Cloudflare zone, found ${zones.length}. Configure cloudflare.zoneId or pass --zone.`,
    );
  }
  return zones[0].id;
}

function parseArguments(argv) {
  const parsed = { command: [] };
  const valueOptions = new Set([
    "--project",
    "--config",
    "--server",
    "--site",
    "--account",
    "--zone",
    "--name",
    "--type",
    "--group",
    "--search",
    "--path",
    "--query",
    "--data",
    "--data-file",
    "--page",
    "--per-page",
    "--max-pages",
    "--ref",
    "--git-dir",
    "--url",
    "--uri",
  ]);
  const repeatedValueOptions = new Set(["--path", "--query", "--uri"]);
  const booleanOptions = new Set([
    "--all",
    "--dry-run",
    "--yes",
    "--upload",
    "--local",
    "--restore",
    "--archive",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h" || argument === "help") parsed.help = true;
    else if (argument === "--version" || argument === "-v") parsed.version = true;
    else if (argument === "--json") parsed.json = true;
    else if (booleanOptions.has(argument)) parsed[toOptionKey(argument)] = true;
    else if (valueOptions.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      const key = toOptionKey(argument);
      if (repeatedValueOptions.has(argument)) {
        parsed[key] ||= [];
        parsed[key].push(value);
      } else {
        if (parsed[key] !== undefined) throw new Error(`${argument} may only be provided once.`);
        parsed[key] = value;
      }
      index += 1;
    } else if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}.`);
    else parsed.command.push(argument);
  }

  return parsed;
}

function toOptionKey(argument) {
  return argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function validateCommand(parsed) {
  if (isPloiApiCommand(parsed.command)) {
    validatePloiApiCommand(parsed);
    return;
  }

  const { command, allowedOptions } = isReleaseCommand(parsed.command)
    ? releaseCommandOptions(parsed)
    : {
        command: parsed.command.join(" "),
        allowedOptions:
          COMMAND_OPTIONS.get(parsed.command.join(" ")) ??
          ploiWorkflowOptions(parsed.command) ??
          dbCommandOptions(parsed.command) ??
          cloudflareWorkflowOptions(parsed.command) ??
          ciCommandOptions(parsed.command) ??
          mediaCommandOptions(parsed.command) ??
          frontendCommandOptions(parsed.command) ??
          siteCommandOptions(parsed.command) ??
          offboardCommandOptions(parsed.command),
      };
  if (!allowedOptions) throw new Error(`Unknown command: ${command}. Run gq --help.`);

  const globals = new Set(["command", "help", "json", "project", "config"]);
  for (const key of Object.keys(parsed)) {
    if (!globals.has(key) && !allowedOptions.includes(key)) {
      throw new Error(`--${toFlagName(key)} is not valid for ${command}.`);
    }
  }
}

function toFlagName(key) {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function contextSummary(context) {
  return {
    project: context.config.project,
    projectRoot: context.projectRoot,
    configPath: context.configPath,
    invocationDirectory: context.invocationDirectory,
    machineEnvPath: context.machineEnvPath,
    ploiConfigured: Boolean(context.env.PLOI_API_TOKEN),
    cloudflareConfigured: Boolean(context.env.CLOUDFLARE_API_TOKEN),
  };
}

function presentPloiServer(server) {
  return {
    id: server.id,
    name: server.name,
    status: server.status,
    ip: server.ip_address,
    provider: server.provider,
    region: server.region,
  };
}

function presentPloiSite(site) {
  return {
    id: site.id,
    domain: site.domain,
    status: site.status,
    systemUser: site.system_user,
    projectRoot: site.project_root,
    webDirectory: site.web_directory,
    lastDeployAt: site.last_deploy_at,
  };
}

function presentCloudflareAccount(account) {
  return { id: account.id, name: account.name, type: account.type };
}

function presentCloudflareZone(zone) {
  return {
    id: zone.id,
    name: zone.name,
    status: zone.status,
    account: zone.account?.name,
    accountId: zone.account?.id,
    plan: zone.plan?.name,
  };
}

function presentDnsRecord(record) {
  return {
    id: record.id,
    type: record.type,
    name: record.name,
    content: record.content,
    proxied: record.proxied,
    ttl: record.ttl,
  };
}

function required(value, label) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`${label} is required in gq.ops.json, .env, or a CLI flag.`);
  }
  return String(value).trim();
}

function printHelp(io) {
  io.out(`gq operations CLI

Usage:
  gq [global options] <command> [command options]

Project:
  gq context show
${WORKSPACE_USAGE.map((usage) => `  ${usage}`).join("\n")}
${NEW_USAGE.map((usage) => `  ${usage}`).join("\n")}
${SYNC_USAGE.map((usage) => `  ${usage}`).join("\n")}
${SKILLS_USAGE.map((usage) => `  ${usage}`).join("\n")}

Ploi:
  gq ploi servers list
  gq ploi server show [--server <id>]
  gq ploi sites list [--server <id>]
  gq ploi site show [--server <id>] [--site <id>]
  gq ploi api list [--group <group>] [--search <text>]
  gq ploi api describe <operation-id>
  gq ploi api <operation-id> [--path <name=value>] [--query <name=value>]
      [--data <json> | --data-file <file>] [--all] [--dry-run | --yes]
${PLOI_WORKFLOW_USAGE.map((usage) => `  ${usage}`).join("\n")}

Cloudflare:
  gq cloudflare accounts list
  gq cloudflare zones list [--account <id>]
  gq cloudflare zone show [--zone <id>]
  gq cloudflare dns list [--zone <id>] [--name <hostname>] [--type <type>]
${CLOUDFLARE_WORKFLOW_USAGE.map((usage) => `  ${usage}`).join("\n")}

Independent media:
${MEDIA_USAGE.map((usage) => `  ${usage}`).join("\n")}

Frontend (published content):
${FRONTEND_USAGE.map((usage) => `  ${usage}`).join("\n")}

Site readiness:
${SITE_USAGE.map((usage) => `  ${usage}`).join("\n")}

Offboarding (cut, restore or archive a Site):
${OFFBOARD_USAGE.map((usage) => `  ${usage}`).join("\n")}

Cloudflare CI:
${CI_USAGE.map((usage) => `  ${usage}`).join("\n")}

Local CMS (DDEV):
${CMS_USAGE.map((usage) => `  ${usage}`).join("\n")}

Database (live → local only):
${DB_USAGE.map((usage) => `  ${usage}`).join("\n")}

Secrets (Sigillo):
${SIGILLO_USAGE.map((usage) => `  ${usage}`).join("\n")}

Release:
${RELEASE_USAGE.map((usage) => `  ${usage}`).join("\n")}

Global options:
  --project <directory>  Select a project explicitly
  --config <file>        Select a configuration file explicitly
  --json                 Print machine-readable JSON
  --version, -v          Show the CLI version
  --help, -h             Show this help

The CLI searches upward from the current directory for gq.ops.json.`);
}

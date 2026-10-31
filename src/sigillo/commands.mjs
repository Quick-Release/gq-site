import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectContext } from "../ops/project-context.mjs";

// Secrets reach a command only through `sigillo run`, per command, for the
// environment gq.ops.json maps the requested name to. The wrapper re-enters gq
// inside `sigillo run` (`--inside`), which drops Sigillo's own bootstrap
// credentials before starting the command, so application code never sees
// them. Nothing here mounts, downloads, or writes an environment.

export const SIGILLO_USAGE = [
  "gq sigillo run <environment> -- <command> [arguments...]",
  "gq sigillo login",
  "gq sigillo setup <environment>",
  "gq sigillo secrets <environment> [arguments...]",
];

const GQ_BIN = fileURLToPath(new URL("../../bin/gq.mjs", import.meta.url));
const REENTRY_VARIABLE = "GQ_SIGILLO_REENTRY";
const BOOTSTRAP_VARIABLES = [
  "SIGILLO_TOKEN",
  "SIGILLO_API_URL",
  "SIGILLO_PROJECT",
  "SIGILLO_ENVIRONMENT",
  REENTRY_VARIABLE,
];
const RUN_USAGE = `Usage: ${SIGILLO_USAGE[0]}`;
// Sigillo CLI arguments the helper commands never pass on: a bulk export of an
// environment, or a mount that writes one to disk (`--mount` or `--mount=…`).
const REFUSED_ARGUMENTS = ["download", "--mount"];

export function isSigilloCommand(argv) {
  return argv[0] === "sigillo";
}

// `argv` is everything after `gq sigillo`, taken verbatim: the wrapped
// command's own options are never parsed as gq's. Resolves to the exit code.
export async function runSigilloCommand(argv, { cwd, env, exec }) {
  const [subcommand, ...rest] = argv;

  if (subcommand === "run" && rest[0] === "--inside") {
    return runInside(parseCommand(rest.slice(1)), { cwd, env, exec });
  }
  if (subcommand === "run") {
    const [environment, ...afterEnvironment] = rest;
    if (environment === undefined || environment.startsWith("-")) throw new Error(RUN_USAGE);
    const command = parseCommand(afterEnvironment);
    return runSigillo({ cwd, env: { ...env, [REENTRY_VARIABLE]: "1" }, exec }, (config) => [
      "run",
      ...environmentFlags(config, environment),
      "--",
      process.execPath,
      GQ_BIN,
      "sigillo",
      "run",
      "--inside",
      "--",
      ...command,
    ]);
  }
  if (subcommand === "login" && rest.length === 0) {
    return runSigillo({ cwd, env, exec }, (config) => [
      "login",
      "--api-url",
      config.apiUrl,
      "--scope",
      ".",
    ]);
  }
  if ((subcommand === "setup" || subcommand === "secrets") && rest.length > 0) {
    const [environment, ...args] = rest;
    refuseBulkArguments(args);
    return runSigillo({ cwd, env, exec }, (config) => [
      subcommand,
      ...args,
      ...environmentFlags(config, environment),
    ]);
  }

  throw new Error(
    `Unknown command: ${["gq sigillo", ...argv].join(" ")}. Use:\n  ${SIGILLO_USAGE.join("\n  ")}`,
  );
}

// Runs the site's Sigillo CLI in the site root on the terminal, with the
// arguments `buildArguments` makes from the validated gq.ops.json `sigillo`.
async function runSigillo({ cwd, env, exec }, buildArguments) {
  const context = await loadProjectContext({ cwd, env });
  const args = buildArguments(validateSigilloConfig(context.config.sigillo));
  const sigillo = await sigilloCommand(context.projectRoot);
  const result = await exec(sigillo.command, [...sigillo.prefix, ...args], {
    cwd: context.projectRoot,
    env,
    stdio: "inherit",
  });
  return result.code;
}

// One Sigillo environment the provisioning commands (`gq cloudflare …`,
// `gq github setup`) store the secrets they mint in, through the site's
// Sigillo CLI. Values go to it over stdin, never in argv, and are never
// printed; `get` reads one into memory for the command's own use.
export async function sigilloSecrets({ context, env, exec }, environment) {
  const flags = environmentFlags(validateSigilloConfig(context.config.sigillo), environment);
  return secretsClient({ context, env, exec }, flags);
}

// Another Sigillo project's environment on the site's Sigillo server, such as
// GQ Platform `ops`, which holds the GETQUICK CI App (gq-platform ADR 0012).
// Same CLI, same rules: stdin in, never printed.
export async function sigilloProjectSecrets({ context, env, exec }, { projectId, environment }) {
  const { apiUrl } = validateSigilloConfig(context.config.sigillo);
  return secretsClient({ context, env, exec }, [
    "--api-url",
    apiUrl,
    "--project",
    projectId,
    "--env",
    environment,
  ]);
}

async function secretsClient({ context, env, exec }, flags) {
  const sigillo = await sigilloCommand(context.projectRoot);
  async function call(args, input) {
    const result = await exec(sigillo.command, [...sigillo.prefix, ...args], {
      cwd: context.projectRoot,
      env,
      input,
    });
    if (result.code !== 0) throw new Error(`sigillo ${args[0]} failed: ${result.stderr.trim()}`);
    return result.stdout;
  }

  return {
    // The Sigillo name of the environment, for messages.
    name: flags.at(-1),
    // The environment's secret listing (names, not values).
    list: () => call(["secrets", ...flags]),
    set: (name, value) => call(["secrets", "set", name, ...flags], value),
    get: async (name) =>
      (await call(["secrets", "get", name, ...flags, "--raw", "--force"])).trim(),
  };
}

async function runInside(command, { cwd, env, exec }) {
  if (env[REENTRY_VARIABLE] !== "1" || env.SIGILLO !== "1") {
    throw new Error("Refusing to run an untrusted Sigillo inner command.");
  }
  const { projectRoot } = await loadProjectContext({ cwd, env });
  const scrubbed = { ...env };
  for (const name of BOOTSTRAP_VARIABLES) delete scrubbed[name];
  const result = await exec(command[0], command.slice(1), {
    cwd: projectRoot,
    env: scrubbed,
    stdio: "inherit",
  });
  return result.code;
}

// `-- <command> [arguments...]`: the separator first, then at least a command.
function parseCommand(separated) {
  if (separated[0] !== "--" || separated.length < 2) throw new Error(RUN_USAGE);
  return separated.slice(1);
}

function refuseBulkArguments(args) {
  const refused = REFUSED_ARGUMENTS.find((name) =>
    args.some((argument) => argument === name || argument.startsWith(`${name}=`)),
  );
  if (refused) {
    throw new Error(
      `Refusing sigillo ${refused}: secrets are injected per command with gq sigillo run, never exported or mounted.`,
    );
  }
}

// The flags that point a Sigillo command at the project and the environment
// gq.ops.json maps `environment` to.
function environmentFlags(config, environment) {
  const mapped = config.environments[environment];
  if (typeof mapped !== "string" || mapped.trim() === "") {
    throw new Error(
      `Unknown Sigillo environment: ${environment}. gq.ops.json sigillo.environments maps ` +
        `${Object.keys(config.environments).join(", ")}.`,
    );
  }
  return ["--api-url", config.apiUrl, "--project", config.projectId, "--env", mapped];
}

function validateSigilloConfig(sigillo) {
  if (!sigillo || typeof sigillo !== "object") {
    throw new Error("gq.ops.json is missing the sigillo block (apiUrl, projectId, environments).");
  }
  if (typeof sigillo.apiUrl !== "string" || !sigillo.apiUrl.startsWith("https://")) {
    throw new Error("gq.ops.json sigillo.apiUrl must be an HTTPS URL.");
  }
  if (typeof sigillo.projectId !== "string" || sigillo.projectId.trim() === "") {
    throw new Error("gq.ops.json sigillo.projectId is required.");
  }
  if (sigillo.projectId.startsWith("REPLACE_WITH_")) {
    throw new Error(
      "gq.ops.json sigillo.projectId is still a placeholder; set it to the site's Sigillo project ID.",
    );
  }
  if (!sigillo.environments || typeof sigillo.environments !== "object") {
    throw new Error("gq.ops.json sigillo.environments is required.");
  }
  return sigillo;
}

// The site's installed CLI, or — on a fresh clone, before the first
// (Sigillo-wrapped) install — the version the site pins, from npm via npx.
async function sigilloCommand(projectRoot) {
  const binary = join(projectRoot, "node_modules", ".bin", "sigillo");
  if (await exists(binary)) return { command: binary, prefix: [] };

  const manifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  const version = manifest.devDependencies?.sigillo;
  if (!version) throw new Error("package.json devDependencies.sigillo is missing.");
  return { command: "npx", prefix: ["--yes", `sigillo@${version}`] };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

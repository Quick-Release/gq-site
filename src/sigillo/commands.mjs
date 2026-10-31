import { fileURLToPath } from "node:url";
import { loadProjectContext } from "../ops/project-context.mjs";
import { environmentFlags, sigilloCommand, validateSigilloConfig } from "./client.mjs";
import {
  fallbackWarning,
  readPlatformRegistryCredentials,
  withRegistryCredentials,
} from "./registry-credentials.mjs";

// Secrets reach a command only through `sigillo run`, per command, for the
// environment gq.ops.json maps the requested name to. The wrapper re-enters gq
// inside `sigillo run` (`--inside`), which drops Sigillo's own bootstrap
// credentials before starting the command, so application code never sees
// them. Nothing here mounts, downloads, or writes an environment. The inner
// step also reads the fleet's registry credentials from GQ Platform `ops`
// (registry-credentials.mjs) into the command's environment.

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
export async function runSigilloCommand(argv, { cwd, env, exec, io }) {
  const [subcommand, ...rest] = argv;

  if (subcommand === "run" && rest[0] === "--inside") {
    return runInside(parseCommand(rest.slice(1)), { cwd, env, exec, io });
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

// The secrets clients the provisioning commands use (client.mjs).
export { sigilloProjectSecrets, sigilloSecrets } from "./client.mjs";

async function runInside(command, { cwd, env, exec, io }) {
  if (env[REENTRY_VARIABLE] !== "1" || env.SIGILLO !== "1") {
    throw new Error("Refusing to run an untrusted Sigillo inner command.");
  }
  const context = await loadProjectContext({ cwd, env });
  const scrubbed = { ...env };
  for (const name of BOOTSTRAP_VARIABLES) delete scrubbed[name];
  // Read as the operator (their checkout's login), as gq github setup --app
  // reads the App: Sigillo's bootstrap token is the Site project's.
  const platform = await readPlatformRegistryCredentials({ context, env: scrubbed, exec });
  const { env: commandEnv, fallbacks } = withRegistryCredentials(scrubbed, platform);
  const warning = fallbackWarning(fallbacks, platform.problem);
  if (warning) io?.err(warning);
  const result = await exec(command[0], command.slice(1), {
    cwd: context.projectRoot,
    env: commandEnv,
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

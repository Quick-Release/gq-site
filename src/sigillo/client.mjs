import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

// The Site's Sigillo CLI as gq's commands call it: the project and
// environments gq.ops.json maps, and a secrets client (list, get, set) for one
// environment of the Site's project or of another project on the same server
// (GQ Platform `ops`, platform.mjs). Values go over stdin, never argv, and are
// never printed.

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

// The flags that point a Sigillo command at the project and the environment
// gq.ops.json maps `environment` to.
export function environmentFlags(config, environment) {
  const mapped = config.environments[environment];
  if (typeof mapped !== "string" || mapped.trim() === "") {
    throw new Error(
      `Unknown Sigillo environment: ${environment}. gq.ops.json sigillo.environments maps ` +
        `${Object.keys(config.environments).join(", ")}.`,
    );
  }
  return ["--api-url", config.apiUrl, "--project", config.projectId, "--env", mapped];
}

export function validateSigilloConfig(sigillo) {
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
export async function sigilloCommand(projectRoot) {
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

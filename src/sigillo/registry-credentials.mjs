// The fleet's two registry credentials (gq-platform ADR 0013), shared by every
// Site and kept once, in GQ Platform `ops`:
//
//   COMPOSER_AUTH          the Composer login (http-basic) for the GETQUICK
//                          registry, proxy.composer.getquick.io
//   GITHUB_PACKAGES_TOKEN  a classic read:packages token for GitHub Packages
//                          (npm.pkg.github.com, the @quick-release packages)
//
// gq reads them at use: `gq sigillo run` reads both before it starts the
// command, and `gq setup` before its install. Whatever the command does with
// them (Composer, pnpm, a Ploi deploy, `gq ci deploy` into the CI Worker) it
// gets them from its environment, as before.
//
// Precedence: GQ Platform `ops` wins. A Site's own copy (in its Sigillo
// environment, or the shell) is used only while GQ Platform `ops` can't be
// read or doesn't hold the name, so a Site that still holds one keeps working
// mid-upgrade; `gq doctor` warns about every copy. Values are never printed,
// put in argv or written to disk here; Sigillo's stderr is never repeated
// (it is untrusted output).

import {
  PLATFORM_LOCATION,
  PLATFORM_NAME,
  PLATFORM_SIGILLO,
  platformSecrets,
} from "./platform.mjs";

export const REGISTRY_SECRETS = Object.freeze(["COMPOSER_AUTH", "GITHUB_PACKAGES_TOKEN"]);

// pnpm and npm read a registry's token from this variable as they would from
// a user-level npm config line, so no file needs to hold it.
export const NPM_PACKAGES_TOKEN_VARIABLE = "npm_config_//npm.pkg.github.com/:_authToken";

// Why GQ Platform `ops` gave no value (never a value, never Sigillo's
// stderr), for the error of a command that then finds one missing.
export const REGISTRY_PROBLEM_VARIABLE = "GQ_REGISTRY_CREDENTIALS_PROBLEM";

// What an operator without access does about it.
export const PLATFORM_ACCESS_REMEDY =
  `ask a GQ Platform admin for read access to ${PLATFORM_NAME} at your Sigillo server, ` +
  `then check it with: npx sigillo secrets --project ${PLATFORM_SIGILLO.projectId} --env ${PLATFORM_SIGILLO.environment}`;

// Resolves to { values, problem }: the names GQ Platform `ops` gave a value
// for, and why any is missing (null when both were read). Never throws.
export async function readPlatformRegistryCredentials(dependencies) {
  let platform;
  try {
    platform = await platformSecrets(dependencies);
  } catch (error) {
    // gq.ops.json or package.json problems: gq's own messages, no secret.
    return { values: {}, problem: `${PLATFORM_LOCATION} can't be read: ${error.message}` };
  }
  const reads = await Promise.allSettled(REGISTRY_SECRETS.map((name) => platform.get(name)));
  const values = {};
  for (const [index, read] of reads.entries()) {
    if (read.status === "fulfilled" && read.value) values[REGISTRY_SECRETS[index]] = read.value;
  }
  const unread = REGISTRY_SECRETS.filter((name) => !values[name]);
  if (unread.length === 0) return { values, problem: null };

  // A name it lacks, or a project this login can't read: the listing tells.
  let names;
  try {
    names = await platform.names();
  } catch {
    return {
      values,
      problem: `your Sigillo login can't read ${PLATFORM_LOCATION}: ${PLATFORM_ACCESS_REMEDY}`,
    };
  }
  const absent = unread.filter((name) => !names.has(name));
  if (absent.length > 0) {
    return {
      values,
      problem: `${PLATFORM_LOCATION} has no ${absent.join(" or ")}: a GQ Platform admin stores it there once for the fleet`,
    };
  }
  return { values, problem: `${unread.join(" and ")} couldn't be read from ${PLATFORM_LOCATION}` };
}

// The command's environment with the registry credentials in place, by the
// precedence above, and the names it fell back to the Site's own copy for.
// Pure: `platform` is readPlatformRegistryCredentials's result.
export function withRegistryCredentials(env, platform) {
  const next = { ...env };
  delete next[REGISTRY_PROBLEM_VARIABLE];
  const fallbacks = [];
  for (const name of REGISTRY_SECRETS) {
    if (platform.values[name]) next[name] = platform.values[name];
    else if (env[name]?.trim()) fallbacks.push(name);
  }
  const token = next.GITHUB_PACKAGES_TOKEN?.trim();
  if (token) next[NPM_PACKAGES_TOKEN_VARIABLE] = token;
  if (platform.problem) next[REGISTRY_PROBLEM_VARIABLE] = platform.problem;
  return { env: next, fallbacks };
}

// A warning (names only) when the command runs on a Site's own copy.
export function fallbackWarning(fallbacks, problem) {
  if (fallbacks.length === 0) return null;
  return (
    `gq: using this Site's own ${fallbacks.join(" and ")} instead of the fleet's in ${PLATFORM_NAME}: ` +
    `${problem ?? `${PLATFORM_NAME} gave none`}. Once gq can read it there, delete the Site's ` +
    "copy (gq doctor lists each)."
  );
}

// The message for a command that needs `name` and doesn't have it.
export function missingRegistryCredential(name, env) {
  const problem = env[REGISTRY_PROBLEM_VARIABLE];
  return (
    `${name} is missing: gq reads it from ${PLATFORM_LOCATION} when the command runs ` +
    `through gq sigillo run${problem ? `, and ${problem}` : ""}.`
  );
}

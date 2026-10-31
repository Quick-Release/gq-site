// The git the deployment policy is read with: a system git, run with an
// environment gq builds itself, never one a Site (its node_modules/.bin,
// under `pnpm exec`) or Sigillo values could shape. The policy decides
// whether a release may happen at all. The Site's own git operations
// (status, commit, archive) still use whichever git it runs.
import { accessSync, constants, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname } from "node:path";

export const TRUSTED_GIT_LOCATIONS = Object.freeze([
  "/usr/bin/git",
  "/usr/local/bin/git",
  "/opt/homebrew/bin/git",
  "/home/linuxbrew/.linuxbrew/bin/git",
]);

// The first executable git at `locations`, or throws.
export function trustedGit(locations = TRUSTED_GIT_LOCATIONS) {
  for (const location of locations) {
    try {
      accessSync(location, constants.X_OK);
      return realpathSync(location);
    } catch {
      // Not here.
    }
  }
  throw new Error(
    `No git at ${locations.join(", ")}: the deployment policy is only read with a system git, not one found on PATH. Nothing was uploaded, synced or deployed.`,
  );
}

// The environment every git gq trusts runs with (a policy read, the Operator
// checkout's checks): built from nothing the caller's environment chooses,
// with no system or global git configuration (so no url.insteadOf,
// credential helper, alias, include or other machine-wide setting can
// redirect or change a read) and replacement objects off
// (GIT_NO_REPLACE_OBJECTS; grafts are refused where they matter).
export function isolatedGitEnvironment({ homedir, path }) {
  return {
    PATH: path,
    HOME: homedir,
    LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

// Git settings every policy read has: no hook or fsmonitor can run anything.
const POLICY_CONFIG = Object.freeze([
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
]);

// The environment of a policy read: isolatedGitEnvironment's, with nothing
// the caller's environment chooses but SSH_AUTH_SOCK (how an ssh origin
// authenticates): no GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
// GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_EXEC_PATH,
// GIT_CONFIG_* or any other GIT_* variable, and no ~/.gitconfig or
// /etc/gitconfig; HOME and the user from the user database; PATH limited to
// the trusted git's directory and the system's. The only credential is
// `header` (an Authorization header for the fixed origin), added as git
// configuration in the environment, never argv; an HTTPS origin that needs
// a global credential helper can't be read (the release refuses).
export function policyGitEnvironment(
  git,
  env = {},
  { header, homedir = userInfo().homedir, username = userInfo().username } = {},
) {
  const config = header ? [...POLICY_CONFIG, ["http.extraHeader", header]] : POLICY_CONFIG;
  return {
    ...isolatedGitEnvironment({ homedir, path: `${dirname(git)}:/usr/bin:/bin` }),
    USER: username,
    LOGNAME: username,
    ...(env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: env.SSH_AUTH_SOCK } : {}),
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(
      config.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ]),
    ),
  };
}

// The policy's git runners in `cwd`, through `exec`: `local` reads the
// repository (no network, no credential), `origin` reads origin (with
// `token`, a bearer token for it, when given). Each resolves to stdout, or
// throws.
export function policyGit({ exec, cwd, env, token, homedir, username }) {
  const git = trustedGit();
  const runner = (header) => {
    const runEnv = policyGitEnvironment(git, env, { header, homedir, username });
    return async (args) => {
      const { code, stdout, stderr } = await exec(git, args, { cwd, env: runEnv });
      if (code !== 0) {
        throw new Error(`git ${args[0]} failed: ${stderr.trim() || `exit ${code}`}`);
      }
      return stdout;
    };
  };
  const local = runner();
  return { local, origin: token ? runner(`Authorization: Bearer ${token}`) : local };
}

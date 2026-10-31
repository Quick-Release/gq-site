// The git the deployment policy is read with: a system git, run with an
// environment gq builds itself, never one a Site (its node_modules/.bin,
// under `pnpm exec`) or Sigillo values could shape. The policy decides
// whether a release may happen at all. The Site's own git operations
// (status, commit, archive) still use whichever git it runs.
import { accessSync, constants, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";

import { readDefaultBranchManifest } from "./deployment-policy.mjs";

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
// with no system or global git configuration (/etc/gitconfig, ~/.gitconfig,
// ~/.config/git/config: no url.insteadOf, credential helper, alias or
// include from there) and replacement objects off (GIT_NO_REPLACE_OBJECTS;
// grafts are refused where they matter). The repository's own config
// (.git/config) still applies, its remote.origin.url and any url.insteadOf
// or credential setting in it included; of it, the policy reads pin only
// core.hooksPath and core.fsmonitor (POLICY_CONFIG).
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

// The environment of a repository-local policy read (the release commit's
// manifest; on an operator's machine, origin too): isolatedGitEnvironment's,
// with nothing the caller's environment chooses but SSH_AUTH_SOCK (how an
// ssh origin authenticates): no GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
// GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_EXEC_PATH,
// GIT_CONFIG_* or any other GIT_* variable, and no system or global git
// configuration (the repository's own .git/config still applies); HOME and
// the user from the user database; PATH limited to the trusted git's
// directory and the system's. It carries no credential: in CI the default
// branch is read elsewhere (policyGit), with its own environment.
export function policyGitEnvironment(
  git,
  env = {},
  { homedir = userInfo().homedir, username = userInfo().username } = {},
) {
  const config = POLICY_CONFIG;
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

// The scheme of ARTIFACTS_REMOTE when it is a URL a CI policy read may use:
// https, or plain http to this machine only (tests); no credentials, query,
// fragment or whitespace. null otherwise.
export function authoritativeScheme(remote) {
  if (typeof remote !== "string") return null;
  if (/^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?(\/[A-Za-z0-9._~%/-]*)?$/u.test(remote)) return "https";
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:[0-9]+)?(\/[A-Za-z0-9._~%/-]*)?$/u.test(remote)) return "http";
  return null;
}

const nothing = "Nothing was uploaded, synced or deployed.";

// The policy's git, through `exec`, for the repository in `cwd`:
//
// - `local` reads that repository (no network, no credential).
// - `defaultBranchManifest(path)` reads the default branch's current
//   manifest. Where it reads from is the trust root:
//   - in CI, `remote` (ARTIFACTS_REMOTE, which the CI Worker's own
//     configuration sets for the step) is the only source. The repository's
//     origin must name exactly it (raw remote.origin.url, includes not
//     followed), or the release refuses; then the read happens in a
//     temporary bare repository gq creates, from that URL, with only gq's
//     configuration: no repository, global or system config (so no origin,
//     url.insteadOf, include or credential setting of the workspace can
//     redirect it), redirects off, only the remote's own protocol allowed,
//     and `token` (ARTIFACTS_TOKEN) as an Authorization header scoped to
//     exactly that URL, in the environment, never argv. A token without a
//     remote refuses.
//   - on an operator's machine (no remote, no token), the repository's own
//     origin, as its repository config says: the operator's checkout is
//     the trust root there (global and system config still off).
// Each runner resolves to stdout, or throws.
export function policyGit({ exec, cwd, env, token, remote, homedir, username }) {
  const git = trustedGit();
  const runner = (runEnv, prefix, directory) => async (args) => {
    const { code, stdout, stderr } = await exec(git, [...prefix, ...args], {
      cwd: directory,
      env: runEnv,
    });
    if (code !== 0) {
      throw new Error(`git ${args[0]} failed: ${stderr.trim() || `exit ${code}`}`);
    }
    return stdout;
  };
  const local = runner(policyGitEnvironment(git, env, { homedir, username }), [], cwd);
  if (!remote) {
    if (token) {
      throw new Error(
        `ARTIFACTS_TOKEN is set without ARTIFACTS_REMOTE: in CI the deployment policy is read only from the remote the CI Worker names, so the release refuses. ${nothing}`,
      );
    }
    return {
      local,
      defaultBranchManifest: (manifestPath) => readDefaultBranchManifest(local, manifestPath, local),
    };
  }
  const scheme = authoritativeScheme(remote);
  if (!scheme) {
    throw new Error(
      `ARTIFACTS_REMOTE isn't an https URL gq reads the deployment policy from, so the release refuses. ${nothing}`,
    );
  }
  return {
    local,
    async defaultBranchManifest(manifestPath) {
      let origin = "";
      try {
        origin = (
          await local(["config", "--local", "--no-includes", "--get", "remote.origin.url"])
        ).trim();
      } catch {
        // No origin: refused below.
      }
      if (origin !== remote) {
        throw new Error(
          `The release repository's origin ${origin ? `(${origin.replace(/\/\/[^/@]*@/u, "//…@")}) ` : ""}isn't ARTIFACTS_REMOTE: in CI the deployment policy is read only from the remote the CI Worker names, and the repository must name the same one. ${nothing}`,
        );
      }
      const directory = mkdtempSync(join(tmpdir(), "gq-policy-"));
      try {
        const config = [
          ...POLICY_CONFIG,
          ["http.followRedirects", "false"],
          ["protocol.allow", "never"],
          [`protocol.${scheme}.allow`, "always"],
          ...(token ? [[`http.${remote}.extraHeader`, `Authorization: Bearer ${token}`]] : []),
        ];
        const runEnv = {
          ...isolatedGitEnvironment({ homedir: homedir ?? userInfo().homedir, path: `${dirname(git)}:/usr/bin:/bin` }),
          USER: username ?? userInfo().username,
          LOGNAME: username ?? userInfo().username,
          GIT_CONFIG_COUNT: String(config.length),
          ...Object.fromEntries(
            config.flatMap(([key, value], index) => [
              [`GIT_CONFIG_KEY_${index}`, key],
              [`GIT_CONFIG_VALUE_${index}`, value],
            ]),
          ),
        };
        await runner(runEnv, [], directory)(["init", "--bare", "--quiet", directory]);
        const read = runner(runEnv, ["--git-dir", directory], directory);
        return await readDefaultBranchManifest(read, manifestPath, read, remote);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

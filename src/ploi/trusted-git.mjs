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

// The scheme of ARTIFACTS_REMOTE when it is a URL a CI read may use, or
// null. "https": https to a DNS name (two or more dot-separated labels of
// letters, digits and inner hyphens, the last starting with a letter, so no
// IP address; no trailing dot, port or credentials). "http": plain http to
// 127.0.0.1 only, any port (the tests' git http-backend). Then a path of one
// or more segments of letters, digits, ".", "_", "~" and "-", none starting
// with "." (so no "." or ".." segment), and no "%"-escape, query or
// fragment. The CI Worker's admission (infra/ci/release.ts) and the release
// step's source fetch (scripts/ci-release.mjs) use these same two
// expressions; see docs/reference/deployment-policy.md.
export function authoritativeScheme(remote) {
  if (typeof remote !== "string") return null;
  if (
    /^https:\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+$/u.test(
      remote,
    )
  )
    return "https";
  if (
    /^http:\/\/127\.0\.0\.1(?::[1-9][0-9]{0,4})?(?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+$/u.test(
      remote,
    )
  )
    return "http";
  return null;
}

// A CI read's git configuration, in git's command-line scope (above any
// repository's): no hook or fsmonitor, no bare repository that isn't named
// with --git-dir, and no transport. ls-remote and fetch add only the
// remote's own protocol, no redirects, and the token as a header git sends
// to exactly that URL (ciNetworkConfig). The admission and the release
// step's source fetch use the same lists.
export const CI_OFFLINE_CONFIG = Object.freeze([
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["safe.bareRepository", "explicit"],
  ["protocol.allow", "never"],
]);

export function ciNetworkConfig(scheme, remote, token) {
  return [
    ...CI_OFFLINE_CONFIG,
    ["http.followRedirects", "false"],
    [`protocol.${scheme}.allow`, "always"],
    [`http.${remote}.extraHeader`, `Authorization: Bearer ${token}`],
  ];
}

// The environment of a CI read's git call with `config`, for a scratch
// directory `scratch` (its cwd): isolatedGitEnvironment's, the user from the
// user database, and GIT_CEILING_DIRECTORIES at the scratch directory's
// parent, so even a call without --git-dir couldn't find a repository above
// it. Nothing from the caller's environment.
export function ciGitEnvironment(git, scratch, config, { homedir, username }) {
  return {
    ...isolatedGitEnvironment({ homedir, path: `${dirname(git)}:/usr/bin:/bin` }),
    USER: username,
    LOGNAME: username,
    GIT_CEILING_DIRECTORIES: dirname(scratch),
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(
      config.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ]),
    ),
  };
}

const nothing = "Nothing was uploaded, synced or deployed.";

// The policy's git, through `exec`, for the repository in `cwd`:
//
// - `local` reads that repository (no network, no credential).
// - `defaultBranchManifest(path)` reads the default branch's current
//   manifest. Where it reads from is the trust root:
//   - in CI, `remote` (ARTIFACTS_REMOTE, which the CI Worker's own
//     configuration sets for the step) is the only source, and it must be a
//     URL authoritativeScheme accepts. The repository's origin must name
//     exactly it (raw remote.origin.url, includes not followed), or the
//     release refuses; then the read happens in a temporary bare repository
//     gq creates, from that URL, with only gq's configuration: every call
//     names it with --git-dir and runs in it, GIT_CEILING_DIRECTORIES at its
//     parent and safe.bareRepository=explicit, so no repository is found
//     from the release repository, the caller's directory or above (no
//     origin, url.insteadOf, include or credential setting of the workspace
//     can redirect it); no global or system config; redirects off; only the
//     remote's own protocol; and `token` (ARTIFACTS_TOKEN) as http.<that
//     exact URL>.extraHeader, which git adds to its HTTP requests to that
//     URL only. The setting reaches git through GIT_CONFIG_COUNT/KEY/VALUE in
//     the environment of the ls-remote and fetch alone, never argv. A token
//     without a remote, or a remote without a token, refuses.
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
      defaultBranchManifest: (manifestPath) =>
        readDefaultBranchManifest(local, manifestPath, local),
    };
  }
  if (!token) {
    throw new Error(
      `ARTIFACTS_REMOTE is set without ARTIFACTS_TOKEN: in CI the deployment policy is read from that remote with the CI Worker's token, so the release refuses. ${nothing}`,
    );
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
      // The scratch directory is the bare repository itself: every call
      // names it with --git-dir and runs in it (ciGitEnvironment).
      const directory = mkdtempSync(join(tmpdir(), "gq-policy-"));
      try {
        const user = {
          homedir: homedir ?? userInfo().homedir,
          username: username ?? userInfo().username,
        };
        const environment = (config) => ciGitEnvironment(git, directory, config, user);
        const prefix = ["--git-dir", directory];
        const offline = runner(environment(CI_OFFLINE_CONFIG), prefix, directory);
        await offline(["init", "--bare", "--quiet"]);
        // The token only reaches ls-remote and fetch; the fetched commit is
        // read offline.
        return await readDefaultBranchManifest(
          runner(environment(ciNetworkConfig(scheme, remote, token)), prefix, directory),
          manifestPath,
          offline,
          remote,
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

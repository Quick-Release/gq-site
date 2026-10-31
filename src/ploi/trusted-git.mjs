// The git the deployment policy is read with: a system location, never one a
// Site (its node_modules/.bin, under `pnpm exec`) or Sigillo values could put
// first on PATH. The policy decides whether a release may happen at all, so
// its reads don't trust the environment's PATH; the Site's own git
// operations (status, commit, archive) still use whichever git it runs.
import { accessSync, constants, realpathSync } from "node:fs";
import { dirname } from "node:path";

export const TRUSTED_GIT_LOCATIONS = Object.freeze([
  "/usr/bin/git",
  "/usr/local/bin/git",
  "/opt/homebrew/bin/git",
  "/home/linuxbrew/.linuxbrew/bin/git",
]);

// The first executable git at TRUSTED_GIT_LOCATIONS (`locations`), or throws.
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

// The environment for a policy read: the caller's, with PATH limited to the
// trusted git's own directory and the system's, so git's own helpers (ssh, a
// credential helper named without a path) don't come from a Site either.
export function trustedGitEnvironment(env, git) {
  return { ...env, PATH: `${dirname(git)}:/usr/bin:/bin` };
}

// Composer for the site's local CMS, on macOS or Linux, with whichever PHP is at hand: the running DDEV project (its
// PHP matches the server), else the host Composer, else DDEV started for the
// purpose. Dependency changes are the exception: they always use the host
// Composer, which has the registry login (see composerDependencyChange).

import { platform } from "node:os";
import { join } from "node:path";

import { syncLocalDesign } from "./local-design.mjs";
import { CMS_PATH, commandExists, composerDependencyChange, ddevStatus } from "./local.mjs";

const COMPOSER_ACTIONS = {
  install: ["install", "--no-interaction"],
  update: ["update", "--no-interaction"],
  reinstall: ["reinstall", "--no-interaction"],
  test: ["test"],
  lint: ["lint"],
  "lint:fix": ["lint:fix"],
};

const DEPENDENCY_CHANGES = new Set(["install", "update", "reinstall"]);

export function chooseRunner({ ddevRunning, hasComposer, hasDdev }) {
  if (ddevRunning) return "ddev";
  if (hasComposer) return "host";
  if (hasDdev) return "ddev-start";
  return null;
}

export function installHint(os = platform()) {
  return os === "darwin"
    ? "Install Composer (brew install composer) or DDEV (https://ddev.com/get-started/)."
    : "Install Composer (sudo apt install composer, or brew install composer) or DDEV (https://ddev.com/get-started/).";
}

// `args` (after the action) go to Composer. Resolves to the exit code.
export async function runComposerCommand(action, args, { context, env, exec, io }) {
  if (!Object.hasOwn(COMPOSER_ACTIONS, action ?? "")) {
    throw new Error(
      `Unsupported Composer action: ${action ?? "(none)"}. Use one of: ${Object.keys(COMPOSER_ACTIONS).join(", ")}.`,
    );
  }
  const cmsRoot = join(context.projectRoot, CMS_PATH);
  const composerArgs = [...COMPOSER_ACTIONS[action], ...args];

  if (DEPENDENCY_CHANGES.has(action)) {
    try {
      await composerDependencyChange(cmsRoot, composerArgs, { exec, env, stdio: "inherit" });
    } catch (error) {
      if (error.exitCode === undefined) throw error;
      io.err(`gq: ${error.message}`);
      return error.exitCode;
    }
    return 0;
  }

  const hasDdev = await commandExists(exec, "ddev", env);
  const runner = chooseRunner({
    ddevRunning: hasDdev && (await ddevStatus(exec, cmsRoot, env)) === "running",
    hasComposer: await commandExists(exec, "composer", env),
    hasDdev,
  });
  if (!runner) throw new Error(`Neither Composer nor DDEV is installed. ${installHint()}`);
  const inherit = { cwd: cmsRoot, env, stdio: "inherit" };

  if (runner === "host") {
    io.out("[composer] DDEV is not running — using the host Composer.");
    return (await exec("composer", composerArgs, inherit)).code;
  }
  if (runner === "ddev-start") {
    io.out(`[composer] No host Composer — starting DDEV for ${CMS_PATH}…`);
    syncLocalDesign(cmsRoot, env);
    const started = await exec("ddev", ["start"], inherit);
    if (started.code !== 0) return started.code;
  }
  return (await exec("ddev", ["composer", ...composerArgs], inherit)).code;
}

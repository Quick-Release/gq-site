import { runCiDeploy, runCiRuns } from "./deploy.mjs";
import { runArtifactsCredential, runArtifactsSetup } from "./git-artifacts.mjs";
import { runGithubSetup } from "./github-setup.mjs";

// The site's Cloudflare CI: deploying its Worker, listing its runs, the
// GitHub → Artifacts mirror's webhook, and git access to Artifacts.
// Command → [usage, the options it accepts, runner].
const CI_COMMANDS = new Map([
  ["ci deploy", ["gq ci deploy", [], runCiDeploy]],
  ["ci runs", ["gq ci runs", [], runCiRuns]],
  ["github setup", ["gq github setup [--dry-run]", ["dryRun"], runGithubSetup]],
  ["git artifacts setup", ["gq git artifacts setup", [], runArtifactsSetup]],
  // git's credential helper protocol.
  ["git artifacts get", ["gq git artifacts get | store | erase", [], runArtifactsCredential]],
  ["git artifacts store", [null, [], runArtifactsCredential]],
  ["git artifacts erase", [null, [], runArtifactsCredential]],
]);

export const CI_USAGE = [...CI_COMMANDS.values()].map(([usage]) => usage).filter(Boolean);

export function ciCommandOptions(command) {
  return CI_COMMANDS.get(command.join(" "))?.[1];
}

export function isCiCommand(command) {
  return CI_COMMANDS.has(command.join(" "));
}

// Resolves to the command's exit code.
export function runCiCommand(command, dependencies) {
  const [, , runner] = CI_COMMANDS.get(command.join(" "));
  return runner(dependencies);
}

import { runEvents } from "./events.mjs";
import { runMedia } from "./media.mjs";
import { runProvision } from "./provision.mjs";
import { runRelease } from "./release.mjs";

// The Ploi workflows (provision, release, media and events), beside gq-ops' read-only `gq ploi` commands.
// Command → [usage, the options it accepts, runner].
const PLOI_WORKFLOWS = new Map([
  ["ploi provision", ["gq ploi provision [--dry-run | --yes]", ["dryRun", "yes"], runProvision]],
  [
    "ploi release",
    ["gq ploi release [--ref <ref>] [--git-dir <dir>]", ["ref", "gitDir"], runRelease],
  ],
  ["ploi media", ["gq ploi media [--dry-run]", ["dryRun"], runMedia]],
  ["ploi events", ["gq ploi events [--dry-run]", ["dryRun"], runEvents]],
]);

export const PLOI_WORKFLOW_USAGE = [...PLOI_WORKFLOWS.values()].map(([usage]) => usage);

export function ploiWorkflowOptions(command) {
  return PLOI_WORKFLOWS.get(command.join(" "))?.[1];
}

export function isPloiWorkflow(command) {
  return PLOI_WORKFLOWS.has(command.join(" "));
}

// Resolves to the workflow's exit code.
export function runPloiWorkflow(command, dependencies) {
  const [, , runner] = PLOI_WORKFLOWS.get(command.join(" "));
  return runner(dependencies);
}

import { runCloudflareCi } from "./ci.mjs";
import { runDeployToken } from "./deploy-token.mjs";
import { runCloudflareMedia } from "./media.mjs";
import { runReleases } from "./releases.mjs";

// The Cloudflare provisioning commands, beside gq-ops' read-only `gq cloudflare` commands. They run with the account's
// token-manager token and store what they mint in Sigillo `staging`.
// Command → [usage, the options it accepts, runner].
const CLOUDFLARE_WORKFLOWS = new Map([
  ["cloudflare ci", ["gq cloudflare ci [--dry-run]", ["dryRun"], runCloudflareCi]],
  [
    "cloudflare deploy-token",
    ["gq cloudflare deploy-token [--dry-run]", ["dryRun"], runDeployToken],
  ],
  ["cloudflare media", ["gq cloudflare media [--dry-run]", ["dryRun"], runCloudflareMedia]],
  ["cloudflare releases", ["gq cloudflare releases [--dry-run]", ["dryRun"], runReleases]],
]);

export const CLOUDFLARE_WORKFLOW_USAGE = [...CLOUDFLARE_WORKFLOWS.values()].map(([usage]) => usage);

export function cloudflareWorkflowOptions(command) {
  return CLOUDFLARE_WORKFLOWS.get(command.join(" "))?.[1];
}

export function isCloudflareWorkflow(command) {
  return CLOUDFLARE_WORKFLOWS.has(command.join(" "));
}

// Resolves to the workflow's exit code.
export function runCloudflareWorkflow(command, dependencies) {
  const [, , runner] = CLOUDFLARE_WORKFLOWS.get(command.join(" "));
  return runner(dependencies);
}

// While gq.ops.json records `offboarded` (ADR 0011), the commands that would
// expose the Site again (attach a domain, mint a token, deploy, release,
// provision, refresh) refuse with what to do instead. Read-only commands
// (checks, `gq db backup`, `ploi api` GETs) keep working. The generated
// deploy scripts (infra/scripts/deploy-frontend.mjs and the CI release step)
// refuse on their own, since they don't run through gq.

import { ploiCatalog } from "../ploi/api-endpoints.mjs";

// The guarded commands, by their first two words.
export const GUARDED_COMMANDS = new Set([
  "cloudflare media",
  "cloudflare deploy-token",
  "cloudflare ci",
  "cloudflare releases",
  "github setup",
  "ci deploy",
  "ploi provision",
  "ploi events",
  "ploi media",
  "ploi release",
  "release package",
  "release push",
  "release tag",
  "frontend refresh",
  "frontend secrets",
]);

// Throws when `parsed` (the dispatcher's) is a guarded command and `config`
// records the Site as offboarded. A `ploi api` operation is guarded unless it
// only reads (GET) or only prints its request (--dry-run), and `cloudflare
// custom-hostname` unless it is its `status`.
export function refuseWhenOffboarded(parsed, config) {
  const record = config.offboarded;
  if (!record) return;
  const name = parsed.command.slice(0, 2).join(" ");
  const writesThroughPloiApi =
    name === "ploi api" && !parsed.dryRun && ploiCatalog.get(parsed.command[2]).method !== "GET";
  // Its `status` only reads.
  const createsCustomHostname =
    name === "cloudflare custom-hostname" && parsed.command[2] !== "status";
  if (!GUARDED_COMMANDS.has(name) && !writesThroughPloiApi && !createsCustomHostname) return;

  const since = `${record.phase} on ${record.at.slice(0, 10)}`;
  const next =
    record.phase === "archived"
      ? "Its infrastructure is deleted."
      : record.archive
        ? "Its archive is under way: finish it with gq offboard --archive (pnpm offboard:archive)."
        : "If the Site is coming back, run gq offboard --restore first (pnpm offboard:restore).";
  throw new Error(
    `${config.project} is offboarded (gq.ops.json offboarded: ${since}): gq ${parsed.command.join(" ")} would expose it again. ${next}`,
  );
}

// Gives the Ploi site's CMS the GETQUICK Google Fonts Developer API key that
// GQ Design imports and updates Google font families with (gq-design
// ADR 0006): sets the one GETQUICK_GOOGLE_FONTS_API_KEY line of its .env and
// leaves every other line as it is. Without the key GQ Design's import and
// update are off; nothing else breaks.
//
// The key is one for the whole fleet, kept once in Sigillo GETQUICK Registry
// `prod`. gq reads it per command, into memory, through the Site's Sigillo CLI
// and the operator's own login (as it reads GQ Platform `ops`); it never
// reaches a Site's Sigillo project, argv or output. A value already in the
// command's environment wins, so a rotation can be pushed without Registry
// access. Idempotent.
//
//   gq ploi fonts [--dry-run]

import { applyEnv } from "../dotenv-text.mjs";
import { createReporter } from "../cli/reporter.mjs";
import { sigilloProjectSecrets } from "../sigillo/client.mjs";
import { createPloiServerClient } from "./server-client.mjs";

export const GOOGLE_FONTS_KEY = "GETQUICK_GOOGLE_FONTS_API_KEY";

// Sigillo GETQUICK Registry: the fleet's GETQUICK-wide service keys.
export const FONTS_KEY_SIGILLO = Object.freeze({
  projectId: "01M3AZV1P6VE2QV0Q8QPS3YPHN",
  environment: "prod",
});
export const FONTS_KEY_LOCATION = `Sigillo GETQUICK Registry ${FONTS_KEY_SIGILLO.environment} (project ${FONTS_KEY_SIGILLO.projectId})`;

// The key from the command's environment, else from GETQUICK Registry.
// Never prints it, and never repeats Sigillo's stderr (untrusted output).
export async function readGoogleFontsKey({ context, env, exec }) {
  const given = (context.env?.[GOOGLE_FONTS_KEY] ?? env[GOOGLE_FONTS_KEY])?.trim();
  if (given) return given;
  let value;
  try {
    const registry = await sigilloProjectSecrets({ context, env, exec }, FONTS_KEY_SIGILLO);
    value = await registry.get(GOOGLE_FONTS_KEY);
  } catch {
    value = "";
  }
  if (!value) {
    throw new Error(
      `${GOOGLE_FONTS_KEY} couldn't be read from ${FONTS_KEY_LOCATION}: check your Sigillo login can read it ` +
        `(npx sigillo secrets --project ${FONTS_KEY_SIGILLO.projectId} --env ${FONTS_KEY_SIGILLO.environment}).`,
    );
  }
  return value;
}

// `gq ploi fonts [--dry-run]`. Resolves to an exit code.
export async function runFonts({ context, parsed, env, exec, fetch, io, interactive }) {
  const ops = context.config;
  if (!ops.ploi?.siteId) throw new Error("gq.ops.json ploi.siteId is required.");
  const key = await readGoogleFontsKey({ context, env, exec });

  const ui = createReporter(io, interactive);
  ui.intro(`Ploi .env · ${GOOGLE_FONTS_KEY}`);
  const client = createPloiServerClient({
    token: context.env.PLOI_API_TOKEN,
    serverId: ops.ploi.serverId,
    fetch,
  });
  const envPath = `/sites/${ops.ploi.siteId}/env`;
  const response = await client.request("GET", envPath);
  const current = response?.data ?? response?.env;
  if (typeof current !== "string" || !current.trim()) {
    throw new Error("The Ploi site has no .env yet; run gq ploi provision first.");
  }

  const { output, changed } = applyEnv(current, { [GOOGLE_FONTS_KEY]: key });
  if (changed.length === 0) {
    ui.outro(`The Ploi .env already has ${GOOGLE_FONTS_KEY}.`);
    return 0;
  }
  ui.note(changed.map((name) => `~ ${name}`).join("\n"), "Plan (values not shown)");
  if (parsed.dryRun) {
    ui.outro("Dry run: nothing changed.");
    return 0;
  }
  await client.request("PATCH", envPath, { content: output });
  ui.outro(
    "Updated. The next CMS release copies the .env into the CMS; its deploy then updates GQ Design's Google font families.",
  );
  return 0;
}

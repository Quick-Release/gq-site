// A Site's secrets live in Sigillo (and, deployed, in its platform's own
// store); its apps' env files hold only generated, non-secret wiring. This
// finds the env files that set a name a Sigillo environment holds, comparing
// names only: no value is read from Sigillo or printed.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseDotenv } from "../dotenv-text.mjs";

const APPS_PATH = "apps";
const ENV_FILES = [".env", ".env.local", ".dev.vars"];

/** Every app's env files, as `{ path, names }` with paths relative to the site root. */
export function appEnvFiles(root) {
  const apps = join(root, APPS_PATH);
  if (!existsSync(apps)) return [];
  return readdirSync(apps, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .flatMap((app) =>
      ENV_FILES.flatMap((file) => {
        const path = `${APPS_PATH}/${app}/${file}`;
        const full = join(root, path);
        if (!existsSync(full)) return [];
        return [{ path, names: Object.keys(parseDotenv(readFileSync(full, "utf8"))) }];
      }),
    );
}

/**
 * The names env files set that a Sigillo environment holds. `listings` are
 * `{ environment, listing }`, each the text of `sigillo secrets` (names).
 */
export function secretsInEnvFiles(files, listings) {
  return files.flatMap(({ path, names }) =>
    names.flatMap((name) => {
      const pattern = new RegExp(`(?<![A-Za-z0-9_])${escape(name)}(?![A-Za-z0-9_])`, "u");
      const holder = listings.find(({ listing }) => pattern.test(listing));
      return holder ? [{ path, name, environment: holder.environment }] : [];
    }),
  );
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// A Site's secrets live in Sigillo (and, deployed, in its platform's own
// store); its apps' env files hold only generated, non-secret wiring
// (ADR 0002). This finds the env files that set a name a Sigillo environment
// holds, by name: no value is read from Sigillo, and a file's own values are
// only compared with what gq generated there, never reported.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { parseEnv } from "../cli/env-files.mjs";
import { CMS_PATH, DDEV_ENV_NAMES } from "../cms/local.mjs";

const APPS_PATH = dirname(CMS_PATH);
const ENV_FILES = [".env", ".env.local", ".dev.vars"];

/**
 * Every app's env files, as `{ path, names }` with paths relative to the site
 * root. `names` leaves out what gq generated: an empty value, the value the
 * app's `.env.example` gives it, and in the CMS's `.env` what `gq cms start`
 * sets from DDEV.
 */
export function appEnvFiles(root) {
  const apps = join(root, APPS_PATH);
  if (!existsSync(apps)) return [];
  return readdirSync(apps, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${APPS_PATH}/${entry.name}`)
    .sort()
    .flatMap((app) => {
      const template = readEnv(join(root, app, ".env.example")) ?? {};
      return ENV_FILES.flatMap((file) => {
        const values = readEnv(join(root, app, file));
        if (values === null) return [];
        const wired = app === CMS_PATH && file === ".env" ? DDEV_ENV_NAMES : [];
        const names = Object.entries(values)
          .filter(([name, value]) => value !== "" && value !== template[name])
          .map(([name]) => name)
          .filter((name) => !wired.includes(name));
        return [{ path: `${app}/${file}`, names }];
      });
    });
}

/**
 * The names env files set that a Sigillo environment holds. `listings` are
 * `{ environment, listing }`, each the text of `sigillo secrets` (names), read
 * as the other gq commands read it.
 */
export function secretsInEnvFiles(files, listings) {
  return files.flatMap(({ path, names }) =>
    names.flatMap((name) => {
      const pattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`, "u");
      const holder = listings.find(({ listing }) => pattern.test(listing));
      return holder ? [{ path, name, environment: holder.environment }] : [];
    }),
  );
}

function readEnv(path) {
  return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : null;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

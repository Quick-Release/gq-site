// Local app assignments checked against Sigillo's names, without fetching
// secret values. Only app roots are inspected; dependencies are not traversed.
import { readdir, readFile } from "node:fs/promises";
import { join, normalize } from "node:path";

import { parseEnv } from "../cli/env-files.mjs";

const ENV_FILES = [".env", ".env.local", ".dev.vars"];
const EXCLUDED_DIRECTORIES = new Set(["node_modules", "vendor", ".git", ".pnpm"]);
const LOCAL_STAND_INS = new Set([
  "DB_PASSWORD",
  "AUTH_KEY",
  "SECURE_AUTH_KEY",
  "LOGGED_IN_KEY",
  "NONCE_KEY",
  "AUTH_SALT",
  "SECURE_AUTH_SALT",
  "LOGGED_IN_SALT",
  "NONCE_SALT",
]);

export async function checkLocalEnvFiles({ root, project, requiredFiles, secretNames, report }) {
  // The shipped blueprint is the authority, never the Site's editable example.
  const template = await readFile(
    new URL("../../blueprint/templates/apps/cms/env.example", import.meta.url),
    "utf8",
  );
  const publicValues = parseEnv(template.replaceAll("{{project}}", project));
  const apps = new Set(Object.keys(requiredFiles));
  try {
    for (const entry of await readdir(join(root, "apps"), { withFileTypes: true })) {
      if (entry.isDirectory()) apps.add(join("apps", entry.name));
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      report.fail(
        "could not inspect apps for local environment files — check directory permissions",
      );
      return;
    }
  }
  let clean = true;
  for (const app of apps) {
    if (
      normalize(app)
        .split(/[\\/]/u)
        .some((part) => EXCLUDED_DIRECTORIES.has(part))
    )
      continue;
    for (const filename of ENV_FILES) {
      const path = join(app, filename);
      let source;
      try {
        source = await readFile(join(root, path), "utf8");
      } catch (error) {
        if (error.code === "ENOENT") continue;
        report.fail(`could not read ${path} — check file permissions and ensure it is a file`);
        clean = false;
        continue;
      }
      const names = new Set();
      // Inspect each assignment: a later public stand-in cannot hide an earlier secret.
      for (const line of source.split(/\r?\n/u)) {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line);
        if (!match || !secretNames.has(match[1])) continue;
        const name = match[1];
        if (
          path === "apps/cms/.env" &&
          LOCAL_STAND_INS.has(name) &&
          parseEnv(line)[name] === publicValues[name]
        )
          continue;
        names.add(name);
      }
      if (names.size === 0) continue;
      clean = false;
      report.fail(
        `${path} sets ${[...names].join(", ")}: names stored in Sigillo — remove these assignments and use gq sigillo run`,
      );
    }
  }
  if (clean)
    report.ok(
      "local app environment files contain no disallowed assignments to Sigillo secret names",
    );
}

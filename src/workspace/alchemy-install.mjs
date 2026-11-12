// The Alchemy packages a Site deploys with, as installed: `alchemy`,
// `@alchemy.run/cloudflare` (Alchemy's Cloudflare provider, its own package
// from 2.0.0-beta.84) and `@alchemy.run/frontend-frameworks` release in
// lockstep at one version, and peer on each other at exactly that version.
// The managed infra imports the Cloudflare provider from its package, and the
// Site's pnpm-workspace.yaml catalog pins all three (gq sync manages those
// keys), so a sync committed without `pnpm install`, or a hand edit, shows
// here as installed versions that disagree with each other or the catalog.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readYamlKey } from "../sync/workspace-keys.mjs";

export const ALCHEMY_PACKAGES = Object.freeze([
  "alchemy",
  "@alchemy.run/cloudflare",
  "@alchemy.run/frontend-frameworks",
]);

const WORKSPACE_FILE = "pnpm-workspace.yaml";

// Each package's installed version under `infra` (and the Frontend's
// frameworks package under `apps/frontend`, which builds with it):
// `{ installed: [{ where, name, version }], problem? }`, with no problem
// when they agree with each other and the catalog. A Site without
// `infra/package.json`, or with no Alchemy in it, has nothing to check.
export function alchemyInstall(root) {
  const manifest = readJson(join(root, "infra", "package.json"));
  if (manifest === null || manifest.dependencies?.alchemy === undefined) return undefined;
  const declared = ALCHEMY_PACKAGES.filter((name) => manifest.dependencies?.[name] !== undefined);
  const installed = declared.map((name) => ({
    where: "infra",
    name,
    version: installedVersion(join(root, "infra"), name),
  }));
  const frontend = join(root, "apps", "frontend");
  const frontendManifest = readJson(join(frontend, "package.json"));
  if (frontendManifest?.dependencies?.["@alchemy.run/frontend-frameworks"] !== undefined) {
    installed.push({
      where: "apps/frontend",
      name: "@alchemy.run/frontend-frameworks",
      version: installedVersion(frontend, "@alchemy.run/frontend-frameworks"),
    });
  }
  const missing = installed.filter(({ version }) => version === undefined);
  if (missing.length > 0) {
    return {
      installed,
      problem: `${missing.map(({ where, name }) => `${where} ${name}`).join(", ")} not installed — run: pnpm install`,
    };
  }
  const workspace = readText(join(root, WORKSPACE_FILE));
  const catalog =
    workspace === null ? undefined : readYamlKey(WORKSPACE_FILE, workspace, ["catalog", "alchemy"]);
  const versions = new Set(installed.map(({ version }) => version));
  if (versions.size > 1) {
    return {
      installed,
      problem:
        `Alchemy packages installed at different versions (${describe(installed)}); they release ` +
        "in lockstep — run: pnpm install",
    };
  }
  const [version] = versions;
  if (catalog !== undefined && catalog !== version) {
    return {
      installed,
      problem: `Alchemy ${version} is installed but ${WORKSPACE_FILE} pins ${catalog} — run: pnpm install`,
    };
  }
  return { installed, version };
}

function describe(installed) {
  return installed.map(({ where, name, version }) => `${where} ${name} ${version}`).join(", ");
}

function installedVersion(app, name) {
  return readJson(join(app, "node_modules", name, "package.json"))?.version;
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function readJson(path) {
  const text = readText(path);
  return text === null ? null : JSON.parse(text);
}

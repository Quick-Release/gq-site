// What a Site's infra installs of Alchemy. alchemy, @alchemy.run/cloudflare
// and @alchemy.run/frontend-frameworks are released at one version and peer
// on each other exactly, and the managed infra/*.ts import what that version
// exports. pnpm-workspace.yaml's catalog pins them (managed keys), so a Site
// that committed a gq sync without `pnpm install` deploys with packages its
// infra wasn't written for. gq doctor fails it: each package must be
// installed in infra/node_modules, all at one version, and at the version
// infra/package.json asks for (the catalog's, for a `catalog:` dependency).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export const ALCHEMY_PACKAGES = Object.freeze([
  "alchemy",
  "@alchemy.run/cloudflare",
  "@alchemy.run/frontend-frameworks",
]);

const INFRA = "infra";
const WORKSPACE = "pnpm-workspace.yaml";

// undefined for a Site without infra/package.json (nothing deploys with
// Alchemy yet); otherwise `{ version }` when the install is whole, or
// `{ problem }`, a sentence naming what is wrong and the command that fixes it.
export async function alchemyInstall(root) {
  const manifest = await readJson(join(root, INFRA, "package.json"));
  if (manifest === undefined) return undefined;
  const dependencies = { ...manifest.devDependencies, ...manifest.dependencies };
  const undeclared = ALCHEMY_PACKAGES.filter((name) => dependencies[name] === undefined);
  if (undeclared.length > 0) {
    return {
      problem: `${INFRA}/package.json doesn't depend on ${undeclared.join(", ")}, which the managed infra imports — run: gq sync, then pnpm install`,
    };
  }

  const installed = await Promise.all(
    ALCHEMY_PACKAGES.map(async (name) => ({
      name,
      version: (await readJson(join(root, INFRA, "node_modules", name, "package.json")))?.version,
    })),
  );
  const missing = installed.filter(({ version }) => typeof version !== "string");
  if (missing.length > 0) {
    return {
      problem: `${INFRA} doesn't have ${missing.map(({ name }) => name).join(", ")} installed — run: pnpm install`,
    };
  }
  const describe = (entries) => entries.map(({ name, version }) => `${name} ${version}`).join(", ");
  if (new Set(installed.map(({ version }) => version)).size > 1) {
    return {
      problem: `${INFRA} installs ${describe(installed)}: Alchemy's packages must be one version — run: pnpm install`,
    };
  }

  let catalog;
  const expected = [];
  for (const name of ALCHEMY_PACKAGES) {
    const spec = dependencies[name];
    if (spec !== "catalog:" && spec !== "catalog:default") {
      expected.push({ name, version: spec, from: `${INFRA}/package.json` });
      continue;
    }
    catalog ??= await readCatalog(root);
    if (typeof catalog === "string") return { problem: catalog };
    if (typeof catalog[name] !== "string") {
      return { problem: `${WORKSPACE}'s catalog has no ${name} — run: gq sync, then pnpm install` };
    }
    expected.push({ name, version: catalog[name], from: `${WORKSPACE}'s catalog` });
  }
  const version = installed[0].version;
  const drifted = expected.filter((entry) => entry.version !== version);
  if (drifted.length > 0) {
    const from = [...new Set(drifted.map((entry) => entry.from))].join(" and ");
    return {
      problem: `${INFRA} installs Alchemy ${version}, but ${from} pins ${describe(drifted)} — run: pnpm install`,
    };
  }
  return { version };
}

// The workspace's default catalog, or a problem sentence.
async function readCatalog(root) {
  const text = await readFile(join(root, WORKSPACE), "utf8").catch(() => undefined);
  if (text === undefined) return `${WORKSPACE} is missing — run: gq sync --recreate ${WORKSPACE}`;
  let parsed;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    return `${WORKSPACE} is not valid YAML: ${error.message.split("\n")[0]}`;
  }
  const catalog = parsed?.catalog;
  return catalog !== null && typeof catalog === "object" ? catalog : {};
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

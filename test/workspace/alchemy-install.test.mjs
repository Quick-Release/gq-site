// gq doctor's Alchemy check: the packages a Site deploys with, installed at
// the one version its catalog pins.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { alchemyInstall } from "../../src/workspace/alchemy-install.mjs";
import { temporaryDirectory } from "../support/fixture-site.mjs";

async function write(root, path, content) {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(
    join(root, path),
    typeof content === "string" ? content : JSON.stringify(content),
  );
}

// A Site with `infra` depending on `names`, each installed at its version in
// `installed` (undefined leaves it out), and the catalog pinning `catalog`.
async function site({ names, installed, frontend, catalog = "2.0.0-beta.84" }) {
  const root = await temporaryDirectory();
  await write(root, "infra/package.json", {
    dependencies: Object.fromEntries(names.map((name) => [name, "catalog:"])),
  });
  for (const [name, version] of Object.entries(installed)) {
    await write(root, `infra/node_modules/${name}/package.json`, { name, version });
  }
  if (frontend !== undefined) {
    const name = "@alchemy.run/frontend-frameworks";
    await write(root, "apps/frontend/package.json", { dependencies: { [name]: "catalog:" } });
    await write(root, `apps/frontend/node_modules/${name}/package.json`, {
      name,
      version: frontend,
    });
  }
  await write(root, "pnpm-workspace.yaml", `catalog:\n  alchemy: ${catalog}\n`);
  return root;
}

const SPLIT = ["alchemy", "@alchemy.run/cloudflare", "@alchemy.run/frontend-frameworks"];
const at = (version, names = SPLIT) => Object.fromEntries(names.map((name) => [name, version]));

test("the Alchemy packages at the catalog's version pass", async () => {
  const root = await site({
    names: SPLIT,
    installed: at("2.0.0-beta.84"),
    frontend: "2.0.0-beta.84",
  });
  const result = alchemyInstall(root);
  assert.equal(result.problem, undefined);
  assert.equal(result.version, "2.0.0-beta.84");
  assert.equal(result.installed.length, 4);
});

test("a Site from before the split, without @alchemy.run/cloudflare, passes on its own pins", async () => {
  const names = ["alchemy", "@alchemy.run/frontend-frameworks"];
  const root = await site({
    names,
    installed: at("2.0.0-beta.79", names),
    catalog: "2.0.0-beta.79",
  });
  assert.equal(alchemyInstall(root).problem, undefined);
});

test("a declared package that isn't installed fails", async () => {
  const root = await site({ names: SPLIT, installed: at("2.0.0-beta.84", ["alchemy"]) });
  assert.equal(
    alchemyInstall(root).problem,
    "infra @alchemy.run/cloudflare, infra @alchemy.run/frontend-frameworks not installed — run: pnpm install",
  );
});

test("packages at different versions fail, naming each", async () => {
  const root = await site({
    names: SPLIT,
    installed: at("2.0.0-beta.84"),
    frontend: "2.0.0-beta.79",
  });
  assert.match(
    alchemyInstall(root).problem,
    /^Alchemy packages installed at different versions \(.*apps\/frontend @alchemy\.run\/frontend-frameworks 2\.0\.0-beta\.79\); they release in lockstep — run: pnpm install$/u,
  );
});

test("an install behind the catalog fails", async () => {
  const root = await site({
    names: SPLIT,
    installed: at("2.0.0-beta.83"),
    catalog: "2.0.0-beta.84",
  });
  assert.equal(
    alchemyInstall(root).problem,
    "Alchemy 2.0.0-beta.83 is installed but pnpm-workspace.yaml pins 2.0.0-beta.84 — run: pnpm install",
  );
});

test("a Site without infra Alchemy has nothing to check", async () => {
  const root = await temporaryDirectory();
  assert.equal(alchemyInstall(root), undefined);
});

test("a catalog range, or a direct pin in infra, isn't compared with the catalog", async () => {
  const ranged = await site({
    names: SPLIT,
    installed: at("2.0.0-beta.84"),
    catalog: "^2.0.0-beta.84",
  });
  assert.equal(alchemyInstall(ranged).problem, undefined);
  const direct = await site({
    names: SPLIT,
    installed: at("2.0.0-beta.84"),
    catalog: "2.0.0-beta.79",
  });
  const path = join(direct, "infra/package.json");
  await writeFile(path, JSON.stringify({ dependencies: at("2.0.0-beta.84") }));
  assert.equal(alchemyInstall(direct).problem, undefined);
});

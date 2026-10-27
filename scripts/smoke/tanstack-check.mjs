// Disposable, account-free package consumer proof. Network is used only to
// install published dependencies. No Alchemy plan, deploy or provisioning runs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const repo = fileURLToPath(new URL("../../", import.meta.url));
const parent = await mkdtemp(join(tmpdir(), "gq-start-"));
const root = join(parent, "orbit");
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, CI: "1" },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")}`);
}
async function json(path, change) {
  const full = join(root, path);
  const object = JSON.parse(await readFile(full, "utf8"));
  change(object);
  await writeFile(full, `${JSON.stringify(object, null, 2)}\n`);
}
try {
  run(
    process.execPath,
    [join(repo, "bin/gq.mjs"), "new", "orbit", "--project", "orbit", "--variant", "content"],
    parent,
  );
  await json("gq.ops.json", (ops) => {
    ops.domains = { admin: "cms.example.test", frontend: "example.test" };
  });
  // The CLI under test may not be published yet; generation used this checkout.
  await json("package.json", (pkg) => {
    pkg.devDependencies["@getquick/site"] = `file:${repo}`;
  });
  // The CI worker is independently tested; this proof installs app and deploy packages.
  const workspace = join(root, "pnpm-workspace.yaml");
  await writeFile(workspace, (await readFile(workspace, "utf8")).replace('  - "infra/ci"\n', ""));
  await json("infra/package.json", (pkg) => {
    pkg.devDependencies.miniflare = "5.20261023.0-beta";
  });
  run("pnpm", ["install", "--no-frozen-lockfile"]);
  run("pnpm", ["--filter", "@orbit/frontend", "check"]);
  run("pnpm", ["--filter", "@orbit/infrastructure", "check"]);
  const migrations = join(root, "apps/frontend/node_modules/@getquick/content/migrations");
  const historical = {
    "0001_publications.sql": "0c0fdcef981c58169a092f68f77a36f741e599d6ebc84314ea2d5a6e792fa706",
    "0002_entries.sql": "6e0289cb3a6ed6f9fff20a3a1365a496d18b1ee36f0efcd8f91efd655dc6c0f4",
    "0003_publication_events.sql":
      "0a87d08c233fad167c67b35f1fa588c8eadeac67074fb7d2f6b3cd5a4daa8e6c",
    "0004_withdrawals.sql": "b77aefdd632b0b4666cd74c849916f9d368b1c6e35e6db7578279f555f3391b5",
    "0005_reconciliation.sql": "4b62e25c24940ae59dd97d9b4d7fc9cc658c2c1f2819adafa5bbc8a16151a00e",
  };
  for (const [name, expected] of Object.entries(historical)) {
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(migrations, name)))
        .digest("hex"),
      expected,
      name,
    );
  }
  for (const name of ["build", "probe"]) {
    const path = join(root, `infra/proof-${name}.mjs`);
    await copyFile(new URL(`./tanstack/${name}.mjs`, import.meta.url), path);
    run(process.execPath, [path]);
  }
} finally {
  if (process.env.KEEP === "1") console.log(`Proof kept at ${root}`);
  else await rm(parent, { recursive: true, force: true });
}

// Disposable, account-free package consumer proof. Network is used only to
// install published dependencies. No Alchemy plan, deploy or provisioning runs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile, copyFile } from "node:fs/promises";
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
    delete pkg.devDependencies["@getquick/site"];
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
  const migrations = join(root, "infra/node_modules/@getquick/content/migrations");
  for (const name of await readdir(join(repo, "blueprint/templates/apps/frontend/migrations"))) {
    assert.deepEqual(
      await readFile(join(migrations, name)),
      await readFile(join(repo, "blueprint/templates/apps/frontend/migrations", name)),
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

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { createFixtureSite, temporaryDirectory } from "../support/fixture-site.mjs";
import { newSite, readSite } from "../support/generated-site.mjs";

const fixture = resolve("test/fixtures/wpgraphql-blocks-2.2.0");
const template = resolve("blueprint/templates/apps/cms");
const patchPath = "patches/wpgraphql-blocks/2.2.0-quiet-unsafe-access.patch";
const runner = "scripts/patch-dependencies.php";
const files = ["plugin.php", "includes/utils.php"];

test("existing sites gain managed patch files while retaining their site-owned Composer configuration", async () => {
  const composer =
    '{"scripts":{"site-check":"echo kept"},"require":{"wp-plugin/wpgraphql-blocks":"2.2.0"}}\n';
  const site = await createFixtureSite({ files: { "apps/cms/composer.json": composer } });
  const synced = await site.run(["sync"]);
  assert.equal(synced.code, 0, synced.stderr);
  assert.equal(await readSite(site.root, "apps/cms/composer.json"), composer);
  for (const file of [runner, patchPath]) {
    assert.equal(
      await readSite(site.root, `apps/cms/${file}`),
      await readFile(join(template, file), "utf8"),
    );
  }
  assert.equal((await site.run(["sync", "--check"])).code, 0);
});

function command(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  assert.ifError(result.error);
  return { ...result, output: result.stdout + result.stderr };
}

async function installation() {
  const cms = await temporaryDirectory();
  const plugin = join(cms, "web/app/plugins/wpgraphql-blocks");
  for (const file of [runner, patchPath]) {
    await mkdir(dirname(join(cms, file)), { recursive: true });
    await copyFile(join(template, file), join(cms, file));
  }
  await mkdir(join(plugin, "includes"), { recursive: true });
  for (const file of files) {
    await copyFile(join(fixture, file === "plugin.php" ? file : "utils.php"), join(plugin, file));
  }
  return { cms, plugin, run: () => command("php", [runner], cms) };
}

async function contents(plugin) {
  return Promise.all(files.map((file) => readFile(join(plugin, file), "utf8")));
}

test("clean application and reruns verify exact bytes and PHP syntax without rewriting files", async () => {
  const site = await installation();
  const clean = site.run();
  assert.equal(clean.status, 0, clean.output);
  assert.match(clean.output, /applied and PHP syntax verified/u);
  const first = await contents(site.plugin);
  const before = await Promise.all(files.map((file) => stat(join(site.plugin, file))));
  const again = site.run();
  assert.equal(again.status, 0, again.output);
  assert.match(again.output, /already applied/u);
  assert.deepEqual(await contents(site.plugin), first);
  assert.deepEqual(
    await Promise.all(files.map(async (file) => (await stat(join(site.plugin, file))).mtimeMs)),
    before.map((entry) => entry.mtimeMs),
  );
  for (const file of files) {
    const lint = command("php", ["-l", join(site.plugin, file)], site.cms);
    assert.equal(lint.status, 0, lint.output);
  }
});

test("repairs either interrupted file and an interrupted hunk", async () => {
  const complete = await installation();
  assert.equal(complete.run().status, 0);
  const expected = await contents(complete.plugin);
  for (const file of files) {
    const site = await installation();
    await copyFile(join(complete.plugin, file), join(site.plugin, file));
    const result = site.run();
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(await contents(site.plugin), expected);
  }
  const site = await installation();
  const source = await readFile(join(site.plugin, "plugin.php"), "utf8");
  await writeFile(
    join(site.plugin, "plugin.php"),
    source.replace(
      "$attributes = $data['attrs'];",
      "$attributes = $data['attrs'] ?? []; // gq-patch-2.2.0",
    ),
  );
  // This is within a multi-change hunk, rather than a complete hunk. GNU patch
  // cannot safely infer the rest: fail without touching either installed file.
  const before = await contents(site.plugin);
  const refused = site.run();
  assert.notEqual(refused.status, 0);
  assert.match(refused.output, /Source drift/u);
  assert.deepEqual(await contents(site.plugin), before);
  // A complete first hunk is repairable, including mixed hunks in one file.
  const constructor = "    public function __construct";
  await writeFile(
    join(site.plugin, "plugin.php"),
    expected[0].slice(0, expected[0].indexOf(constructor)) +
      source.slice(source.indexOf(constructor)),
  );
  const repaired = site.run();
  assert.equal(repaired.status, 0, repaired.output);
  assert.deepEqual(await contents(site.plugin), expected);
});

test("version, missing files and source drift fail without changing installed files or leaving rejects", async () => {
  for (const mode of ["version", "context", "unrelated", "already-patched", "missing"]) {
    const site = await installation();
    if (mode === "already-patched") assert.equal(site.run().status, 0);
    const path = join(site.plugin, "plugin.php");
    let source = await readFile(path, "utf8");
    if (mode === "version") source = source.replace("Version: 2.2.0", "Version: 2.3.0");
    else if (mode === "context") source = source.replace("class Block", "class ChangedBlock");
    else source += "\n// unreviewed source drift\n";
    await writeFile(path, source);
    if (mode === "missing") {
      const { unlink } = await import("node:fs/promises");
      await unlink(join(site.plugin, files[1]));
    }
    const before = await readFile(path, "utf8");
    const result = site.run();
    assert.notEqual(result.status, 0, mode);
    assert.match(result.output, /GETQUICK dependency patch failed/u, mode);
    assert.equal(await readFile(path, "utf8"), before, mode);
    assert.deepEqual((await readdir(site.plugin)).sort(), ["includes", "plugin.php"], mode);
  }
});

test("real field resolvers preserve response bytes and query arguments across all 32 argument combinations", async () => {
  const site = await installation();
  const theme = join(site.cms, "theme");
  await mkdir(theme);
  await writeFile(join(theme, "theme.json"), '{"styles":{"color":{}}}');
  const probe = () => {
    const result = command(
      "php",
      [resolve("test/support/blocks-response.php"), site.plugin, theme],
      site.cms,
    );
    assert.equal(result.status, 0, result.output);
    return JSON.parse(result.stdout);
  };
  const before = probe();
  assert.ok(before.warnings.length > 1000, "the pristine plugin must reproduce the warning flood");
  const applied = site.run();
  assert.equal(applied.status, 0, applied.output);
  const after = probe();
  assert.deepEqual(after.warnings, [], JSON.stringify(after.warnings.slice(0, 5)));
  assert.deepEqual(after.responses, before.responses);
  assert.deepEqual(after.queries, before.queries);
  assert.equal(after.responses.length, 65);
  assert.equal(after.libxmlRestored, true);
});

test("generated Composer lifecycle patches installs, updates and production autoloads without Node", async () => {
  const generated = await newSite();
  const composer = JSON.parse(await readSite(generated.root, "apps/cms/composer.json"));
  assert.deepEqual(composer.scripts["post-autoload-dump"], ["@patch:dependencies"]);
  assert.equal(composer.scripts["patch:dependencies"], "@php scripts/patch-dependencies.php");
  for (const file of [runner, patchPath]) {
    assert.equal(
      await readSite(generated.root, `apps/cms/${file}`),
      await readFile(join(template, file), "utf8"),
    );
  }
  const site = await installation();
  // Real Composer lifecycle, no registry or WordPress needed for this seam.
  await mkdir(join(site.cms, "dependency"));
  await writeFile(
    join(site.cms, "dependency/composer.json"),
    JSON.stringify({ name: "test/dependency", version: "1.0.0" }),
  );
  await writeFile(
    join(site.cms, "composer.json"),
    JSON.stringify({
      name: "test/patch",
      scripts: composer.scripts,
      repositories: [{ type: "path", url: "dependency", options: { symlink: false } }],
      require: { "test/dependency": "1.0.0" },
    }),
  );
  for (const args of [
    ["install"],
    ["update"],
    ["dump-autoload"],
    ["install", "--no-dev", "--optimize-autoloader"],
  ]) {
    const result = command("composer", [...args, "--no-interaction"], site.cms);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /wpgraphql-blocks 2.2.0 warning patch/u);
  }
  await writeFile(join(site.plugin, "includes/utils.php"), "<?php // drift\n");
  const failure = command("composer", ["dump-autoload", "--no-dev"], site.cms);
  assert.notEqual(failure.status, 0);
  assert.match(failure.output, /Source drift/u);
});

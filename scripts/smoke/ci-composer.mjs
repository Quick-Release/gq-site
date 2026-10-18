// Run by ci-composer.sh with a generated site and its built CI runner image.
// Each install runs in a fresh container from that image (its own user, root,
// and its environment), with a copy of the site's CMS mounted at
// /workspace/apps/cms, where CI's steps find it, and no vendor, lockfile or
// Composer cache: a clean install.
//
// Composer skips its root check when it detects Docker (/.dockerenv, Docker's
// mounts), which Cloudflare's containers aren't: there, root runs without
// plugins. Every run here gets an `open_basedir = /` PHP ini (it restricts
// nothing), which turns that detection off, so Composer treats root as it
// does in CI.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";

const [site, image] = process.argv.slice(2);
const cms = join(site, "apps/cms");
const generated = JSON.parse(await readFile(join(cms, "composer.json"), "utf8"));

// The install step's own command, as the site's CI Worker runs it.
const ci = await readFile(join(site, "infra/ci/cloudflare.ci.ts"), "utf8");
const install = ci.match(/"(composer install [^"]*)"/u)?.[1];
assert.ok(install, "infra/ci/cloudflare.ci.ts has no composer install step");
assert.match(install, /--no-interaction/u);

// The reviewed bytes the patch runner verifies, from the runner itself.
const runner = await readFile(join(cms, "scripts/patch-dependencies.php"), "utf8");
const reviewed = Object.fromEntries(
  [...runner.matchAll(/'([\w/.-]+\.php)' => '([0-9a-f]{64})'/gu)].map((match) => match.slice(1)),
);
assert.deepEqual(Object.keys(reviewed), ["plugin.php", "includes/utils.php"]);

// The CMS without the GETQUICK registry (it needs COMPOSER_AUTH) and its
// packages; allow-plugins, installer-paths and scripts as generated.
async function workspace(name, edit = () => {}) {
  const root = join(site, "..", name);
  await cp(cms, join(root, "apps/cms"), { recursive: true });
  const composer = structuredClone(generated);
  composer.repositories = composer.repositories.filter((entry) => entry.name !== "getquick");
  composer.require = Object.fromEntries(
    Object.entries(composer.require).filter(([name]) => !name.startsWith("getquick/")),
  );
  edit(composer);
  await writeFile(join(root, "apps/cms/composer.json"), `${JSON.stringify(composer, null, 2)}\n`);
  return { root, composer, path: (file) => join(root, "apps/cms", file) };
}

const ini = join(site, "..", "php-ini");
await mkdir(ini);
await writeFile(join(ini, "cloudflare-runtime.ini"), "open_basedir = /\n");

function inImage(root, script) {
  const result = spawnSync(
    "docker",
    ["run", "--rm", "--entrypoint", "bash", "-v", `${root}:/workspace`, "-w", "/workspace"]
      .concat(["-v", `${ini}:/php-ini:ro`, "-e", "PHP_INI_SCAN_DIR=:/php-ini"])
      .concat([image, "-c", script]),
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );
const sha256 = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const blocks = "web/app/plugins/wpgraphql-blocks";
const plugins = "Composer plugins have been disabled for safety";

// 1. The install step as CI runs it: installers run as root.
{
  const clean = await workspace("clean");
  const run = inImage(
    clean.root,
    `id -u && php -r 'echo ini_get("open_basedir"), "\\n";' && ${install}`,
  );
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /^0\n\/\n/u, "root, with Composer's Docker detection off");
  assert.doesNotMatch(run.output, new RegExp(plugins, "u"));
  assert.match(
    run.output,
    /wpgraphql-blocks 2\.2\.0 warning patch applied and PHP syntax verified\./u,
  );

  // Every WordPress package Composer installed is in its installer path.
  const placement = {};
  for (const [path, types] of Object.entries(generated.extra["installer-paths"])) {
    for (const type of types) placement[type.replace(/^type:/u, "")] = path;
  }
  const { packages } = JSON.parse(
    await readFile(clean.path("vendor/composer/installed.json"), "utf8"),
  );
  const wordpress = packages.filter((entry) => placement[entry.type]);
  for (const entry of wordpress) {
    const expected = placement[entry.type].replace("{$name}", entry.name.split("/")[1]);
    const actual = normalize(join("vendor/composer", entry["install-path"]));
    assert.equal(`${actual}/`, expected, entry.name);
    assert.ok((await readdir(clean.path(expected))).length > 0, `${expected} is empty`);
  }
  const required = Object.keys(clean.composer.require).filter((name) =>
    /^wp-(plugin|theme)\//u.test(name),
  );
  assert.ok(required.includes("wp-plugin/wpgraphql-blocks"));
  assert.deepEqual(
    required.filter((name) => !wordpress.some((entry) => entry.name === name)),
    [],
    "required WordPress packages Composer didn't install as WordPress packages",
  );
  // WordPress core, by roots/wordpress-core-installer.
  const core = generated.extra["wordpress-install-dir"];
  assert.ok(
    await exists(clean.path(`${core}/wp-includes/version.php`)),
    `${core} has no WordPress`,
  );
  assert.equal(await exists(clean.path("vendor/wp-plugin")), false);

  // The patch applied the reviewed bytes, and PHP accepts them.
  for (const [file, hash] of Object.entries(reviewed)) {
    assert.equal(await sha256(clean.path(`${blocks}/${file}`)), hash, file);
  }

  // A later step restores this workspace: the CMS checks `pnpm verify --ci`
  // runs (as the same user) and a rerun of the install still verify.
  const again = inImage(
    clean.root,
    `${install} && composer lint --working-dir=apps/cms && composer test --working-dir=apps/cms`,
  );
  assert.equal(again.status, 0, again.output);
  assert.match(again.output, /wpgraphql-blocks 2\.2\.0 warning patch already applied/u);
  console.log(
    `✓ clean install as root: ${wordpress.length} WordPress packages placed, patch verified`,
  );
}

// 2. allow-plugins still decides which plugins run: COMPOSER_ALLOW_SUPERUSER
// trusts root, not every plugin.
{
  const blocked = await workspace("blocked", (composer) => {
    delete composer.config["allow-plugins"]["composer/installers"];
  });
  const run = inImage(blocked.root, install);
  assert.notEqual(run.status, 0, run.output);
  assert.match(run.output, /composer\/installers.*allow-plugins/su);
  assert.equal(await exists(blocked.path(`${blocks}/plugin.php`)), false);
  console.log("✓ a plugin missing from allow-plugins is still refused");
}

// 3. The failure CI had: root without COMPOSER_ALLOW_SUPERUSER.
{
  const control = await workspace("without-superuser");
  const run = inImage(control.root, `env -u COMPOSER_ALLOW_SUPERUSER ${install}`);
  assert.notEqual(run.status, 0, run.output);
  assert.match(run.output, new RegExp(plugins, "u"));
  assert.match(
    run.output,
    /GETQUICK dependency patch failed: Missing or unsupported wpgraphql-blocks/u,
  );
  assert.equal(await exists(control.path(`${blocks}/plugin.php`)), false);
  assert.ok(await exists(control.path("vendor/wp-plugin/wpgraphql-blocks/plugin.php")));
  console.log("✓ without COMPOSER_ALLOW_SUPERUSER the install fails as it did in CI");
}

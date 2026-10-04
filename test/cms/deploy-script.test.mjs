// The CMS deploy script (deploy/ploi/admin.sh), fully generated from
// gq.ops.json, run as Ploi runs it: in a site directory, with stub wp,
// composer, rsync, curl, php and sudo on PATH that record their calls.
import assert from "node:assert/strict";
import { access, lstat, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ploiReleaseShippedPaths } from "../../src/index.mjs";

import { createFixtureSite } from "../support/fixture-site.mjs";
import { deploy, recordingExtension } from "../support/deploy-script.mjs";
import { hash, newSite, readSite } from "../support/generated-site.mjs";

const PLUGINS = ["getquick-design", "acme-blocks", "wp-graphql"];

const ACME = {
  schemaVersion: 1,
  project: "acme-shop",
  variant: "content",
  wordpress: { plugins: PLUGINS },
};

// The deploy script gq sync renders for ACME.
async function generatedScript() {
  const fixture = await createFixtureSite({ ops: ACME });
  const result = await fixture.run(["sync"]);
  assert.equal(result.code, 0, result.stderr);
  return readSite(fixture.root, "deploy/ploi/admin.sh");
}

function wpCalls(calls, command) {
  return calls.filter(([tool, ...args]) => tool === "wp" && args.join(" ").startsWith(command));
}

test("the deploy script activates exactly the plugins gq.ops.json lists, in order", async () => {
  const result = await deploy(await generatedScript());

  assert.equal(result.code, 0, result.output);
  assert.deepEqual(
    wpCalls(result.calls, "plugin activate").map(([, , , plugin]) => plugin),
    PLUGINS,
  );
  assert.deepEqual(
    wpCalls(result.calls, "plugin is-installed").map(([, , , plugin]) => plugin),
    PLUGINS,
  );
  assert.match(result.stdout, /^ACME_SHOP_DEPLOY_STATUS=success SHA=0123abcd$/mu);
});

test("the deploy checks gq-config through its unchanged must-use plugin version constant", async () => {
  const script = await generatedScript();
  const check = 'eval exit(defined("GETQUICK_CONFIG_VERSION") ? 0 : 1);';
  const loaded = await deploy(script);
  assert.equal(loaded.code, 0, loaded.output);
  assert.ok(wpCalls(loaded.calls, check).length === 1);
  assert.ok(!wpCalls(loaded.calls, "plugin activate").some((call) => call.includes("gq-config")));

  const missing = await deploy(script, { failing: [check] });
  assert.equal(missing.code, 1, missing.output);
  assert.match(
    missing.stderr,
    /The gq-config must-use plugin did not load \(GETQUICK_CONFIG_VERSION is undefined\)\./u,
  );
  assert.deepEqual(wpCalls(missing.calls, "core update-db"), []);
  assert.doesNotMatch(missing.stdout, /^ACME_SHOP_DEPLOY_STATUS=success/mu);
});

test("the deploy script replaces exactly the paths gq ploi release ships", async () => {
  const result = await deploy(await generatedScript());

  assert.equal(result.code, 0, result.output);
  // The main rsync protects what the server owns; the copy-back of shipped
  // plugins and themes doesn't.
  const replaced = result.calls.filter(
    ([tool, ...args]) => tool === "rsync" && args.includes("--filter=P /.env"),
  );
  assert.deepEqual(
    replaced.map((call) => call.at(-1)),
    ploiReleaseShippedPaths.map((path) => `${path}/`),
  );
});

test("the deploy extensions run in lexical order from apps/cms, after activation and update-db", async () => {
  const result = await deploy(await generatedScript(), {
    releaseFiles: {
      "deploy/ploi/admin.d/20-retire.sh": recordingExtension("20-retire.sh"),
      "deploy/ploi/admin.d/10-theme.sh": recordingExtension("10-theme.sh"),
      "deploy/ploi/admin.d/9-late.sh": recordingExtension("9-late.sh"),
      "deploy/ploi/admin.d/a-lower.sh": recordingExtension("a-lower.sh"),
      "deploy/ploi/admin.d/B-upper.sh": recordingExtension("B-upper.sh"),
      // Not an extension: only *.sh files run.
      "deploy/ploi/admin.d/README.md": "# Deploy extensions\n",
      "deploy/ploi/admin.d/notes.txt": recordingExtension("notes.txt"),
    },
  });

  assert.equal(result.code, 0, result.output);
  const ran = result.calls.filter(([tool]) => tool === "extension");
  assert.deepEqual(
    ran.map(([, name]) => name),
    ["10-theme.sh", "20-retire.sh", "9-late.sh", "B-upper.sh", "a-lower.sh"],
  );
  for (const [, , cwd] of ran) assert.equal(cwd, `${result.site}/apps/cms`);
  // After the last activation and the database update, before the flush.
  const at = (call) => result.calls.indexOf(call);
  assert.ok(at(wpCalls(result.calls, "plugin activate").at(-1)) < at(ran[0]));
  assert.ok(at(wpCalls(result.calls, "core update-db")[0]) < at(ran[0]));
  assert.ok(at(ran.at(-1)) < at(wpCalls(result.calls, "rewrite flush")[0]));
  assert.match(result.stdout, /^Running deploy extension deploy\/ploi\/admin\.d\/10-theme\.sh$/mu);
});

test("a failing deploy extension fails the deploy and leaves maintenance mode off", async () => {
  const result = await deploy(await generatedScript(), {
    releaseFiles: {
      "deploy/ploi/admin.d/10-first.sh": recordingExtension("10-first.sh"),
      "deploy/ploi/admin.d/20-fails.sh": recordingExtension("20-fails.sh", 3),
      "deploy/ploi/admin.d/30-never.sh": recordingExtension("30-never.sh"),
    },
  });

  assert.equal(result.code, 3);
  assert.deepEqual(
    result.calls.filter(([tool]) => tool === "extension").map(([, name]) => name),
    ["10-first.sh", "20-fails.sh"],
  );
  assert.match(
    result.stderr,
    /^Deploy extension deploy\/ploi\/admin\.d\/20-fails\.sh failed \(exit 3\)\.$/mu,
  );
  assert.match(result.stdout, /^ACME_SHOP_DEPLOY_STATUS=failed EXIT_CODE=3 SHA=0123abcd$/mu);
  const maintenance = wpCalls(result.calls, "maintenance-mode").map(([, , action]) => action);
  assert.deepEqual(maintenance, ["activate", "deactivate"]);
  assert.deepEqual(result.calls.at(-1), ["wp", "maintenance-mode", "deactivate"]);
  assert.doesNotMatch(result.stdout, /^ACME_SHOP_DEPLOY_STATUS=success/mu);
});

test("before WordPress is installed, the deploy activates nothing and runs no extension", async () => {
  const result = await deploy(await generatedScript(), {
    installed: false,
    releaseFiles: { "deploy/ploi/admin.d/10-theme.sh": recordingExtension("10-theme.sh") },
  });

  assert.equal(result.code, 0, result.output);
  assert.deepEqual(
    result.calls.filter(([tool]) => tool === "wp").map((call) => call.join(" ")),
    ["wp core is-installed", "wp maintenance-mode deactivate"],
  );
  assert.match(result.stdout, /^ACME_SHOP_DEPLOY_STATUS=success SHA=0123abcd$/mu);
});

test("a site without deploy extensions deploys", async () => {
  const result = await deploy(await generatedScript());

  assert.equal(result.code, 0, result.output);
  assert.doesNotMatch(result.output, /extension/u);
  assert.deepEqual(
    wpCalls(result.calls, "maintenance-mode").map(([, , action]) => action),
    ["activate", "deactivate"],
  );
});

test("the deploy passes COMPOSER_AUTH to Composer and never prints it", async () => {
  const composerAuth = '{"http-basic":{"proxy.composer.getquick.io":{"password":"secret-login"}}}';
  for (const releaseFiles of [
    {},
    { "deploy/ploi/admin.d/10-fails.sh": recordingExtension("10-fails.sh", 1) },
  ]) {
    const result = await deploy(await generatedScript(), { composerAuth, releaseFiles });

    assert.equal(result.composerAuth, composerAuth);
    assert.doesNotMatch(result.output, /secret-login/u);
  }
});

test("gq new writes the deploy script and the deploy extension directory", async () => {
  const site = await newSite();

  const script = await readSite(site.root, "deploy/ploi/admin.sh");
  assert.equal((await lstat(join(site.root, "deploy/ploi/admin.sh"))).mode & 0o777, 0o755);
  assert.match(script, /^ {2}for plugin in gq-design gq-support .* safe-svg; do$/mu);
  assert.match(script, /^ {4}echo "ACME_DEPLOY_STATUS=success SHA=\$deployed_sha"$/mu);
  assert.match(
    await readSite(site.root, "deploy/ploi/admin.d/README.md"),
    /^# CMS deploy extensions$/mu,
  );
  const lock = JSON.parse(await readSite(site.root, "gq.lock.json"));
  assert.equal(lock.files["deploy/ploi/admin.sh"], hash(script));
  assert.ok(lock.created.includes("deploy/ploi/admin.d/README.md"));

  // It activates the CMS skeleton's plugins, then its theme extension
  // activates getquick-theme.
  const extension = "deploy/ploi/admin.d/10-theme.sh";
  const result = await deploy(script, {
    releaseFiles: { [extension]: await readSite(site.root, extension) },
  });
  assert.equal(result.code, 0, result.output);
  const { plugins } = JSON.parse(await readSite(site.root, "gq.ops.json")).wordpress;
  assert.deepEqual(
    wpCalls(result.calls, "plugin activate").map(([, , , plugin]) => plugin),
    plugins,
  );
  assert.deepEqual(wpCalls(result.calls, "theme activate"), [
    ["wp", "theme", "activate", "getquick-theme"],
  ]);
});

test("listing a plugin in gq.ops.json makes gq sync add it to the deploy script", async () => {
  const site = await newSite();
  const manifest = JSON.parse(await readSite(site.root, "gq.ops.json"));
  await writeFile(
    join(site.root, "gq.ops.json"),
    `${JSON.stringify({ ...manifest, wordpress: { plugins: ["wp-graphql", "acme-blocks"] } }, null, 2)}\n`,
  );

  const check = await site.run(["sync", "--check"]);
  assert.equal(check.code, 1);
  assert.match(check.stdout, /^deploy\/ploi\/admin\.sh: pending, gq sync would update it\.$/mu);
  const sync = await site.run(["sync"]);
  assert.equal(sync.code, 0, sync.stderr);

  const script = await readSite(site.root, "deploy/ploi/admin.sh");
  assert.match(script, /^ {2}for plugin in wp-graphql acme-blocks; do$/mu);
  const result = await deploy(script);
  assert.deepEqual(
    wpCalls(result.calls, "plugin activate").map(([, , , plugin]) => plugin),
    ["wp-graphql", "acme-blocks"],
  );
});

test("gq sync leaves the deploy extensions alone, and doesn't restore a deleted directory", async () => {
  const site = await newSite();
  await writeFile(join(site.root, "deploy/ploi/admin.d/10-site.sh"), "wp theme activate acme\n");
  await writeFile(join(site.root, "deploy/ploi/admin.d/README.md"), "# Ours now\n");

  assert.equal((await site.run(["sync", "--check"])).code, 0);
  assert.equal(await readSite(site.root, "deploy/ploi/admin.d/README.md"), "# Ours now\n");

  await rm(join(site.root, "deploy/ploi/admin.d"), { recursive: true });
  const sync = await site.run(["sync"]);
  assert.equal(sync.code, 0, sync.stderr);
  await assert.rejects(access(join(site.root, "deploy/ploi/admin.d")), { code: "ENOENT" });
});

test("a plugin that isn't a plugin slug is refused before gq sync writes anything", async () => {
  for (const plugin of ["acme blocks", "acme;reboot", "$(reboot)", "-acme", "../acme"]) {
    const fixture = await createFixtureSite({
      ops: { ...ACME, wordpress: { plugins: ["wp-graphql", plugin] } },
    });

    const result = await fixture.run(["sync"]);

    assert.equal(result.code, 1, plugin);
    assert.equal(
      result.stderr,
      "gq: gq.ops.json is invalid: wordpress.plugins[1] must be a plugin slug " +
        "(letters, digits, -, _ and ., starting with a letter or digit).\n",
    );
    await assert.rejects(access(fixture.path("deploy/ploi/admin.sh")), { code: "ENOENT" });
  }
});

// The deploy script gq sync renders for ACME with `locale` as its
// wordpress.locale.
async function scriptWithLocale(locale) {
  const fixture = await createFixtureSite({
    ops: { ...ACME, wordpress: { plugins: PLUGINS, locale } },
  });
  const result = await fixture.run(["sync"]);
  assert.equal(result.code, 0, result.stderr);
  return readSite(fixture.root, "deploy/ploi/admin.sh");
}

const languageCalls = (calls) =>
  calls
    .filter(
      ([tool, command, ...args]) =>
        tool === "wp" && (command === "language" || args[1] === "WPLANG"),
    )
    .map((call) => call.slice(1).join(" "));

test("the deploy installs wordpress.locale's language and makes it the site's", async () => {
  const result = await deploy(await scriptWithLocale("pt_PT_ao90"), {
    languageInstalled: false,
    releaseFiles: { "deploy/ploi/admin.d/10-theme.sh": recordingExtension("10-theme.sh") },
  });

  assert.equal(result.code, 0, result.output);
  assert.deepEqual(languageCalls(result.calls), [
    "language core is-installed pt_PT_ao90",
    "language core install pt_PT_ao90",
    "option update WPLANG pt_PT_ao90 --quiet",
    "language core update --quiet",
    "language plugin install --all pt_PT_ao90 --quiet",
    "language plugin update --all --quiet",
    "language theme install --all pt_PT_ao90 --quiet",
    "language theme update --all --quiet",
  ]);
  // After the database update, before the site's own extensions.
  const at = (call) => result.calls.indexOf(call);
  const extension = result.calls.find(([tool]) => tool === "extension");
  assert.ok(
    at(wpCalls(result.calls, "core update-db")[0]) < at(wpCalls(result.calls, "language")[0]),
  );
  assert.ok(at(wpCalls(result.calls, "language").at(-1)) < at(extension));
});

test("the deploy doesn't reinstall an installed language", async () => {
  const result = await deploy(await scriptWithLocale("pt_PT"));

  assert.equal(result.code, 0, result.output);
  assert.deepEqual(wpCalls(result.calls, "language core install"), []);
  assert.deepEqual(wpCalls(result.calls, "option update WPLANG"), [
    ["wp", "option", "update", "WPLANG", "pt_PT", "--quiet"],
  ]);
});

test("a language the deploy can't install fails it; a missing translation only warns", async () => {
  const failed = await deploy(await scriptWithLocale("pt_PT"), {
    languageInstalled: false,
    failing: ["language core install"],
  });
  assert.equal(failed.code, 1);
  assert.deepEqual(wpCalls(failed.calls, "option update WPLANG"), []);
  assert.match(failed.stdout, /^ACME_SHOP_DEPLOY_STATUS=failed EXIT_CODE=1 /mu);

  const warned = await deploy(await scriptWithLocale("pt_PT"), {
    failing: ["language core update", "language plugin install", "language theme update"],
  });
  assert.equal(warned.code, 0, warned.output);
  assert.match(warned.stderr, /^Could not update the pt_PT core translations\.$/mu);
  assert.match(warned.stderr, /^Some plugin translations for pt_PT are not available\.$/mu);
  assert.match(warned.stderr, /^Could not update the theme translations for pt_PT\.$/mu);
});

test("an en_US site's deploy only makes English the site's language", async () => {
  const result = await deploy(await scriptWithLocale("en_US"));

  assert.equal(result.code, 0, result.output);
  assert.deepEqual(languageCalls(result.calls), ["option update WPLANG  --quiet"]);
});

test("without wordpress.locale, the deploy leaves the site's language alone", async () => {
  const result = await deploy(await generatedScript());

  assert.equal(result.code, 0, result.output);
  assert.deepEqual(languageCalls(result.calls), []);
});

test("the deploy keeps the server's language packs", async () => {
  const result = await deploy(await scriptWithLocale("pt_PT"));

  const replaced = result.calls.filter(
    ([tool, ...args]) => tool === "rsync" && args.includes("--filter=P /.env"),
  );
  assert.ok(replaced.length > 0);
  for (const call of replaced) assert.ok(call.includes("--filter=P /web/app/languages/"));
});

test("a locale that isn't a WordPress locale is refused before gq sync writes anything", async () => {
  for (const locale of ["pt-PT", "PT_pt", "pt_PT;reboot", "$(reboot)", "-pt", "pt_PT_"]) {
    const fixture = await createFixtureSite({
      ops: { ...ACME, wordpress: { plugins: PLUGINS, locale } },
    });

    const result = await fixture.run(["sync"]);

    assert.equal(result.code, 1, locale);
    assert.equal(
      result.stderr,
      "gq: gq.ops.json is invalid: wordpress.locale must be a WordPress locale, " +
        "like en_US, pt_PT or pt_PT_ao90.\n",
    );
    await assert.rejects(access(fixture.path("deploy/ploi/admin.sh")), { code: "ENOENT" });
  }
});

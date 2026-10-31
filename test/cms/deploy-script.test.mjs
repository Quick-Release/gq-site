// The CMS deploy script (deploy/ploi/admin.sh), fully generated from
// gq.ops.json, run as Ploi runs it: in a site directory, with stub wp,
// composer, rsync, curl, php and sudo on PATH that record their calls.
import assert from "node:assert/strict";
import { access, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ploiReleaseShippedPaths } from "../../src/index.mjs";
import { renderServerExpectations } from "../../src/ploi/package-expectations.mjs";

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

test("full and Composer-only deploys verify dependency patches before activation and fail on patch errors", async () => {
  const script = await generatedScript();
  for (const composerOnly of [false, true]) {
    const result = await deploy(script, { composerOnly });
    assert.equal(result.code, 0, result.output);
    const composer = result.calls.findIndex(([tool]) => tool === "composer");
    const patch = result.calls.findIndex(
      ([tool, arg]) => tool === "php" && arg === "scripts/patch-dependencies.php",
    );
    assert.ok(patch > composer);
    const activation = result.calls.findIndex(([tool, arg]) => tool === "wp" && arg === "plugin");
    assert.ok(composerOnly ? activation === -1 : activation > patch);
    const failed = await deploy(script, { composerOnly, patchExit: 27 });
    assert.equal(failed.code, 27, failed.output);
    assert.deepEqual(wpCalls(failed.calls, "plugin activate"), []);
    assert.deepEqual(wpCalls(failed.calls, "core update-db"), []);
    assert.match(failed.output, /DEPLOY_STATUS=failed/u);
  }
});

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

test("a site with plain permalinks gets /%postname%/ after the extensions, before the flush", async () => {
  const result = await deploy(await generatedScript(), {
    releaseFiles: { "deploy/ploi/admin.d/10-theme.sh": recordingExtension("10-theme.sh") },
  });

  assert.equal(result.code, 0, result.output);
  const [structure, ...more] = wpCalls(result.calls, "rewrite structure");
  assert.deepEqual(more, []);
  assert.deepEqual(structure, ["wp", "rewrite", "structure", "/%postname%/", "--quiet"]);
  const at = (call) => result.calls.indexOf(call);
  const extension = result.calls.find(([tool]) => tool === "extension");
  assert.ok(at(extension) < at(wpCalls(result.calls, "option get permalink_structure")[0]));
  assert.ok(at(structure) < at(wpCalls(result.calls, "rewrite flush")[0]));
  assert.match(result.stdout, /^Setting pretty permalinks \(\/%postname%\/\)/mu);
});

test("a permalink structure the site already has stays", async () => {
  const result = await deploy(await generatedScript(), {
    permalinkStructure: "/%year%/%monthnum%/%postname%/",
  });

  assert.equal(result.code, 0, result.output);
  assert.equal(wpCalls(result.calls, "option get permalink_structure").length, 1);
  assert.deepEqual(wpCalls(result.calls, "rewrite structure"), []);
  assert.equal(wpCalls(result.calls, "rewrite flush").length, 1);
});

test("a permalink structure that can't be read fails the deploy instead of replacing it", async () => {
  const result = await deploy(await generatedScript(), {
    failing: ["option get permalink_structure"],
  });

  assert.equal(result.code, 1, result.output);
  assert.deepEqual(wpCalls(result.calls, "rewrite structure"), []);
  assert.deepEqual(wpCalls(result.calls, "rewrite flush"), []);
  assert.match(result.stdout, /^ACME_SHOP_DEPLOY_STATUS=failed/mu);
});

test("a Composer-only deploy and a deploy before WordPress is installed leave permalinks alone", async () => {
  const script = await generatedScript();
  for (const options of [{ composerOnly: true }, { installed: false }]) {
    const result = await deploy(script, options);
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(wpCalls(result.calls, "option get permalink_structure"), []);
    assert.deepEqual(wpCalls(result.calls, "rewrite structure"), []);
  }
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

// --- guarded packages: the installed tree checked after composer install -----

const SUPPORT_PATH = "apps/cms/web/app/plugins/gq-support";
// The tree package-expectations.test.mjs pins with coreutils' digest.
const SUPPORT_TREE = {
  "gq-support.php": "hello\n",
  "src/a-b.php": "abc",
  "Z.txt": "Z",
};
// The approved package, files from its approval record; the digest is
// gq-support.files/v1's, from printf '<path>\0<sha256>\n' ... | sha256sum.
const SUPPORT = {
  name: "getquick/gq-support",
  version: "0.1.11",
  installPath: "web/app/plugins/gq-support",
  filesDigest: "57661d4dc252d72859e8ac659219b6948230f73e2916aa631a04761219bf77d3",
  files: {
    "gq-support.php": "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
    "src/a-b.php": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "Z.txt": "bbeebd879e1dff6918546dc0c179fdde505f2a21591c9a9c96e36b054ec5af83",
  },
};
const LOCK = '{"packages":[{"name":"getquick/gq-support","version":"0.1.11"}]}\n';

// The guarded Site's request admission, as gq sync renders it (set by
// guardedScript); every guarded release ships it.
let admissionScript;

async function guardedScript() {
  const fixture = await createFixtureSite({
    ops: {
      ...ACME,
      domains: { admin: "cms.acme.test", frontend: "www.acme.test" },
      deployment: {
        protected: true,
        state: "authorized",
        guardedPackages: ["getquick/gq-support"],
        approval: { slot: "acme/production", stage: "prod" },
      },
    },
  });
  const result = await fixture.run(["sync"]);
  assert.equal(result.code, 0, result.stderr);
  admissionScript = await readSite(fixture.root, "deploy/ploi/admission.sh");
  return readSite(fixture.root, "deploy/ploi/admin.sh");
}

// deploy(), for a guarded release: it ships the request admission.
function deployGuarded(script, { releaseFiles = {}, ...options } = {}) {
  return deploy(script, {
    ...options,
    releaseFiles: { "deploy/ploi/admission.sh": admissionScript, ...releaseFiles },
  });
}

// A guarded deploy whose server has `tree` installed (path → content), with
// the release's lock `lock` and expectations rendered for `releasedLock`.
function guardedDeploy(
  script,
  {
    tree = SUPPORT_TREE,
    composerOnly = false,
    lock = LOCK,
    releasedLock = LOCK,
    expectations = true,
    siteFiles = {},
    releaseFiles = {},
    ...options
  } = {},
) {
  return deployGuarded(script, {
    ...options,
    composerOnly,
    releaseFiles: {
      ...releaseFiles,
      "apps/cms/composer.lock": lock,
      ...(expectations
        ? { PACKAGE_EXPECTATIONS: renderServerExpectations([SUPPORT], releasedLock) }
        : {}),
    },
    siteFiles: {
      ...Object.fromEntries(
        Object.entries(tree).map(([path, content]) => [`${SUPPORT_PATH}/${path}`, content]),
      ),
      ...siteFiles,
    },
  });
}

// No PHP-FPM reload (sudo), activation, database or rewrite step ran.
// PHP-FPM reloads after Composer started (a guarded deploy's request
// admission reloads it once before anything changes).
function reloadsAfterComposer(calls) {
  const composer = calls.findIndex(([tool]) => tool === "composer");
  return composer === -1 ? [] : calls.slice(composer).filter(([tool]) => tool === "sudo");
}

function assertStoppedBeforeWordPress(result) {
  assert.deepEqual(reloadsAfterComposer(result.calls), []);
  for (const step of ["plugin", "core update-db", "rewrite", "theme", "option", "language"]) {
    assert.deepEqual(wpCalls(result.calls, step), [], step);
  }
  assert.match(result.stdout, /DEPLOY_STATUS=failed/u);
}

test("a guarded deploy verifies the installed tree after Composer and before the PHP-FPM reload", async () => {
  const script = await guardedScript();
  assert.match(script, /^GUARDED_PACKAGES="getquick\/gq-support"$/mu);

  for (const composerOnly of [false, true]) {
    const result = await guardedDeploy(script, { composerOnly });
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /Verified getquick\/gq-support 0\.1\.11: 3 files match 57661d4d/u);
    const composer = result.calls.findIndex(([tool]) => tool === "composer");
    assert.ok(composer !== -1 && reloadsAfterComposer(result.calls).length === 1);
    if (composerOnly) {
      // Composer-only: no WP-CLI call at all, so no activation or database step.
      assert.deepEqual(
        result.calls.filter(([tool]) => tool === "wp"),
        [],
      );
    } else {
      assert.ok(wpCalls(result.calls, "core update-db").length === 1);
    }
  }
});

test("a guarded deploy refuses an extra, missing or changed file before the reload, activation or database", async () => {
  const script = await guardedScript();
  const cases = [
    [{ ...SUPPORT_TREE, "src/backdoor.php": "<?php" }, /extra\s+src\/backdoor\.php/u],
    [{ "gq-support.php": "hello\n", "Z.txt": "Z" }, /missing\s+src\/a-b\.php/u],
    [{ ...SUPPORT_TREE, "Z.txt": "changed" }, /changed\s+Z\.txt/u],
  ];
  for (const [tree, message] of cases) {
    for (const composerOnly of [false, true]) {
      const result = await guardedDeploy(script, { tree, composerOnly });
      assert.notEqual(result.code, 0, result.output);
      assert.match(result.stderr, /getquick\/gq-support's installed files don't match/u);
      assert.match(result.stderr, message);
      assertStoppedBeforeWordPress(result);
      if (composerOnly)
        assert.deepEqual(
          result.calls.filter(([tool]) => tool === "wp"),
          [],
        );
    }
  }
});

test("a guarded deploy refuses another lock, or a release without expectations, before changing anything on the server", async () => {
  const script = await guardedScript();
  for (const [options, message] of [
    [{ lock: '{"packages":[]}\n' }, /The release's composer\.lock isn't the lock gq checked/u],
    [
      { expectations: false },
      /guards getquick\/gq-support, but the release has no PACKAGE_EXPECTATIONS/u,
    ],
  ]) {
    for (const composerOnly of [false, true]) {
      const result = await guardedDeploy(script, { ...options, composerOnly });
      assert.notEqual(result.code, 0, result.output);
      assert.match(result.stderr, message);
      // Nothing replaced, installed, reloaded or run in WordPress: not even
      // maintenance mode.
      assert.deepEqual(
        result.calls.filter(([tool]) => ["rsync", "composer", "sudo", "wp", "php"].includes(tool)),
        [],
      );
      assert.match(result.stdout, /DEPLOY_STATUS=failed/u);
    }
  }
});

test("a guarded deploy refuses an installed file whose name the approval can't hold", async () => {
  const script = await guardedScript();
  // gq-support's paths have no spaces: such a file is never approved.
  const result = await guardedDeploy(script, {
    tree: { ...SUPPORT_TREE, "src/a b.php": "abc" },
    composerOnly: true,
  });
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.stderr, /extra\s+src\/a b\.php/u);
  assertStoppedBeforeWordPress(result);
});

test("an unguarded Site's deploy ignores package expectations it doesn't guard", async () => {
  const script = await generatedScript();
  assert.match(script, /^GUARDED_PACKAGES=""$/mu);
  const result = await deploy(script);
  assert.equal(result.code, 0, result.output);
  assert.doesNotMatch(result.stdout, /Verified/u);
});

// --- guarded packages: held by the request admission for the whole deploy --

const HOLD = ".gq/hold";
const GATE = ".gq/admission.php";
const INI = "apps/cms/web/.user.ini";
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

// The index of the first call to `tool` (with `arg`), or -1.
const firstCall = (calls, tool, arg) =>
  calls.findIndex(([name, ...args]) => name === tool && (!arg || args.includes(arg)));

async function assertHeld(result) {
  assert.match(await readFile(join(result.site, HOLD), "utf8"), /^[0-9a-f]{32}\n$/u);
  assert.ok(
    result.calls.some(([tool]) => tool === "composer-saw-hold"),
    "held before Composer",
  );
  assert.doesNotMatch(result.stdout, /hold is lifted/u);
  assert.deepEqual(wpCalls(result.calls, "maintenance-mode"), []);
}

test("a guarded deploy holds the Site, and proves it, before replacing or installing anything", async () => {
  const script = await guardedScript();
  for (const composerOnly of [false, true]) {
    const result = await guardedDeploy(script, { composerOnly });
    assert.equal(result.code, 0, result.output);
    const reload = firstCall(result.calls, "sudo");
    const probes = result.calls.filter(
      ([tool, ...args]) => tool === "curl" && args.includes("--resolve"),
    );
    const rsync = firstCall(result.calls, "rsync");
    const composer = firstCall(result.calls, "composer");
    assert.ok(
      reload !== -1 && reload < rsync && rsync < composer,
      "reloaded before anything changed",
    );
    // TLS for the admin domain on this machine, the certificate checked, no
    // redirect followed: the front page and setup-config.php.
    assert.deepEqual(
      probes.map((call) => call.at(-1)),
      ["https://cms.acme.test/", "https://cms.acme.test/wp/wp-admin/setup-config.php"],
    );
    for (const probe of probes) {
      assert.ok(probe.includes("cms.acme.test:443:127.0.0.1"));
      assert.ok(probe.includes("=https") && probe.includes("--max-redirs"));
      assert.ok(!probe.includes("--insecure") && !probe.includes("-k"));
      assert.ok(result.calls.indexOf(probe) < rsync);
    }
    assert.ok(result.calls.some(([tool]) => tool === "composer-saw-hold"));
    assert.match(
      result.stdout,
      /Held: PHP-FPM reloaded, every worker that ran before the hold has gone/u,
    );
    // Lifted only at the very end; the gate and .user.ini stay.
    assert.match(result.stdout, /The hold is lifted/u);
    assert.equal(await exists(join(result.site, HOLD)), false);
    assert.match(await readFile(join(result.site, GATE), "utf8"), /PHP_SAPI !== 'cli'/u);
    assert.match(
      await readFile(join(result.site, INI), "utf8"),
      new RegExp(`auto_prepend_file = "${join(result.site, GATE).replaceAll("/", "\\/")}"`, "u"),
    );
    assert.deepEqual(wpCalls(result.calls, "maintenance-mode"), []);
  }
});

test("a guarded deploy that fails or is killed once the hold is proven keeps it", async () => {
  const script = await guardedScript();
  for (const composerOnly of [false, true]) {
    for (const [options, label] of [
      [{ composerExit: 2 }, "Composer fails mid-install"],
      [{ composerKill: true }, "the deploy is killed mid-install (no exit trap)"],
      [{ tree: { ...SUPPORT_TREE, "src/backdoor.php": "<?php" } }, "the packages don't verify"],
    ]) {
      const result = await guardedDeploy(script, { ...options, composerOnly });
      assert.notEqual(result.code, 0, `${label}: ${result.output}`);
      await assertHeld(result);
      assert.deepEqual(reloadsAfterComposer(result.calls), [], label);
      for (const step of ["plugin", "core update-db", "rewrite", "option"]) {
        assert.deepEqual(wpCalls(result.calls, step), [], `${label}: ${step}`);
      }
    }
  }
  // A step after verification (a deploy extension) failing keeps it too.
  const extension = await guardedDeploy(script, {
    releaseFiles: { "deploy/ploi/admin.d/10-fail.sh": recordingExtension("10-fail.sh", 4) },
  });
  assert.equal(extension.code, 4, extension.output);
  await assertHeld(extension);
});

test("a guarded deploy whose hold can't be proven changes no package, removes only its own hold, and says what it did change", async () => {
  const script = await guardedScript();
  const cases = [
    [{ SUDO_EXIT: "1" }, /PHP-FPM couldn't be reloaded \(sudo -n service php8\.3-fpm reload\)/u],
    [{ CURL_PROBE: "stale" }, /didn't answer 503 with this hold's nonce/u],
    [{ CURL_PROBE: "down" }, /didn't answer 503 with this hold's nonce/u],
    [
      { PS_STUCK: "1", GQ_ADMISSION_DRAIN_SECONDS: "1" },
      /1 PHP-FPM 8\.3 worker\(s\) that ran before the hold were still running after 1s/u,
    ],
    [{ PS_NONE: "1" }, /no PHP-FPM 8\.3 worker is visible to this user/u],
  ];
  for (const [env, message] of cases) {
    // A first hold: removed again.
    const first = await guardedDeploy(script, { env });
    assert.notEqual(first.code, 0, first.output);
    assert.match(first.stderr, message);
    assert.match(
      first.stderr,
      /No package file was changed; the admission gate apps\/cms\/web\/\.user\.ini .*changed\. The hold this attempt placed was removed\./u,
    );
    assert.doesNotMatch(first.stderr, /nothing changed/u);
    assert.equal(await exists(join(first.site, HOLD)), false);
    assert.deepEqual(
      first.calls.filter(([tool]) => ["rsync", "composer"].includes(tool)),
      [],
    );

    // A hold an earlier failed deploy left: kept.
    const earlier = await guardedDeploy(script, {
      env,
      siteFiles: { [HOLD]: "f".repeat(32) + "\n" },
    });
    assert.notEqual(earlier.code, 0, earlier.output);
    assert.match(earlier.stderr, /The hold an earlier failed deploy left stays\./u);
    assert.equal(await exists(join(earlier.site, HOLD)), true);
    assert.deepEqual(
      earlier.calls.filter(([tool]) => ["rsync", "composer"].includes(tool)),
      [],
    );
  }
});

test("the request admission keeps a .user.ini's other settings, and refuses a prepend it didn't write", async () => {
  const script = await guardedScript();
  const kept = await guardedDeploy(script, {
    siteFiles: { [INI]: "memory_limit = 256M\nupload_max_filesize = 64M\n" },
  });
  assert.equal(kept.code, 0, kept.output);
  const ini = await readFile(join(kept.site, INI), "utf8");
  assert.match(
    ini,
    /^memory_limit = 256M\nupload_max_filesize = 64M\n\n; BEGIN GETQUICK request admission/u,
  );
  assert.match(ini, /auto_prepend_file = /u);

  for (const conflicting of [
    "auto_prepend_file = /srv/other/prepend.php\n",
    "  AUTO_PREPEND_FILE=/srv/other/prepend.php\n",
  ]) {
    const refused = await guardedDeploy(script, { siteFiles: { [INI]: conflicting } });
    assert.notEqual(refused.code, 0, refused.output);
    assert.match(
      refused.stderr,
      /already sets auto_prepend_file; gq won't replace or chain unknown prepend code/u,
    );
    assert.equal(await readFile(join(refused.site, INI), "utf8"), conflicting);
    assert.equal(await exists(join(refused.site, HOLD)), false);
    assert.equal(firstCall(refused.calls, "sudo"), -1);
    assert.deepEqual(
      refused.calls.filter(([tool]) => ["rsync", "composer"].includes(tool)),
      [],
    );
  }
});

test("the release's real rsync --delete keeps the request admission's .user.ini, and what the release doesn't ship goes", async (t) => {
  if (!(await exists("/usr/bin/rsync"))) return t.skip("needs /usr/bin/rsync");
  const script = await guardedScript();
  for (const composerOnly of [false, true]) {
    const result = await guardedDeploy(script, {
      composerOnly,
      env: { REAL_RSYNC: "1" },
      siteFiles: {
        [INI]: "memory_limit = 256M\n",
        "apps/cms/web/stale.php": "<?php // not in the release\n",
      },
    });
    assert.equal(result.code, 0, result.output);
    assert.ok(result.calls.some(([tool]) => tool === "rsync"));
    const ini = await readFile(join(result.site, INI), "utf8");
    assert.match(ini, /^memory_limit = 256M\n\n; BEGIN GETQUICK request admission/u);
    assert.match(ini, /auto_prepend_file = /u);
    // --delete is real: a file the release doesn't ship is gone.
    assert.equal(await exists(join(result.site, "apps/cms/web/stale.php")), false);
    assert.equal(await readFile(join(result.site, "apps/cms/web/index.php"), "utf8"), "<?php\n");
  }
});

test("the request admission refuses symlinks and other files where it writes, an invisible PHP-FPM, a release shipping .user.ini, and an unusable admin domain", async () => {
  const script = await guardedScript();
  for (const [options, message] of [
    [{ siteLinks: { [HOLD]: "/etc/passwd" } }, /\.gq\/hold isn't a regular file gq can manage/u],
    [{ siteLinks: { [INI]: "/etc/php.ini" } }, /\.user\.ini isn't a regular file gq can manage/u],
    [{ siteLinks: { ".gq": "/tmp" } }, /\.gq isn't a directory gq can manage/u],
    [{ siteDirectories: [HOLD] }, /\.gq\/hold isn't a regular file/u],
    [{ env: { PS_NO_MASTER: "1" } }, /PHP-FPM 8\.3's master process isn't visible to this user/u],
    [
      { releaseFiles: { [INI]: "memory_limit = 1G\n" } },
      /The release ships apps\/cms\/web\/\.user\.ini/u,
    ],
  ]) {
    const result = await guardedDeploy(script, options);
    assert.notEqual(result.code, 0, result.output);
    assert.match(result.stderr, message);
    assert.equal(firstCall(result.calls, "sudo"), -1);
    assert.deepEqual(
      result.calls.filter(([tool]) => ["rsync", "composer"].includes(tool)),
      [],
    );
  }

  const fixture = await createFixtureSite({
    ops: {
      ...ACME,
      domains: { admin: 'cms.acme.test"; touch /tmp/x; "', frontend: "www.acme.test" },
      deployment: {
        protected: true,
        state: "authorized",
        guardedPackages: ["getquick/gq-support"],
        approval: { slot: "acme/production", stage: "prod" },
      },
    },
  });
  assert.equal((await fixture.run(["sync"])).code, 0);
  const admission = await readSite(fixture.root, "deploy/ploi/admission.sh");
  assert.match(admission, /^ADMIN_HOST=""$/mu);
});

test("an unguarded Site's failed deploy still lifts maintenance mode as before", async () => {
  const result = await deploy(await generatedScript(), { patchExit: 3 });
  assert.equal(result.code, 3, result.output);
  assert.equal(wpCalls(result.calls, "maintenance-mode deactivate").length, 1);
  await assert.rejects(access(join(result.site, ".gq")));
});

test("a guarded deploy refuses expectations that don't state exactly its guarded packages, before changing anything", async () => {
  const script = await guardedScript();
  const other = {
    ...SUPPORT,
    name: "getquick/gq-design",
    installPath: "web/app/plugins/gq-design",
  };
  for (const [packages, message] of [
    [[other], /states getquick\/gq-design, but this Site guards exactly getquick\/gq-support\./u],
    [
      [SUPPORT, other],
      /states getquick\/gq-design getquick\/gq-support, but this Site guards exactly getquick\/gq-support\./u,
    ],
  ]) {
    const result = await deployGuarded(script, {
      releaseFiles: {
        "apps/cms/composer.lock": LOCK,
        PACKAGE_EXPECTATIONS: renderServerExpectations(packages, LOCK),
      },
    });
    assert.notEqual(result.code, 0, result.output);
    assert.match(result.stderr, message);
    assert.deepEqual(
      result.calls.filter(([tool]) => ["rsync", "composer", "sudo", "wp", "php"].includes(tool)),
      [],
    );
  }
  const malformed = await deployGuarded(script, {
    releaseFiles: {
      "apps/cms/composer.lock": LOCK,
      PACKAGE_EXPECTATIONS: `${renderServerExpectations([SUPPORT], LOCK)}file ${"0".repeat(64)} ../wp-config.php\n`,
    },
  });
  assert.match(malformed.stderr, /PACKAGE_EXPECTATIONS has a line gq doesn't write/u);
  assert.deepEqual(
    malformed.calls.filter(([tool]) => tool === "rsync"),
    [],
  );
});

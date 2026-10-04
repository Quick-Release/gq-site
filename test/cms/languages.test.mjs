// A bilingual Site's languages: gq.ops.json's wordpress.languages, checked
// before gq sync writes anything, and the generated CMS deploy script that
// installs them and makes Polylang's languages match (deploy/ploi/polylang.sh),
// run as Ploi runs it with stub wp, composer, rsync, curl, php and sudo.
import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createFixtureSite } from "../support/fixture-site.mjs";
import { deploy, recordingExtension } from "../support/deploy-script.mjs";
import { newSite, readSite } from "../support/generated-site.mjs";

const PLUGINS = ["wp-graphql", "polylang-pro", "gq-polylang-graphql"];

const ACME = { schemaVersion: 1, project: "acme-shop", variant: "content" };

const BILINGUAL = {
  plugins: PLUGINS,
  locale: "pt_PT_ao90",
  languages: [{ locale: "en_US", slug: "en" }],
};

// The CMS deploy files gq sync renders for ACME with `wordpress`: the deploy
// script, and the release files it runs besides it.
async function generatedDeploy(wordpress) {
  const fixture = await createFixtureSite({ ops: { ...ACME, wordpress } });
  const result = await fixture.run(["sync"]);
  assert.equal(result.code, 0, result.stderr);
  return {
    script: await readSite(fixture.root, "deploy/ploi/admin.sh"),
    releaseFiles: {
      "deploy/ploi/polylang.sh": await readSite(fixture.root, "deploy/ploi/polylang.sh"),
    },
  };
}

// Deploys the site gq sync renders with `wordpress`, Polylang holding
// `polylang` (one line per language: slug, locale, order).
async function deployWith(wordpress, { polylang = [], releaseFiles = {}, ...options } = {}) {
  const generated = await generatedDeploy(wordpress);
  return deploy(generated.script, {
    ...options,
    polylangLanguages: polylang,
    releaseFiles: { ...generated.releaseFiles, ...releaseFiles },
  });
}

// The deploy's Polylang commands (wp eval-file - <command> …), as text.
const polylangCalls = (calls) =>
  calls
    .filter(([tool, command, file]) => tool === "wp" && command === "eval-file" && file === "-")
    .map((call) => call.slice(3).join(" "));

const changes = (calls) => polylangCalls(calls).filter((call) => /^(add|update) /u.test(call));

test("a bilingual Site's first deploy creates its languages in Polylang, the default first", async () => {
  const result = await deployWith(BILINGUAL, {
    languageInstalled: false,
    releaseFiles: { "deploy/ploi/admin.d/10-theme.sh": recordingExtension("10-theme.sh") },
  });

  assert.equal(result.code, 0, result.output);
  assert.deepEqual(polylangCalls(result.calls), [
    "languages",
    "add pt pt_PT_ao90 0",
    "add en en_US 1",
    "settings pt",
    "assign",
  ]);
  // After the site's language is set, before the site's own extensions.
  const at = (call) => result.calls.indexOf(call);
  const polylang = result.calls.filter(
    ([tool, command, file]) => tool === "wp" && command === "eval-file" && file === "-",
  );
  const wplang = result.calls.find(([tool, , , option]) => tool === "wp" && option === "WPLANG");
  const extension = result.calls.find(([tool]) => tool === "extension");
  assert.ok(at(wplang) < at(polylang[0]));
  assert.ok(at(polylang.at(-1)) < at(extension));
  assert.match(result.stdout, /^ACME_SHOP_DEPLOY_STATUS=success SHA=0123abcd$/mu);
});

test("the deploy installs every language's core pack; en_US ships with WordPress", async () => {
  const result = await deployWith(
    { ...BILINGUAL, languages: [...BILINGUAL.languages, { locale: "fr_FR", slug: "fr" }] },
    { languageInstalled: false },
  );

  assert.equal(result.code, 0, result.output);
  const installs = result.calls
    .filter(([tool, command, kind]) => tool === "wp" && command === "language" && kind === "core")
    .map((call) => call.slice(3).join(" "));
  assert.deepEqual(
    installs.filter((call) => !call.startsWith("update")),
    ["is-installed pt_PT_ao90", "install pt_PT_ao90", "is-installed fr_FR", "install fr_FR"],
  );
});

test("deploying again changes nothing in Polylang", async () => {
  const result = await deployWith(BILINGUAL, {
    polylang: ["pt pt_PT_ao90 0", "en en_US 1"],
  });

  assert.equal(result.code, 0, result.output);
  assert.deepEqual(changes(result.calls), []);
  // Both only set what is already so.
  assert.deepEqual(polylangCalls(result.calls), ["languages", "settings pt", "assign"]);
});

test("a language whose locale or order changed is updated", async () => {
  const result = await deployWith(
    {
      ...BILINGUAL,
      languages: [
        { locale: "es_ES", slug: "es" },
        { locale: "en_GB", slug: "en" },
      ],
    },
    { polylang: ["pt pt_PT_ao90 0", "en en_US 1", "es es_ES 2"] },
  );

  assert.equal(result.code, 0, result.output);
  assert.deepEqual(changes(result.calls), ["update es es_ES 1", "update en en_GB 2"]);
});

test("a language gq.ops.json no longer lists stops the deploy, naming it; none is deleted", async () => {
  const result = await deployWith(BILINGUAL, {
    polylang: ["pt pt_PT_ao90 0", "fr fr_FR 1", "de de_DE 2"],
    releaseFiles: { "deploy/ploi/admin.d/10-theme.sh": recordingExtension("10-theme.sh") },
  });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /^gq\.ops\.json no longer lists Polylang's language fr \(fr_FR\)\. List it again in wordpress\.languages, /mu,
  );
  assert.match(
    result.stderr,
    /^gq\.ops\.json no longer lists Polylang's language de \(de_DE\)\./mu,
  );
  // Before it changes anything.
  assert.deepEqual(polylangCalls(result.calls), ["languages"]);
  assert.deepEqual(
    result.calls.filter(([tool]) => tool === "extension"),
    [],
  );
  assert.match(result.stdout, /^ACME_SHOP_DEPLOY_STATUS=failed EXIT_CODE=1 /mu);
  assert.deepEqual(result.calls.at(-1), ["wp", "maintenance-mode", "deactivate"]);
});

test("a Polylang command that fails fails the deploy", async () => {
  const result = await deployWith(BILINGUAL, { failing: ["eval-file - add en"] });

  assert.equal(result.code, 1);
  assert.deepEqual(polylangCalls(result.calls), [
    "languages",
    "add pt pt_PT_ao90 0",
    "add en en_US 1",
  ]);
  assert.match(result.stdout, /^ACME_SHOP_DEPLOY_STATUS=failed EXIT_CODE=1 /mu);
});

test("a Site without wordpress.languages deploys without Polylang", async () => {
  for (const wordpress of [{ plugins: PLUGINS }, { plugins: PLUGINS, locale: "pt_PT_ao90" }]) {
    const result = await deploy((await generatedDeploy(wordpress)).script);

    assert.equal(result.code, 0, result.output);
    assert.deepEqual(polylangCalls(result.calls), []);
  }
});

test("adding wordpress.languages makes gq sync regenerate the deploy script", async () => {
  const site = await newSite();
  const manifest = JSON.parse(await readSite(site.root, "gq.ops.json"));
  const plugins = [...manifest.wordpress.plugins, "polylang-pro", "gq-polylang-graphql"];
  await writeFile(
    join(site.root, "gq.ops.json"),
    `${JSON.stringify({ ...manifest, wordpress: { ...BILINGUAL, plugins } }, null, 2)}\n`,
  );

  const check = await site.run(["sync", "--check"]);
  assert.equal(check.code, 1);
  assert.match(check.stdout, /^deploy\/ploi\/admin\.sh: pending, gq sync would update it\.$/mu);
  assert.equal((await site.run(["sync"])).code, 0);

  const script = await readSite(site.root, "deploy/ploi/admin.sh");
  assert.match(script, /^WP_LANGUAGES="en_US:en"$/mu);
});

// Each `wordpress` is refused, with `message`, before gq sync writes anything.
async function assertRefused(wordpress, message) {
  const fixture = await createFixtureSite({ ops: { ...ACME, wordpress } });

  const result = await fixture.run(["sync"]);

  assert.equal(result.code, 1, JSON.stringify(wordpress));
  assert.equal(result.stderr, `gq: gq.ops.json is invalid: ${message}.\n`);
  await assert.rejects(access(fixture.path("deploy/ploi/admin.sh")), { code: "ENOENT" });
}

test("a language's locale must be a WordPress locale", async () => {
  for (const locale of ["en-US", "EN_us", "en_US;reboot", "$(reboot)", "-en", ""]) {
    await assertRefused(
      { ...BILINGUAL, languages: [{ locale, slug: "en" }] },
      "wordpress.languages[0].locale must be a WordPress locale, like en_US, pt_PT or pt_PT_ao90",
    );
  }
});

test("a language's slug must be a lowercase URL segment", async () => {
  for (const slug of ["EN", "en/us", "en_us", "-en", "en-", "1en", "en us", "$(reboot)", ""]) {
    await assertRefused(
      { ...BILINGUAL, languages: [{ locale: "en_US", slug }] },
      "wordpress.languages[0].slug must be a lowercase URL segment, like en or pt-br",
    );
  }
});

test("wordpress.languages requires wordpress.locale, the default language", async () => {
  await assertRefused(
    { plugins: PLUGINS, languages: BILINGUAL.languages },
    "wordpress.languages needs wordpress.locale, the default language",
  );
});

test("a language's locale and slug are unique, and never the default language's", async () => {
  await assertRefused(
    {
      ...BILINGUAL,
      languages: [
        { locale: "en_US", slug: "en" },
        { locale: "en_US", slug: "us" },
      ],
    },
    "wordpress.languages[1].locale repeats en_US",
  );
  await assertRefused(
    { ...BILINGUAL, languages: [{ locale: "pt_PT_ao90", slug: "ao" }] },
    "wordpress.languages[0].locale repeats pt_PT_ao90, the default language's",
  );
  await assertRefused(
    {
      ...BILINGUAL,
      languages: [
        { locale: "en_US", slug: "en" },
        { locale: "en_GB", slug: "en" },
      ],
    },
    "wordpress.languages[1].slug repeats en",
  );
  // pt is pt_PT_ao90's: the default language's slug is its language code.
  await assertRefused(
    { ...BILINGUAL, languages: [{ locale: "pt_BR", slug: "pt" }] },
    "wordpress.languages[0].slug repeats pt, the default language's",
  );
});

test("wordpress.languages requires Polylang and its GraphQL integration in wordpress.plugins", async () => {
  const message =
    "wordpress.plugins must include polylang-pro (or polylang) and gq-polylang-graphql " +
    "for wordpress.languages";
  await assertRefused({ ...BILINGUAL, plugins: ["wp-graphql", "polylang-pro"] }, message);
  await assertRefused({ ...BILINGUAL, plugins: ["wp-graphql", "gq-polylang-graphql"] }, message);

  const free = await generatedDeploy({
    ...BILINGUAL,
    plugins: ["wp-graphql", "polylang", "gq-polylang-graphql"],
  });
  assert.match(free.script, /^WP_LANGUAGES="en_US:en"$/mu);
});

// gq.ops.json schema v1 and its migrations, driven through run(): `gq sync
// --manifest [--check]` against fixture sites holding Lombardi's and Ekis's
// real v0 manifests, and the refusals every other command makes when the
// manifest is older, newer, or invalid.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { manifestJsonSchema } from "../../src/manifest/schema.mjs";
import { VERSION } from "../../src/version.mjs";
import { createFixtureSite, recordingExec } from "../support/fixture-site.mjs";
import {
  CONTENT_CHECKS,
  missingFiles,
  releaseExec,
  releaseRun,
  verifyChecks,
  versionedFiles,
} from "../support/site-settings.mjs";

const LOMBARDI_V0 = await readFixture("lombardi.v0.json");
const EKIS_V0 = await readFixture("ekis.v0.json");
const LOMBARDI_RELEASE_CONFIG = await readFile(
  new URL("../fixtures/manifests/lombardi.shop-devtools.config.mjs", import.meta.url),
  "utf8",
);
const SCHEMA_URL = "./node_modules/@getquick/site/schema/gq.ops.schema.json";

async function readFixture(name) {
  return JSON.parse(
    await readFile(new URL(`../fixtures/manifests/${name}`, import.meta.url), "utf8"),
  );
}

async function readManifest(fixture) {
  return readFile(fixture.path("gq.ops.json"), "utf8");
}

test("gq sync --manifest migrates Lombardi's v0 manifest to v1", async () => {
  const fixture = await createFixtureSite({ ops: LOMBARDI_V0 });

  const result = await fixture.run(["sync", "--manifest", "--variant", "content"]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "gq.ops.json: migrated schema v0 → v1.\n");
  assert.equal(result.stderr, "");
  const { project, ...rest } = LOMBARDI_V0;
  const expected = { $schema: SCHEMA_URL, schemaVersion: 1, project, variant: "content", ...rest };
  assert.equal(await readManifest(fixture), `${JSON.stringify(expected, null, 2)}\n`);
});

test("gq sync --manifest migrates Ekis's v0 manifest to v1, naming each key it drops", async () => {
  const fixture = await createFixtureSite({ ops: EKIS_V0 });

  const result = await fixture.run(["sync", "--manifest", "--variant", "commerce"]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "gq.ops.json: migrated schema v0 → v1.\n");
  assert.equal(
    result.stderr,
    [
      "warning: gq.ops.json dropped credentials: gq no longer writes provider credentials to .env.",
      "warning: gq.ops.json dropped github.environment: gq no longer syncs GitHub Actions secrets and variables.",
      "warning: gq.ops.json dropped github.secrets: gq no longer syncs GitHub Actions secrets and variables.",
      "warning: gq.ops.json dropped github.variables: gq no longer syncs GitHub Actions secrets and variables.",
      "",
    ].join("\n"),
  );
  assert.deepEqual(JSON.parse(await readManifest(fixture)), {
    $schema: SCHEMA_URL,
    schemaVersion: 1,
    project: "ekis",
    variant: "commerce",
    sigillo: EKIS_V0.sigillo,
    domains: { admin: "ekis-admin.bnq.pt", docs: "ekis-docs.bnq.pt", frontend: "ekis.bnq.pt" },
    ploi: { serverId: "", siteId: "" },
    cloudflare: { accountId: "8f38791a8c37b182239af2a385ab3c31", zoneId: "", zoneName: "bnq.pt" },
    github: { repository: "Quick-Release/ekis" },
  });
});

test("migrating a v1 manifest is a no-op", async () => {
  for (const [v0, variant] of [
    [LOMBARDI_V0, "content"],
    [EKIS_V0, "commerce"],
  ]) {
    const fixture = await createFixtureSite({ ops: v0 });
    await fixture.run(["sync", "--manifest", "--variant", variant]);
    const migrated = await readManifest(fixture);

    for (const argv of [
      ["sync", "--manifest"],
      ["sync", "--manifest", "--check"],
    ]) {
      const result = await fixture.run(argv);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, "gq.ops.json: up to date (schema v1).\n");
      assert.equal(result.stderr, "");
      assert.equal(await readManifest(fixture), migrated);
    }
  }
});

test("gq sync --manifest --check reports a pending migration and writes nothing", async () => {
  const fixture = await createFixtureSite({ ops: EKIS_V0 });
  const before = await readManifest(fixture);

  const result = await fixture.run(["sync", "--manifest", "--check", "--variant", "commerce"]);

  assert.equal(result.code, 1);
  assert.equal(
    result.stdout,
    "gq.ops.json: schema v0 → v1 pending. " +
      "Run gq sync --manifest --variant commerce to apply it.\n",
  );
  assert.match(result.stderr, /^warning: gq\.ops\.json dropped credentials: /u);
  assert.equal(await readManifest(fixture), before);
});

test("gq sync --check reports a v0 manifest as pending without a variant", async () => {
  const fixture = await createFixtureSite({ ops: LOMBARDI_V0 });
  const before = await readManifest(fixture);

  const result = await fixture.run(["sync", "--check"]);

  assert.equal(result.code, 1);
  assert.equal(
    result.stdout,
    "gq.ops.json: schema v0 → v1 pending. " +
      "Run gq sync --manifest --variant <content|commerce> to apply it.\n",
  );
  assert.equal(result.stderr, "");
  assert.equal(await readManifest(fixture), before);
});

test("gq sync refuses a --variant that contradicts a v1 manifest's", async () => {
  const fixture = await createFixtureSite({ ops: EKIS_V0 });
  await fixture.run(["sync", "--manifest", "--variant", "commerce"]);

  const result = await fixture.run(["sync", "--variant", "content"]);

  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    "gq: gq.ops.json declares variant commerce; --variant content only applies when " +
      "migrating a v0 manifest.\n",
  );
});

test("migrating a v0 manifest asks for the variant instead of guessing it", async () => {
  const fixture = await createFixtureSite({ ops: LOMBARDI_V0 });
  const before = await readManifest(fixture);

  for (const argv of [
    ["sync", "--manifest"],
    ["sync", "--manifest", "--variant", "shop"],
  ]) {
    const result = await fixture.run(argv);
    assert.equal(result.code, 1);
    assert.equal(
      result.stderr,
      "gq: Migrating gq.ops.json to schema v1 needs the site's variant: " +
        "pass --variant content or --variant commerce.\n",
    );
    assert.equal(await readManifest(fixture), before);
  }
});

test("commands refuse a manifest older than v1, pointing at gq sync --manifest", async () => {
  const fixture = await createFixtureSite({ ops: LOMBARDI_V0 });

  const result = await fixture.run(["context", "show"]);

  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    "gq: gq.ops.json is schema v0, older than this gq reads (v1). " +
      "Run gq sync --manifest --variant <content|commerce> to migrate it.\n",
  );
});

test("commands and gq sync refuse a manifest newer than the installed gq", async () => {
  const fixture = await createFixtureSite({
    ops: { schemaVersion: 2, project: "future", variant: "content" },
  });

  for (const argv of [
    ["context", "show"],
    ["sync", "--manifest"],
  ]) {
    const result = await fixture.run(argv);
    assert.equal(result.code, 1);
    assert.equal(
      result.stderr,
      `gq: gq.ops.json is schema v2, newer than gq ${VERSION} reads (v1). Update @getquick/site.\n`,
    );
  }
});

test("an invalid manifest fails naming each key path", async () => {
  for (const [ops, problems] of [
    [{ schemaVersion: 1, variant: "content" }, "project is required"],
    [
      { schemaVersion: 1, project: "fixture", variant: "shop" },
      'variant must be "content" or "commerce"',
    ],
    [
      {
        schemaVersion: 1,
        project: "fixture",
        variant: "content",
        domains: { admin: "admin.example.test", staging: "staging.example.test" },
        ploi: { serverID: "12" },
        wordpress: { plugins: ["getquick-config", 7] },
      },
      "domains.frontend is required; domains.staging is not a known key; " +
        "ploi.serverID is not a known key; " +
        "wordpress.plugins[1]: Invalid input: expected string, received number",
    ],
    [
      {
        schemaVersion: 1,
        project: "fixture",
        variant: "content",
        artifacts: { namespace: "fixture", repo: "fixture", jurisdiction: "ch" },
      },
      'artifacts.jurisdiction must be "eu" or "us" or "unrestricted"',
    ],
    [{ schemaVersion: "1", project: "fixture" }, null],
  ]) {
    const fixture = await createFixtureSite({ ops });
    const result = await fixture.run(["context", "show"]);
    assert.equal(result.code, 1);
    assert.equal(
      result.stderr,
      problems === null
        ? "gq: gq.ops.json schemaVersion must be a non-negative integer.\n"
        : `gq: gq.ops.json is invalid: ${problems}.\n`,
    );
  }
});

test("the published JSON Schema is the one generated from the zod schema", async () => {
  const published = await readFile(
    new URL("../../schema/gq.ops.schema.json", import.meta.url),
    "utf8",
  );
  assert.equal(published, `${JSON.stringify(manifestJsonSchema(), null, 2)}\n`);
  assert.equal(JSON.parse(published).additionalProperties, false);
  assert.deepEqual(JSON.parse(published).required, ["schemaVersion", "project", "variant"]);
});

// --- folding the release config ---------------------------------------------

const RELEASE_CONFIG = "shop-devtools.config.mjs";
const LOMBARDI_THEME = "apps/cms/web/app/themes/lombardi-theme";

// Lombardi's site at `version`: its release config and the files it versions.
function lombardiFiles(version) {
  return versionedFiles(version, {
    [RELEASE_CONFIG]: LOMBARDI_RELEASE_CONFIG,
    [`${LOMBARDI_THEME}/style.css`]: `/*\nTheme Name: Lombardi\nVersion: ${version}\n*/\n`,
    [`${LOMBARDI_THEME}/functions.php`]: `<?php\ndefine( 'LOMBARDI_THEME_VERSION', '${version}' );\n`,
  });
}

const LOMBARDI_ADDITIONS = {
  release: {
    textFiles: [
      {
        path: `${LOMBARDI_THEME}/style.css`,
        patterns: [{ regexp: "^Version: .+$", flags: "m", replacement: "Version: {version}" }],
      },
      {
        path: `${LOMBARDI_THEME}/functions.php`,
        patterns: [
          {
            regexp: "define\\( 'LOMBARDI_THEME_VERSION', '[^']+' \\);",
            replacement: "define( 'LOMBARDI_THEME_VERSION', '{version}' );",
          },
        ],
      },
    ],
    paths: [`${LOMBARDI_THEME}/style.css`, `${LOMBARDI_THEME}/functions.php`],
  },
};

const RELEASE_BRANCH_WARNING =
  "warning: shop-devtools.config.mjs dropped releaseBranch: gq releases the branch that is checked out.\n";

test("gq sync --manifest folds Lombardi's release config into its v1 manifest", async () => {
  const fixture = await createFixtureSite({ ops: LOMBARDI_V0, files: lombardiFiles("1.2.3") });

  const result = await fixture.run(["sync", "--manifest", "--variant", "content"]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    result.stdout,
    "gq.ops.json: migrated schema v0 → v1.\n" +
      "gq.ops.json: folded in shop-devtools.config.mjs and removed it.\n",
  );
  assert.equal(result.stderr, RELEASE_BRANCH_WARNING);
  const { project, ...rest } = LOMBARDI_V0;
  const expected = {
    $schema: SCHEMA_URL,
    schemaVersion: 1,
    project,
    variant: "content",
    ...rest,
    ...LOMBARDI_ADDITIONS,
  };
  assert.equal(await readManifest(fixture), `${JSON.stringify(expected, null, 2)}\n`);
  assert.equal(existsSync(fixture.path(RELEASE_CONFIG)), false);

  const again = await fixture.run(["sync", "--manifest"]);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout, "gq.ops.json: up to date (schema v1).\n");
  assert.equal(again.stderr, "");
  assert.equal(await readManifest(fixture), `${JSON.stringify(expected, null, 2)}\n`);
});

test("Lombardi's folded manifest releases, verifies and doctors as 0.8.0 did", async () => {
  const fixture = await createFixtureSite({ ops: LOMBARDI_V0, files: lombardiFiles("1.2.3") });
  await fixture.run(["sync", "--manifest", "--variant", "content"]);

  // shop-devtools.config.mjs is gone, so the release commit no longer stages it.
  const exec = releaseExec();
  const push = await fixture.run(["release", "push", "minor"], { exec });
  assert.equal(push.code, 0, push.stderr);
  assert.deepEqual(releaseRun(exec), {
    checks: CONTENT_CHECKS,
    paths: [
      "VERSION",
      "CHANGELOG.md",
      "README.md",
      "package.json",
      "pnpm-workspace.yaml",
      "gq.ops.json",
      "infra",
      "deploy/ploi/admin.sh",
      "AGENTS.md",
      "apps/cms/.gitignore",
      "apps/cms/composer.json",
      "apps/cms/composer.lock",
      "apps/frontend/package.json",
      `${LOMBARDI_THEME}/style.css`,
      `${LOMBARDI_THEME}/functions.php`,
    ],
  });
  const released = lombardiFiles("1.3.0");
  for (const path of [
    "package.json",
    "apps/frontend/package.json",
    `${LOMBARDI_THEME}/style.css`,
    `${LOMBARDI_THEME}/functions.php`,
  ]) {
    assert.equal(await readFile(fixture.path(path), "utf8"), released[path], path);
  }

  const verifyExec = recordingExec();
  const verify = await fixture.run(["verify", "--ci"], { exec: verifyExec });
  assert.equal(verify.code, 0, verify.stderr);
  assert.deepEqual(verifyChecks(verifyExec), CONTENT_CHECKS);

  const doctor = await fixture.run(["doctor"]);
  assert.deepEqual(
    missingFiles(doctor.stdout).filter((path) => path.startsWith("apps/")),
    ["apps/cms/composer.json", "apps/cms/.ddev/config.yaml", "apps/frontend/astro.config.mjs"],
  );
});

test("gq sync --manifest --check reports the fold as pending and writes nothing", async () => {
  const fixture = await createFixtureSite({ ops: LOMBARDI_V0, files: lombardiFiles("1.2.3") });
  const before = await readManifest(fixture);

  const result = await fixture.run(["sync", "--manifest", "--check"]);

  assert.equal(result.code, 1);
  assert.equal(
    result.stdout,
    "gq.ops.json: schema v0 → v1 pending. " +
      "Run gq sync --manifest --variant <content|commerce> to apply it.\n" +
      "shop-devtools.config.mjs: folding into gq.ops.json pending. " +
      "Run gq sync --manifest --variant <content|commerce> to apply it.\n",
  );
  assert.equal(await readManifest(fixture), before);
  assert.equal(existsSync(fixture.path(RELEASE_CONFIG)), true);
});

test("a v1 manifest beside a release config is folded, and commands refuse it until then", async () => {
  // What gq 0.9.0's migration left: v1, with the release config still there.
  const fixture = await createFixtureSite({ ops: LOMBARDI_V0, files: lombardiFiles("1.2.3") });
  const config = await readFile(fixture.path(RELEASE_CONFIG), "utf8");
  await fixture.run(["sync", "--manifest", "--variant", "content"]);
  const folded = await readManifest(fixture);
  const v1 = JSON.parse(folded);
  delete v1.release;
  const site = await createFixtureSite({ ops: v1, files: { [RELEASE_CONFIG]: config } });

  for (const argv of [["release", "push", "minor"], ["version", "check"], ["verify"]]) {
    const result = await site.run(argv);
    assert.equal(result.code, 1, argv.join(" "));
    assert.equal(
      result.stderr,
      "gq: shop-devtools.config.mjs is no longer read: the release, verify and doctor settings " +
        "live in gq.ops.json. Run gq sync --manifest to fold it in.\n",
    );
    assert.deepEqual(result.exec.calls, []);
  }

  // doctor still diagnoses the rest, and fails on the module.
  const doctor = await site.run(["doctor"]);
  assert.equal(doctor.code, 1);
  assert.match(
    doctor.stdout,
    /✗ shop-devtools\.config\.mjs hasn't been folded into gq\.ops\.json — run: gq sync --manifest$/mu,
  );
  assert.match(doctor.stdout, /✗ apps\/cms\/composer\.json is missing$/mu);

  const check = await site.run(["sync", "--manifest", "--check"]);
  assert.equal(check.code, 1);
  assert.equal(
    check.stdout,
    "shop-devtools.config.mjs: folding into gq.ops.json pending. " +
      "Run gq sync --manifest to apply it.\n",
  );

  const sync = await site.run(["sync", "--manifest"]);
  assert.equal(sync.code, 0, sync.stderr);
  assert.equal(sync.stdout, "gq.ops.json: folded in shop-devtools.config.mjs and removed it.\n");
  assert.equal(await readManifest(site), folded);
  assert.equal(existsSync(site.path(RELEASE_CONFIG)), false);
});

test("folding keeps only what differs from the defaults and names defaults it adds", async () => {
  const config = `export default {
  jsonFiles: ["package.json", "apps/docs/package.json"],
  releasePaths: ["VERSION", "CHANGELOG.md", "shop-devtools.config.mjs", "apps/docs"],
  checks: [
    "make",
    { cmd: "pnpm", args: ["run", "check"] },
    { cmd: "pnpm", args: [], cwd: "apps/docs" },
  ],
  doctor: { requiredFiles: { "apps/frontend": ["package.json", "tsconfig.json"] } },
};
`;
  const fixture = await createFixtureSite({
    ops: LOMBARDI_V0,
    files: { [RELEASE_CONFIG]: config },
  });

  const result = await fixture.run(["sync", "--manifest", "--variant", "content"]);

  assert.equal(result.code, 0, result.stderr);
  const added = (kind, values) =>
    values.map(
      (value) =>
        `warning: shop-devtools.config.mjs omits the content default ${kind} ${value}, ` +
        "which gq now adds.\n",
    );
  assert.equal(
    result.stderr,
    [
      ...added("version file", ["apps/frontend/package.json"]),
      ...added("release path", [
        "README.md",
        "package.json",
        "pnpm-workspace.yaml",
        "gq.ops.json",
        "infra",
        "deploy/ploi/admin.sh",
        "AGENTS.md",
        "apps/cms/.gitignore",
        "apps/cms/composer.json",
        "apps/cms/composer.lock",
        "apps/frontend/package.json",
      ]),
      ...added(
        "check",
        CONTENT_CHECKS.slice(1).map((line) => `"${line}"`),
      ),
      'warning: shop-devtools.config.mjs runs "make" before the content default checks; ' +
        "gq now runs it after them.\n",
      ...added("required file", [
        "apps/cms/composer.json",
        "apps/cms/.ddev/config.yaml",
        "apps/frontend/astro.config.mjs",
      ]),
    ].join(""),
  );
  const manifest = JSON.parse(await readManifest(fixture));
  assert.deepEqual(
    { release: manifest.release, verify: manifest.verify, doctor: manifest.doctor },
    {
      release: { jsonFiles: ["apps/docs/package.json"], paths: ["apps/docs"] },
      verify: { checks: [{ cmd: "make" }, { cmd: "pnpm", cwd: "apps/docs" }] },
      doctor: { requiredFiles: { "apps/frontend": ["tsconfig.json"] } },
    },
  );
});

test("folding refuses a release config gq.ops.json can't express, and writes nothing", async () => {
  for (const [config, problems] of [
    [
      `export default {
  versionFile: "version.txt",
  changelogPath: "docs/CHANGELOG.md",
  docsChangelogPath: "apps/docs/changelog.mdx",
  composer: { manifest: "apps/cms/composer.json", packages: ["site/plugin"] },
  deploys: [{ cmd: "pnpm", args: ["deploy:frontend"] }],
  hooks: {},
  doctor: { requiredFiles: {}, ports: [] },
};
`,
      [
        'versionFile is "version.txt", but every site\'s version file is VERSION',
        'changelogPath is "docs/CHANGELOG.md", but every site\'s changelog is CHANGELOG.md',
        "docsChangelogPath is not supported: the docs changelog page was dropped with shop-devtools",
        "composer is not supported: gq no longer pins Composer packages to the release version",
        "deploys is not supported: releases deploy from Cloudflare CI",
        "hooks is not a release config key",
        "doctor.ports is not a release config key",
      ],
    ],
    [
      `export default {
  textFiles: [
    { path: "a.css", patterns: [{ regexp: "^Version: .+$", replacement: (v) => \`Version: \${v}\` }] },
    { path: "b.css", patterns: [{ regexp: /x/, replacement: () => "Version: 1.0.0" }] },
  ],
};
`,
      [
        "textFiles[0].patterns[0].regexp must be a regular expression",
        "textFiles[1].patterns[0].replacement must return the version inside fixed text",
      ],
    ],
  ]) {
    const fixture = await createFixtureSite({
      ops: LOMBARDI_V0,
      files: { [RELEASE_CONFIG]: config },
    });
    const before = await readManifest(fixture);

    const result = await fixture.run(["sync", "--manifest", "--variant", "content"]);

    assert.equal(result.code, 1);
    assert.equal(
      result.stderr,
      `gq: Can't fold shop-devtools.config.mjs into gq.ops.json: ${problems.join("; ")}. ` +
        "Change it, then run gq sync --manifest again.\n",
    );
    assert.equal(await readManifest(fixture), before);
    assert.equal(existsSync(fixture.path(RELEASE_CONFIG)), true);
  }
});

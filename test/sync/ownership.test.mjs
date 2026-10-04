// gq new and gq sync on the blueprint's managed files, driven through run():
// a site generated into a temporary directory, then kept in step with the
// installed blueprint, without touching what the site owns, a hand edit, the
// network or a provider.
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { VERSION } from "../../src/version.mjs";
import { createFixtureSite, runGq, temporaryDirectory } from "../support/fixture-site.mjs";
import { hash, newSite, readSite, snapshot } from "../support/generated-site.mjs";

const MISE = '[tools]\nnode = "24.21.0"\n';
const PRE_COMMIT = "#!/bin/sh\nset -e\n\nvp staged\npnpm check\n";
const PRE_PUSH = [
  "#!/bin/sh",
  "set -e",
  "",
  "# The same checks `pnpm push` and Cloudflare CI run (gq verify: the content",
  "# variant's checks plus gq.ops.json `verify.checks`).",
  "# Skip once with: git push --no-verify",
  "pnpm verify",
  "",
].join("\n");
const SKILLS = ".claude/skills";
const MANAGED_PATHS = [
  ".claude/skills",
  ".mise.toml",
  ".nvmrc",
  ".vite-hooks/pre-commit",
  ".vite-hooks/pre-push",
  "deploy/ploi/admin.sh",
  "deploy/ploi/polylang.sh",
  "docs/adr/README.md",
  "docs/agents/README.md",
  "docs/agents/domain.md",
  "docs/agents/issue-tracker.md",
  "docs/agents/triage-labels.md",
  "docs/plans/README.md",
  "docs/research/README.md",
  "infra/ci/Dockerfile",
  "infra/ci/cloudflare.ci.ts",
  "infra/ci/env.ts",
  "infra/ci/github.ts",
  "infra/ci/mirror.ts",
  "infra/ci/package.json",
  "infra/ci/release.ts",
  "infra/ci/src/index.ts",
  "infra/ci/tsconfig.json",
  "infra/ci/wrangler.jsonc",
  "infra/frontend.run.ts",
  "infra/package.json",
  "infra/scripts/deploy-frontend.mjs",
  "infra/tsconfig.json",
  "scripts/ci-release.mjs",
  "scripts/ci.test.mjs",
  "vite.config.ts",
];
// The files gq manages a part of (a section, or keys), and the ones it
// creates once besides gq.ops.json: the root scaffolding, and the CMS and
// Frontend skeletons.
const SHARED_PATHS = [".gitignore", "AGENTS.md", "package.json"];
const CREATED_PATHS = [
  "GLOSSARY.md",
  "README.md",
  "VERSION",
  "apps/cms/.ddev/commands/host/db-sync",
  "apps/cms/.ddev/config.yaml",
  "apps/cms/.env.example",
  "apps/cms/.env.production.example",
  "apps/cms/.gitignore",
  "apps/cms/LICENSE.md",
  "apps/cms/README.md",
  "apps/cms/composer.json",
  "apps/cms/config/application.php",
  "apps/cms/config/environments/development.php",
  "apps/cms/config/environments/staging.php",
  "apps/cms/phpunit.xml.dist",
  "apps/cms/pint.json",
  "apps/cms/scripts/.gitkeep",
  "apps/cms/tests/Feature/ExampleTest.php",
  "apps/cms/tests/Pest.php",
  "apps/cms/web/app/mu-plugins/bedrock-autoloader.php",
  "apps/cms/web/app/mu-plugins/content-api.php",
  "apps/cms/web/app/mu-plugins/delivery-retries.php",
  "apps/cms/web/app/mu-plugins/publication-events.php",
  "apps/cms/web/app/mu-plugins/settings-events.php",
  "apps/cms/web/app/plugins/.gitkeep",
  "apps/cms/web/app/themes/.gitkeep",
  "apps/cms/web/app/uploads/.gitkeep",
  "apps/cms/web/index.php",
  "apps/cms/web/wp-config.php",
  "apps/cms/wp-cli.yml",
  "apps/frontend/.env.example",
  "apps/frontend/.gitignore",
  "apps/frontend/README.md",
  "apps/frontend/astro.config.mjs",
  "apps/frontend/migrations/0001_publications.sql",
  "apps/frontend/migrations/0002_entries.sql",
  "apps/frontend/migrations/0003_publication_events.sql",
  "apps/frontend/migrations/0004_withdrawals.sql",
  "apps/frontend/migrations/0005_reconciliation.sql",
  "apps/frontend/package.json",
  "apps/frontend/public/favicon.svg",
  "apps/frontend/public/robots.txt",
  "apps/frontend/src/components/Home.astro",
  "apps/frontend/src/env.d.ts",
  "apps/frontend/src/entries.test.ts",
  "apps/frontend/src/events.test.ts",
  "apps/frontend/src/homepage.test.ts",
  "apps/frontend/src/language-updates.test.ts",
  "apps/frontend/src/languages.test.ts",
  "apps/frontend/src/layouts/Layout.astro",
  "apps/frontend/src/lib/copy.ts",
  "apps/frontend/src/lib/delivery.ts",
  "apps/frontend/src/lib/events.ts",
  "apps/frontend/src/lib/publications.ts",
  "apps/frontend/src/lib/reconciliation.ts",
  "apps/frontend/src/lib/runtime.ts",
  "apps/frontend/src/lib/site-language.test.ts",
  "apps/frontend/src/lib/site-language.ts",
  "apps/frontend/src/lib/wordpress.test.ts",
  "apps/frontend/src/lib/wordpress.ts",
  "apps/frontend/src/lib/wp-block-renderer.test.ts",
  "apps/frontend/src/lib/wp-block-renderer.ts",
  "apps/frontend/src/lib/wp-block-styles.test.ts",
  "apps/frontend/src/lib/wp-block-styles.ts",
  "apps/frontend/src/lib/wp-container-layout.test.ts",
  "apps/frontend/src/lib/wp-container-layout.ts",
  "apps/frontend/src/pages/[...slug].astro",
  "apps/frontend/src/pages/gq/events.ts",
  "apps/frontend/src/pages/gq/refresh.ts",
  "apps/frontend/src/pages/index.astro",
  "apps/frontend/src/reconciliation.test.ts",
  "apps/frontend/src/retries.test.ts",
  "apps/frontend/src/routes.test.ts",
  "apps/frontend/src/settings.test.ts",
  "apps/frontend/src/styles/global.css",
  "apps/frontend/src/test/sqlite-d1.ts",
  "apps/frontend/src/test/wordpress-stub.ts",
  "apps/frontend/src/withdrawals.test.ts",
  "apps/frontend/tsconfig.json",
  "apps/frontend/vite.config.ts",
  "apps/frontend/vitest.config.ts",
  "deploy/ploi/admin.d/10-theme.sh",
  "deploy/ploi/admin.d/README.md",
  "pnpm-workspace.yaml",
];

test("gq new writes a v1 manifest, the managed files and the lock, then runs git init", async () => {
  const parent = await temporaryDirectory();
  const root = join(parent, "acme");

  const result = await runGq(["new", "acme", "--project", "acme", "--variant", "content"], {
    cwd: parent,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readSite(root, "gq.ops.json")), {
    $schema: "./node_modules/@getquick/site/schema/gq.ops.schema.json",
    schemaVersion: 1,
    project: "acme",
    variant: "content",
    wordpress: {
      plugins: [
        "gq-design",
        "gq-support",
        "wp-graphql",
        "wpgraphql-blocks",
        "s3-uploads",
        "simple-history",
        "cimo-image-optimizer",
        "safe-svg",
      ],
      locale: "en_US",
    },
  });
  assert.equal(await readSite(root, ".mise.toml"), MISE);
  assert.equal(await readSite(root, ".nvmrc"), "24.21.0\n");
  assert.equal(await readSite(root, ".vite-hooks/pre-commit"), PRE_COMMIT);
  assert.equal(await readSite(root, ".vite-hooks/pre-push"), PRE_PUSH);
  for (const hook of [".vite-hooks/pre-commit", ".vite-hooks/pre-push"]) {
    assert.equal((await lstat(join(root, hook))).mode & 0o777, 0o755, hook);
  }
  assert.match(await readSite(root, "vite.config.ts"), /^ {2}staged: \{$/mu);
  assert.match(await readSite(root, "docs/adr/README.md"), /^# Architecture Decision Records$/mu);
  assert.equal((await lstat(join(root, SKILLS))).isSymbolicLink(), true);
  assert.equal(await readlink(join(root, SKILLS)), "../.agents/skills");

  const lock = JSON.parse(await readSite(root, "gq.lock.json"));
  assert.deepEqual(Object.keys(lock), [
    "gq",
    "schemaVersion",
    "files",
    "sections",
    "keys",
    "created",
  ]);
  assert.equal(lock.gq, VERSION);
  assert.equal(lock.schemaVersion, 1);
  assert.deepEqual(Object.keys(lock.files), MANAGED_PATHS);
  for (const path of MANAGED_PATHS.filter((path) => path !== SKILLS)) {
    assert.equal(lock.files[path], hash(await readFile(join(root, path))), path);
  }
  assert.match(lock.files[SKILLS], /^sha256:[0-9a-f]{64}$/u);
  assert.equal(
    result.stdout.slice(0, result.stdout.indexOf("\nNext,")),
    [
      `Created acme (content, en_US) in ${root}:`,
      "  gq.ops.json",
      ...[...MANAGED_PATHS, ...SHARED_PATHS, ...CREATED_PATHS]
        .sort((a, b) => (a < b ? -1 : 1))
        .map((path) => `  ${path}`),
      "  gq.lock.json",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    result.exec.calls.map(({ command, args, cwd }) => ({ command, args, cwd })),
    [{ command: "git", args: ["init", "--quiet"], cwd: root }],
  );
  assert.deepEqual(result.fetch.requests, []);
});

test("a site gq new generated is in sync: --check exits 0 and gq sync writes nothing", async () => {
  const site = await newSite();
  const before = await snapshot(site.root);

  const check = await site.run(["sync", "--check"]);
  assert.equal(check.code, 0, check.stderr);
  assert.equal(check.stdout, "gq.ops.json: up to date (schema v1).\nManaged files: up to date.\n");
  assert.equal(check.stderr, "");

  const sync = await site.run(["sync"]);
  assert.equal(sync.code, 0, sync.stderr);
  assert.equal(sync.stdout, "gq.ops.json: up to date (schema v1).\nManaged files: up to date.\n");
  assert.deepEqual(await snapshot(site.root), before);

  for (const { fetch, exec } of [check, sync]) {
    assert.deepEqual(fetch.requests, []);
    assert.deepEqual(exec.calls, []);
  }
});

test("a hand-edited managed file stops gq sync with a diff, and nothing is written", async () => {
  const site = await newSite();
  const edited = '[tools]\nnode = "24.21.0"\npython = "3.13"\n';
  await writeFile(join(site.root, ".mise.toml"), edited);
  const before = await snapshot(site.root);
  const diff = [
    ".mise.toml: edited since gq last wrote it (gq.lock.json); gq sync would write:",
    "--- .mise.toml",
    "+++ .mise.toml (gq sync)",
    "@@ -1,3 +1,2 @@",
    " [tools]",
    ' node = "24.21.0"',
    '-python = "3.13"',
    "",
  ].join("\n");
  const refusal =
    "gq: Local edits to managed files: .mise.toml. gq sync writes nothing until each is " +
    "reverted, or deleted to be regenerated.\n";

  for (const argv of [["sync"], ["sync", "--check"]]) {
    const result = await site.run(argv);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, `gq.ops.json: up to date (schema v1).\n${diff}`);
    assert.equal(result.stderr, refusal);
    assert.deepEqual(await snapshot(site.root), before);
  }
});

// A site an older gq generated: its lock records the toolchain pins that gq
// wrote, which the installed blueprint has since changed. `files` are the
// site's own, written after.
async function siteFromOlderGq(files = {}) {
  const site = await newSite();
  const oldMise = '[tools]\nnode = "24.20.0"\n';
  await writeFile(join(site.root, ".mise.toml"), oldMise);
  const lock = JSON.parse(await readSite(site.root, "gq.lock.json"));
  lock.gq = "0.8.0";
  lock.files[".mise.toml"] = hash(oldMise);
  await writeFile(join(site.root, "gq.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(site.root, path)), { recursive: true });
    await writeFile(join(site.root, path), content);
  }
  return site;
}

test("a template change to an unedited managed file is applied and the lock updated", async () => {
  const site = await siteFromOlderGq();
  const before = await snapshot(site.root);

  const check = await site.run(["sync", "--check"]);
  assert.equal(check.code, 1);
  assert.equal(
    check.stdout,
    [
      "gq.ops.json: up to date (schema v1).",
      ".mise.toml: pending, gq sync would update it.",
      "gq.lock.json: pending, gq sync would update it.",
      "",
    ].join("\n"),
  );
  assert.deepEqual(await snapshot(site.root), before);

  const sync = await site.run(["sync"]);
  assert.equal(sync.code, 0, sync.stderr);
  assert.equal(
    sync.stdout,
    "gq.ops.json: up to date (schema v1).\n.mise.toml: updated.\ngq.lock.json: updated.\n",
  );
  assert.equal(await readSite(site.root, ".mise.toml"), MISE);
  const lock = JSON.parse(await readSite(site.root, "gq.lock.json"));
  assert.equal(lock.gq, VERSION);
  assert.equal(lock.files[".mise.toml"], hash(MISE));
  assert.equal((await site.run(["sync", "--check"])).code, 0);
  for (const { fetch, exec } of [check, sync]) {
    assert.deepEqual(fetch.requests, []);
    assert.deepEqual(exec.calls, []);
  }
});

test("gq sync leaves site-owned files byte-identical", async () => {
  const owned = {
    "README.md": "# Acme\n",
    "docs/adr/0001-use-astro.md": "# ADR 0001\n",
    "docs/plans/launch.md": "# Launch\n",
    "docs/research/hosting.md": "# Hosting\n",
    "docs/agents/deploys.md": "# Deploys\n",
    ".agents/skills/acme/SKILL.md": "# Acme skill\n",
    ".vite-hooks/commit-msg": "#!/bin/sh\n",
    "apps/cms/web/app/plugins/acme-blocks/acme-blocks.php": "<?php\n",
    "apps/frontend/package.json": '{ "name": "@acme/frontend" }\n',
    "apps/cms/.gitignore": "vendor/\n",
    "deploy/ploi/admin.d/10-acme.sh": "wp theme activate acme-theme\n",
  };
  const site = await siteFromOlderGq(owned);
  const before = await snapshot(site.root);

  const result = await site.run(["sync"]);

  assert.equal(result.code, 0, result.stderr);
  const after = await snapshot(site.root);
  for (const path of Object.keys(owned)) assert.deepEqual(after[path], before[path], path);
  assert.deepEqual(
    Object.keys(after).sort(),
    [
      ...new Set([
        ...Object.keys(owned),
        ...MANAGED_PATHS,
        ...SHARED_PATHS,
        ...CREATED_PATHS,
        "gq.lock.json",
        "gq.ops.json",
      ]),
    ].sort(),
  );
});

test("gq sync regenerates a deleted managed file", async () => {
  const site = await newSite();
  await rm(join(site.root, ".mise.toml"));

  const result = await site.run(["sync"]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "gq.ops.json: up to date (schema v1).\n.mise.toml: created.\n");
  assert.equal(await readSite(site.root, ".mise.toml"), MISE);
});

test("a local edit to any managed file, or a retargeted symlink, stops gq sync", async () => {
  const site = await newSite();
  for (const path of MANAGED_PATHS) {
    if (path === SKILLS) {
      await rm(join(site.root, path));
      await symlink("../skills", join(site.root, path));
    } else await writeFile(join(site.root, path), `${await readSite(site.root, path)}local\n`);
  }
  const before = await snapshot(site.root);

  for (const argv of [["sync"], ["sync", "--check"]]) {
    const result = await site.run(argv);
    assert.equal(result.code, 1);
    for (const path of MANAGED_PATHS) {
      assert.ok(result.stdout.includes(`\n${path}: edited since gq last wrote it`), path);
    }
    assert.equal(
      result.stderr,
      `gq: Local edits to managed files: ${MANAGED_PATHS.join(", ")}. gq sync writes nothing ` +
        "until each is reverted, or deleted to be regenerated.\n",
    );
    assert.deepEqual(await snapshot(site.root), before);
  }
});

test("a retargeted agent-skills symlink shows as a diff of its targets", async () => {
  const site = await newSite();
  await rm(join(site.root, SKILLS));
  await symlink("../skills", join(site.root, SKILLS));

  const result = await site.run(["sync"]);

  assert.equal(result.code, 1);
  assert.equal(
    result.stdout,
    [
      "gq.ops.json: up to date (schema v1).",
      ".claude/skills: edited since gq last wrote it (gq.lock.json); gq sync would write:",
      "--- .claude/skills",
      "+++ .claude/skills (gq sync)",
      "@@ -1,1 +1,1 @@",
      "-symlink -> ../skills",
      "+symlink -> ../.agents/skills",
      "",
    ].join("\n"),
  );
  assert.equal(await readlink(join(site.root, SKILLS)), "../skills");
});

test("a directory in place of the agent-skills symlink counts as edited", async () => {
  const site = await newSite();
  await rm(join(site.root, SKILLS));
  await mkdir(join(site.root, SKILLS, "tdd"), { recursive: true });
  await writeFile(join(site.root, SKILLS, "tdd", "SKILL.md"), "# TDD\n");
  const before = await snapshot(site.root);

  const result = await site.run(["sync"]);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /^-directory\n\+symlink -> \.\.\/\.agents\/skills$/mu);
  assert.deepEqual(await snapshot(site.root), before);
});

test("without a lock, a directory in place of the agent-skills symlink counts as edited", async () => {
  const site = await createFixtureSite({
    ops: { schemaVersion: 1, project: "acme", variant: "content" },
    files: { ".claude/skills/tdd/SKILL.md": "# TDD\n" },
  });
  const before = await snapshot(site.root);

  const result = await site.run(["sync"]);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /^\.claude\/skills: edited since gq last wrote it/mu);
  assert.deepEqual(await snapshot(site.root), before);
});

test("gq sync recreates a deleted agent-skills symlink, and keeps it on the next sync", async () => {
  const site = await newSite();
  await rm(join(site.root, SKILLS));

  const result = await site.run(["sync"]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "gq.ops.json: up to date (schema v1).\n.claude/skills: created.\n");
  assert.equal(await readlink(join(site.root, SKILLS)), "../.agents/skills");
  const before = await snapshot(site.root);
  const again = await site.run(["sync"]);
  assert.equal(again.stdout, "gq.ops.json: up to date (schema v1).\nManaged files: up to date.\n");
  assert.deepEqual(await snapshot(site.root), before);
});

test("gq sync makes a hook that lost its executable bit executable again", async () => {
  const site = await newSite();
  const hook = join(site.root, ".vite-hooks/pre-push");
  await chmod(hook, 0o644);

  const check = await site.run(["sync", "--check"]);
  assert.equal(check.code, 1);
  assert.equal(
    check.stdout,
    "gq.ops.json: up to date (schema v1).\n.vite-hooks/pre-push: pending, gq sync would update it.\n",
  );
  assert.equal((await lstat(hook)).mode & 0o777, 0o644);

  const sync = await site.run(["sync"]);
  assert.equal(sync.code, 0, sync.stderr);
  assert.equal(
    sync.stdout,
    "gq.ops.json: up to date (schema v1).\n.vite-hooks/pre-push: updated.\n",
  );
  assert.equal((await lstat(hook)).mode & 0o777, 0o755);
  assert.equal(await readSite(site.root, ".vite-hooks/pre-push"), PRE_PUSH);
});

test("without a lock, a hook that differs only in its executable bit is not an edit", async () => {
  const site = await createFixtureSite({
    ops: { schemaVersion: 1, project: "acme", variant: "content" },
    files: { ".vite-hooks/pre-push": PRE_PUSH },
  });
  const hook = join(site.root, ".vite-hooks/pre-push");
  await chmod(hook, 0o644);

  const result = await site.run(["sync"]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^\.vite-hooks\/pre-push: updated\.$/mu);
  assert.equal((await lstat(hook)).mode & 0o777, 0o755);
});

test("without a lock, a managed file that differs from the template counts as edited", async () => {
  const site = await createFixtureSite({
    ops: { schemaVersion: 1, project: "acme", variant: "content" },
    files: { ".mise.toml": '[tools]\nnode = "22.12.0"\n' },
  });
  const before = await snapshot(site.root);

  const result = await site.run(["sync"]);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /^\.mise\.toml: edited since gq last wrote it/mu);
  assert.match(result.stdout, /^-node = "22\.12\.0"\n\+node = "24\.21\.0"$/mu);
  assert.deepEqual(await snapshot(site.root), before);
});

test("a local edit also holds back a pending manifest migration", async () => {
  const v0 = { project: "acme" };
  const site = await createFixtureSite({
    ops: v0,
    files: { ".mise.toml": '[tools]\nnode = "22.12.0"\n' },
  });
  const before = await snapshot(site.root);

  const result = await site.run(["sync", "--variant", "content"]);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /^gq\.ops\.json: schema v0 → v1 pending\./u);
  assert.match(result.stderr, /^gq: Local edits to managed files: \.mise\.toml\./u);
  assert.deepEqual(await snapshot(site.root), before);
});

test("gq new refuses a commerce site and a directory that isn't empty", async () => {
  const parent = await temporaryDirectory();
  await writeFile(join(parent, "notes.md"), "mine\n");

  for (const [argv, message] of [
    [
      ["new", "shop", "--project", "shop", "--variant", "commerce"],
      "gq: gq new --variant commerce is not supported until phase 4.\n",
    ],
    [["new", ".", "--project", "acme", "--variant", "content"], `gq: ${parent} is not empty.\n`],
    [
      ["new", "notes.md", "--project", "acme", "--variant", "content"],
      `gq: ${join(parent, "notes.md")} is not a directory.\n`,
    ],
    [
      ["new", "acme", "--project", "acme", "--variant", "shop"],
      "gq: --variant must be content or commerce: shop\n",
    ],
    [
      ["new", "acme", "--project", "acme", "--variant", "content", "--yes"],
      "gq: Usage: gq new <dir> --project <name> --variant content [--locale <locale>]\n",
    ],
  ]) {
    const result = await runGq(argv, { cwd: parent });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, message);
    assert.deepEqual(result.exec.calls, []);
  }
  assert.deepEqual(await readdir(parent), ["notes.md"]);
});

test("gq sync refuses a lock a newer gq wrote, instead of downgrading its files", async () => {
  const lock = { gq: "999.0.0", schemaVersion: 1, files: { ".mise.toml": hash(MISE) } };
  const site = await createFixtureSite({
    ops: { schemaVersion: 1, project: "acme", variant: "content" },
    files: { ".mise.toml": MISE, "gq.lock.json": `${JSON.stringify(lock, null, 2)}\n` },
  });
  const before = await snapshot(site.root);

  for (const argv of [["sync"], ["sync", "--check"]]) {
    const result = await site.run(argv);
    assert.equal(result.code, 1);
    assert.equal(
      result.stderr,
      `gq: gq.lock.json was written by gq 999.0.0, newer than the installed ${VERSION}. ` +
        "Update @getquick/site.\n",
    );
    assert.deepEqual(await snapshot(site.root), before);
  }
});

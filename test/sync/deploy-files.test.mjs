// gq new and gq sync on a site's deploy wiring, driven through run(): the
// Cloudflare CI Worker, the Frontend deploy config and script, and the CI
// release step, fully generated from gq.ops.json. The content site's manifest
// renders the content site's own files (test/fixtures/content-site).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createFixtureSite, temporaryDirectory } from "../support/fixture-site.mjs";
import { hash, newSite, readSite, snapshot } from "../support/generated-site.mjs";

const DEPLOY_PATHS = [
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
];

const CONTENT_SITE = JSON.parse(
  await readFile(new URL("../fixtures/manifests/content-site.v1.json", import.meta.url), "utf8"),
);

// A site whose every value differs from the content site's.
const ACME = {
  schemaVersion: 1,
  project: "acme-shop",
  variant: "content",
  domains: { admin: "cms.acme.test", frontend: "www.acme.test" },
  artifacts: { namespace: "acme-ns", repo: "acme-repo" },
  ci: { worker: "acme-builds", backupBucket: "acme-snapshots" },
  cloudflare: { accountId: "0123456789abcdef0123456789abcdef", zoneName: "acme.test" },
  github: { repository: "Example/acme-site" },
};

function contentSiteFile(path) {
  return readFile(new URL(`../fixtures/content-site/${path}`, import.meta.url), "utf8");
}

async function writeManifest(root, manifest) {
  await writeFile(join(root, "gq.ops.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

// A gq new site's manifest with ACME's site values filled in.
async function fillManifest(root) {
  const current = JSON.parse(await readSite(root, "gq.ops.json"));
  await writeManifest(root, { ...current, ...ACME, project: current.project });
}

test("the content site's manifest renders its CI Worker, Frontend deploy and release step", async () => {
  const fixture = await createFixtureSite({ ops: CONTENT_SITE });

  const result = await fixture.run(["sync"]);

  assert.equal(result.code, 0, result.stderr);
  const lock = JSON.parse(await readSite(fixture.root, "gq.lock.json"));
  for (const path of DEPLOY_PATHS) {
    const expected = await contentSiteFile(path);
    assert.equal(await readSite(fixture.root, path), expected, path);
    assert.equal(lock.files[path], hash(expected), path);
  }
});

test("every site value in the deploy files comes from gq.ops.json", async () => {
  const fixture = await createFixtureSite({ ops: ACME });

  const result = await fixture.run(["sync"]);

  assert.equal(result.code, 0, result.stderr);
  const wrangler = await readSite(fixture.root, "infra/ci/wrangler.jsonc");
  for (const line of [
    "  // AcmeShop CI on Cloudflare: pushes to the Artifacts repository (gq.ops.json",
    '  "name": "acme-builds",',
    '      "namespace": "acme-ns",',
    '      "name": "acme-builds",',
    '      "name": "acme-shop-mirror",',
    '          "namespace": "acme-ns",',
    '          "repo_name": "acme-repo",',
    '            "workflow_name": "acme-builds",',
    '      "bucket_name": "acme-snapshots",',
    '    "BACKUP_BUCKET_NAME": "acme-snapshots",',
    '    "CLOUDFLARE_ACCOUNT_ID": "0123456789abcdef0123456789abcdef",',
    '    "CLOUDFLARE_DEPLOY_ACCOUNT_ID": "0123456789abcdef0123456789abcdef",',
    '    "ARTIFACTS_NAMESPACE": "acme-ns",',
    '    "ARTIFACTS_REPO": "acme-repo",',
    '    "GITHUB_REPOSITORY": "Example/acme-site",',
  ]) {
    assert.ok(wrangler.split("\n").includes(line), `wrangler.jsonc lacks: ${line}`);
  }
  const frontend = await readSite(fixture.root, "infra/frontend.run.ts");
  assert.match(frontend, /^ {2}"AcmeShopFrontend",$/mu);
  assert.match(frontend, /^ {4}const worker = "acme-shop-fe";$/mu);
  assert.match(frontend, /^ {4}const name = production \? worker : `\$\{worker\}-\$\{stage\}`;$/mu);
  assert.match(frontend, /: `https:\/\/\$\{name\}\.workers\.dev`,$/mu);
  assert.match(frontend, /^ {2}const database = "acme-shop-fe-publications";$/mu);
  assert.match(await readSite(fixture.root, "infra/ci/package.json"), /"name": "@acme-shop\/ci",/u);
  assert.match(
    await readSite(fixture.root, "infra/ci/github.ts"),
    /"User-Agent": "acme-shop-ci",/u,
  );

  // Nothing of the content site's is left in any deploy file.
  for (const path of DEPLOY_PATHS) {
    const content = await readSite(fixture.root, path);
    for (const pattern of [/larkspur/iu, /8f38791a8c37b182239af2a385ab3c31/u, /bnq\.pt/u]) {
      assert.doesNotMatch(content, pattern, path);
    }
  }
});

test("a gq new site's deploy files hold placeholders until gq.ops.json has the values", async () => {
  const site = await newSite();
  const wrangler = await readSite(site.root, "infra/ci/wrangler.jsonc");
  assert.match(wrangler, /^ {2}"name": "<ci\.worker>",$/mu);
  assert.match(wrangler, /^ {4}"CLOUDFLARE_ACCOUNT_ID": "<cloudflare\.accountId>",$/mu);
  // GitHub is optional: without a repository the site is Artifacts-only.
  assert.match(wrangler, /^ {4}"GITHUB_REPOSITORY": "",$/mu);

  await fillManifest(site.root);
  const check = await site.run(["sync", "--check"]);
  assert.equal(check.code, 1);
  assert.equal(
    check.stdout,
    [
      "gq.ops.json: up to date (schema v1).",
      "infra/ci/wrangler.jsonc: pending, gq sync would update it.",
      "gq.lock.json: pending, gq sync would update it.",
      "",
    ].join("\n"),
  );

  const sync = await site.run(["sync"]);
  assert.equal(sync.code, 0, sync.stderr);
  const synced = await readSite(site.root, "infra/ci/wrangler.jsonc");
  assert.match(synced, /^ {2}"name": "acme-builds",$/mu);
  assert.doesNotMatch(synced, /<[a-zA-Z.]+>/u);
  const lock = JSON.parse(await readSite(site.root, "gq.lock.json"));
  assert.equal(lock.files["infra/ci/wrangler.jsonc"], hash(synced));

  const again = await site.run(["sync", "--check"]);
  assert.equal(again.code, 0, again.stdout);
});

test("a hand-edited deploy file stops gq sync even when gq.ops.json changed too", async () => {
  const site = await newSite();
  const path = "infra/ci/wrangler.jsonc";
  const edited = (await readSite(site.root, path)).replace(
    '"max_instances": 6,',
    '"max_instances": 9,',
  );
  await writeFile(join(site.root, path), edited);
  await fillManifest(site.root);
  const before = await snapshot(site.root);

  const result = await site.run(["sync"]);

  assert.equal(result.code, 1);
  assert.match(
    result.stdout,
    /^infra\/ci\/wrangler\.jsonc: edited since gq last wrote it \(gq\.lock\.json\); gq sync would write:$/mu,
  );
  assert.match(result.stdout, /^- {6}"max_instances": 9,$/mu);
  assert.match(result.stdout, /^\+ {2}"name": "acme-builds",$/mu);
  assert.match(result.stderr, /Local edits to managed files: infra\/ci\/wrangler\.jsonc\./u);
  assert.deepEqual(await snapshot(site.root), before);
});

test("no secret reaches a generated file, and generation calls no provider", async () => {
  const secrets = {
    CLOUDFLARE_API_TOKEN: "secret-cloudflare-token",
    CI_DEPLOY_API_TOKEN: "secret-ci-deploy-token",
    PLOI_API_TOKEN: "secret-ploi-token",
    R2_ACCESS_KEY_ID: "secret-r2-key-id",
    R2_SECRET_ACCESS_KEY: "secret-r2-key",
    GITHUB_CI_TOKEN: "secret-github-token",
    GITHUB_WEBHOOK_SECRET: "secret-webhook",
    COMPOSER_AUTH: '{"http-basic":{"secret-registry":{"password":"secret-password"}}}',
    SIGILLO_TOKEN: "secret-sigillo-token",
    FRONTEND_REFRESH_TOKEN: "secret-frontend-refresh-token-0123456789",
    PUBLICATION_EVENT_SECRET: "secret-publication-event-key-0123456789",
  };
  const fixture = await createFixtureSite({ ops: CONTENT_SITE });

  const result = await fixture.run(["sync"], { env: secrets });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.fetch.requests, []);
  assert.deepEqual(result.exec.calls, []);
  for (const [path, { content }] of Object.entries(await snapshot(fixture.root))) {
    assert.doesNotMatch(content ?? "", /secret-/u, path);
  }
});

test("scripts/ci.test.mjs run from a git hook leaves the hook's repository alone", async () => {
  const fixture = await createFixtureSite({ ops: ACME });
  assert.equal((await fixture.run(["sync"])).code, 0);

  // A worktree's pre-push hook runs `pnpm verify` with git's repository
  // variables pointing at the site's own repository.
  const site = await temporaryDirectory();
  const git = (...args) =>
    execFileSync("git", ["-C", site, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=s", "-c", "user.email=s@s", "commit", "-q", "--allow-empty", "-m", "site");
  const state = () => ({
    refs: git("for-each-ref"),
    config: git("config", "--local", "--list"),
    head: git("rev-parse", "HEAD"),
  });
  const before = state();

  // NODE_TEST_CONTEXT would make the nested runner report to this one.
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", "--test", "scripts/ci.test.mjs"],
    {
      cwd: fixture.root,
      encoding: "utf8",
      env: {
        ...environment,
        GIT_DIR: join(site, ".git"),
        GIT_INDEX_FILE: join(site, ".git", "index"),
      },
    },
  );

  assert.deepEqual(state(), before);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("the generated Frontend deploy and CI release step refuse an offboarded Site", async () => {
  const fixture = await createFixtureSite({
    ops: { ...ACME, offboarded: { at: "2026-10-01T09:00:00.000Z", phase: "cut" } },
  });
  assert.equal((await fixture.run(["sync"])).code, 0);
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const node = (script, args = []) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: fixture.root,
      encoding: "utf8",
      env: { ...environment, PATH: "" },
    });

  const deploy = node("infra/scripts/deploy-frontend.mjs");
  assert.equal(deploy.status, 1);
  assert.equal(
    deploy.stderr,
    "acme-shop is offboarded (gq.ops.json offboarded): deploying the Frontend would expose it again. If the Site is coming back, run gq offboard --restore first.\n",
  );

  const release = node("scripts/ci-release.mjs", ["--ref", "0123abcd"]);
  assert.equal(release.status, 1);
  assert.equal(
    release.stderr,
    "acme-shop is offboarded (gq.ops.json offboarded): a release would expose it again. If the Site is coming back, run gq offboard --restore first.\n",
  );
  assert.equal(release.stdout, "", "it refuses before anything else");
});

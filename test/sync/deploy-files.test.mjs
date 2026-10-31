// gq new and gq sync on a site's deploy wiring, driven through run(): the
// Cloudflare CI Worker, the Frontend deploy config and script, and the CI
// release step, fully generated from gq.ops.json. The content site's manifest
// renders the content site's own files (test/fixtures/content-site).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { deploymentRefusal } from "../../src/ploi/deployment-policy.mjs";
import { createFixtureSite, runGq, temporaryDirectory } from "../support/fixture-site.mjs";
import { hash, newSite, readSite, snapshot } from "../support/generated-site.mjs";

const DEPLOY_PATHS = [
  "apps/frontend/workers/consent-purge.ts",
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
  "infra/consent.ts",
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

test("the Frontend deploy provisions the consent records in the eu jurisdiction (ADR 0019)", async () => {
  const fixture = await createFixtureSite({ ops: ACME });

  const result = await fixture.run(["sync"]);

  assert.equal(result.code, 0, result.stderr);
  const consent = await readSite(fixture.root, "infra/consent.ts");
  // One database per Site and stage, created in eu, kept in production.
  assert.match(consent, /^ {2}const database = "acme-shop-fe-consent";$/mu);
  assert.match(consent, /^ {2}return yield\* Cloudflare\.D1\.Database\("AcmeShopConsent", \{$/mu);
  assert.match(consent, /^ {4}name: production \? database : `\$\{database\}-\$\{stage\}`,$/mu);
  assert.match(consent, /^ {4}jurisdiction: CONSENT_JURISDICTION,$/mu);
  assert.match(consent, /^export const CONSENT_JURISDICTION = "eu";$/mu);
  assert.match(consent, /\.pipe\(Alchemy\.RemovalPolicy\.retain\(production\)\)/u);
  // Its migrations are the Frontend's installed consent Runtime's.
  assert.match(consent, /"\.\/consent\/migrations"/u);
  // The retention purge: its own Worker on a daily cron, with no public URL.
  assert.match(consent, /^ {4}const worker = "acme-shop-consent-purge";$/mu);
  assert.match(consent, /^ {6}crons: \[CONSENT_PURGE_SCHEDULE\],$/mu);
  assert.match(consent, /^ {6}workersDev: false,$/mu);
  assert.match(
    consent,
    /^ {6}main: fileURLToPath\(new URL\("workers\/consent-purge\.ts", frontendApp\)\),$/mu,
  );

  const frontend = await readSite(fixture.root, "infra/frontend.run.ts");
  assert.match(frontend, /^ {14}CONSENT_DB: yield\* ConsentDatabase,$/mu);
  assert.match(frontend, /^ {14}CONSENT_RATE_LIMITER: consentRateLimiter\(name\),$/mu);
  assert.match(frontend, /CONSENT_READ_TOKEN: Redacted\.make\(consentReadToken\)/u);
  assert.match(frontend, /^ {4}if \(consentRecords\) yield\* ConsentPurge;$/mu);

  const purge = await readSite(fixture.root, "apps/frontend/workers/consent-purge.ts");
  assert.match(purge, /from "@getquick\/content\/consent\/server";$/mu);
  assert.match(purge, /^ {2}async scheduled\(/mu);
  assert.match(purge, /\.purge\(\)/u);
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
    GQ_PREVIEW_CMS_USERNAME: "secret-preview-username",
    GQ_PREVIEW_CMS_APPLICATION_PASSWORD: "secret-preview-password",
    GQ_PREVIEW_ACCESS_CLIENT_ID: "secret-preview-client-id",
    GQ_PREVIEW_ACCESS_CLIENT_SECRET: "secret-preview-client-secret",
    GQ_AUTH_GRAPHQL_CLIENT_ID: "secret-graphql-client-id",
    GQ_AUTH_GRAPHQL_CLIENT_SECRET: "secret-graphql-client-secret",
    GQ_AUTH_AUTOMATION_CLIENT_ID: "secret-automation-client-id",
    GQ_AUTH_AUTOMATION_CLIENT_SECRET: "secret-automation-client-secret",
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

test("the generated CI release step and Frontend deploy refuse a paused or reserved Site exactly as gq ploi release does", async () => {
  const holds = [
    { protected: true, state: "paused", reason: "Controlled release in preparation" },
    {
      protected: true,
      state: "reserved",
      reason: "Nightly update running",
      holder: "nightly pipeline",
    },
  ];
  for (const deployment of holds) {
    const ops = { ...ACME, deployment };
    const fixture = await createFixtureSite({ ops });
    assert.equal((await fixture.run(["sync"])).code, 0);
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;

    const release = spawnSync(process.execPath, ["scripts/ci-release.mjs", "--ref", "0123abcd"], {
      cwd: fixture.root,
      encoding: "utf8",
      env: { ...environment, PATH: "" },
    });

    assert.equal(release.status, 1);
    assert.equal(release.stderr, `${deploymentRefusal(ops)}\n`);
    assert.equal(release.stdout, "", "it refuses before anything else");

    const frontend = spawnSync(process.execPath, ["infra/scripts/deploy-frontend.mjs"], {
      cwd: fixture.root,
      encoding: "utf8",
      env: { ...environment, PATH: "" },
    });
    assert.equal(frontend.status, 1);
    assert.equal(frontend.stderr, `${deploymentRefusal(ops)}\n`);
  }
});

test("preview config uses site.bind after Website initialization", async () => {
  const fixture = await createFixtureSite({
    ops: {
      ...ACME,
      preview: { cmsUrl: "https://cms.acme.test", audience: "https://www.acme.test/gq/preview" },
    },
  });
  const result = await fixture.run(["sync"]);
  assert.equal(result.code, 0, result.stderr);
  const frontend = await readSite(fixture.root, "infra/frontend.run.ts");
  assert.match(frontend, /previewBindings\(ops, process.env, Redacted.make\)/u);
  assert.match(
    frontend,
    /const site = yield\* Website;[\s\S]*site.bind`Preview`\(\{ env: previewEnv \}\)/u,
  );
  assert.doesNotMatch(frontend, /\.\.\.previewEnv/u);
  assert.doesNotMatch(frontend, /PUBLIC_GQ_PREVIEW/u);
});

// The CI Worker's steps (infra/ci/release.ts ciSteps), executed in order as
// the Worker runs them: bash, git and node, a local bare repository standing
// in for Artifacts, and a tagged workspace whose install, verify and release
// are marker scripts the tag controls. An old tag runs its own scripts, so
// the admission must stop a held or historical release before any of them.
test("the CI Worker admits a release first, so a held or historical tag runs none of its own code", async () => {
  for (const variant of ["content", "commerce"]) {
    const parent = await temporaryDirectory();
    const created = await runGq(["new", "site", "--project", "acme-shop", "--variant", variant], {
      cwd: parent,
    });
    assert.equal(created.code, 0, created.stderr);
    const worker = await readSite(join(parent, "site"), "infra/ci/cloudflare.ci.ts");
    // The Worker runs exactly ciSteps' list, through one runner call each.
    assert.match(
      worker,
      /for \(const \{ on, step \} of ciSteps\(params, \{ install, verify, release \}\)\)/u,
    );
    assert.equal(worker.split("ci.runner(").length - 1, 1);
    assert.equal(worker.split("workspace.runner(").length - 1, 1);
  }

  const fixture = await createFixtureSite({ ops: ACME });
  assert.equal((await fixture.run(["sync"])).code, 0);
  const { ciSteps, admissionCommand } = await import(join(fixture.root, "infra/ci/release.ts"));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("GIT_") && name !== "NODE_TEST_CONTEXT",
    ),
  );
  const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, env: environment, encoding: "utf8" }).trim();
  const commit = (work, message) =>
    git(
      work,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "commit",
      "--quiet",
      "-m",
      message,
    );

  // Artifacts: `requested` tagged v1.0.0, then `current` on main (null:
  // none). The workspace holds the tag's marker scripts.
  async function release({ current, requested = ACME, trigger = "tag", wrongSha = false }) {
    const root = await temporaryDirectory();
    const bare = join(root, "artifacts.git");
    git(root, "init", "--quiet", "--bare", "--initial-branch=main", bare);
    const work = join(root, "work");
    git(root, "init", "--quiet", "--initial-branch=main", work);
    await writeFile(join(work, "gq.ops.json"), `${JSON.stringify(requested)}\n`);
    git(work, "add", "-A");
    commit(work, "tagged");
    git(
      work,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "tag",
      "-a",
      "v1.0.0",
      "-m",
      "v1.0.0",
    );
    const tagObject = git(work, "rev-parse", "v1.0.0");
    if (current === null) await rm(join(work, "gq.ops.json"));
    else await writeFile(join(work, "gq.ops.json"), `${JSON.stringify(current)}\n`);
    await writeFile(join(work, "README.md"), "later\n");
    git(work, "add", "-A");
    commit(work, "main");
    git(work, "push", "--quiet", bare, "main", "v1.0.0");

    const workspace = join(root, "workspace");
    await mkdir(workspace);
    // The tag's own code: each step records that it ran, and what secret it saw.
    await writeFile(
      join(workspace, "mark.mjs"),
      'import { appendFileSync } from "node:fs"; appendFileSync("MARKERS", `${process.argv[2]} ${process.env.SECRET ?? ""}\\n`);',
    );
    const step = (name) => ({ name, command: `node mark.mjs ${name}` });
    const placed = ciSteps(
      { trigger, tag: "v1.0.0", sha: wrongSha ? "1".repeat(40) : tagObject },
      // The release step has source control credentials, as the Worker's does.
      {
        install: step("install"),
        verify: step("verify"),
        release: { ...step("release"), sourceControlCredentials: true },
      },
    );
    const ran = [];
    let output = "";
    for (const {
      step: { name, command, sourceControlCredentials },
    } of placed) {
      const result = spawnSync("bash", ["-c", command], {
        cwd: workspace,
        encoding: "utf8",
        env: {
          ...environment,
          SECRET: "s3cret",
          ...(sourceControlCredentials
            ? { ARTIFACTS_REMOTE: bare, ARTIFACTS_TOKEN: "artifacts-token" }
            : {}),
        },
      });
      ran.push(name);
      output += result.stdout + result.stderr;
      if (result.status !== 0) break;
    }
    const markers = await readFile(join(workspace, "MARKERS"), "utf8").catch(() => "");
    return { ran, markers, output };
  }

  const admitted = await release({ current: ACME });
  assert.deepEqual(admitted.ran, ["admission", "install", "verify", "release"]);
  assert.equal(admitted.markers, "install s3cret\nverify s3cret\nrelease s3cret\n");
  assert.match(admitted.output, /Release [0-9a-f]{12} admitted/u);

  const paused = {
    ...ACME,
    deployment: { protected: true, state: "paused", reason: "Controlled release" },
  };
  const guarded = {
    ...ACME,
    deployment: {
      protected: true,
      state: "authorized",
      guardedPackages: ["getquick/gq-support"],
      approval: { slot: "acme/production", stage: "prod" },
    },
  };
  for (const [options, message] of [
    // An old tag without the hold, held by the default branch's policy.
    [{ current: paused }, /the default branch's gq\.ops\.json deployment\.state: paused/u],
    [
      { current: ACME, requested: paused },
      /release [0-9a-f]{12}'s gq\.ops\.json deployment\.state: paused/u,
    ],
    [
      { current: { ...ACME, offboarded: { at: "2026-10-01T09:00:00.000Z", phase: "cut" } } },
      /offboarded \(the default branch's gq\.ops\.json offboarded\)/u,
    ],
    // A historical tag whose gq wouldn't verify the guarded package.
    [{ current: guarded }, /predates the default branch's deployment policy/u],
    // Fail closed: no current policy, or a tag that isn't the one asked for.
    [{ current: null }, /The default branch's gq\.ops\.json can't be read/u],
    [{ current: ACME, wrongSha: true }, /Release 111111111111's gq\.ops\.json can't be read/u],
  ]) {
    const result = await release(options);
    assert.deepEqual(result.ran, ["admission"], JSON.stringify(options));
    assert.equal(result.markers, "", "none of the tag's code ran");
    assert.match(result.output, message);
    assert.doesNotMatch(result.output, /artifacts-token/u);
  }
  assert.deepEqual((await release({ current: guarded, requested: guarded })).ran.length, 4);

  // A branch push isn't a release: no admission, nothing deployed.
  const push = await release({ current: paused, trigger: "push" });
  assert.deepEqual(push.ran, ["install", "verify"]);
  assert.throws(
    () => admissionCommand("v1.0.0; rm -rf /", "v1.0.0"),
    /Not a commit or tag object id/u,
  );
  assert.throws(() => admissionCommand("1".repeat(40), "v1; rm -rf /"), /Not a release tag/u);
});

// `pnpm plan:frontend` runs infra's plan:frontend: the deploy wrapper in
// dry-run mode, so a plan reads the Cloudflare account from gq.ops.json as
// the deploy does. An executable named alchemy records its arguments and
// account; it never deploys.
async function plan(root) {
  const scripts = JSON.parse(await readSite(root, "package.json")).scripts;
  assert.equal(
    scripts["plan:frontend"],
    "gq sigillo run staging -- pnpm --dir infra run plan:frontend",
  );
  assert.equal(scripts["plan:frontend:raw"], "pnpm --dir infra run plan:frontend");
  const infra = JSON.parse(await readSite(root, "infra/package.json")).scripts;
  assert.equal(infra["plan:frontend"], "node scripts/deploy-frontend.mjs --dry-run --detailed");
  const alchemy = join(root, "alchemy");
  await writeFile(
    alchemy,
    `#!${process.execPath}\nconsole.log(JSON.stringify({ args: process.argv.slice(2), account: process.env.CLOUDFLARE_ACCOUNT_ID }));\n`,
  );
  await chmod(alchemy, 0o755);
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  delete environment.CLOUDFLARE_ACCOUNT_ID;
  const [command, ...args] = infra["plan:frontend"].split(" ");
  assert.equal(command, "node");
  const result = spawnSync(process.execPath, args, {
    cwd: join(root, "infra"),
    encoding: "utf8",
    env: { ...environment, PATH: root },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

const PLAN_ARGS = [
  "deploy",
  "--stage",
  "prod",
  "--config",
  "frontend.run.ts",
  "--yes",
  "--no-input",
  "--dry-run",
  "--detailed",
];

test("a content Site's plan:frontend plans through the deploy wrapper, with gq.ops.json's account", async () => {
  const fixture = await createFixtureSite({ ops: ACME });
  assert.equal((await fixture.run(["sync"])).code, 0);

  assert.deepEqual(await plan(fixture.root), {
    args: PLAN_ARGS,
    account: ACME.cloudflare.accountId,
  });
});

test("a commerce Site's plan:frontend plans through the deploy wrapper, with gq.ops.json's account", async () => {
  const parent = await temporaryDirectory();
  const created = await runGq(["new", "shop", "--project", "shop", "--variant", "commerce"], {
    cwd: parent,
  });
  assert.equal(created.code, 0, created.stderr);
  const root = join(parent, "shop");
  const manifest = JSON.parse(await readSite(root, "gq.ops.json"));
  await writeManifest(root, {
    ...manifest,
    cloudflare: { ...manifest.cloudflare, accountId: ACME.cloudflare.accountId },
  });

  assert.deepEqual(await plan(root), { args: PLAN_ARGS, account: ACME.cloudflare.accountId });
});

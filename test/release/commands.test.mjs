// Release and version commands (formerly shop-devtools) at the run() seam: a
// content site — the default JSON files, plus a theme
// stylesheet header and a PHP define as text-file patterns in gq.ops.json —
// driven in-process with a recording exec.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createFixtureSite, recordingExec } from "../support/fixture-site.mjs";
import { CONTENT_CHECKS, CONTENT_RELEASE_PATHS } from "../support/site-settings.mjs";

// A content site whose gq.ops.json adds its theme's stylesheet header and PHP
// define as text-file patterns, and the theme to the release paths.
const OPS = {
  schemaVersion: 1,
  project: "fixture",
  variant: "content",
  release: {
    textFiles: [
      {
        path: "theme/style.css",
        patterns: [{ regexp: "^Version: .+$", flags: "m", replacement: "Version: {version}" }],
      },
      {
        path: "theme/functions.php",
        patterns: [
          {
            regexp: "define\\( 'THEME_VERSION', '[^']+' \\);",
            replacement: "define( 'THEME_VERSION', '{version}' );",
          },
        ],
      },
    ],
    paths: ["theme"],
  },
};

function siteFiles(version, overrides = {}) {
  return {
    VERSION: `${version}\n`,
    "CHANGELOG.md": "# Changelog\n\n## v1.2.3 - 2026-09-01\n\n- Earlier release.\n",
    "package.json": `${JSON.stringify({ name: "site", version, private: true }, null, 2)}\n`,
    "apps/frontend/package.json": `${JSON.stringify({ name: "frontend", version }, null, 2)}\n`,
    "theme/style.css": `/*\nTheme Name: Site\nVersion: ${version}\n*/\n`,
    "theme/functions.php": `<?php\ndefine( 'THEME_VERSION', '${version}' );\n`,
    ...overrides,
  };
}

const read = (site, path) => readFile(site.path(path), "utf8");
const releaseSite = (version, overrides) =>
  createFixtureSite({ ops: OPS, files: siteFiles(version, overrides) });

test("version check passes when every configured file carries VERSION", async () => {
  const site = await releaseSite("1.2.3");
  const result = await site.run(["version", "check"]);
  assert.equal(result.stderr, "");
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "All project packages are synced at 1.2.3.\n");
  assert.deepEqual(result.exec.calls, []);
});

test("version check lists every file that drifted from VERSION", async () => {
  const site = await releaseSite("1.2.3", {
    "apps/frontend/package.json": `${JSON.stringify({ name: "frontend" })}\n`,
    "theme/style.css": "/*\nVersion: 1.2.2\n*/\n",
  });
  const result = await site.run(["version", "check"]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "gq: Version drift detected for 1.2.3:\n" +
      "  - apps/frontend/package.json: [missing]\n" +
      '  - theme/style.css: missing "Version: 1.2.3"\n',
  );
});

test("version check accepts an explicit version", async () => {
  const site = await releaseSite("1.2.3");
  const result = await site.run(["version", "check", "1.3.0"]);
  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    "gq: Version drift detected for 1.3.0:\n" +
      "  - package.json: 1.2.3\n" +
      "  - apps/frontend/package.json: 1.2.3\n" +
      '  - theme/style.css: missing "Version: 1.3.0"\n' +
      "  - theme/functions.php: missing \"define( 'THEME_VERSION', '1.3.0' );\"\n",
  );
});

test("version sync writes VERSION into the JSON files and text-file patterns", async () => {
  const site = await releaseSite("1.2.3", { VERSION: "2.0.0\n" });
  const result = await site.run(["version", "sync"]);
  assert.equal(result.stderr, "");
  assert.equal(result.code, 0);
  assert.equal(
    result.stdout,
    "Synced project version 2.0.0.\nAll project packages are synced at 2.0.0.\n",
  );
  assert.equal(
    await read(site, "package.json"),
    '{\n  "name": "site",\n  "version": "2.0.0",\n  "private": true\n}\n',
  );
  assert.equal(
    await read(site, "apps/frontend/package.json"),
    '{\n  "name": "frontend",\n  "version": "2.0.0"\n}\n',
  );
  assert.equal(await read(site, "theme/style.css"), "/*\nTheme Name: Site\nVersion: 2.0.0\n*/\n");
  assert.equal(
    await read(site, "theme/functions.php"),
    "<?php\ndefine( 'THEME_VERSION', '2.0.0' );\n",
  );
  assert.equal(await read(site, "VERSION"), "2.0.0\n");
  assert.deepEqual(result.exec.calls, []);
});

test("version sync fails on a text file without its version pattern", async () => {
  const site = await releaseSite("1.2.3", { "theme/functions.php": "<?php\n" });
  const result = await site.run(["version", "sync"]);
  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    "gq: theme/functions.php is missing expected version pattern /define\\( 'THEME_VERSION', '[^']+' \\);/.\n",
  );
});

test("release prepare writes the new VERSION, syncs it, and names the next step", async () => {
  const site = await releaseSite("1.2.3");
  const result = await site.run(["release", "prepare", "1.3.0-rc.1"]);
  assert.equal(result.stderr, "");
  assert.equal(result.code, 0);
  assert.equal(
    result.stdout,
    "Synced project version 1.3.0-rc.1.\n" +
      "All project packages are synced at 1.3.0-rc.1.\n" +
      "Prepared release 1.3.0-rc.1. Commit the synced files, then run: gq release tag 1.3.0-rc.1\n",
  );
  assert.equal(await read(site, "VERSION"), "1.3.0-rc.1\n");
  assert.equal(
    await read(site, "theme/style.css"),
    "/*\nTheme Name: Site\nVersion: 1.3.0-rc.1\n*/\n",
  );
  assert.deepEqual(result.exec.calls, []);
});

test("release prepare rejects a version that isn't semver and writes nothing", async () => {
  const site = await releaseSite("1.2.3");
  const result = await site.run(["release", "prepare", "v1.3"]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, 'gq: Expected a semver version, received "v1.3".\n');
  assert.equal(await read(site, "VERSION"), "1.2.3\n");
});

test("release tag tags a clean, synced tree", async () => {
  const site = await releaseSite("1.2.3");
  const exec = recordingExec();
  const result = await site.run(["release", "tag"], { exec });
  assert.equal(result.stderr, "");
  assert.equal(result.code, 0);
  assert.equal(
    result.stdout,
    "All project packages are synced at 1.2.3.\nCreated v1.2.3. Push it with: git push origin v1.2.3\n",
  );
  assert.deepEqual(
    exec.calls.map(({ command, args, cwd }) => [command, args, cwd]),
    [
      ["git", ["status", "--porcelain"], site.root],
      ["git", ["tag", "-a", "v1.2.3", "-m", "Release v1.2.3"], site.root],
    ],
  );
});

test("release tag refuses a dirty working tree", async () => {
  const site = await releaseSite("1.2.3");
  const exec = recordingExec(({ args }) =>
    args[0] === "status" ? { stdout: " M VERSION\n" } : {},
  );
  const result = await site.run(["release", "tag"], { exec });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "gq: Release tagging requires a clean working tree.\n");
  assert.equal(exec.calls.length, 1);
});

// Answers the git queries `release push` reads; everything else succeeds silently.
function gitAnswers(overrides = {}) {
  const answers = {
    "tag --list v1.3.0": "",
    "tag --merged HEAD --list v[0-9]* --sort=-v:refname": "v1.2.3\nv1.2.2\n",
    "log v1.2.3..HEAD --pretty=format:%h %s": "abc1234 feat: add a page\ndef5678 fix: a typo\n",
    "diff --cached --name-only": "VERSION\n",
    "rev-parse --abbrev-ref HEAD": "main\n",
    "symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
    ...overrides,
  };
  return ({ command, args }) =>
    command === "git" ? { stdout: answers[args.join(" ")] ?? "" } : {};
}

const releaseGit = (overrides) => recordingExec(gitAnswers(overrides));

test("release push bumps, syncs, logs, checks, commits, tags and pushes", async () => {
  const site = await releaseSite("1.2.3");
  const exec = releaseGit();
  const result = await site.run(["release", "push", "minor"], { exec, env: { PATH: "/bin" } });
  assert.equal(result.stderr, "");
  assert.equal(result.code, 0);
  assert.equal(
    result.stdout,
    [
      "Synced project version 1.3.0.",
      "Updated CHANGELOG.md from v1.2.3 to v1.3.0.",
      "All project packages are synced at 1.3.0.",
      "Created v1.3.0. Push it with: git push origin v1.3.0",
      "Pushed minor release 1.3.0.",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    exec.calls.map(({ command, args }) => [command, ...args].join(" ")),
    [
      "git rev-parse --abbrev-ref HEAD",
      "git symbolic-ref --quiet --short refs/remotes/origin/HEAD",
      "git tag --list v1.3.0",
      "git tag --merged HEAD --list v[0-9]* --sort=-v:refname",
      "git log v1.2.3..HEAD --pretty=format:%h %s",
      ...CONTENT_CHECKS,
      `git add ${[...CONTENT_RELEASE_PATHS, "theme"].join(" ")}`,
      "git diff --cached --name-only",
      "git commit -m Release v1.3.0",
      "git tag -a v1.3.0 -m Release v1.3.0",
      "git push origin main",
      "git push origin v1.3.0",
    ],
  );
  const composer = exec.calls.find(({ command }) => command === "composer");
  assert.deepEqual(composer.env, { PATH: "/bin" });
  assert.equal(composer.cwd, site.root);

  assert.equal(await read(site, "VERSION"), "1.3.0\n");
  assert.equal(
    await read(site, "theme/functions.php"),
    "<?php\ndefine( 'THEME_VERSION', '1.3.0' );\n",
  );
  assert.match(
    await read(site, "CHANGELOG.md"),
    /^# Changelog\n\n## v1\.3\.0 - \d{4}-\d{2}-\d{2}\n\nPrevious release: v1\.2\.3\n\n- abc1234 feat: add a page\n- def5678 fix: a typo\n\n## v1\.2\.3 - 2026-09-01\n\n- Earlier release\.\n$/,
  );
});

test("release push fix bumps the patch number and names it a fix", async () => {
  const site = await releaseSite("1.2.3");
  const exec = releaseGit({ "tag --list v1.2.4": "" });
  const result = await site.run(["release", "push", "patch"], { exec });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\nPushed fix release 1\.2\.4\.\n$/);
});

test("release push stops before writing anything when the tag exists", async () => {
  const site = await releaseSite("1.2.3");
  const exec = releaseGit({ "tag --list v2.0.0": "v2.0.0\n" });
  const result = await site.run(["release", "push", "major"], { exec });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "gq: Release tag v2.0.0 already exists.\n");
  assert.equal(await read(site, "VERSION"), "1.2.3\n");
});

test("release push stops when a check fails, before committing", async () => {
  const site = await releaseSite("1.2.3");
  const answer = gitAnswers();
  const exec = recordingExec((call) => (call.command === "pnpm" ? { code: 2 } : answer(call)));
  const result = await site.run(["release", "push", "minor"], { exec });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "gq: pnpm run check exited with code 2.\n");
  assert.equal(exec.calls.at(-1).command, "pnpm");
});

test("release push refuses a branch other than the default before changing anything", async () => {
  const site = await releaseSite("1.2.3");
  const exec = releaseGit({ "rev-parse --abbrev-ref HEAD": "feature/spec-38\n" });
  const result = await site.run(["release", "push", "minor"], { exec });
  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    "gq: Release push must run on the default branch main, but HEAD is on feature/spec-38. " +
      "Merge the branch into main, then run: git switch main && gq release push minor\n",
  );
  assert.equal(await read(site, "VERSION"), "1.2.3\n");
  assert.equal(await read(site, "CHANGELOG.md"), siteFiles("1.2.3")["CHANGELOG.md"]);
  assert.deepEqual(
    exec.calls.map(({ command, args }) => [command, ...args].join(" ")),
    [
      "git rev-parse --abbrev-ref HEAD",
      "git symbolic-ref --quiet --short refs/remotes/origin/HEAD",
    ],
  );
});

test("release push falls back to main when origin/HEAD is not set", async () => {
  const site = await releaseSite("1.2.3");
  const answer = gitAnswers({ "rev-parse --abbrev-ref HEAD": "trunk\n" });
  const exec = recordingExec((call) =>
    call.args?.[0] === "symbolic-ref" ? { code: 1, stdout: "" } : answer(call),
  );
  const result = await site.run(["release", "push", "minor"], { exec });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /default branch main, but HEAD is on trunk\./);
  assert.equal(await read(site, "VERSION"), "1.2.3\n");
});

test("release push follows origin/HEAD when the default branch isn't main", async () => {
  const site = await releaseSite("1.2.3");
  const exec = releaseGit({
    "rev-parse --abbrev-ref HEAD": "trunk\n",
    "symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/trunk\n",
  });
  const result = await site.run(["release", "push", "minor"], { exec });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    exec.calls.slice(-2).map(({ args }) => args.join(" ")),
    ["push origin trunk", "push origin v1.3.0"],
  );
});

test("release push refuses a detached HEAD before changing anything", async () => {
  const site = await releaseSite("1.2.3");
  const exec = releaseGit({ "rev-parse --abbrev-ref HEAD": "HEAD\n" });
  const result = await site.run(["release", "push", "minor"], { exec });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "gq: Cannot push release from a detached HEAD.\n");
  assert.equal(await read(site, "VERSION"), "1.2.3\n");
});

test("release push rejects anything but a bump kind", async () => {
  const site = await releaseSite("1.2.3");
  const result = await site.run(["release", "push", "1.3.0"]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "gq: Usage: gq release push <major|minor|fix>\n");
  assert.deepEqual(result.exec.calls, []);
});

test("release commands find the site from a subdirectory", async () => {
  const site = await releaseSite("1.2.3");
  const result = await site.run(["version", "check"], { cwd: site.path("theme") });
  assert.equal(result.code, 0, result.stderr);
});

test("release commands reject options they don't take before loading a project", async () => {
  const site = await createFixtureSite({ ops: null });
  for (const [argv, message] of [
    [["version", "check", "--dry-run"], "--dry-run is not valid for version check."],
    [["release", "tag", "--yes"], "--yes is not valid for release tag."],
    [
      ["release", "tag", "1.2.3", "extra"],
      "Unknown command: release tag 1.2.3 extra. Run gq --help.",
    ],
  ]) {
    const result = await site.run(argv);
    assert.equal(result.code, 1, argv.join(" "));
    assert.equal(result.stderr, `gq: ${message}\n`);
  }
});

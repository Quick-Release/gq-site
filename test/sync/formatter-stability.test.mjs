// A site's pre-commit hook formats its staged files (vp fmt --write), so a
// fully generated file must already be as the formatter writes it, whatever
// the site's values; otherwise the first commit edits it and gq sync then
// refuses to write. Line lengths that vary with the project name are the risk:
// a short name lets the formatter join a wrapped line, a long one splits it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, symlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createFixtureSite } from "../support/fixture-site.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const ownership = JSON.parse(await readFile(join(repo, "blueprint/ownership.json"), "utf8"));

// What the site's pre-commit hook formats (templates/vite.config.ts `staged`).
const FORMATTED = /\.(?:js|cjs|mjs|jsx|ts|tsx|json|jsonc|md|mdx|css|scss|html)$/u;

// A site named `project`, with its other values named after it as Lombardi's are.
function manifest(project) {
  return {
    schemaVersion: 1,
    project,
    variant: "content",
    domains: { admin: `cms.${project}.test`, frontend: `www.${project}.test` },
    artifacts: { namespace: project, repo: project },
    ci: { worker: `${project}-ci`, backupBucket: `${project}-ci-backups` },
    cloudflare: { accountId: "0123456789abcdef0123456789abcdef", zoneName: `${project}.test` },
    github: { repository: `Example/${project}` },
  };
}

// The shortest name, and one well past any real site's (Lombardi's is eight
// characters).
for (const project of ["a", "abcdefghij-abcdefghij-abcdefghij-abcdefg"]) {
  test(`fully generated files are formatter-stable for a ${project.length}-character project name`, async () => {
    const fixture = await createFixtureSite({ ops: manifest(project) });
    const result = await fixture.run(["sync"]);
    assert.equal(result.code, 0, result.stderr);
    // The site's vite.config.ts imports vite-plus; use this package's.
    await mkdir(fixture.path("node_modules"));
    await symlink(join(repo, "node_modules/vite-plus"), fixture.path("node_modules/vite-plus"));

    const paths = ownership.fullyGenerated
      .filter(({ template }) => template !== undefined)
      .map(({ path }) => path)
      .filter((path) => FORMATTED.test(path));
    const check = spawnSync(join(repo, "node_modules/.bin/vp"), ["fmt", "--check", ...paths], {
      cwd: fixture.root,
      encoding: "utf8",
    });

    assert.equal(check.status, 0, `${check.stdout}${check.stderr}`);
  });
}

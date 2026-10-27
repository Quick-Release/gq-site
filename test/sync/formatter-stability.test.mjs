// A site's pre-commit hook formats its staged files (vp fmt --write), so a
// fully generated file must already be as the formatter writes it, whatever
// the site's values; otherwise the first commit edits it and gq sync then
// refuses to write. The app skeleton gq new creates once must be too, or the
// site's first commit rewrites it. Line lengths that vary with the project name are the risk:
// a short name lets the formatter join a wrapped line, a long one splits it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, symlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createFixtureSite } from "../support/fixture-site.mjs";
import { newSite } from "../support/generated-site.mjs";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const ownership = JSON.parse(await readFile(join(repo, "blueprint/ownership.json"), "utf8"));

// What the site's pre-commit hook formats (templates/vite.config.ts `staged`).
const FORMATTED = /\.(?:js|cjs|mjs|jsx|ts|tsx|json|jsonc|md|mdx|css|scss|html)$/u;

// A site named `project`, with its other values named after it.
function manifest(project) {
  return {
    schemaVersion: 1,
    project,
    variant: "content",
    contentRuntime: "package",
    domains: { admin: `cms.${project}.test`, frontend: `www.${project}.test` },
    // So the files gq writes only for a Site with forms are checked too.
    wordpress: { plugins: ["gravityforms"] },
    forms: { provider: "gravityforms", spam: ["honeypot", "turnstile"] },
    artifacts: { namespace: project, repo: project },
    ci: { worker: `${project}-ci`, backupBucket: `${project}-ci-backups` },
    cloudflare: { accountId: "0123456789abcdef0123456789abcdef", zoneName: `${project}.test` },
    github: { repository: `Example/${project}` },
  };
}

// The site's vite.config.ts imports vite-plus; use this package's.
async function linkVitePlus(root) {
  await mkdir(join(root, "node_modules"));
  await symlink(join(repo, "node_modules/vite-plus"), join(root, "node_modules/vite-plus"));
}

function formatCheck(root, paths) {
  return spawnSync(join(repo, "node_modules/.bin/vp"), ["fmt", "--check", ...paths], {
    cwd: root,
    encoding: "utf8",
  });
}

// The shortest name, and one well past any real site's.
const NAMES = ["a", "abcdefghij-abcdefghij-abcdefghij-abcdefg"];

for (const framework of ["astro", "tanstack"]) {
  for (const project of NAMES) {
    test(`fully generated ${framework} files are formatter-stable for a ${project.length}-character project name`, async () => {
      const fixture = await createFixtureSite({ ops: { ...manifest(project), framework } });
      const result = await fixture.run(["sync"]);
      assert.equal(result.code, 0, result.stderr);
      await linkVitePlus(fixture.root);

      const paths = ownership.fullyGenerated
        .filter(
          ({ template, framework: selected }) =>
            template !== undefined && (!selected || selected === framework),
        )
        .map(({ path }) => path)
        .filter((path) => FORMATTED.test(path));
      const check = formatCheck(fixture.root, paths);

      assert.equal(check.status, 0, `${check.stdout}${check.stderr}`);
    });
  }
}

// gq new's own name too (four characters), the length a reported site had.
for (const framework of ["astro", "tanstack"]) {
  for (const project of [...NAMES, "acme"]) {
    test(`create-once ${framework} files are formatter-stable for a ${project.length}-character project name`, async () => {
      const site = await newSite(project, framework);
      await linkVitePlus(site.root);

      const paths = ownership.createOnce
        .filter(
          ({ template, framework: selected }) =>
            template !== undefined && (!selected || selected === framework),
        )
        .map(({ path }) => path)
        .filter((path) => FORMATTED.test(path));
      const check = formatCheck(site.root, paths);

      assert.equal(check.status, 0, `${check.stdout}${check.stderr}`);
    });
  }
}

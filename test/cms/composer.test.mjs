import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chooseRunner, installHint } from "../../src/cms/composer.mjs";
import { installProblem } from "../../src/cms/local.mjs";
import { syncLocalDesign } from "../../src/cms/local-design.mjs";

// Choosing the Composer runner.
test("prefers a running DDEV project, whose PHP matches the server", () => {
  assert.equal(chooseRunner({ ddevRunning: true, hasComposer: true, hasDdev: true }), "ddev");
});

test("uses the host Composer when DDEV is not running", () => {
  assert.equal(chooseRunner({ ddevRunning: false, hasComposer: true, hasDdev: true }), "host");
  assert.equal(chooseRunner({ ddevRunning: false, hasComposer: true, hasDdev: false }), "host");
});

test("starts DDEV when there is no host Composer", () => {
  assert.equal(
    chooseRunner({ ddevRunning: false, hasComposer: false, hasDdev: true }),
    "ddev-start",
  );
});

test("gives up without Composer or DDEV, with a per-OS install hint", () => {
  assert.equal(chooseRunner({ ddevRunning: false, hasComposer: false, hasDdev: false }), null);
  assert.match(installHint("darwin"), /brew install composer/);
  assert.match(installHint("linux"), /apt install composer/);
});

test("installs only with the registry login and the host Composer", () => {
  assert.equal(installProblem({ composerAuth: "{}", hasComposer: true }), null);
  assert.match(installProblem({ composerAuth: "", hasComposer: true }), /COMPOSER_AUTH is missing/);
  assert.match(
    installProblem({ composerAuth: "{}", hasComposer: false }, "darwin"),
    /brew install composer/,
  );
});

// The local Design CLI cases: the real gq bin and a fake
// host Composer that fails mid-change.
const gq = fileURLToPath(new URL("../../bin/gq.mjs", import.meta.url));

for (const slug of ["getquick-design", "gq-design"]) {
  for (const action of ["install", "update", "reinstall"]) {
    test(`gq cms composer ${action} restores ${slug} and exit status on Composer failure`, (t) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "getquick-composer-")));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const cms = join(root, "apps/cms");
      const source = join(root, "design checkout");
      const plugin = join(cms, "web/app/plugins", slug);
      const state = join(cms, ".local-plugins");
      mkdirSync(source, { recursive: true });
      mkdirSync(plugin, { recursive: true });
      mkdirSync(state, { recursive: true });
      writeFileSync(join(source, `${slug}.php`), "local edits");
      writeFileSync(join(plugin, `${slug}.php`), "registry release");
      writeFileSync(join(state, "config.json"), JSON.stringify({ getquickDesign: source }));
      writeFileSync(
        join(root, "gq.ops.json"),
        JSON.stringify({ schemaVersion: 1, project: "fixture", variant: "content" }),
      );
      syncLocalDesign(cms, { CI: "" });
      const bin = join(root, "bin");
      mkdirSync(bin);
      const log = join(root, "composer.log");
      writeFileSync(
        join(bin, "composer"),
        `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.COMPOSER_TEST_LOG, JSON.stringify(args) + '\\n');
const plugin = 'web/app/plugins/${slug}';
if (args[0] === 'dump-autoload') {
  if (!fs.lstatSync(plugin).isSymbolicLink() || !fs.existsSync('.local-plugins/design-operation.lock')) process.exit(99);
} else {
  if (fs.lstatSync(plugin).isSymbolicLink()) process.exit(98);
  fs.writeFileSync(plugin + '/${slug}.php', 'partially updated registry release');
  process.exit(23);
}
`,
        { mode: 0o755 },
      );
      const result = spawnSync(
        process.execPath,
        [gq, "cms", "composer", action, `getquick/${slug}`],
        {
          cwd: root,
          env: {
            ...process.env,
            CI: "",
            COMPOSER_AUTH: "{}",
            COMPOSER_TEST_LOG: log,
            PATH: `${bin}:${process.env.PATH}`,
          },
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 23, result.stderr);
      assert.deepEqual(
        readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
        [
          [action, "--no-interaction", `getquick/${slug}`],
          ["dump-autoload", "--no-scripts"],
        ],
      );
      assert.equal(readlinkSync(plugin), source);
      assert.equal(readFileSync(join(source, `${slug}.php`), "utf8"), "local edits");
      assert.equal(
        readFileSync(join(state, `${slug}-release/${slug}.php`), "utf8"),
        "partially updated registry release",
      );
    });
  }
}

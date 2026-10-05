import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { composerInstall } from "../../src/cms/local.mjs";
import {
  localDesignOverride,
  syncLocalDesign,
  withDesignRegistryInstall,
  withLinkedLocalDesign,
} from "../../src/cms/local-design.mjs";
import { exec } from "../../src/exec.mjs";

function fixture(t) {
  // Real path: macOS's tmpdir() is a /var symlink to /private/var, and the
  // links under test store resolved paths.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "getquick-design-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cms = join(root, "apps/cms");
  const source = join(root, "design checkout");
  const plugin = join(cms, "web/app/plugins/getquick-design");
  const state = join(cms, ".local-plugins");
  const backup = join(state, "getquick-design-release");
  const config = join(state, "config.json");
  mkdirSync(source, { recursive: true });
  mkdirSync(plugin, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(source, "getquick-design.php"), "local edits");
  writeFileSync(join(plugin, "getquick-design.php"), "registry release");
  writeFileSync(config, JSON.stringify({ getquickDesign: source }));
  writeFileSync(join(root, "gq.ops.json"), "{}");
  return { root, cms, source, plugin, state, backup, config };
}

const local = { CI: "" };

function renamedFixture(t) {
  const f = fixture(t);
  syncLocalDesign(f.cms, local);
  const oldSource = join(f.root, "getquick-design");
  renameSync(f.source, oldSource);
  rmSync(f.plugin);
  symlinkSync(oldSource, f.plugin);
  const source = join(f.root, "gq-design");
  renameSync(oldSource, source);
  renameSync(join(source, "getquick-design.php"), join(source, "gq-design.php"));
  writeFileSync(f.config, JSON.stringify({ getquickDesign: source }));
  return { ...f, source, currentPlugin: join(f.cms, "web/app/plugins/gq-design") };
}

test("renamed checkout migrates the dangling old link without losing the registry backup", (t) => {
  const f = renamedFixture(t);
  assert.equal(syncLocalDesign(f.cms, local), true);
  assert.equal(readlinkSync(f.currentPlugin), f.source);
  assert.equal(existsSync(f.plugin), false);
  assert.equal(readFileSync(join(f.backup, "getquick-design.php"), "utf8"), "registry release");
  assert.equal(readFileSync(join(f.source, "gq-design.php"), "utf8"), "local edits");
  assert.equal(syncLocalDesign(f.cms, local), true);
  assert.equal(existsSync(join(f.cms, ".ddev/docker-compose.getquick-design.local.yaml")), false);
  assert.equal(existsSync(join(f.cms, ".ddev/config.getquick-design.local.yaml")), false);
  const compose = readFileSync(join(f.cms, ".ddev/docker-compose.gq-design.local.yaml"), "utf8");
  assert.ok(compose.includes(`source: ${JSON.stringify(f.source)}`));
  assert.ok(compose.includes(`target: ${JSON.stringify(f.source)}`));
  assert.match(compose, /read_only: true/u);
  const hooks = readFileSync(join(f.cms, ".ddev/config.gq-design.local.yaml"), "utf8");
  assert.match(hooks, /gq cms design\n/u);
  assert.match(hooks, /gq cms design refresh\n/u);
});

test("a partial backup copy failure preserves the intact release and relinks the checkout", (t) => {
  const f = renamedFixture(t);
  writeFileSync(join(f.backup, "extra.php"), "complete release");
  const module = new URL("../../src/cms/local-design.mjs", import.meta.url).href;
  const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
fs.cpSync = (_source, destination) => {
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(join(destination, 'getquick-design.php'), 'partial copy');
  throw new Error('injected copy failure');
};
syncBuiltinESMExports();
const { withDesignRegistryInstall } = await import(${JSON.stringify(module)});
let invoked = false;
let refreshed = false;
await assert.rejects(withDesignRegistryInstall(${JSON.stringify(f.cms)}, () => {
  invoked = true;
}, { env: { CI: '' }, afterRelink: () => { refreshed = true; } }), /injected copy failure/);
assert.equal(invoked, false);
assert.equal(refreshed, true);
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(f.backup, "getquick-design.php"), "utf8"), "registry release");
  assert.equal(readFileSync(join(f.backup, "extra.php"), "utf8"), "complete release");
  assert.equal(existsSync(f.plugin), false);
  assert.equal(readlinkSync(f.currentPlugin), f.source);
  assert.equal(readFileSync(join(f.source, "gq-design.php"), "utf8"), "local edits");
});

test("new and legacy config keys support either checkout entrypoint without rewriting config", (t) => {
  const f = fixture(t);
  for (const key of ["gqDesign", "getquickDesign"]) {
    const config = JSON.stringify({ [key]: f.source });
    writeFileSync(f.config, config);
    assert.equal(localDesignOverride(f.cms, local).slug, "getquick-design");
    renameSync(join(f.source, "getquick-design.php"), join(f.source, "gq-design.php"));
    const override = localDesignOverride(f.cms, local);
    assert.equal(override.slug, "gq-design");
    assert.equal(override.plugin, join(f.cms, "web/app/plugins/gq-design"));
    assert.equal(override.backup, join(f.state, "gq-design-release"));
    assert.equal(readFileSync(f.config, "utf8"), config);
    renameSync(join(f.source, "gq-design.php"), join(f.source, "getquick-design.php"));
  }
  writeFileSync(f.config, JSON.stringify({ gqDesign: f.source, getquickDesign: f.source }));
  assert.equal(localDesignOverride(f.cms, local).source, f.source);
  writeFileSync(f.config, JSON.stringify({ gqDesign: f.source, getquickDesign: "/different" }));
  assert.throws(() => syncLocalDesign(f.cms, local), /conflicting/u);
  assert.equal(lstatSync(f.plugin).isSymbolicLink(), false);
});

test("package rename keeps separate releases and restores both slugs before subsequent installs", async (t) => {
  const f = renamedFixture(t);
  const currentBackup = join(f.state, "gq-design-release");
  await withDesignRegistryInstall(
    f.cms,
    () => {
      assert.equal(lstatSync(f.plugin).isDirectory(), true);
      assert.equal(existsSync(f.currentPlugin), false);
      assert.equal(readFileSync(join(f.plugin, "getquick-design.php"), "utf8"), "registry release");
      rmSync(f.plugin, { recursive: true }); // Composer removes getquick/getquick-design.
      mkdirSync(f.currentPlugin);
      writeFileSync(join(f.currentPlugin, "gq-design.php"), "new registry release");
    },
    {
      env: local,
      afterRelink: (override) => {
        assert.equal(override.plugin, f.currentPlugin);
        assert.equal(readlinkSync(f.currentPlugin), f.source);
        assert.throws(() => syncLocalDesign(f.cms, local), /Another local Design operation/u);
      },
    },
  );
  assert.equal(existsSync(f.plugin), false);
  assert.equal(readFileSync(join(f.backup, "getquick-design.php"), "utf8"), "registry release");
  assert.equal(readFileSync(join(currentBackup, "gq-design.php"), "utf8"), "new registry release");
  await withDesignRegistryInstall(
    f.cms,
    () => {
      for (const plugin of [f.plugin, f.currentPlugin]) {
        assert.equal(lstatSync(plugin).isDirectory(), true);
        assert.equal(lstatSync(plugin).isSymbolicLink(), false);
      }
      writeFileSync(join(f.currentPlugin, "gq-design.php"), "updated registry release");
    },
    { env: local },
  );
  assert.equal(
    readFileSync(join(currentBackup, "gq-design.php"), "utf8"),
    "updated registry release",
  );
  assert.equal(readFileSync(join(f.source, "gq-design.php"), "utf8"), "local edits");
  assert.equal(existsSync(f.plugin), false);
});

for (const partial of [false, true]) {
  test(`a failed rename install retains the old release after removal (partial new package=${partial})`, async (t) => {
    const f = renamedFixture(t);
    const failure = new Error("rename failed");
    let refreshed = false;
    await assert.rejects(
      withDesignRegistryInstall(
        f.cms,
        () => {
          rmSync(f.plugin, { recursive: true });
          if (partial) {
            mkdirSync(f.currentPlugin);
            writeFileSync(join(f.currentPlugin, "gq-design.php"), "partial registry release");
          }
          throw failure;
        },
        {
          env: local,
          afterRelink: () => {
            assert.equal(readlinkSync(f.currentPlugin), f.source);
            refreshed = true;
          },
        },
      ),
      (error) => error === failure,
    );
    assert.equal(refreshed, true);
    assert.equal(readFileSync(join(f.backup, "getquick-design.php"), "utf8"), "registry release");
    assert.equal(existsSync(f.plugin), false);
    assert.equal(readFileSync(join(f.source, "gq-design.php"), "utf8"), "local edits");
    if (partial) {
      assert.equal(
        readFileSync(join(f.state, "gq-design-release/gq-design.php"), "utf8"),
        "partial registry release",
      );
    }
  });
}

test("a failed install deleting both restored directories retains both registry backups", async (t) => {
  const f = renamedFixture(t);
  mkdirSync(f.currentPlugin);
  writeFileSync(join(f.currentPlugin, "gq-design.php"), "new registry release");
  syncLocalDesign(f.cms, local);
  await assert.rejects(
    withDesignRegistryInstall(
      f.cms,
      () => {
        rmSync(f.plugin, { recursive: true });
        rmSync(f.currentPlugin, { recursive: true });
        throw new Error("both removed before failure");
      },
      { env: local },
    ),
    /both removed before failure/u,
  );
  assert.equal(readlinkSync(f.currentPlugin), f.source);
  assert.equal(existsSync(f.plugin), false);
  assert.equal(readFileSync(join(f.backup, "getquick-design.php"), "utf8"), "registry release");
  assert.equal(
    readFileSync(join(f.state, "gq-design-release/gq-design.php"), "utf8"),
    "new registry release",
  );
  assert.equal(readFileSync(join(f.source, "gq-design.php"), "utf8"), "local edits");
});

test("rolling the checkout and package back restores the legacy link without discarding either release", async (t) => {
  const f = renamedFixture(t);
  mkdirSync(f.currentPlugin);
  writeFileSync(join(f.currentPlugin, "gq-design.php"), "new registry release");
  syncLocalDesign(f.cms, local);
  const legacySource = join(f.root, "getquick-design");
  renameSync(f.source, legacySource);
  renameSync(join(legacySource, "gq-design.php"), join(legacySource, "getquick-design.php"));
  writeFileSync(f.config, JSON.stringify({ gqDesign: legacySource }));
  await withDesignRegistryInstall(
    f.cms,
    () => {
      assert.equal(lstatSync(f.currentPlugin).isDirectory(), true);
      assert.equal(lstatSync(f.plugin).isDirectory(), true);
      rmSync(f.currentPlugin, { recursive: true });
      writeFileSync(join(f.plugin, "getquick-design.php"), "rolled back release");
    },
    { env: local },
  );
  assert.equal(readlinkSync(f.plugin), legacySource);
  assert.equal(existsSync(f.currentPlugin), false);
  assert.equal(readFileSync(join(f.backup, "getquick-design.php"), "utf8"), "rolled back release");
  assert.equal(
    readFileSync(join(f.state, "gq-design-release/gq-design.php"), "utf8"),
    "new registry release",
  );
  assert.equal(readFileSync(join(legacySource, "getquick-design.php"), "utf8"), "local edits");
  assert.equal(syncLocalDesign(f.cms, local), true);
});

test("startup links the checkout, preserves the release, and generates local DDEV files", (t) => {
  const f = fixture(t);
  assert.equal(syncLocalDesign(f.cms, local), true);
  assert.equal(readlinkSync(f.plugin), f.source);
  assert.equal(readFileSync(join(f.backup, "getquick-design.php"), "utf8"), "registry release");
  const compose = readFileSync(
    join(f.cms, ".ddev/docker-compose.getquick-design.local.yaml"),
    "utf8",
  );
  assert.ok(compose.includes(`source: ${JSON.stringify(f.source)}`));
  assert.ok(compose.includes(`target: ${JSON.stringify(f.source)}`));
  assert.match(compose, /read_only: true/u);
  assert.match(
    readFileSync(join(f.cms, ".ddev/config.getquick-design.local.yaml"), "utf8"),
    /pre-start:[\s\S]*exec-host: \.\.\/\.\.\/node_modules\/\.bin\/gq cms design\n[\s\S]*post-start:[\s\S]*exec-host: \.\.\/\.\.\/node_modules\/\.bin\/gq cms design refresh\n/u,
  );
  assert.equal(syncLocalDesign(f.cms, local), true);
  assert.equal(readFileSync(join(f.source, "getquick-design.php"), "utf8"), "local edits");
});

test("Composer sees only the registry copy and its updated release is preserved after relinking", async (t) => {
  const f = fixture(t);
  syncLocalDesign(f.cms, local);
  const result = await withDesignRegistryInstall(
    f.cms,
    () => {
      assert.equal(lstatSync(f.plugin).isSymbolicLink(), false);
      // The fallback survives Composer deleting a package before failing.
      assert.equal(existsSync(f.backup), true);
      writeFileSync(join(f.plugin, "getquick-design.php"), "updated registry release");
      return 123;
    },
    { env: local },
  );
  assert.equal(result, 123);
  assert.equal(readlinkSync(f.plugin), f.source);
  assert.equal(
    readFileSync(join(f.backup, "getquick-design.php"), "utf8"),
    "updated registry release",
  );
  assert.equal(readFileSync(join(f.source, "getquick-design.php"), "utf8"), "local edits");
});

test("Composer failure relinks, refreshes metadata under the lock, and propagates the original error", async (t) => {
  const f = fixture(t);
  syncLocalDesign(f.cms, local);
  const failure = new Error("Composer failed");
  let refreshed = false;
  await assert.rejects(
    () =>
      withDesignRegistryInstall(
        f.cms,
        () => {
          throw failure;
        },
        {
          env: local,
          afterRelink: () => {
            assert.equal(readlinkSync(f.plugin), f.source);
            assert.throws(() => syncLocalDesign(f.cms, local), /Another local Design operation/u);
            refreshed = true;
          },
        },
      ),
    (error) => error === failure,
  );
  assert.equal(refreshed, true);
  assert.equal(syncLocalDesign(f.cms, local), true);
});

test("a failed first install that leaves no directory still restores the source link", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    () =>
      withDesignRegistryInstall(
        f.cms,
        () => {
          rmSync(f.plugin, { recursive: true });
          throw new Error("failed install");
        },
        { env: local },
      ),
    /failed install/u,
  );
  assert.equal(readlinkSync(f.plugin), f.source);
  assert.equal(readFileSync(join(f.source, "getquick-design.php"), "utf8"), "local edits");
  assert.equal(readFileSync(join(f.backup, "getquick-design.php"), "utf8"), "registry release");
});

test("CI ignores even a configured override and staging without opt-in stays untouched", async (t) => {
  const f = fixture(t);
  assert.equal(syncLocalDesign(f.cms, { CI: "true" }), false);
  assert.equal(
    await withDesignRegistryInstall(f.cms, () => "ci ran", { env: { CI: "true" } }),
    "ci ran",
  );
  assert.equal(lstatSync(f.plugin).isSymbolicLink(), false);
  assert.equal(existsSync(join(f.cms, ".ddev")), false);
  rmSync(f.config);
  assert.equal(syncLocalDesign(f.cms, local), false);
  assert.equal(
    await withDesignRegistryInstall(f.cms, () => "staging ran", { env: local }),
    "staging ran",
  );
  assert.equal(lstatSync(f.plugin).isSymbolicLink(), false);
});

test("a disabled or missing opt-in never hands an existing source symlink to Composer", async (t) => {
  const f = fixture(t);
  syncLocalDesign(f.cms, local);
  const action = () => assert.fail("Composer must not receive the source symlink");
  await assert.rejects(
    () => withDesignRegistryInstall(f.cms, action, { env: { CI: "true" } }),
    /without an active local override/u,
  );
  rmSync(f.config);
  await assert.rejects(
    () => withDesignRegistryInstall(f.cms, action, { env: local }),
    /without an active local override/u,
  );
  assert.equal(readlinkSync(f.plugin), f.source);
  assert.equal(readFileSync(join(f.source, "getquick-design.php"), "utf8"), "local edits");
});

test("invalid or missing source configuration cannot modify the installed plugin", (t) => {
  const f = fixture(t);
  writeFileSync(f.config, JSON.stringify({ getquickDesign: "relative/path" }));
  assert.throws(() => syncLocalDesign(f.cms, local), /absolute/u);
  writeFileSync(
    f.config,
    JSON.stringify({ getquickDesign: join(f.cms, "web/app/plugins/getquick-design") }),
  );
  assert.throws(() => syncLocalDesign(f.cms, local), /outside apps\/cms/u);
  writeFileSync(f.config, JSON.stringify({ getquickDesign: join(f.root, "missing") }));
  assert.throws(() => syncLocalDesign(f.cms, local), /ENOENT/u);
  assert.equal(lstatSync(f.plugin).isSymbolicLink(), false);
  assert.equal(readFileSync(join(f.plugin, "getquick-design.php"), "utf8"), "registry release");
});

test("unexpected symlinks and ambiguous backups are refused rather than overwritten", async (t) => {
  const f = fixture(t);
  mkdirSync(f.backup);
  assert.throws(() => syncLocalDesign(f.cms, local), /Both the installed/u);
  rmSync(f.plugin, { recursive: true });
  symlinkSync(join(f.root, "some-other-checkout"), f.plugin);
  await assert.rejects(
    () => withDesignRegistryInstall(f.cms, () => assert.fail("must not run"), { env: local }),
    /different plugin symlink/u,
  );
  assert.equal(readlinkSync(f.plugin), join(f.root, "some-other-checkout"));
});

test("symlinked destination ancestors cannot turn the checkout into a registry install", async (t) => {
  const f = fixture(t);
  const source = join(f.root, "getquick-design");
  renameSync(f.source, source);
  writeFileSync(f.config, JSON.stringify({ getquickDesign: source }));
  const plugins = join(f.cms, "web/app/plugins");
  rmSync(plugins, { recursive: true });
  symlinkSync(f.root, plugins);
  await assert.rejects(
    () => withDesignRegistryInstall(f.cms, () => assert.fail("must not run"), { env: local }),
    /unsafe local plugin ancestor/u,
  );
  assert.equal(readFileSync(join(source, "getquick-design.php"), "utf8"), "local edits");
  assert.equal(lstatSync(source).isSymbolicLink(), false);
});

for (const unsafe of [
  "live sibling",
  "unrelated dangling link",
  "unsafe new backup",
  "ambiguous new release",
  "DDEV symlink",
  "DDEV directory",
  "custom old hooks",
  "custom new hooks",
  "unverified rename",
]) {
  test(`rename migration refuses ${unsafe} before touching the legacy state`, (t) => {
    const f = renamedFixture(t);
    if (unsafe === "live sibling") mkdirSync(join(f.root, "getquick-design"));
    if (unsafe === "unrelated dangling link") {
      rmSync(f.plugin);
      symlinkSync(join(f.root, "unrelated"), f.plugin);
    }
    if (unsafe === "unsafe new backup") symlinkSync(f.source, join(f.state, "gq-design-release"));
    if (unsafe === "ambiguous new release") {
      mkdirSync(f.currentPlugin);
      mkdirSync(join(f.state, "gq-design-release"));
    }
    if (unsafe === "DDEV symlink") {
      symlinkSync(
        join(f.source, "gq-design.php"),
        join(f.cms, ".ddev/config.gq-design.local.yaml"),
      );
    }
    if (unsafe === "DDEV directory") {
      rmSync(join(f.cms, ".ddev"), { recursive: true });
      symlinkSync(f.source, join(f.cms, ".ddev"));
    }
    if (unsafe === "custom old hooks") {
      writeFileSync(
        join(f.cms, ".ddev/config.getquick-design.local.yaml"),
        "# Generated by someone else\n",
      );
    }
    if (unsafe === "custom new hooks") {
      writeFileSync(join(f.cms, ".ddev/config.gq-design.local.yaml"), "# My hooks\n");
    }
    if (unsafe === "unverified rename") rmSync(f.backup, { recursive: true });
    const oldTarget = readlinkSync(f.plugin);
    assert.throws(() => syncLocalDesign(f.cms, local), /Refusing|refusing/u);
    assert.equal(readlinkSync(f.plugin), oldTarget);
    if (unsafe !== "unverified rename") {
      assert.equal(readFileSync(join(f.backup, "getquick-design.php"), "utf8"), "registry release");
    }
    assert.equal(readFileSync(join(f.source, "gq-design.php"), "utf8"), "local edits");
    assert.equal(existsSync(join(f.state, "design-operation.lock")), false);
  });
}

for (const env of [local, { CI: "true" }]) {
  test(`a dangling gq-design symlink is protected without opt-in (CI=${env.CI})`, async (t) => {
    const f = fixture(t);
    rmSync(f.config);
    const plugin = join(f.cms, "web/app/plugins/gq-design");
    symlinkSync(join(f.root, "missing"), plugin);
    await assert.rejects(
      withDesignRegistryInstall(f.cms, () => assert.fail("Composer must not run"), { env }),
      /without an active local override/u,
    );
    assert.equal(lstatSync(plugin).isSymbolicLink(), true);
  });
}

test("startup recovers a dead owner only after its Composer child has also exited", (t) => {
  const f = fixture(t);
  const dead = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid;
  const lock = join(f.state, "design-operation.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: dead, host: hostname() }));
  writeFileSync(join(lock, "command.pid"), String(process.pid));
  assert.throws(() => syncLocalDesign(f.cms, local), /child is still alive/u);
  assert.equal(lstatSync(f.plugin).isSymbolicLink(), false);
  writeFileSync(join(lock, "command.pid"), String(dead));
  assert.equal(syncLocalDesign(f.cms, local), true);
  assert.equal(readlinkSync(f.plugin), f.source);
  assert.equal(existsSync(lock), false);
  assert.equal(readFileSync(join(f.source, "getquick-design.php"), "utf8"), "local edits");
});

test("DDEV autoload refresh holds the same lock as dependency changes", async (t) => {
  const f = fixture(t);
  await withLinkedLocalDesign(
    f.cms,
    async () => {
      assert.equal(readlinkSync(f.plugin), f.source);
      await assert.rejects(
        () => withDesignRegistryInstall(f.cms, () => assert.fail("must not run"), { env: local }),
        /Another local Design operation/u,
      );
    },
    local,
  );
  assert.equal(existsSync(join(f.state, "design-operation.lock")), false);
});

// db sync's composer.lock install, through the real exec and a fake host
// Composer.
test("composerInstall restores the link and fails with Composer's exit status", async (t) => {
  const f = fixture(t);
  syncLocalDesign(f.cms, local);
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  const log = join(f.root, "composer.log");
  writeFileSync(
    join(bin, "composer"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.COMPOSER_TEST_LOG, JSON.stringify(args) + '\\n');
const plugin = 'web/app/plugins/getquick-design';
if (args[0] === 'dump-autoload') {
  if (!fs.lstatSync(plugin).isSymbolicLink() || !fs.existsSync('.local-plugins/design-operation.lock')) process.exit(99);
} else {
  if (fs.lstatSync(plugin).isSymbolicLink()) process.exit(98);
  fs.writeFileSync(plugin + '/getquick-design.php', 'partially updated registry release');
  process.exit(23);
}
`,
    { mode: 0o755 },
  );
  await assert.rejects(
    composerInstall(f.cms, {
      exec,
      env: {
        ...process.env,
        CI: "",
        COMPOSER_AUTH: "{}",
        COMPOSER_TEST_LOG: log,
        PATH: `${bin}:${process.env.PATH}`,
      },
    }),
    /Composer failed \(exit 23\)/u,
  );
  assert.deepEqual(
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    [
      ["install", "--no-interaction"],
      ["dump-autoload", "--no-scripts"],
    ],
  );
  assert.equal(readlinkSync(f.plugin), f.source);
  assert.equal(readFileSync(join(f.source, "getquick-design.php"), "utf8"), "local edits");
  assert.equal(
    readFileSync(join(f.backup, "getquick-design.php"), "utf8"),
    "partially updated registry release",
  );
});

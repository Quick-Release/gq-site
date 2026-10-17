// gq cms: the site's local CMS (DDEV startup, Composer, the Design override's
// DDEV hooks), driven through run() against a fixture site with a recording
// exec standing in for sh, ddev and composer.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createFixtureSite, recordingExec } from "../support/fixture-site.mjs";

const GQ_BIN = fileURLToPath(new URL("../../bin/gq.mjs", import.meta.url));

const OPS = {
  schemaVersion: 1,
  project: "fixture",
  variant: "content",
  media: { bucket: "fixture-media", domain: "media.example.test" },
};

const ENV_EXAMPLE = "WP_ENV='local'\nWP_HOME='https://fixture-admin.ddev.site'\n";

const DESCRIBE = {
  raw: {
    status: "running",
    primary_url: "https://fixture-admin.ddev.site",
    dbinfo: { host: "db", dbname: "db", username: "db", password: "db" },
  },
};

async function site(files = {}) {
  return createFixtureSite({
    ops: OPS,
    files: { "apps/cms/.env.example": ENV_EXAMPLE, ...files },
  });
}

// `installed` names the commands `command -v` finds; `ddev describe -j`
// answers `describe` (null: DDEV can't describe the project); `codes` maps a
// command line to its exit code.
function fakeTools({ installed = ["ddev", "composer"], describe = DESCRIBE, codes = {} } = {}) {
  return recordingExec((call) => {
    if (isLookup(call)) return { code: installed.includes(call.args.at(-1)) ? 0 : 1 };
    const [command, ...args] = commandLine(call);
    if (command === "ddev" && args.join(" ") === "describe -j") {
      return describe ? { stdout: JSON.stringify(describe) } : { code: 1 };
    }
    const code = codes[[command, ...args].join(" ")];
    return code === undefined ? {} : { code };
  });
}

function isLookup({ command, args }) {
  return command === "sh" && args[1].startsWith("command -v");
}

// A command run under the Design override's PID-recording `sh -c` wrapper,
// as the command it wraps.
function commandLine({ command, args }) {
  return command === "sh" && args[1].startsWith("printf") ? args.slice(4) : [command, ...args];
}

// The calls that do something: everything except `command -v` and describe.
function actions(exec) {
  return exec.calls
    .filter((call) => !isLookup(call))
    .map(commandLine)
    .filter((line) => line.join(" ") !== "ddev describe -j");
}

async function withDesignOverride(fixture, slug = "getquick-design") {
  const source = fixture.path("design checkout");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, `${slug}.php`), "local edits");
  await mkdir(fixture.path(`apps/cms/web/app/plugins/${slug}`), { recursive: true });
  await mkdir(fixture.path("apps/cms/.local-plugins"), { recursive: true });
  await writeFile(
    fixture.path("apps/cms/.local-plugins/config.json"),
    JSON.stringify({ getquickDesign: source }),
  );
  return source;
}

test("gq cms start --foreground starts DDEV in apps/cms and points apps/cms/.env at it", async () => {
  const fixture = await site();
  const exec = fakeTools();
  const result = await fixture.run(["cms", "start", "--foreground", "--skip-confirmation"], {
    env: { CI: "" },
    exec,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(actions(exec), [["ddev", "start", "--skip-confirmation"]]);
  const start = exec.calls.findIndex(({ args }) => args[0] === "start");
  assert.equal(exec.calls[start].cwd, fixture.path("apps/cms"));
  assert.equal(exec.options[start].stdio, "inherit");
  const env = await readFile(fixture.path("apps/cms/.env"), "utf8");
  assert.match(env, /WP_HOME='https:\/\/fixture-admin.ddev.site'/u);
  assert.match(env, /S3_UPLOADS_BUCKET_URL='https:\/\/media.example.test'/u);
  assert.match(result.stdout, /Created apps\/cms\/.env from .env.example/u);
  assert.match(result.stdout, /WordPress: https:\/\/fixture-admin.ddev.site\/wp\/wp-admin/u);
  assert.equal(existsSync(fixture.path("apps/cms/.local-plugins/ddev-start.json")), false);
});

test("gq cms start --foreground fails with DDEV's exit code and leaves .env alone", async () => {
  const fixture = await site();
  const exec = fakeTools({ codes: { "ddev start": 7 } });
  const result = await fixture.run(["cms", "start", "--foreground"], { env: { CI: "" }, exec });
  assert.equal(result.code, 7);
  assert.match(result.stderr, /DDEV start failed \(exit 7\)/u);
  assert.equal(existsSync(fixture.path("apps/cms/.env")), false);
});

test("gq cms start needs DDEV installed", async () => {
  const fixture = await site();
  const exec = fakeTools({ installed: ["composer"] });
  const result = await fixture.run(["cms", "start", "--foreground"], { env: { CI: "" }, exec });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /DDEV is required/u);
  assert.deepEqual(actions(exec), []);
});

test("DDEV startup links the renamed Design checkout first, with hooks that run this site's gq", async () => {
  const fixture = await site();
  const source = await withDesignOverride(fixture, "gq-design");
  const exec = fakeTools();
  const result = await fixture.run(["cms", "start", "--foreground"], { env: { CI: "" }, exec });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readlink(fixture.path("apps/cms/web/app/plugins/gq-design")), source);
  const hooks = await readFile(fixture.path("apps/cms/.ddev/config.gq-design.local.yaml"), "utf8");
  assert.match(
    hooks,
    /pre-start:\n {4}- exec-host: \.\.\/\.\.\/node_modules\/\.bin\/gq cms design\n/u,
  );
  assert.match(
    hooks,
    /post-start:\n {4}- exec-host: \.\.\/\.\.\/node_modules\/\.bin\/gq cms design refresh\n/u,
  );
  assert.doesNotMatch(hooks, /scripts\//u);
});

test("gq cms start launches a detached gq worker and returns before DDEV is ready", async () => {
  const fixture = await site();
  const exec = recordingExec(({ command, args }) => {
    if (command === process.execPath) return { pid: 4242 };
    if (command === "sh") return { code: 0 };
    if (args.join(" ") === "describe -j") return { stdout: JSON.stringify(DESCRIBE) };
    return {};
  });
  const result = await fixture.run(["cms", "start", "--skip-confirmation"], {
    env: { CI: "", PATH: "/fake/bin" },
    exec,
  });
  assert.equal(result.code, 0, result.stderr);

  const launch = exec.calls.findIndex(({ command }) => command === process.execPath);
  const status = JSON.parse(
    await readFile(fixture.path("apps/cms/.local-plugins/ddev-start.json"), "utf8"),
  );
  assert.deepEqual(exec.calls[launch].args, [
    GQ_BIN,
    "cms",
    "start",
    "--background-job",
    status.id,
    "--skip-confirmation",
  ]);
  assert.equal(exec.calls[launch].cwd, fixture.path("apps/cms"));
  assert.equal(exec.calls[launch].env.PATH, "/fake/bin");
  assert.deepEqual(exec.options[launch].background, {
    log: fixture.path("apps/cms/.local-plugins/ddev-start.log"),
  });
  assert.equal(status.pid, 4242);
  assert.equal(status.phase, "starting");
  // Nothing but the worker touches DDEV's services.
  assert.deepEqual(
    actions(exec).filter(([command]) => command === "ddev"),
    [],
  );
  assert.match(result.stdout, /Fixture CMS/u);
  assert.match(result.stdout, /launched in background \(PID 4242\)/u);
  assert.match(result.stdout, /Admin {4}https:\/\/fixture-admin.ddev.site\/wp\/wp-admin\//u);
  assert.match(result.stdout, /GraphQL {2}https:\/\/fixture-admin.ddev.site\/wp\/graphql/u);
  assert.match(result.stdout, /Status {4}gq cms status/u);
  assert.match(result.stdout, /Log {7}apps\/cms\/.local-plugins\/ddev-start.log/u);
});

test("gq cms status reports no job, then a failed one with its message and exit 1", async () => {
  const fixture = await site();
  const none = await fixture.run(["cms", "status"]);
  assert.equal(none.code, 0, none.stderr);
  assert.match(none.stdout, /No background DDEV startup recorded\./u);
  assert.match(none.stdout, /Log: .*apps\/cms\/.local-plugins\/ddev-start.log/u);

  await mkdir(fixture.path("apps/cms/.local-plugins"), { recursive: true });
  await writeFile(
    fixture.path("apps/cms/.local-plugins/ddev-start.json"),
    JSON.stringify({ id: "job", pid: 99, phase: "failed", message: "DDEV start failed (exit 7)." }),
  );
  const failed = await fixture.run(["cms", "status"]);
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /Last DDEV startup: failed \(PID 99\)/u);
  assert.match(failed.stdout, /DDEV start failed \(exit 7\)\./u);
});

test("gq cms stop and describe pass their arguments to DDEV in apps/cms", async () => {
  const fixture = await site();
  const exec = fakeTools();
  assert.equal((await fixture.run(["cms", "stop", "--unlist"], { exec })).code, 0);
  assert.equal((await fixture.run(["cms", "describe"], { exec })).code, 0);
  assert.deepEqual(actions(exec), [
    ["ddev", "stop", "--unlist"],
    ["ddev", "describe"],
  ]);
  assert.ok(
    exec.calls
      .filter(({ command }) => command === "ddev")
      .every(({ cwd }) => cwd === fixture.path("apps/cms")),
  );
});

test("gq cms rejects an unknown action or a stray background job flag", async () => {
  const fixture = await site();
  const unknown = await fixture.run(["cms", "restart"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /gq cms start/u);
  const stray = await fixture.run(["cms", "stop", "--background-job", "id"], {
    exec: fakeTools(),
  });
  assert.equal(stray.code, 1);
  assert.match(stray.stderr, /Invalid background startup job/u);
});

test("gq cms composer update changes dependencies with the host Composer and the registry login", async () => {
  const fixture = await site();
  const exec = fakeTools();
  const result = await fixture.run(["cms", "composer", "update", "getquick/gq-design"], {
    env: { CI: "", COMPOSER_AUTH: "{}" },
    exec,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(actions(exec), [
    ["composer", "update", "--no-interaction", "getquick/gq-design"],
  ]);
  assert.equal(exec.calls.at(-1).cwd, fixture.path("apps/cms"));
  assert.equal(exec.calls.at(-1).env.COMPOSER_AUTH, "{}");
});

test("gq cms composer install relinks a local Design checkout and keeps Composer's exit code", async () => {
  const fixture = await site();
  const source = await withDesignOverride(fixture);
  const exec = fakeTools({ codes: { "composer install --no-interaction": 23 } });
  const result = await fixture.run(["cms", "composer", "install"], {
    env: { CI: "", COMPOSER_AUTH: "{}" },
    exec,
  });
  assert.equal(result.code, 23);
  assert.match(result.stderr, /Composer failed \(exit 23\)/u);
  assert.deepEqual(actions(exec), [
    ["composer", "install", "--no-interaction"],
    ["composer", "dump-autoload", "--no-scripts"],
  ]);
  assert.equal(await readlink(fixture.path("apps/cms/web/app/plugins/getquick-design")), source);
});

test("gq cms composer install refuses to run without the registry login", async () => {
  const fixture = await site();
  const exec = fakeTools();
  const result = await fixture.run(["cms", "composer", "install"], { env: { CI: "" }, exec });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /COMPOSER_AUTH is missing/u);
  assert.deepEqual(actions(exec), []);
});

test("gq cms composer reinstall rebuilds autoloads to run dependency patches and propagates failure", async () => {
  const fixture = await site();
  for (const code of [0, 19]) {
    const exec = fakeTools({ codes: { "composer dump-autoload --no-interaction": code } });
    const result = await fixture.run(
      ["cms", "composer", "reinstall", "wp-plugin/wpgraphql-blocks"],
      {
        env: { CI: "", COMPOSER_AUTH: "{}" },
        exec,
      },
    );
    assert.equal(result.code, code, result.stderr);
    assert.deepEqual(actions(exec), [
      ["composer", "reinstall", "--no-interaction", "wp-plugin/wpgraphql-blocks"],
      ["composer", "dump-autoload", "--no-interaction"],
    ]);
  }
});

test("gq cms composer lint runs in a running DDEV, else the host Composer, else a started DDEV", async () => {
  const running = fakeTools();
  const fixture = await site();
  assert.equal((await fixture.run(["cms", "composer", "lint"], { exec: running })).code, 0);
  assert.deepEqual(actions(running), [["ddev", "composer", "lint"]]);

  const stopped = fakeTools({ describe: { raw: { ...DESCRIBE.raw, status: "stopped" } } });
  const host = await fixture.run(["cms", "composer", "test", "--filter", "x"], { exec: stopped });
  assert.equal(host.code, 0, host.stderr);
  assert.match(host.stdout, /using the host Composer/u);
  assert.deepEqual(actions(stopped), [["composer", "test", "--filter", "x"]]);

  const ddevOnly = fakeTools({ installed: ["ddev"], describe: null });
  const started = await fixture.run(["cms", "composer", "lint"], {
    env: { CI: "" },
    exec: ddevOnly,
  });
  assert.equal(started.code, 0, started.stderr);
  assert.deepEqual(actions(ddevOnly), [
    ["ddev", "start"],
    ["ddev", "composer", "lint"],
  ]);

  const failing = fakeTools({ codes: { "ddev composer lint": 2 } });
  assert.equal((await fixture.run(["cms", "composer", "lint"], { exec: failing })).code, 2);
});

test("gq cms composer gives up without Composer or DDEV, and rejects unknown actions", async () => {
  const fixture = await site();
  const none = await fixture.run(["cms", "composer", "lint"], {
    exec: fakeTools({ installed: [] }),
  });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /Neither Composer nor DDEV is installed/u);

  const unknown = await fixture.run(["cms", "composer", "require", "x"], { exec: fakeTools() });
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /install, update, reinstall, test, lint, lint:fix/u);
});

test("gq cms design links the renamed checkout, and refresh rebuilds DDEV's autoload under the lock", async () => {
  const fixture = await site();
  const source = await withDesignOverride(fixture, "gq-design");
  const exec = fakeTools();
  const linked = await fixture.run(["cms", "design"], {
    cwd: fixture.path("apps/cms"),
    env: { CI: "" },
    exec,
  });
  assert.equal(linked.code, 0, linked.stderr);
  assert.match(linked.stdout, /Local source linked/u);
  assert.equal(await readlink(fixture.path("apps/cms/web/app/plugins/gq-design")), source);

  const refreshed = await fixture.run(["cms", "design", "refresh"], {
    cwd: fixture.path("apps/cms"),
    env: { CI: "" },
    exec,
  });
  assert.equal(refreshed.code, 0, refreshed.stderr);
  assert.deepEqual(actions(exec), [["ddev", "exec", "composer", "dump-autoload", "--no-scripts"]]);
  assert.equal(existsSync(fixture.path("apps/cms/.local-plugins/design-operation.lock")), false);
});

test("gq cms design does nothing without an opt-in, and CI never links", async () => {
  const fixture = await site();
  await withDesignOverride(fixture);
  const exec = fakeTools();
  const ci = await fixture.run(["cms", "design"], { env: { CI: "1" }, exec });
  assert.equal(ci.code, 0, ci.stderr);
  assert.equal(ci.stdout, "");
  const refresh = await fixture.run(["cms", "design", "refresh"], { env: { CI: "1" }, exec });
  assert.equal(refresh.code, 0, refresh.stderr);
  assert.deepEqual(exec.calls, []);
  const extra = await fixture.run(["cms", "design", "other"], { exec });
  assert.equal(extra.code, 1);
});

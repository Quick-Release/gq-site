// The CMS's PHP error log (apps/cms/config/application.php): a request's
// warnings go to the site's logs/php-error.log, never to the FastCGI stderr
// stream nginx reads into its header buffer (a 502 once it overflows). Runs
// the generated config under php-cgi, whose error logging without error_log
// is PHP-FPM's: the SAPI's stderr on the FastCGI stream.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createFixtureSite } from "../support/fixture-site.mjs";
import { deploy } from "../support/deploy-script.mjs";
import { readSite } from "../support/generated-site.mjs";

const ACME = {
  schemaVersion: 1,
  project: "acme-shop",
  variant: "content",
  wordpress: { plugins: ["wp-graphql"] },
};

const phpCgi = spawnSync("php-cgi", ["-v"], { encoding: "utf8" });
const skip = phpCgi.status === 0 ? false : "php-cgi is not installed";

// Just enough of roots/wp-config and oscarotero/env for application.php.
const STUBS = `<?php
namespace Roots\\WPConfig {
    class Config {
        private static $values = [];
        public static function define($key, $value) { self::$values[$key] = $value; }
        public static function get($key) { return self::$values[$key] ?? null; }
        public static function apply() {}
    }
}
namespace Env {
    class Env {
        const CONVERT_BOOL = 1;
        const CONVERT_NULL = 2;
        const CONVERT_INT = 4;
        const STRIP_QUOTES = 8;
        const LOCAL_FIRST = 16;
        public static $options = 0;
    }
    function env($name) {
        $value = getenv($name);
        return $value === false ? null : $value;
    }
}
`;

// A request (php-cgi) or WP-CLI (php) through the generated config, in a Ploi
// site directory, that hits an undefined array key. Resolves to the process's
// stderr and the site's logs/php-error.log (undefined when absent).
async function request(script, { sapi = "php-cgi", logs = true, env = {} } = {}) {
  const fixture = await createFixtureSite({ ops: ACME });
  assert.equal((await fixture.run(["sync"])).code, 0);
  const site = join(fixture.root, "ploi-site");
  const cms = join(site, "apps/cms");
  await mkdir(join(cms, "config"), { recursive: true });
  await writeFile(
    join(cms, "config/application.php"),
    await readSite(fixture.root, "apps/cms/config/application.php"),
  );
  await writeFile(join(cms, "stubs.php"), STUBS);
  await writeFile(
    join(cms, "index.php"),
    `<?php\nrequire __DIR__ . '/stubs.php';\nrequire __DIR__ . '/config/application.php';\n${script}\n`,
  );
  if (logs) await mkdir(join(site, "logs"));
  // php.ini-production's logging (Ploi's): every error logged, none shown.
  const ini = ["-d", "error_reporting=32767", "-d", "log_errors=1", "-d", "display_errors=0"];
  const result = spawnSync(sapi, ["-n", ...ini, "index.php"], {
    cwd: cms,
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    log: await readFile(join(site, "logs/php-error.log"), "utf8").catch(() => undefined),
  };
}

const WARNING = `$attributes = []; echo $attributes['width'] ?? '', 'ok', $attributes['height'];`;

test("a request's warnings go to logs/php-error.log, not FastCGI stderr", { skip }, async () => {
  const result = await request(WARNING);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /ok/u);
  assert.doesNotMatch(result.stdout, /Undefined array key/u);
  assert.doesNotMatch(result.stderr, /Undefined array key/u);
  assert.match(result.log, /Warning: {2}Undefined array key "height"/u);
});

test("without the logs directory, PHP's default (stderr) stays", { skip }, async () => {
  // The baseline the config replaces: what nginx received before.
  const result = await request(WARNING, { logs: false });

  assert.equal(result.log, undefined);
  assert.match(result.stderr, /Undefined array key "height"/u);
});

test("PHP_ERROR_LOG names another file", { skip }, async () => {
  const fixture = await createFixtureSite({ ops: ACME });
  const other = join(fixture.root, "elsewhere.log");
  const result = await request(WARNING, { env: { PHP_ERROR_LOG: other } });

  assert.equal(result.log, undefined);
  assert.doesNotMatch(result.stderr, /Undefined array key/u);
  assert.match(await readFile(other, "utf8"), /Undefined array key "height"/u);
});

test("WP-CLI and development keep PHP's own error output", { skip }, async () => {
  const cli = await request(WARNING, { sapi: "php" });
  assert.equal(cli.log, undefined);
  assert.match(cli.stderr + cli.stdout, /Undefined array key "height"/u);

  const development = await request(WARNING, { env: { WP_ENV: "development" } });
  assert.equal(development.log, undefined);
});

test("the deploy creates the logs directory and rotates a large error log", async () => {
  const fixture = await createFixtureSite({ ops: ACME });
  assert.equal((await fixture.run(["sync"])).code, 0);
  const script = await readSite(fixture.root, "deploy/ploi/admin.sh");

  const fresh = await deploy(script);
  assert.equal(fresh.code, 0, fresh.output);
  assert.ok((await stat(join(fresh.site, "logs"))).isDirectory());
  assert.doesNotMatch(fresh.output, /Rotated/u);

  const small = await deploy(script, { siteFiles: { "logs/php-error.log": "old warning\n" } });
  assert.equal(small.code, 0, small.output);
  assert.equal(await readFile(join(small.site, "logs/php-error.log"), "utf8"), "old warning\n");

  const large = await deploy(script, {
    siteFiles: { "logs/php-error.log": "", "logs/php-error.log.1": "older\n" },
    before: (site) => truncate(join(site, "logs/php-error.log"), 64 * 1024 * 1024 + 1),
  });
  assert.equal(large.code, 0, large.output);
  assert.match(large.stdout, /Rotated logs\/php-error\.log/u);
  await assert.rejects(readFile(join(large.site, "logs/php-error.log")), { code: "ENOENT" });
  assert.equal(
    (await readFile(join(large.site, "logs/php-error.log.1"))).length,
    64 * 1024 * 1024 + 1,
  );
});

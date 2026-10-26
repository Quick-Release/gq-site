#!/usr/bin/env node
//
// The CMS's REST gate on a real WordPress (see cms-rest-gate.sh): a generated
// content site's content-api.php as a must-use plugin of a real WordPress on
// SQLite, served over HTTP by PHP's built-in server. A stand-in registers
// Gravity Forms' submission, form and entry routes with no permission check
// of their own, and gq-content's forms module's `active()`, switched by an
// option. Anonymously, with Gravity Forms active, only a POST to
// /gf/v2/forms/<id>/submissions reaches its route, by pretty permalink or
// ?rest_route=; the REST index, reading a form or its entries, a method
// override and every other route are 401 rest_auth_required. With Gravity
// Forms inactive, the submission is closed too; a signed-in user's requests
// are WordPress's own business.
//
//   node scripts/smoke/cms-rest-gate.mjs <generated site directory> <download cache>

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { checker, freePort, run } from "./frontend-runtime-lib.mjs";

const site = resolve(process.argv[2] ?? ".");
const cache = resolve(process.argv[3] ?? ".");
const work = mkdtempSync(join(tmpdir(), "gq-cms-rest-gate-"));
const wordpress = join(work, "wordpress");
const bin = join(work, "bin");

const results = checker();
const { check } = results;

// Gravity Forms' REST routes as far as the gate is concerned, each open to
// anyone and answering which it is; and gq-content's forms check.
const STAND_IN = `<?php
namespace GetQuick\\Content\\Forms {
    function active(): bool { return get_option('stand_in_gravity_forms') === 'active'; }
}
namespace {
    add_action('rest_api_init', static function (): void {
        $route = static fn (string $name) => static fn () => new WP_REST_Response(['route' => $name]);
        register_rest_route('gf/v2', '/forms/(?P<id>\\d+)/submissions', ['methods' => 'POST', 'callback' => $route('submission'), 'permission_callback' => '__return_true']);
        register_rest_route('gf/v2', '/forms/(?P<id>\\d+)', ['methods' => 'GET', 'callback' => $route('form'), 'permission_callback' => '__return_true']);
        register_rest_route('gf/v2', '/forms/(?P<id>\\d+)/entries', ['methods' => 'GET, POST', 'callback' => $route('entries'), 'permission_callback' => '__return_true']);
    });
}
`;

function setUpWordPress() {
  const unzip = (archive, into) => {
    const result = spawnSync("unzip", ["-q", "-o", join(cache, archive), "-d", into]);
    if (result.status !== 0) throw new Error(`unzip ${archive} failed`);
  };
  unzip(`wordpress-${process.env.WORDPRESS_VERSION}.zip`, work);
  const plugins = join(wordpress, "wp-content/plugins");
  unzip("sqlite-database-integration.zip", plugins);
  const mu = join(wordpress, "wp-content/mu-plugins");
  mkdirSync(mu);
  copyFileSync(
    join(site, "apps/cms/web/app/mu-plugins/content-api.php"),
    join(mu, "content-api.php"),
  );
  writeFileSync(join(mu, "gravity-forms-stand-in.php"), STAND_IN);
  writeFileSync(
    join(work, "router.php"),
    `<?php $path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($path !== '/' && is_file($_SERVER['DOCUMENT_ROOT'] . $path)) { return false; }
$_SERVER['SCRIPT_NAME'] = '/index.php';
require $_SERVER['DOCUMENT_ROOT'] . '/index.php';\n`,
  );
  const sqlite = join(plugins, "sqlite-database-integration");
  writeFileSync(
    join(wordpress, "wp-content/db.php"),
    readFileSync(join(sqlite, "db.copy"), "utf8")
      .replaceAll("{SQLITE_IMPLEMENTATION_FOLDER_PATH}", sqlite)
      .replaceAll("{SQLITE_PLUGIN}", "sqlite-database-integration/load.php"),
  );
  mkdirSync(bin);
  writeFileSync(
    join(bin, "wp"),
    `#!/bin/sh\nexec php -d display_errors=stderr -d error_reporting=${32767 & ~8192 & ~16384} -d memory_limit=512M ${JSON.stringify(join(cache, "wp-cli.phar"))} --path=${JSON.stringify(wordpress)} "$@"\n`,
  );
  chmodSync(join(bin, "wp"), 0o755);
}

async function wp(args) {
  const result = await run(join(bin, "wp"), args, {
    env: { ...process.env, WP_CLI_CACHE_DIR: join(work, "wp-cli-cache") },
  });
  if (result.code !== 0) throw new Error(`wp ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

async function serveWordPress(port) {
  const server = spawn(
    "php",
    [
      "-d",
      "display_errors=stderr",
      "-S",
      `127.0.0.1:${port}`,
      "-t",
      wordpress,
      join(work, "router.php"),
    ],
    { stdio: "ignore" },
  );
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/wp-includes/version.php`);
      return server;
    } catch {
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  server.kill();
  throw new Error("PHP's built-in server didn't start");
}

let server;
try {
  setUpWordPress();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  await wp([
    "config",
    "create",
    "--dbname=wordpress",
    "--dbuser=wordpress",
    "--dbpass=wordpress",
    "--skip-check",
  ]);
  await wp([
    "core",
    "install",
    `--url=${origin}`,
    "--title=Test",
    "--admin_user=editor",
    "--admin_password=editor-password",
    "--admin_email=editor@example.test",
    "--skip-email",
  ]);
  await wp(["rewrite", "structure", "/%postname%/"]);
  await wp(["option", "update", "stand_in_gravity_forms", "active"]);
  server = await serveWordPress(port);

  // An anonymous request: its status and, once a route answers, which.
  const request = async (method, path, headers = {}) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: method === "GET" ? undefined : JSON.stringify({ input_1: "Ana" }),
    });
    const body = await response.json().catch(() => null);
    return `${response.status} ${body?.route ?? body?.code ?? ""}`.trim();
  };
  const expect = async (label, method, path, wanted, headers) => {
    const got = await request(method, path, headers);
    check(label, got === wanted, got);
  };
  const closed = "401 rest_auth_required";

  await expect(
    "a submission reaches Gravity Forms' route",
    "POST",
    "/wp-json/gf/v2/forms/1/submissions",
    "200 submission",
  );
  await expect(
    "so does one by ?rest_route=",
    "POST",
    "/?rest_route=/gf/v2/forms/1/submissions",
    "200 submission",
  );
  await expect("the REST index stays closed", "GET", "/wp-json/", closed);
  await expect("reading a form stays closed", "GET", "/wp-json/gf/v2/forms/1", closed);
  await expect("reading its entries stays closed", "GET", "/wp-json/gf/v2/forms/1/entries", closed);
  await expect("posting an entry stays closed", "POST", "/wp-json/gf/v2/forms/1/entries", closed);
  await expect("users stay closed", "GET", "/wp-json/wp/v2/users", closed);
  await expect("a batch stays closed", "POST", "/wp-json/batch/v1", closed);
  await expect(
    "a method override on the submission route stays closed",
    "POST",
    "/wp-json/gf/v2/forms/1/submissions?_method=GET",
    closed,
  );
  await expect(
    "so does a method override header",
    "POST",
    "/wp-json/gf/v2/forms/1/submissions",
    closed,
    { "X-HTTP-Method-Override": "GET" },
  );

  await wp(["option", "update", "stand_in_gravity_forms", "inactive"]);
  await expect(
    "with Gravity Forms inactive, a submission is closed",
    "POST",
    "/wp-json/gf/v2/forms/1/submissions",
    closed,
  );
} finally {
  server?.kill();
  rmSync(work, { recursive: true, force: true });
}

if (results.failures > 0) {
  console.error(`${results.failures} check(s) failed.`);
  process.exit(1);
}
console.log(
  "The CMS's REST gate lets only Gravity Forms submissions through, on a real WordPress.",
);

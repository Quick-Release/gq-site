// A real WordPress for the CMS proofs (cms-polylang.mjs, cms-rest-gate.mjs):
// the version the CMS skeleton pins, on SQLite, driven by WP-CLI and served
// over HTTP by PHP's built-in server, from the archives their .sh scripts
// download into the cache.

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "./frontend-runtime-lib.mjs";

/**
 * Unpacks WordPress `version` and `plugins` (archive names in `cache`, the
 * SQLite integration always among them) into a new directory named after
 * `name`. Resolves to its paths, `env` (with `wp` on PATH, as the deploy has
 * it), `wp(args)`, `serve(port)` and `remove()`.
 */
export function realWordPress({ name, cache, version, plugins = [] }) {
  const work = mkdtempSync(join(tmpdir(), `${name}-`));
  const wordpress = join(work, "wordpress");
  const bin = join(work, "bin");
  const unzip = (archive, into) => {
    const result = spawnSync("unzip", ["-q", "-o", join(cache, archive), "-d", into]);
    if (result.status !== 0) throw new Error(`unzip ${archive} failed`);
  };
  unzip(`wordpress-${version}.zip`, work);
  const pluginsDirectory = join(wordpress, "wp-content/plugins");
  for (const plugin of ["sqlite-database-integration.zip", ...plugins]) {
    unzip(plugin, pluginsDirectory);
  }
  // WordPress over HTTP: files as they are, every other path through
  // WordPress (pretty permalinks, /graphql, /wp-json).
  writeFileSync(
    join(work, "router.php"),
    `<?php $path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($path !== '/' && is_file($_SERVER['DOCUMENT_ROOT'] . $path)) { return false; }
$_SERVER['SCRIPT_NAME'] = '/index.php';
require $_SERVER['DOCUMENT_ROOT'] . '/index.php';\n`,
  );
  const sqlite = join(pluginsDirectory, "sqlite-database-integration");
  writeFileSync(
    join(wordpress, "wp-content/db.php"),
    readFileSync(join(sqlite, "db.copy"), "utf8")
      .replaceAll("{SQLITE_IMPLEMENTATION_FOLDER_PATH}", sqlite)
      .replaceAll("{SQLITE_PLUGIN}", "sqlite-database-integration/load.php"),
  );
  // `wp` on PATH, as the deploy has it.
  mkdirSync(bin);
  writeFileSync(
    join(bin, "wp"),
    `#!/bin/sh\nexec php -d display_errors=stderr -d error_reporting=${32767 & ~8192 & ~16384} -d memory_limit=512M ${JSON.stringify(join(cache, "wp-cli.phar"))} --path=${JSON.stringify(wordpress)} "$@"\n`,
  );
  chmodSync(join(bin, "wp"), 0o755);

  const env = () => ({
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    WP_CLI_CACHE_DIR: join(work, "wp-cli-cache"),
  });

  async function wp(args) {
    const result = await run(join(bin, "wp"), args, { env: env() });
    if (result.code !== 0) throw new Error(`wp ${args.join(" ")} failed:\n${result.stderr}`);
    return result.stdout.trim();
  }

  /** WordPress over HTTP (PHP's built-in server); resolves to the server. */
  async function serve(port) {
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

  /** Configures and installs it at `origin`, with pretty permalinks. */
  async function install(origin, title) {
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
      `--title=${title}`,
      "--admin_user=editor",
      "--admin_password=editor-password",
      "--admin_email=editor@example.test",
      "--skip-email",
    ]);
    await wp(["rewrite", "structure", "/%postname%/"]);
  }

  return {
    wordpress,
    env,
    wp,
    serve,
    install,
    remove: () => rmSync(work, { recursive: true, force: true }),
  };
}

#!/usr/bin/env node
//
// A guarded Site's deploy quarantine on a real WordPress (see quarantine.sh):
// the .maintenance file a generated deploy script writes (taken verbatim from
// deploy/ploi/admin.sh), in a real WordPress's ABSPATH, served over HTTP by
// PHP's built-in server and driven by real WP-CLI.
//
//   node scripts/smoke/quarantine.mjs <generated guarded site> <download cache>

import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { checker, freePort } from "./frontend-runtime-lib.mjs";
import { realWordPress } from "./wordpress-lib.mjs";

const site = resolve(process.argv[2] ?? ".");
const cache = resolve(process.argv[3] ?? ".");
const results = checker();
const { check } = results;

// The quarantine exactly as the generated deploy script writes it.
const script = readFileSync(join(site, "deploy/ploi/admin.sh"), "utf8");
const quarantine =
  /cat >"\$wordpress\/\.maintenance" <<'GQ_QUARANTINE'\n([\s\S]*?)\nGQ_QUARANTINE\n/u.exec(
    script,
  )?.[1];
if (!quarantine) throw new Error("The generated deploy script writes no quarantine.");

const { wordpress, wp, serve, install, remove } = realWordPress({
  name: "gq-quarantine",
  cache,
  version: process.env.WORDPRESS_VERSION,
});
const maintenance = join(wordpress, ".maintenance");
const md5 = (text) => createHash("md5").update(text).digest("hex");

let server;
try {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  await install(origin, "Test");
  server = await serve(port);
  // A request's status, its body read so the connection closes cleanly.
  const status = async (path, init = {}) => {
    const response = await fetch(`${origin}${path}`, { redirect: "manual", ...init });
    await response.arrayBuffer();
    return response.status;
  };

  const before = await status("/");
  check("before: the home page is served", before === 200, String(before));

  // WordPress's own maintenance mode, for contrast: the scrape exception
  // (md5 of $upgrading, readable in the file) gets through.
  await wp(["maintenance-mode", "activate"]);
  const upgrading = /\$upgrading = (\d+);/u.exec(readFileSync(maintenance, "utf8"))[1];
  check("WordPress's .maintenance answers 503", (await status("/")) === 503);
  check(
    "WordPress's .maintenance lets its scrape exception through",
    (await status(`/?wp_scrape_key=${md5(upgrading)}&wp_scrape_nonce=${upgrading}`)) === 200,
  );
  await wp(["maintenance-mode", "deactivate"]);

  writeFileSync(maintenance, `${quarantine}\n`);
  const scrape = (value) => `wp_scrape_key=${md5(value)}&wp_scrape_nonce=${value}`;
  for (const [label, path, init] of [
    ["the home page", "/"],
    ["the REST API", "/wp-json/"],
    ["the login page", "/wp-login.php"],
    ["the admin", "/wp-admin/"],
    ["a scrape request for $upgrading 0", `/?${scrape("0")}`],
    ["a scrape request for 4102444800", `/?${scrape("4102444800")}`],
    [
      "a scrape request in a POST body",
      "/",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: scrape("0"),
      },
    ],
    ["a query pretending to be the command line", "/?PHP_SAPI=cli&wp-cli=1"],
    [
      "headers pretending to be WP-CLI",
      "/",
      { headers: { "X-WP-CLI": "1", "User-Agent": "WP-CLI" } },
    ],
  ]) {
    const got = await status(path, init);
    check(`quarantined: ${label} answers 503`, got === 503, String(got));
  }
  const body = await (await fetch(`${origin}/`)).text();
  check("quarantined: the body names no timestamp or secret", !/\d{6,}/u.test(body), body);

  // WP-CLI, which a recovery deploy runs, works under the quarantine.
  check("quarantined: WP-CLI runs", (await wp(["option", "get", "siteurl"])) === origin);
  check(
    "quarantined: WordPress isn't in maintenance mode for WP-CLI",
    (await wp(["eval", "echo wp_is_maintenance_mode() ? 'on' : 'off';"])) === "off",
  );

  // Lifted (as a deploy that verified and finished does): served again.
  rmSync(maintenance);
  check("lifted: the home page is served", (await status("/")) === 200);
} finally {
  server?.kill();
  remove();
}

if (results.failures > 0) {
  console.error(`${results.failures} check(s) failed.`);
  process.exit(1);
}
console.log(
  "A guarded Site's quarantine answers every web request 503 on a real WordPress, its scrape exception included, while WP-CLI works.",
);

#!/usr/bin/env node
//
// A bilingual Site's real-CMS proof, on a generated content site (see
// cms-polylang.sh): a real WordPress, on SQLite and driven by WP-CLI, with
// WPGraphQL, Polylang and GQ Polylang for WPGraphQL active and Portuguese
// pages that have no language yet, as a monolingual Site has them. The
// site's own deploy/ploi/polylang.sh, run with the languages its admin.sh
// passes it, creates Portuguese (the default, unprefixed) and English (/en/)
// and assigns the existing pages to Portuguese. With English translations
// added, GraphQL over HTTP resolves /en/ to the English front page, gives
// English's translated title, and each page's uri in its own language's
// directory. Running polylang.sh again changes nothing; a language
// gq.ops.json no longer lists stops it, named, before it changes anything,
// whether or not the language has content: it never deletes one.
//
// Then the site's own publication-events.php and settings-events.php send
// their events to a receiver standing in for the Frontend, as editors change
// each language: an English page's publication and withdrawal name English
// and its /en/ URI, each language's front page is at its home (/en/, /),
// English's own menu locations, menus and string translations (its tagline)
// name English alone, and the logo and the site's own title name no
// language, since every language shows them.
//
//   node scripts/smoke/cms-polylang.mjs <generated site directory> <download cache>

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { checker, freePort, run } from "./frontend-runtime-lib.mjs";

const site = resolve(process.argv[2] ?? ".");
const cache = resolve(process.argv[3] ?? ".");
const work = mkdtempSync(join(tmpdir(), "gq-cms-polylang-"));
const wordpress = join(work, "wordpress");
const bin = join(work, "bin");

const results = checker();
const { check } = results;

function setUpWordPress() {
  const unzip = (archive, into) => {
    const result = spawnSync("unzip", ["-q", "-o", join(cache, archive), "-d", into]);
    if (result.status !== 0) throw new Error(`unzip ${archive} failed`);
  };
  unzip(`wordpress-${process.env.WORDPRESS_VERSION}.zip`, work);
  const plugins = join(wordpress, "wp-content/plugins");
  for (const plugin of [
    "sqlite-database-integration.zip",
    "wp-graphql.zip",
    "polylang.zip",
    `gq-polylang-graphql-${process.env.POLYLANG_GRAPHQL_VERSION}.zip`,
  ]) {
    unzip(plugin, plugins);
  }
  // WordPress over HTTP: files as they are, every other path through
  // WordPress (pretty permalinks, /graphql).
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
  // `wp` on PATH for polylang.sh, as the deploy has it.
  mkdirSync(bin);
  writeFileSync(
    join(bin, "wp"),
    `#!/bin/sh\nexec php -d display_errors=stderr -d error_reporting=${32767 & ~8192 & ~16384} -d memory_limit=512M ${JSON.stringify(join(cache, "wp-cli.phar"))} --path=${JSON.stringify(wordpress)} "$@"\n`,
  );
  chmodSync(join(bin, "wp"), 0o755);
}

// The CMS's .env once its events are on: where the Frontend is, and its key.
let cmsEnv = {};

const env = () => ({
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  WP_CLI_CACHE_DIR: join(work, "wp-cli-cache"),
  ...cmsEnv,
});

async function wp(args) {
  const result = await run(join(bin, "wp"), args, { env: env() });
  if (result.code !== 0) throw new Error(`wp ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

/** Runs PHP in WordPress with WP-CLI; resolves to what it echoes, as JSON. */
async function php(code) {
  return JSON.parse(await wp(["eval", code]));
}

/** The site's deploy/ploi/polylang.sh, with `languages` (the default first) as admin.sh passes them. */
function polylang(languages) {
  return run("bash", [join(site, "deploy/ploi/polylang.sh"), ...languages], {
    cwd: join(site, "apps/cms"),
    env: env(),
  });
}

/** What polylang.sh changes: Polylang's languages and options. */
function polylangState() {
  return php(`echo json_encode([
    'languages' => array_map(fn($l) => [$l->slug, $l->locale, $l->term_group, $l->is_default], PLL()->model->languages->get_list()),
    'options' => get_option('polylang'),
  ]);`);
}

/** A page; resolves to its ID. */
async function page(title, slug, language) {
  const id = Number(
    await wp([
      "post",
      "create",
      "--post_type=page",
      "--post_status=publish",
      `--post_title=${title}`,
      `--post_name=${slug}`,
      "--porcelain",
    ]),
  );
  if (language) await wp(["eval", `pll_set_post_language(${id}, '${language}');`]);
  return id;
}

/**
 * A stand-in for the Frontend's /gq/events: it records each event the CMS
 * sends and answers it refreshed. Resolves to the server and the events.
 */
async function eventReceiver(port) {
  const events = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (request.url === "/gq/events") events.push(JSON.parse(body));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "refreshed" }));
    });
  });
  await new Promise((done) => server.listen(port, "127.0.0.1", done));
  return { server, events };
}

/** An event as these checks compare it: its action, then what it names. */
function describeEvent(event) {
  return event.action === "settings"
    ? `settings ${event.setting} ${event.language ?? "(every language)"}`
    : `${event.action} ${event.entry.uri} ${event.entry.language ?? "(no language)"}`;
}

/** WordPress over HTTP (PHP's built-in server); resolves to the server. */
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
let receiver;
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
    "--title=Sítio de teste",
    "--admin_user=editor",
    "--admin_password=editor-password",
    "--admin_email=editor@example.test",
    "--skip-email",
  ]);
  await wp(["rewrite", "structure", "/%postname%/"]);
  await wp(["plugin", "activate", "wp-graphql", "polylang", "gq-polylang-graphql"]);

  // A monolingual Site's content: pages without a language.
  const inicio = await page("Início", "inicio");
  const sobre = await page("Sobre", "sobre");
  await wp(["option", "update", "show_on_front", "page"]);
  await wp(["option", "update", "page_on_front", String(inicio)]);

  // The languages the generated deploy script passes polylang.sh.
  const script = readFileSync(join(site, "deploy/ploi/admin.sh"), "utf8");
  const variable = (name) => script.match(new RegExp(`^${name}="(.*)"$`, "mu"))[1];
  const languages = [variable("WP_LOCALE"), ...variable("WP_LANGUAGES").split(" ")];
  check(
    "the generated deploy script passes Portuguese (AO90) and English under /en/",
    JSON.stringify(languages) === JSON.stringify(["pt_PT_ao90", "en_US:en"]),
    JSON.stringify(languages),
  );

  const first = await polylang(languages);
  check("polylang.sh configures Polylang on a monolingual Site", first.code === 0, first.stderr);
  const configured = await polylangState();
  check(
    "Portuguese is the default language, then English",
    JSON.stringify(configured.languages) ===
      JSON.stringify([
        ["pt", "pt_PT_ao90", 0, true],
        ["en", "en_US", 1, false],
      ]),
    JSON.stringify(configured.languages),
  );
  check(
    "each language is a URL directory, the default's hidden",
    configured.options.force_lang === 1 &&
      configured.options.hide_default === true &&
      configured.options.rewrite === true,
    JSON.stringify(configured.options),
  );
  const assigned = await php(
    `echo json_encode([pll_get_post_language(${inicio}), pll_get_post_language(${sobre})]);`,
  );
  check(
    "the content without a language is the default language's",
    JSON.stringify(assigned) === JSON.stringify(["pt", "pt"]) &&
      /Assigned the default language to \d+ posts/u.test(first.stdout),
    `${JSON.stringify(assigned)} ${first.stdout}`,
  );

  // An editor translates the site into English.
  const home = await page("Home", "home", "en");
  const about = await page("About", "about", "en");
  await wp([
    "eval",
    `pll_save_post_translations(['pt' => ${inicio}, 'en' => ${home}]);
     pll_save_post_translations(['pt' => ${sobre}, 'en' => ${about}]);
     $mo = new PLL_MO();
     $en = PLL()->model->languages->get('en');
     $mo->import_from_db($en);
     $mo->add_entry($mo->make_entry('Sítio de teste', 'Test site'));
     $mo->export_to_db($en);`,
  ]);
  await wp(["rewrite", "flush", "--hard"]);

  server = await serveWordPress(port);
  const graphql = async (query) => {
    const response = await fetch(`${origin}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    return response.json();
  };
  const read = await graphql(`{
    front: nodeByUri(uri: "/en/") { ... on Page { databaseId title isFrontPage uri } }
    en: language(code: EN) { title }
    about: page(id: ${about}, idType: DATABASE_ID) { uri }
    sobre: page(id: ${sobre}, idType: DATABASE_ID) { uri }
  }`);
  const data = read.data ?? {};
  check(
    'nodeByUri("/en/") is the English front page',
    data.front?.databaseId === home && data.front.isFrontPage === true && data.front.uri === "/en/",
    JSON.stringify(read),
  );
  check(
    "language(code: EN) has the English title",
    data.en?.title === "Test site",
    JSON.stringify(read),
  );
  check(
    "an English page's uri is /en/<its slug>/",
    data.about?.uri === "/en/about/",
    JSON.stringify(read),
  );
  check(
    "a Portuguese page's uri has no prefix",
    data.sobre?.uri === "/sobre/",
    JSON.stringify(read),
  );

  // --- The events editors' changes send, in each language ---
  const receiverPort = await freePort();
  const received = await eventReceiver(receiverPort);
  receiver = received.server;
  cmsEnv = {
    GETQUICK_FRONTEND_URL: `http://127.0.0.1:${receiverPort}`,
    PUBLICATION_EVENT_SECRET: "cms-polylang-proof-event-signing-key-01234",
  };
  const muPlugins = join(wordpress, "wp-content/mu-plugins");
  mkdirSync(muPlugins, { recursive: true });
  for (const plugin of ["publication-events.php", "settings-events.php"]) {
    cpSync(join(site, "apps/cms/web/app/mu-plugins", plugin), join(muPlugins, plugin));
  }
  // The primary menu location getquick-theme registers.
  writeFileSync(
    join(muPlugins, "getquick-theme-locations.php"),
    `<?php add_action('after_setup_theme', static fn() => register_nav_menus(['primary' => 'Primary menu']));\n`,
  );
  /** What running `wp <args>` sent the Frontend, as describeEvent gives each. */
  const sends = async (args) => {
    received.events.length = 0;
    await wp(args);
    return received.events.splice(0).map(describeEvent);
  };
  const expectSent = (label, sent, expected) =>
    check(label, JSON.stringify(sent) === JSON.stringify(expected), JSON.stringify(sent));

  const team = Number(
    await wp([
      "post",
      "create",
      "--post_type=page",
      "--post_status=draft",
      "--post_title=Team",
      "--post_name=team",
      "--porcelain",
    ]),
  );
  await wp(["eval", `pll_set_post_language(${team}, 'en');`]);
  expectSent(
    "publishing an English page sends its /en/ URI and English",
    await sends(["post", "update", String(team), "--post_status=publish"]),
    ["publish /en/team/ en"],
  );
  expectSent(
    "unpublishing it withdraws its /en/ URI, in English",
    await sends(["post", "update", String(team), "--post_status=draft"]),
    ["withdraw /en/team/ en"],
  );
  expectSent(
    "updating the English front page sends /en/, English's home",
    await sends(["post", "update", String(home), "--post_content=Welcome back."]),
    ["publish /en/ en"],
  );
  expectSent(
    "updating the Portuguese front page sends /, in Portuguese",
    await sends(["post", "update", String(inicio), "--post_content=Bem-vindo de volta."]),
    ["publish / pt"],
  );

  const menu = Number(await wp(["menu", "create", "Main EN", "--porcelain"]));
  expectSent(
    "assigning English's primary menu names English alone",
    await sends([
      "eval",
      `$menus = PLL()->model->options->get('nav_menus');
       $menus[get_option('stylesheet')]['primary']['en'] = ${menu};
       PLL()->model->options->set('nav_menus', $menus);`,
    ]),
    ["settings menus en"],
  );
  expectSent(
    "editing the English menu names English alone",
    await sends(["menu", "item", "add-custom", String(menu), "Team", "/en/team/"]),
    ["settings menus en"],
  );
  expectSent(
    "setting the site's own tagline names no language",
    await sends(["option", "update", "blogdescription", "Coisas"]),
    ["settings identity (every language)"],
  );
  expectSent(
    "translating the tagline into English names English alone",
    await sends([
      "eval",
      `$mo = new PLL_MO();
       $en = PLL()->model->languages->get('en');
       $mo->import_from_db($en);
       $mo->add_entry($mo->make_entry(get_option('blogdescription'), 'Things, in English'));
       $mo->export_to_db($en);`,
    ]),
    ["settings identity en"],
  );
  expectSent(
    "changing the logo names no language: every language shows it",
    await sends(["option", "update", "site_logo", String(inicio)]),
    ["settings logo (every language)"],
  );
  expectSent(
    "changing the site's own title names no language: a language without a translation shows it",
    await sends(["option", "update", "blogname", "Sítio de teste 2"]),
    ["settings identity (every language)"],
  );
  const statuses = JSON.parse(await wp(["gq-events", "settings", "status", "--format=json"]));
  check(
    "wp gq-events settings status lists English's own menus and identity",
    ["menus:en", "identity:en"].every((setting) =>
      statuses.some((row) => row.setting === setting && row.status === "refreshed"),
    ),
    JSON.stringify(statuses),
  );
  cmsEnv = {};

  // The next deploys.
  const before = await polylangState();
  const again = await polylang(languages);
  check(
    "running polylang.sh again changes nothing",
    again.code === 0 &&
      again.stdout === "" &&
      JSON.stringify(await polylangState()) === JSON.stringify(before),
    `${again.code} ${again.stdout} ${again.stderr}`,
  );

  // English has content; a French language just added has none.
  const removed = await polylang([languages[0]]);
  check(
    "a language gq.ops.json no longer lists stops it, named, and changes nothing",
    removed.code === 1 &&
      /no longer lists Polylang's language en \(en_US\)\./u.test(removed.stderr) &&
      JSON.stringify(await polylangState()) === JSON.stringify(before),
    `${removed.code} ${removed.stderr}`,
  );
  const added = await polylang([...languages, "fr_FR:fr"]);
  const withFrench = await polylangState();
  const dropped = await polylang(languages);
  check(
    "it never deletes a language, even one without content",
    added.code === 0 &&
      dropped.code === 1 &&
      /no longer lists Polylang's language fr \(fr_FR\)\./u.test(dropped.stderr) &&
      JSON.stringify(await polylangState()) === JSON.stringify(withFrench),
    `${added.stderr} ${dropped.code} ${dropped.stderr}`,
  );
} finally {
  server?.kill();
  receiver?.close();
  rmSync(work, { recursive: true, force: true });
}

if (results.failures > 0) {
  console.error(`${results.failures} check(s) failed.`);
  process.exit(1);
}
console.log(
  "The bilingual Site's Polylang configuration and its events per language work on a real WordPress.",
);

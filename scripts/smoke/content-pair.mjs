#!/usr/bin/env node
//
// The content package pair's wiring proof, on a generated content site whose
// Frontend's npm dependencies are installed (see content-pair.sh). The
// runtime's behaviour is gq-content's to prove; this proves that a Site gq new
// generates runs the pinned runtime, wired as the blueprint means it:
//
//   keys       both halves pinned to the blueprint's one version, installed
//              from npm with the published integrity, and gq sync --check
//              clean;
//   crontab    the crontab gq ploi events installs runs the command the
//              pinned CMS plugin (its published ZIP, checked by SHA-256)
//              registers, the CMS defines the identity the plugin reads, and
//              the Site has no copied delivery plugins beside it;
//   migrations infra/frontend.run.ts's own resolution finds the installed
//              package's publication migrations, and they migrate a local D1
//              store;
//   routes     the Frontend built by Alchemy's Astro Cloudflare build and
//              served in workerd with that store: /gq/refresh and /gq/events
//              answer through the package (405 to a GET, 401 without the
//              token), gq frontend refresh prepares the Site and its pages are
//              then served from the store, and gq frontend events check is
//              accepted with this Site's identity while another Site's event
//              is refused;
//   forms      the managed /gq/forms/ route (the Site declares `forms`)
//              answers through the package: a post is checked against the
//              form's descriptor as the store holds it with its page, and a
//              form its page doesn't reference is refused. No post reaches
//              the CMS.
//
// Nothing reaches Cloudflare: no account, token or remote resource is used.
//
//   node scripts/smoke/content-pair.mjs <generated site directory>

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CONTACT_FORM } from "@getquick/content/forms/testing";

import { retryCrontab } from "../../src/ploi/events.mjs";
import { CONTENT_PAIR } from "../../src/sync/content-pair.mjs";
import {
  buildFrontend,
  checker,
  deliverEvent,
  freePort,
  localWorker,
  runGq,
  stopWorker,
  stubCms,
  visit,
} from "./frontend-runtime-lib.mjs";

// Immutable published pairs: v0.3.1 (source cbf2925), v0.3.2 (source
// 698b989), v0.4.0 (source 61f51f4) and v0.4.2 (source 043afbe). A new pin
// brings its release receipt's own npm/ZIP hashes.
const PUBLISHED = {
  "0.4.2": {
    integrity:
      "sha512-Phkk8tZ/LinT9HoOT7sreysvLbvYAAU7693Aof7ycgftVymd0wW482TqZHRNBkR15u4JOBWRI237gmO2vzSivQ==",
    zipSha256: "a0a28adda5ef17d09574bb65174fde553fefd70171b2382521bc0bbce2d1baa7",
  },
  "0.4.0": {
    integrity:
      "sha512-YSKKFoilWBpu/Mm3lP2Y9asFitsArYrk0djlpyN9RDC/fCLZdspqnZbjC98mNuc8DlY3g0MQhbdmVYMSWg1Rmg==",
    zipSha256: "1d177a9f1508e501b2c495881748a51d89e1a88d3f03d868f6eb0a2e858a85fc",
  },
  "0.3.2": {
    integrity:
      "sha512-1EErw67A+On/M1AZDlk0DOMcBsRkJU6wK7t4b93BHayBn9y32s2IZKxsCf/jfxe/DfBlnhRYk66z4msarOsdCA==",
    zipSha256: "89706f3f1796e78d20bbe34ea6205834709052b9fa3446b58ae102dfc169d774",
  },
  "0.3.1": {
    integrity:
      "sha512-g5MMkL6NvUMo+BJ5f4T94WAcNGdFNDneMpoSK76s2cvbgW+Lyb0nFab2uig2BW+eDh9gcMqDafeJyJZ0oWL3rA==",
    zipSha256: "a20c2afe1cd37c2789fc2fd839d6c00f5cb4eb2279c3d1746efbf353f95fecc0",
  },
};

const site = resolve(process.argv[2] ?? ".");
const frontend = join(site, "apps/frontend");
const work = mkdtempSync(join(tmpdir(), "gq-content-pair-"));
const token = "content-pair-proof-refresh-token-0123456789";
const eventKey = "content-pair-proof-event-signing-key-012345";
const { version } = CONTENT_PAIR;
const published = PUBLISHED[version];

const results = checker();
const { check } = results;

const readJson = (path) => JSON.parse(readFileSync(join(site, path), "utf8"));

// --- Keys ---
const ops = readJson("gq.ops.json");
check('gq.ops.json runs the content runtime from its "package"', ops.contentRuntime === "package");
check(
  `apps/cms/composer.json requires ${CONTENT_PAIR.composer} ${version}`,
  readJson("apps/cms/composer.json").require?.[CONTENT_PAIR.composer] === version,
);
check(
  `apps/frontend/package.json depends on ${CONTENT_PAIR.npm} ${version}`,
  readJson("apps/frontend/package.json").dependencies?.[CONTENT_PAIR.npm] === version,
);
const installed = join(frontend, "node_modules", CONTENT_PAIR.npm, "package.json");
check(
  `pnpm installed ${CONTENT_PAIR.npm} ${version} in the Frontend`,
  existsSync(installed) && JSON.parse(readFileSync(installed, "utf8")).version === version,
);
check(
  `the lockfile holds the published ${CONTENT_PAIR.npm} ${version}`,
  Boolean(published) &&
    readFileSync(join(site, "pnpm-lock.yaml"), "utf8").includes(
      `'${CONTENT_PAIR.npm}@${version}':\n    resolution: {integrity: ${published.integrity}}`,
    ),
);
const syncCheck = await runGq(site, ["sync", "--check"]);
check("gq sync --check finds the Site in step", syncCheck.code === 0, syncCheck.stdout);

// --- Crontab ---
const zip = join(work, `gq-content-${version}.zip`);
const download = await fetch(
  `https://github.com/Quick-Release/gq-content/releases/download/v${version}/gq-content-${version}.zip`,
);
writeFileSync(zip, Buffer.from(await download.arrayBuffer()));
const zipSha256 = createHash("sha256").update(readFileSync(zip)).digest("hex");
check(
  `the ${CONTENT_PAIR.composer} ${version} ZIP is the published one`,
  download.ok && zipSha256 === published?.zipSha256,
  `HTTP ${download.status}, SHA-256 ${zipSha256}`,
);
const plugin = join(work, "plugin");
const unzip = spawnSync("unzip", ["-q", zip, "-d", plugin], { encoding: "utf8" });
check("its ZIP extracts", unzip.status === 0, unzip.stderr);
const pluginFile = (path) => {
  const file = join(plugin, path);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};
check(
  `the plugin is version ${version}`,
  new RegExp(`^ \\* Version: ${version.replaceAll(".", "\\.")}$`, "mu").test(
    pluginFile("gq-content.php"),
  ),
);
const crontab = retryCrontab({ systemUser: "acme", domain: "admin.acme.example" });
const scheduled = /PATH="\/usr\/local\/bin:\$PATH" (.+)$/u.exec(crontab.command)?.[1];
check(
  "gq ploi events' crontab runs the plugin's own scheduler command",
  scheduled !== undefined &&
    pluginFile("modules/delivery-retries.php").includes(`const COMMAND = '${scheduled}';`),
  scheduled,
);
check(
  "the plugin registers it with WP-CLI",
  pluginFile("modules/delivery-retries.php").includes(
    `\\WP_CLI::add_command('${scheduled?.replace(/^wp | --quiet$/gu, "")}'`,
  ),
);
check(
  "the CMS defines the Site identity the plugin signs with",
  pluginFile("modules/publication-events.php").includes("setting('GQ_CONTENT_SITE_ID')") &&
    readFileSync(join(site, "apps/cms/config/application.php"), "utf8").includes(
      `Config::define('GQ_CONTENT_SITE_ID', '${ops.project}');`,
    ),
);
const muPlugins = readdirSync(join(site, "apps/cms/web/app/mu-plugins"));
check(
  "the CMS copies none of the plugin's modules beside it",
  !muPlugins.some((name) =>
    ["publication-events.php", "settings-events.php", "delivery-retries.php"].includes(name),
  ),
  muPlugins.join(", "),
);

// --- Migrations ---
// infra/frontend.run.ts's own resolution, run as Node runs TypeScript
// (erasable syntax only), from the infra directory as the deploy imports it.
const runTs = readFileSync(join(site, "infra/frontend.run.ts"), "utf8");
const resolver = /^async function installedPublicationMigrations\([\s\S]*?^\}$/mu.exec(runTs)?.[0];
check("infra/frontend.run.ts resolves the publication migrations", resolver !== undefined);
const probe = join(site, "infra", "content-pair-probe.ts");
let resolved;
try {
  writeFileSync(
    probe,
    [
      'import { existsSync, readFileSync } from "node:fs";',
      'import { fileURLToPath } from "node:url";',
      resolver,
      `const runtime = ${JSON.stringify(ops.contentRuntime)};`,
      "console.log(JSON.stringify([",
      "  await installedPublicationMigrations(runtime),",
      "  await installedPublicationMigrations(undefined),",
      "]));",
      "",
    ].join("\n"),
  );
  resolved = spawnSync(process.execPath, [probe], { encoding: "utf8" });
} finally {
  rmSync(probe, { force: true });
}
const [migrations, olderSite] = resolved.status === 0 ? JSON.parse(resolved.stdout) : [null, 0];
check(
  "an older Site with the package installed (for consent) but no migrations of its own gets no store",
  olderSite === null,
  String(olderSite),
);
// The package's own answer, through its exports, as any importer resolves it.
const packageJson = join(frontend, "node_modules", CONTENT_PAIR.npm, "package.json");
const migrationsEntry = JSON.parse(readFileSync(packageJson, "utf8")).exports["./migrations"]
  .import;
const packageMigrations = (await import(pathToFileURL(join(packageJson, "..", migrationsEntry))))
  .migrationsDirectory;
check(
  `the deploy migrates the store from ${CONTENT_PAIR.npm}/migrations`,
  migrations !== null && resolve(migrations) === resolve(packageMigrations),
  resolved.stderr || String(migrations),
);
check("the Site has no migrations of its own", !existsSync(join(frontend, "migrations")));
const sql = migrations && existsSync(migrations) ? readdirSync(migrations).sort() : [];
check(
  "they are the publication store's five migrations",
  sql.length === 5 && sql[0] === "0001_publications.sql" && sql[4] === "0005_reconciliation.sql",
  sql.join(", "),
);

// --- Routes ---
const cms = stubCms([
  ["/about/", { id: "page-64", title: "About", content: "We make things." }],
  [
    "/contact/",
    { id: "page-65", title: "Contact", content: "Write to us.", forms: [CONTACT_FORM] },
  ],
]);
const local = localWorker({
  site,
  work,
  migrations,
  vars: { FRONTEND_REFRESH_TOKEN: token, PUBLICATION_EVENT_SECRET: eventKey },
});

let worker;
try {
  await cms.start();
  const port = await freePort();
  const siteUrl = `http://127.0.0.1:${port}`;
  buildFrontend(frontend, siteUrl, `http://127.0.0.1:${cms.port}/graphql`);
  const migrate = local.migrate();
  check("they migrate a local D1 store", migrate.status === 0, migrate.stderr);
  worker = await local.start(port);

  const cold = await visit(port);
  check("a never-refreshed homepage is a 503", cold.status === 503, `HTTP ${cold.status}`);
  for (const route of ["/gq/refresh", "/gq/events"]) {
    const get = await fetch(`${siteUrl}${route}`);
    check(
      `${route} answers through the package: POST only`,
      get.status === 405 && get.headers.get("allow") === "POST",
      `HTTP ${get.status}`,
    );
  }
  const anonymous = await fetch(`${siteUrl}/gq/refresh`, { method: "POST", body: "{}" });
  check(
    "a refresh without the token is refused",
    anonymous.status === 401,
    `HTTP ${anonymous.status}`,
  );

  const refresh = await runGq(site, ["frontend", "refresh", "--url", siteUrl, "--json"], {
    FRONTEND_REFRESH_TOKEN: token,
  });
  check(
    "gq frontend refresh prepares the Site",
    refresh.code === 0 && refresh.json?.ready === true,
    JSON.stringify(refresh.json) + refresh.stderr,
  );
  const home = await visit(port);
  check(
    "its homepage is then served from the store, with its chrome",
    home.status === 200 &&
      home.html.includes(cms.heading) &&
      new RegExp(`<a href="/about/"[^>]*>${cms.menuLabel}</a>`).test(home.html),
    `HTTP ${home.status}`,
  );
  const entry = await visit(port, "/about/");
  check(
    "and an entry, composed by the Site's page",
    entry.status === 200 &&
      entry.html.includes("We make things.") &&
      entry.html.includes("<title>About — Acme</title>"),
    `HTTP ${entry.status}`,
  );

  const events = await runGq(site, ["frontend", "events", "check", "--url", siteUrl, "--json"], {
    PUBLICATION_EVENT_SECRET: eventKey,
  });
  check(
    `gq frontend events check is accepted for ${ops.project}`,
    events.code === 0 && events.json?.accepted === true && events.json.answer?.site === ops.project,
    JSON.stringify(events.json) + events.stderr,
  );
  // --- Forms ---
  const post = (path, body) =>
    fetch(`${siteUrl}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: siteUrl,
      },
      body: new URLSearchParams(body),
    });
  const formGet = await fetch(`${siteUrl}/gq/forms/1`);
  check(
    "/gq/forms/1 answers through the package: POST only",
    formGet.status === 405 && formGet.headers.get("allow") === "POST",
    `HTTP ${formGet.status}`,
  );
  const requests = cms.requests;
  const empty = await post("/gq/forms/1", { gq_source: "/contact/" });
  const emptyAnswer = await empty.json().catch(() => null);
  check(
    "a post missing required fields is checked against the descriptor stored with its page",
    empty.status === 422 &&
      emptyAnswer?.status === "invalid" &&
      Object.keys(emptyAnswer.errors ?? {}).length > 0,
    `HTTP ${empty.status} ${JSON.stringify(emptyAnswer)}`,
  );
  const elsewhere = await post("/gq/forms/1", { gq_source: "/about/" });
  check(
    "a form its page doesn't reference is refused",
    elsewhere.status === 502,
    `HTTP ${elsewhere.status}`,
  );
  check("neither post reached the CMS", cms.requests === requests, `${cms.requests - requests}`);
  const notForm = await fetch(`${siteUrl}/gq/forms/contact`, { method: "POST" });
  check(
    "anything else under /gq/forms/ is a 404",
    notForm.status === 404,
    `HTTP ${notForm.status}`,
  );

  const other = await deliverEvent(port, eventKey, {
    site: "beta",
    id: randomUUID(),
    action: "check",
    occurredAt: Date.now(),
  });
  check(
    "another Site's event is refused",
    other.status >= 400 && other.status < 500,
    `HTTP ${other.status}`,
  );
} finally {
  await stopWorker(worker);
  await cms.stop();
  rmSync(work, { recursive: true, force: true });
}

if (results.failures > 0) {
  console.error(`${results.failures} check(s) failed.`);
  process.exit(1);
}
console.log(
  `The generated Site wires ${CONTENT_PAIR.composer} and ${CONTENT_PAIR.npm} ${version}: keys, crontab, migrations, routes and forms.`,
);

#!/usr/bin/env node
//
// The bilingual variant of the runtime proof, on a generated content site
// whose gq.ops.json lists Portuguese (AO90) as wordpress.locale and English
// under /en/ in wordpress.languages (see frontend-runtime.sh): builds the
// Frontend with Alchemy's Astro Cloudflare build, serves it in workerd with a
// local D1 publication store, and drives it against a stub WordPress that
// answers as GQ Polylang for WPGraphQL does:
//
//   gq frontend refresh stores each language's front page and chrome and
//   every entry with its translations; with the CMS down, / and /en/ are each
//   language's home from the store, with its own title, menu and <html lang>;
//   /sobre/ and /en/about/ are served with hreflang alternates to each other,
//   and all of it outlives a Worker restart. /en/sobre/ is a 404 in English.
//
// Nothing reaches Cloudflare: no account, token or remote resource is used.
//
//   node scripts/smoke/frontend-languages.mjs <generated site directory>

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildFrontend,
  checker,
  freePort,
  localWorker,
  runGq,
  stopWorker,
  visit,
} from "./frontend-runtime-lib.mjs";

const site = resolve(process.argv[2] ?? ".");
const frontend = join(site, "apps/frontend");
const work = mkdtempSync(join(tmpdir(), "gq-frontend-languages-"));
const token = "languages-proof-refresh-token-0123456789abc";

const results = checker();
const { check } = results;

const page = (id, title, uri, language, translations = []) => ({
  id,
  title,
  content: `<p>${title}.</p>`,
  uri,
  status: "publish",
  isRestricted: false,
  modifiedGmt: "2026-10-01T09:00:00",
  featuredImage: null,
  language: { slug: language },
  translations: translations.map(([uri, slug]) => ({ uri, language: { slug } })),
});
const pages = new Map([
  ["/sobre/", page("page-1", "Sobre", "/sobre/", "pt", [["/en/about/", "en"]])],
  ["/en/about/", page("page-2", "About", "/en/about/", "en", [["/sobre/", "pt"]])],
]);
const fronts = {
  PT: {
    title: "Acme PT",
    tagline: "Coisas",
    heading: "Bem-vindo à Acme",
    menu: ["Sobre nós", "/sobre/"],
  },
  EN: {
    title: "Acme EN",
    tagline: "Things",
    heading: "Welcome to Acme",
    menu: ["About us", "/en/about/"],
  },
};
const tokens = { colors: [], spacingSizes: [] };

/** WordPress with Polylang and GQ Polylang for WPGraphQL, answering the Frontend's queries by name. */
function answer(name, variables) {
  const front = fronts[variables.language ?? "PT"];
  switch (name) {
    case "HomePage": {
      const nodeByUri = {
        __typename: "Page",
        id: `front-${variables.language ?? "PT"}`,
        isFrontPage: true,
        title: variables.language ? "Home" : "Início",
        content: `<h1>${front.heading}</h1>`,
      };
      const settings = { title: front.title, description: front.tagline };
      return variables.language
        ? { language: settings, nodeByUri, designTokens: tokens }
        : { generalSettings: settings, nodeByUri, designTokens: tokens };
    }
    case "SiteChrome":
      return {
        generalSettings: { siteIcon: null, siteLogo: null },
        menuItems: {
          nodes: [
            {
              id: front.menu[1],
              parentId: null,
              label: front.menu[0],
              url: front.menu[1],
              target: null,
            },
          ],
        },
      };
    case "EntryByUri":
      return {
        postBy: null,
        pageBy: pages.get(decodeURI(variables.uri)) ?? null,
        designTokens: tokens,
      };
    case "PublishedRoutes":
      return {
        contentNodes: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            { uri: "/", id: "front-PT", modifiedGmt: null },
            { uri: "/en/", id: "front-EN", modifiedGmt: null },
            ...[...pages.values()].map(({ uri, id, modifiedGmt }) => ({ uri, id, modifiedGmt })),
          ],
        },
      };
    case "DesignPresets":
      return { designTokens: tokens };
  }
  return null;
}

const cms = {
  up: true,
  server: createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (!cms.up) {
        response.writeHead(503).end();
        return;
      }
      const { query, variables = {} } = JSON.parse(body);
      const data = answer(/query (\w+)/.exec(query)?.[1], variables);
      response.writeHead(data ? 200 : 400, { "content-type": "application/json" });
      response.end(JSON.stringify(data ? { data } : { errors: [{ message: "unknown query" }] }));
    });
  }),
};

const local = localWorker({ site, work, vars: { FRONTEND_REFRESH_TOKEN: token } });

const alternates = (html) =>
  [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map(
    ([, hreflang, href]) => `${hreflang} ${new URL(href).pathname}`,
  );

let worker;
try {
  await new Promise((done) => cms.server.listen(0, "127.0.0.1", done));
  const port = await freePort();
  const siteUrl = `http://127.0.0.1:${port}`;
  buildFrontend(frontend, siteUrl, `http://127.0.0.1:${cms.server.address().port}/graphql`);
  const migrated = local.migrate();
  check(
    "the Frontend's migrations apply to a bilingual Site's store",
    migrated.status === 0,
    migrated.stderr,
  );
  worker = await local.start(port);

  const refreshed = await runGq(site, ["frontend", "refresh", "--url", siteUrl, "--json"], {
    FRONTEND_REFRESH_TOKEN: token,
  });
  check(
    "gq frontend refresh stores each language's front page and chrome",
    refreshed.code === 0 &&
      refreshed.json?.ready === true &&
      refreshed.json?.languages?.en?.home?.state === "published" &&
      refreshed.json?.languages?.en?.chrome?.state === "published",
    refreshed.stdout || refreshed.stderr,
  );

  const served = async (label) => {
    const [pt, en, sobre, about] = await Promise.all(
      ["/", "/en/", "/sobre/", "/en/about/"].map((path) => visit(port, path)),
    );
    check(
      `${label}: / is the Portuguese home, with its title, menu and <html lang>`,
      pt.status === 200 &&
        pt.html.includes('<html lang="pt-PT">') &&
        pt.html.includes("Bem-vindo à Acme") &&
        /<a href="\/sobre\/"[^>]*>Sobre nós<\/a>/.test(pt.html),
      `HTTP ${pt.status}`,
    );
    check(
      `${label}: /en/ is the English home from the store, with its title, menu and <html lang>`,
      en.status === 200 &&
        en.html.includes('<html lang="en-US">') &&
        en.html.includes("Welcome to Acme") &&
        /<a href="\/en\/about\/"[^>]*>About us<\/a>/.test(en.html) &&
        !en.html.includes("Sobre nós"),
      `HTTP ${en.status}`,
    );
    const pair = ["pt-PT /sobre/", "en-US /en/about/", "x-default /sobre/"];
    check(
      `${label}: /sobre/ and /en/about/ link to each other with hreflang alternates`,
      sobre.status === 200 &&
        about.status === 200 &&
        about.html.includes('<html lang="en-US">') &&
        JSON.stringify(alternates(sobre.html)) === JSON.stringify(pair) &&
        JSON.stringify(alternates(about.html)) === JSON.stringify(pair),
      `${JSON.stringify(alternates(sobre.html))} ${JSON.stringify(alternates(about.html))}`,
    );
  };

  // WordPress confirms it has no English page there.
  const wrong = await visit(port, "/en/sobre/");
  check(
    "/en/sobre/ is a 404 in English: no fallback to the Portuguese page",
    wrong.status === 404 && wrong.html.includes('<html lang="en-US">'),
    `HTTP ${wrong.status}`,
  );

  cms.up = false;
  await served("CMS down");

  await stopWorker(worker);
  worker = await local.start(port);
  await served("after a Worker restart");
} catch (error) {
  console.error(error.message);
  results.failures += 1;
} finally {
  await stopWorker(worker);
  cms.server.closeAllConnections();
  await new Promise((done) => cms.server.close(done));
  rmSync(work, { recursive: true, force: true });
}

console.log(
  results.failures === 0
    ? "Bilingual runtime proof passed."
    : `Bilingual runtime proof failed: ${results.failures} check(s).`,
);
process.exit(results.failures === 0 ? 0 : 1);

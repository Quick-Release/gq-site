#!/usr/bin/env node
//
// The consent proof (CONSENT-1, LEGAL-1; ADR 0019), on a generated content
// site whose Frontend's npm dependencies are installed (see consent.sh). The
// consent Runtime's behaviour is gq-content's to prove; this proves that the
// Frontend gq new generates composes it, as a visitor and an operator meet it:
//
//   acceptance  gq-content's shared suite (runConsentAcceptance, CONSENT-1
//               acceptance evidence 1, 2 and 5) passes in Chromium on
//               representative routes: raw HTML, a visit without a decision
//               and one after Reject all load nothing third-party, and the
//               Cookie settings control is on every page;
//   embeds      a published YouTube embed is served without its live source;
//   legal       every page's footer links the language's legal pages and
//               carries Cookie settings;
//   records     POST /gq/consent records a decision in CONSENT_DB, and
//               GET /gq/consent/records/<id> and /gq/consent/stats answer it
//               (the suite's own Reject all among them) with the bearer only;
//   readiness   gq site check's consent part (legal-pages, consent-runtime,
//               third-party-hosts) is ready with GQ Config's GA4 on.
//
// Once for a monolingual Site, then again with a second language. The
// Frontend is built by Alchemy's Astro Cloudflare build and served in workerd
// with a local D1 publication store and consent database, read from a stub CMS with
// GQ Config's Legal Contract and GA4 switched on. Third-party requests the
// browser makes are answered locally, so no visitor traffic leaves the
// machine. Nothing reaches Cloudflare.
//
//   node scripts/smoke/consent.mjs <generated site directory>
//
// CHROMIUM may name a Chromium executable; otherwise Playwright's own.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "playwright";
import { failures, runConsentAcceptance, scanConsentHtml } from "@getquick/content/consent/testing";

import { siteLanguages } from "../../src/manifest/schema.mjs";
import { consentReadiness } from "../../src/site/readiness.mjs";
import {
  buildFrontend,
  checker,
  freePort,
  localWorker,
  runGq,
  stopWorker,
  stubCms,
} from "./frontend-runtime-lib.mjs";

const site = resolve(process.argv[2] ?? ".");
const frontend = join(site, "apps/frontend");
const opsPath = join(site, "gq.ops.json");
const token = "consent-proof-refresh-token-0123456789abcdef";
const readToken = "consent-proof-read-token-0123456789abcdef";
const measurementId = "G-TEST1234";
// The Site's media domain, first party as the Site's own (the logo is there).
const media = "media.example";
const cmsHost = "cms.acme.test";

const results = checker();
const { check } = results;

// The installed @getquick/content's own answers, through its exports, as
// any importer resolves them.
const contentManifest = join(frontend, "node_modules/@getquick/content/package.json");
async function contentExport(entry) {
  const path = JSON.parse(readFileSync(contentManifest, "utf8")).exports[entry].import;
  return import(pathToFileURL(join(contentManifest, "..", path)));
}
const { consentMigrationsDirectory: consentMigrations } =
  await contentExport("./consent/migrations");
const { migrationsDirectory: publicationMigrations } = await contentExport("./migrations");

const youtube =
  '<figure class="wp-block-embed is-provider-youtube"><div class="wp-block-embed__wrapper"><iframe title="Video" width="560" height="315" src="https://www.youtube.com/embed/abcdefghijk?feature=oembed" allowfullscreen></iframe></div></figure>';

/** GQ Config's Legal Contract in a language (`fallback`: an untranslated privacy policy). */
function contract({ privacy, cookies, fallback = false }) {
  return {
    schemaVersion: 1,
    controller: { name: "Acme, Lda.", privacyEmail: "privacy@acme.example", dpoContact: null },
    roles: [
      {
        role: "privacy_policy",
        url: privacy,
        title: null,
        revision: "2026-10-01T09:00:00",
        isFallback: fallback,
      },
      {
        role: "cookie_policy",
        url: cookies,
        title: null,
        revision: "2026-10-02T09:00:00",
        isFallback: false,
      },
    ],
    missingRequired: [],
  };
}

/**
 * The Site's content, by language slug: its home's heading, its pages
 * (URI → title, body and the URI of its translation) and its Legal Contract.
 * The front page embeds nothing; the about page embeds a YouTube video.
 */
const SITES = {
  monolingual: {
    en: {
      heading: "Welcome to Acme",
      pages: {
        "/about/": { title: "About", body: `<p>We make things.</p>${youtube}` },
        "/privacy/": { title: "Privacy policy", body: "<p>Our privacy policy.</p>" },
        "/cookies/": { title: "Cookie policy", body: "<p>Our cookies.</p>" },
      },
      legal: contract({ privacy: "/privacy/", cookies: "/cookies/" }),
    },
  },
  bilingual: {
    pt: {
      heading: "Bem-vindo à Acme",
      pages: {
        "/sobre/": {
          title: "Sobre",
          body: `<p>Fazemos coisas.</p>${youtube}`,
          translation: "/en/about/",
        },
        "/privacidade/": { title: "Política de privacidade", body: "<p>Privacidade.</p>" },
        "/cookies/": {
          title: "Política de cookies",
          body: "<p>Cookies.</p>",
          translation: "/en/cookies/",
        },
      },
      legal: contract({ privacy: "/privacidade/", cookies: "/cookies/" }),
    },
    en: {
      heading: "Welcome to Acme",
      pages: {
        "/en/about/": {
          title: "About",
          body: `<p>We make things.</p>${youtube}`,
          translation: "/sobre/",
        },
        "/en/cookies/": {
          title: "Cookie policy",
          body: "<p>Cookies.</p>",
          translation: "/cookies/",
        },
      },
      // The privacy policy isn't translated: the default language's page.
      legal: contract({ privacy: "/privacidade/", cookies: "/en/cookies/", fallback: true }),
    },
  },
};

/** The stub CMS's answers for `content` (SITES' shape), `languages` from siteLanguages(). */
function answers(content, languages) {
  const multilingual = languages.length > 0;
  const defaultSlug = Object.keys(content)[0];
  const slugOf = (code) => (code ? code.toLowerCase() : defaultSlug);
  const tokens = { colors: [], spacingSizes: [] };
  const pages = Object.entries(content).flatMap(([slug, language]) =>
    Object.entries(language.pages).map(([uri, page]) => ({ uri, slug, ...page })),
  );
  const modifiedGmt = "2026-10-01T09:00:00";
  return {
    HomePage: ({ language }) => {
      const slug = slugOf(language);
      const settings = { title: "Acme", description: "Things" };
      return {
        ...(language ? { language: settings } : { generalSettings: settings }),
        nodeByUri: {
          __typename: "Page",
          id: `home-${slug}`,
          title: "Home",
          content: `<h1>${content[slug].heading}</h1>`,
          isFrontPage: true,
        },
        designTokens: tokens,
      };
    },
    EntryByUri: ({ uri }) => {
      const page = pages.find((each) => each.uri === decodeURI(uri));
      return {
        designTokens: tokens,
        postBy: null,
        pageBy: page
          ? {
              id: `page-${page.uri}`,
              title: page.title,
              content: page.body,
              uri: page.uri,
              status: "publish",
              isRestricted: false,
              modifiedGmt,
              featuredImage: null,
              ...(multilingual
                ? {
                    language: { slug: page.slug },
                    translations: page.translation
                      ? [
                          {
                            uri: page.translation,
                            language: {
                              slug: pages.find((each) => each.uri === page.translation).slug,
                            },
                          },
                        ]
                      : [],
                  }
                : {}),
            }
          : null,
      };
    },
    PublishedRoutes: () => ({
      contentNodes: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          ...(languages.length > 0 ? languages : [{ home: "/" }]).map(({ home }) => ({
            uri: home,
            id: null,
            modifiedGmt: null,
          })),
          ...pages.map((page) => ({ uri: page.uri, id: `page-${page.uri}`, modifiedGmt })),
        ],
      },
    }),
    DesignPresets: () => ({ designTokens: tokens }),
    SiteChrome: ({ language }) => {
      const slug = slugOf(language);
      const about = Object.keys(content[slug].pages)[0];
      return {
        generalSettings: {
          siteIcon: null,
          siteLogo: { node: { sourceUrl: `https://${media}/logo.svg`, altText: "Acme" } },
        },
        menuItems: {
          nodes: [
            {
              id: `about-${slug}`,
              parentId: null,
              label: content[slug].pages[about].title,
              url: about,
              target: null,
            },
          ],
        },
        // GQ Design's Header & Footer selects no pattern.
        header: null,
        footer: null,
      };
    },
    // GQ Config's consent settings, as the content runtime reads them into
    // each language's chrome: the Legal Contract, and GA4 switched on.
    ConsentSettings: ({ language }) => ({
      getquickLegal: content[language ?? defaultSlug].legal,
      googleAnalytics: { enabled: true, measurementId },
    }),
  };
}

const ownOps = readFileSync(opsPath, "utf8");
const browser = await chromium.launch(
  process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
);
try {
  await prove("monolingual", ownOps);
  const ops = JSON.parse(ownOps);
  ops.wordpress.plugins.push("polylang-pro", "gq-polylang-graphql");
  ops.wordpress.locale = "pt_PT_ao90";
  ops.wordpress.languages = [{ locale: "en_US", slug: "en" }];
  await prove("bilingual", `${JSON.stringify(ops, null, 2)}\n`);
} finally {
  writeFileSync(opsPath, ownOps);
  await browser.close();
}

async function prove(kind, opsText) {
  console.log(`\n--- A ${kind} Site ---`);
  writeFileSync(opsPath, opsText);
  const ops = JSON.parse(opsText);
  const languages = siteLanguages(ops);
  const content = SITES[kind];
  const cms = stubCms([]);
  cms.answers = answers(content, languages);
  const work = mkdtempSync(join(tmpdir(), "gq-consent-"));
  const local = localWorker({
    site,
    work,
    migrations: publicationMigrations,
    consentMigrations,
    vars: { FRONTEND_REFRESH_TOKEN: token, CONSENT_READ_TOKEN: readToken },
  });
  let worker;
  try {
    await cms.start();
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    buildFrontend(frontend, origin, `http://127.0.0.1:${cms.port}/graphql`);
    for (const binding of ["PUBLICATION_DB", "CONSENT_DB"]) {
      const migrate = local.migrate(binding);
      check(`${binding} is migrated locally`, migrate.status === 0, migrate.stderr);
    }
    worker = await local.start(port);
    const refresh = await runGq(site, ["frontend", "refresh", "--url", origin, "--json"], {
      FRONTEND_REFRESH_TOKEN: token,
    });
    check(
      "gq frontend refresh prepares the Site",
      refresh.code === 0 && refresh.json?.ready === true,
      JSON.stringify(refresh.json) + refresh.stderr,
    );

    const routes = [
      ...(languages.length > 0 ? languages.map(({ home }) => home) : ["/"]),
      ...Object.values(content).flatMap((language) => Object.keys(language.pages)),
    ];
    const firstParty = { siteOrigin: origin, firstPartyHosts: [media] };

    // --- Embeds and legal links, in the HTML as served ---
    for (const route of routes) {
      const response = await fetch(`${origin}${route}`);
      const html = await response.text();
      const scan = scanConsentHtml(html, firstParty);
      check(
        `${route} is served with no live third-party source`,
        response.status === 200 && scan.liveThirdParty.length === 0,
        `HTTP ${response.status}: ${JSON.stringify(scan.liveThirdParty)}`,
      );
      const slug = languages.find(({ home }) => home !== "/" && route.startsWith(home))?.slug;
      const legal = content[slug ?? Object.keys(content)[0]].legal;
      const footer = /<footer\b[^>]*>([\s\S]*?)<\/footer>/.exec(html)?.[1] ?? "";
      const links = Object.fromEntries(
        [...footer.matchAll(/<a href="([^"]+)" data-gq-legal-role="([a-z_]+)"/g)].map((m) => [
          m[2],
          m[1],
        ]),
      );
      check(
        `${route}'s footer links its language's legal pages and carries Cookie settings`,
        JSON.stringify(links) ===
          JSON.stringify(Object.fromEntries(legal.roles.map(({ role, url }) => [role, url]))) &&
          footer.includes("data-gq-consent-open"),
        JSON.stringify(links),
      );
    }
    const about = Object.keys(Object.values(content)[0].pages)[0];
    const aboutScan = scanConsentHtml(await (await fetch(`${origin}${about}`)).text(), firstParty);
    check(
      `${about}'s YouTube embed is a placeholder (no catalog service declared: blocked)`,
      JSON.stringify(aboutScan.blocked) ===
        JSON.stringify([{ host: "www.youtube.com", tag: "iframe" }]),
      JSON.stringify(aboutScan),
    );

    // --- gq-content's shared acceptance suite, in Chromium ---
    const answered = [];
    const suite = await runConsentAcceptance(
      {
        async newContext(options) {
          const context = await browser.newContext(options);
          // Captured by the suite first, then answered here: nothing leaves.
          await context.route(
            (url) => url.origin !== origin,
            (route) => {
              answered.push(route.request().url());
              return route.fulfill({
                contentType: "text/html",
                body: "<!doctype html><title>stub</title>",
              });
            },
          );
          return context;
        },
      },
      { ...firstParty, routes },
    );
    for (const each of suite) {
      console.log(
        `  ${each.passed ? "PASS" : "FAIL"} ${each.criterion} ${each.route}: ${each.detail}`,
      );
    }
    check(
      `gq-content's runConsentAcceptance passes all ${suite.length} checks on ${routes.join(" ")}`,
      suite.length > 0 && failures(suite).length === 0,
      `${failures(suite).length} failed`,
    );
    const thirdParty = answered.filter((url) => new URL(url).hostname !== media);
    check(
      "the browser requested nothing third-party but the Site's media",
      thirdParty.length === 0,
      thirdParty.join(", "),
    );

    // --- Records, in CONSENT_DB ---
    const home = await (await fetch(`${origin}/`)).text();
    const config = JSON.parse(
      /<script type="application\/json" id="gq-consent-config">(.*?)<\/script>/.exec(home)[1],
    );
    check(
      "the homepage's consent configuration has GA4 from GQ Config",
      JSON.stringify(config.configuration.services) === JSON.stringify(["consent", "ga4"]),
      JSON.stringify(config.configuration.services),
    );
    const consentId = randomUUID();
    const record = await fetch(`${origin}/gq/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        consentId,
        decidedAt: new Date().toISOString(),
        configVersion: config.configuration.version,
        legalRevisions: config.legalRevisions,
        decisions: { preferences: false, analytics: true, marketing: false, external_media: false },
        action: "custom",
        language: config.language,
        uiVersion: config.uiVersion,
      }),
    });
    check(
      "POST /gq/consent records a decision",
      record.status === 201,
      `HTTP ${record.status}: ${await record.text()}`,
    );
    const anonymous = await fetch(`${origin}/gq/consent/records/${consentId}`);
    check(
      "its record isn't readable without the bearer",
      anonymous.status === 401,
      `HTTP ${anonymous.status}`,
    );
    const read = await fetch(`${origin}/gq/consent/records/${consentId}`, {
      headers: { Authorization: `Bearer ${readToken}` },
    });
    const body = await read.json().catch(() => null);
    check(
      `GET /gq/consent/records/<id> answers it from CONSENT_DB, for Site ${ops.project}`,
      read.status === 200 &&
        body?.records?.length === 1 &&
        body.records[0].siteId === ops.project &&
        body.records[0].decisions.analytics === true,
      `HTTP ${read.status}: ${JSON.stringify(body)}`,
    );
    const day = new Date().toISOString().slice(0, 10);
    const stats = await (
      await fetch(`${origin}/gq/consent/stats?from=${day}&to=${day}`, {
        headers: { Authorization: `Bearer ${readToken}` },
      })
    ).json();
    check(
      "the suite's Reject all decisions were recorded too",
      stats.byAction?.reject_all > 0 && stats.byAction?.custom === 1,
      JSON.stringify(stats),
    );

    // --- gq site check's consent part, against this Frontend ---
    const readinessOps = {
      ...ops,
      domains: { admin: cmsHost, frontend: `127.0.0.1` },
      media: { bucket: "acme-media", domain: media },
    };
    const legalAnswer = (legal, language) => ({
      ...legal,
      language,
      roles: legal.roles.map(({ role, isFallback }) => ({ role, isFallback })),
    });
    const readiness = await consentReadiness({
      ops: readinessOps,
      env: {},
      origin: new URL(origin),
      languages,
      fetch: async (url, init) =>
        new URL(url).hostname === cmsHost
          ? Response.json({
              data: {
                googleAnalytics: { enabled: true, measurementId },
                legal: legalAnswer(Object.values(content)[0].legal, Object.keys(content)[0]),
                ...Object.fromEntries(
                  languages
                    .filter(({ isDefault }) => !isDefault)
                    .map(({ code, slug }) => [
                      `legal_${code}`,
                      legalAnswer(content[slug].legal, slug),
                    ]),
                ),
              },
            })
          : fetch(url, init),
    });
    for (const each of readiness) {
      check(
        `gq site check: ${each.name} is ${each.status === "warn" ? "a warning" : "ready"} with GA4 on (${each.detail})`,
        each.status === "ok" ||
          (each.name === "legal-pages" && each.status === "warn" && languages.length > 0),
        each.action ?? "",
      );
    }
  } finally {
    await stopWorker(worker);
    await cms.stop();
    rmSync(work, { recursive: true, force: true });
  }
}

if (results.failures > 0) {
  console.error(`${results.failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nThe generated Site composes the consent Runtime: UI, embeds, routes and records.");

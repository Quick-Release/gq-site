#!/usr/bin/env node
// Actual saved Hero HTML and public node through a generated Site declaring YouTube.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import {
  buildFrontend,
  freePort,
  localWorker,
  runGq,
  stopWorker,
  stubCms,
} from "./frontend-runtime-lib.mjs";

assert.ok(process.argv[2], "Pass a generated Site");
const site = resolve(process.argv[2]);
const frontend = join(site, "apps/frontend");
const configurationPath = join(frontend, "src/lib/content.ts");
const source = readFileSync(configurationPath, "utf8");
assert.ok(
  source.includes("services: []"),
  "the generated Site starts without optional media services",
);
const fixture = new URL("../../test/fixtures/presentation/", import.meta.url);
const saved = readFileSync(new URL("hero-youtube.html", fixture), "utf8");
const publicDocument = JSON.parse(readFileSync(new URL("hero-saved-public.json", fixture), "utf8"));
const youtube = publicDocument.blocks.find(
  (item) => item.fixture === "getquick-video-hero-saved-youtube",
).node;
const installed = join(frontend, "node_modules/@getquick/content");
const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
const contentExport = (name) =>
  import(pathToFileURL(join(installed, manifest.exports[name].import)));
const { migrationsDirectory } = await contentExport("./migrations");
const { consentMigrationsDirectory } = await contentExport("./consent/migrations");
const work = mkdtempSync(join(tmpdir(), "gq-presentation-hero-"));
const token = "hero-production-proof-refresh-token-0123456789";
const local = localWorker({
  site,
  work,
  migrations: migrationsDirectory,
  consentMigrations: consentMigrationsDirectory,
  vars: { FRONTEND_REFRESH_TOKEN: token },
});
const cms = stubCms([]);
let browser;
let worker;
try {
  // Ordinary Site configuration, not a template policy or alternate renderer.
  writeFileSync(configurationPath, source.replace("services: []", 'services: ["youtube"]'));
  await cms.start();
  const origin = `http://127.0.0.1:${await freePort()}`;
  buildFrontend(frontend, origin, `http://127.0.0.1:${cms.port}/graphql`);
  cms.entries.set("/hero-consent/", { id: "79", title: "Hero consent", content: saved });
  cms.answers.EntryByUri = ({ uri }) => ({
    postBy: null,
    pageBy: {
      ...cms.entries.get(uri),
      uri,
      status: "publish",
      isRestricted: false,
      modifiedGmt: "2026-10-24T00:00:00",
      featuredImage: null,
    },
    designTokens: { colors: [], spacingSizes: [] },
  });
  cms.answers.SiteChrome = () => ({
    generalSettings: { siteIcon: null, siteLogo: null },
    menuItems: { nodes: [] },
    header: { title: "Saved Hero", blocksJson: JSON.stringify([youtube]) },
    footer: null,
  });
  for (const binding of ["PUBLICATION_DB", "CONSENT_DB"]) {
    const result = local.migrate(binding);
    assert.equal(result.status, 0, result.stderr);
  }
  worker = await local.start(Number(new URL(origin).port));
  const refreshed = await runGq(site, ["frontend", "refresh", "--url", origin, "--json"], {
    FRONTEND_REFRESH_TOKEN: token,
  });
  assert.equal(refreshed.code, 0, refreshed.stdout + refreshed.stderr);
  browser = await chromium.launch(
    process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
  );
  const page = await browser.newPage({
    reducedMotion: "reduce",
    viewport: { width: 640, height: 900 },
  });
  let playerRequests = 0;
  await page.route("https://www.youtube-nocookie.com/**", (route) => {
    playerRequests++;
    return route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Local player fixture</title>",
    });
  });
  await page.route("https://example.test/poster.jpg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"/>',
    }),
  );
  assert.equal((await page.goto(`${origin}/hero-consent/`)).status(), 200);
  const documentRoot = await page.locator("html").elementHandle();
  const heroes = page.locator(".wp-block-getquick-design-video-hero");
  const frames = heroes.locator(":scope > .gqd-video-hero__media > iframe");
  assert.equal(await heroes.count(), 2, "saved body and actual public neutral chrome both render");
  assert.equal(await frames.count(), 0, "players are absent before consent");
  assert.equal(playerRequests, 0);
  await page.locator("#gq-consent-banner [data-gq-consent-accept-all]").click();
  await frames.first().waitFor({ state: "attached" });
  assert.equal(await frames.count(), 2);
  for (const frame of await frames.all()) {
    assert.equal(
      await frame.getAttribute("src"),
      null,
      "grant under reduced motion stays deferred",
    );
    assert.ok(
      (await frame.getAttribute("data-src")).startsWith("https://www.youtube-nocookie.com/"),
    );
    assert.equal(await frame.getAttribute("title"), 'Video "di" sfondo & musica');
  }
  assert.equal(playerRequests, 0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForFunction(
    (root) =>
      [...root.querySelectorAll(".gqd-video-hero__media > iframe")].every((frame) =>
        frame.hasAttribute("src"),
      ),
    documentRoot,
  );
  for (const [width, frameWidth, frameHeight, left, top] of [
    [640, 455.111111, 256, -67.555556, 0],
    [900, 450, 253.125, 0, 1.4375],
    [1024, 512, 256, 0, 0],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction(
      ({ root, frameWidth, frameHeight }) =>
        [...root.querySelectorAll(".gqd-video-hero__media > iframe")].every((frame) => {
          const box = frame.getBoundingClientRect();
          return Math.abs(box.width - frameWidth) < 0.1 && Math.abs(box.height - frameHeight) < 0.1;
        }),
      { root: documentRoot, frameWidth, frameHeight },
    );
    for (const hero of await heroes.all()) {
      const box = await hero.boundingBox();
      assert.equal(box.width, width / 2);
      assert.equal(box.height, 256);
      const media = await hero.locator(":scope > .gqd-video-hero__media").boundingBox();
      assert.equal(media.width, box.width);
      assert.equal(media.height, 256);
      const frame = await hero.locator(":scope > .gqd-video-hero__media > iframe").boundingBox();
      assert.ok(Math.abs(frame.x - media.x - left) < 0.1);
      assert.ok(Math.abs(frame.y - media.y - top) < 0.1);
    }
  }
  assert.ok(playerRequests > 0, "players load only when consent and motion both permit");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(
    (root) =>
      [...root.querySelectorAll(".gqd-video-hero__media > iframe")].every(
        (frame) => !frame.hasAttribute("src"),
      ),
    documentRoot,
  );
  await page.locator("footer [data-gq-consent-open]").click();
  const preferencesClosed = page
    .locator("#gq-consent-preferences")
    .evaluate(
      (element) =>
        new Promise((resolve) =>
          element.addEventListener("close", () => resolve(true), { once: true }),
        ),
    );
  await Promise.all([
    preferencesClosed,
    page.locator("#gq-consent-preferences [data-gq-consent-reject-all]").click(),
  ]);
  await page.locator("#gq-consent-preferences").waitFor({ state: "hidden" });
  await frames.first().waitFor({ state: "detached" });
  assert.equal(await frames.count(), 0);
  for (const hero of await heroes.all()) {
    assert.equal(await hero.locator(".gqd-video-hero__poster").isVisible(), true);
    const link = hero.getByRole("link", { name: "Discover more", exact: true });
    await link.focus();
    assert.equal(
      await link.evaluate((element) => element === element.ownerDocument.activeElement),
      true,
    );
  }
  console.log(
    "✓ actual saved/public Hero: deferred consent grant, reduced motion, cover/contain/reset geometry, withdrawal, poster and focus",
  );
} finally {
  writeFileSync(configurationPath, source);
  await browser?.close();
  await stopWorker(worker);
  await cms.stop();
  rmSync(work, { recursive: true, force: true });
}

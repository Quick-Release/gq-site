#!/usr/bin/env node
// The generated content starter, built before the CMS serves the saved document.
// No parser or reference renderer substitutes for its public route and CSS.
// Usage: node scripts/smoke/presentation.mjs <generated Site> [rendered document]
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const fixture = new URL("../../test/fixtures/presentation/", import.meta.url);
const saved = readFileSync(
  process.argv[3] ? resolve(process.argv[3]) : new URL("container-rendered.html", fixture),
  "utf8",
);
const publicDocument = JSON.parse(readFileSync(new URL("container-public.json", fixture), "utf8"));
const mediaDocument = JSON.parse(readFileSync(new URL("media-public.json", fixture), "utf8"));
const themeDocument = JSON.parse(readFileSync(new URL("theme-delivery.json", fixture), "utf8"));
const layoutDocument = JSON.parse(readFileSync(new URL("layout-delivery.json", fixture), "utf8"));
const heroSaved = readFileSync(new URL("hero-saved.html", fixture), "utf8");
const installed = join(frontend, "node_modules/@getquick/content");
const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
const { resolveDesignTheme } = await import(
  pathToFileURL(join(installed, manifest.exports["."].import))
);
const { migrationsDirectory } = await import(
  pathToFileURL(join(installed, manifest.exports["./migrations"].import))
);
const work = mkdtempSync(join(tmpdir(), "gq-presentation-"));
const token = "presentation-proof-refresh-token-0123456789";
const local = localWorker({
  site,
  work,
  migrations: migrationsDirectory,
  vars: { FRONTEND_REFRESH_TOKEN: token },
});
const cms = stubCms([]);
let worker;
let browser;
try {
  await cms.start();
  const origin = `http://127.0.0.1:${await freePort()}`;
  buildFrontend(frontend, origin, `http://127.0.0.1:${cms.port}/graphql`);
  // The supported settings arrive only after production CSS has been built.
  cms.entries.set("/presentation/", {
    id: "73",
    title: "Presentation",
    content: saved,
  });
  cms.entries.set("/media/", {
    id: "77",
    title: "Media",
    content: mediaDocument.html.join(""),
  });
  cms.entries.set("/layout/", { id: "75", title: "Layout", content: layoutDocument.html });
  cms.entries.set("/hero/", { id: "79", title: "Hero", content: heroSaved });
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
  // The public neutral tree was serialized from the same saved editor document.
  // The HTTP GraphQL envelope here is a stub, not a live producer proof.
  const pattern = {
    title: "Saved Container",
    blocksJson: JSON.stringify([publicDocument.blocks[0].node]),
  };
  cms.answers.SiteChrome = () => ({
    generalSettings: { siteIcon: null, siteLogo: null },
    menuItems: { nodes: [] },
    header: pattern,
    footer: pattern,
  });
  const migration = local.migrate();
  assert.equal(migration.status, 0, migration.stderr);
  worker = await local.start(Number(new URL(origin).port));
  const refresh = await runGq(site, ["frontend", "refresh", "--url", origin, "--json"], {
    FRONTEND_REFRESH_TOKEN: token,
  });
  assert.equal(refresh.code, 0, refresh.stdout + refresh.stderr);
  browser = await chromium.launch(
    process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
  );
  const page = await browser.newPage();
  await page.route("https://example.test/poster.jpg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="green"/></svg>',
    }),
  );
  await page.route("https://design.example/image.jpg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"/>',
    }),
  );
  await page.route("https://gqd-media.test/photo.svg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="green"/></svg>',
    }),
  );
  const response = await page.goto(`${origin}/presentation/`);
  assert.equal(response.status(), 200);
  for (const region of [".prose-wp", "header", "footer .gqd-content"]) {
    const containers = page.locator(`${region} .wp-block-getquick-design-container`);
    assert.equal(await containers.count(), 3, `${region} retains all saved children`);
    const bare = containers.nth(1);
    const authored = containers.nth(2);
    assert.equal(await bare.textContent().then((text) => text.trim()), "Bare nested container");
    assert.equal(
      await authored.textContent().then((text) => text.trim()),
      "Authored nested container",
    );
    for (const direction of ["ltr", "rtl"]) {
      await page.locator("html").evaluate((element, value) => {
        element.dir = value;
      }, direction);
      // Independent Tailwind 4.3.3 defaults, immediately around every threshold.
      for (const [width, cap] of [
        [639, 639],
        [640, 640],
        [641, 640],
        [767, 640],
        [768, 768],
        [769, 768],
        [1023, 768],
        [1024, 1024],
        [1025, 1024],
        [1279, 1024],
        [1280, 1280],
        [1281, 1280],
        [1535, 1280],
        [1536, 1536],
        [1537, 1536],
      ]) {
        await page.setViewportSize({ width, height: 900 });
        const defaults = await bare.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const style = element.ownerDocument.defaultView.getComputedStyle(element);
          return { width: box.width, x: box.x, padding: style.paddingInlineStart };
        });
        assert.ok(
          Math.abs(defaults.width - cap) < 0.1,
          `default cap at ${width}: ${defaults.width}`,
        );
        assert.equal(
          defaults.x,
          direction === "rtl" ? width - cap : 0,
          `Container doesn't center at ${width}`,
        );
        assert.equal(defaults.padding, "0px");
        const box = await authored.boundingBox();
        const expected = width >= 1024 ? 512 : width >= 768 ? cap : width / 2;
        assert.ok(Math.abs(box.width - expected) < 0.1, `authored width at ${width}: ${box.width}`);
        assert.ok(Math.abs(box.x - (width - expected) / 2) < 0.1, `explicit centering at ${width}`);
        assert.equal(
          await authored.evaluate(
            (el) => el.ownerDocument.defaultView.getComputedStyle(el).paddingInlineStart,
          ),
          "16px",
        );
      }
    }
  }
  console.log(
    "✓ late-authored nested Container defaults and overrides in production Astro/workerd",
  );
  await page.setViewportSize({ width: 900, height: 900 });
  assert.equal((await page.goto(`${origin}/media/`)).status(), 200);
  const image = page.locator(".prose-wp .wp-block-image > a > img");
  await image.evaluate((element) => element.decode());
  const imageBox = await image.boundingBox();
  const wrapperBox = await page.locator(".prose-wp .wp-block-image").boundingBox();
  assert.equal(imageBox.height, 192, "Image height uses 48 default spacing units");
  assert.equal(imageBox.width, wrapperBox.width, "linked media fills its authored wrapper");
  assert.equal(await image.getAttribute("alt"), "Mountain");
  assert.equal(await image.locator("..").getAttribute("href"), "https://example.test/route");
  assert.equal(await page.locator(".prose-wp figcaption").textContent(), "Caption");
  console.log("✓ real native saved Image geometry, link, alternate text and caption");
  // The same saved document receives a new resolved theme without rebuilding.
  const theme = resolveDesignTheme({
    spacing: "0.5rem",
    breakpoints: { sm: "42rem", md: "52rem", lg: "68rem", xl: "84rem", "2xl": "100rem" },
  });
  cms.answers.DesignPresets = () => ({ designTokens: { colors: [], spacingSizes: [], theme } });
  const updated = await runGq(site, ["frontend", "refresh", "--url", origin, "--json"], {
    FRONTEND_REFRESH_TOKEN: token,
  });
  assert.equal(updated.code, 0, updated.stdout + updated.stderr);
  await page.goto(`${origin}/presentation/`);
  for (const [width, expected] of [
    [831, 415.5],
    [832, 832],
    [833, 832],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    for (const region of [".prose-wp", "header", "footer .gqd-content"]) {
      const authored = page.locator(`${region} .wp-block-getquick-design-container`).nth(2);
      assert.equal(
        (await authored.boundingBox()).width,
        expected,
        `${region} resolved md threshold at ${width}`,
      );
      assert.equal(
        await authored.evaluate(
          (el) => el.ownerDocument.defaultView.getComputedStyle(el).paddingInlineStart,
        ),
        "32px",
        "theme spacing refresh reaches saved presentation",
      );
    }
  }
  console.log("✓ resolved breakpoint and spacing updates reach production CSS without rebuilding");
  for (const delivery of themeDocument.deliveries) {
    cms.entries.set("/theme/", { id: "74", title: "Theme", content: delivery.publicHtml });
    cms.answers.DesignPresets = () => ({
      designTokens: { ...delivery.tokens, spacingSizes: [] },
    });
    const refreshed = await runGq(site, ["frontend", "refresh", "--url", origin, "--json"], {
      FRONTEND_REFRESH_TOKEN: token,
    });
    assert.equal(refreshed.code, 0, refreshed.stdout + refreshed.stderr);
    assert.equal((await page.goto(`${origin}/theme/`)).status(), 200);
    const sample = page.locator(".prose-wp #gqd-theme-sample");
    const reset = await sample.evaluate((element) => {
      const style = (target) => element.ownerDocument.defaultView.getComputedStyle(target);
      const heading = style(element.querySelector("h2"));
      const list = style(element.querySelector("ul"));
      const image = style(element.querySelector("img"));
      return {
        heading: { size: heading.fontSize, weight: heading.fontWeight },
        list: list.listStyleType,
        image: { display: image.display, maxWidth: image.maxWidth, border: image.borderTopWidth },
      };
    });
    assert.deepEqual(
      reset,
      {
        heading: { size: "16px", weight: "400" },
        list: "none",
        image: { display: "block", maxWidth: "100%", border: "0px" },
      },
      `${delivery.state} actual saved heading/list/media Preflight`,
    );
    const thresholds =
      delivery.state === "default" ? [640, 768, 1024, 1280, 1536] : [640, 800, 1024, 1280, 1536];
    for (const threshold of thresholds) {
      for (const width of [threshold - 1, threshold, threshold + 1]) {
        await page.setViewportSize({ width, height: 900 });
        const expectedCap = thresholds.filter((value) => value <= width).at(-1);
        const bare = page.locator(".prose-wp #gqd-theme-bare");
        assert.equal(
          await bare.evaluate(
            (element) => element.ownerDocument.defaultView.getComputedStyle(element).maxWidth,
          ),
          expectedCap ? `${expectedCap}px` : "none",
          `${delivery.state} actual saved Container cap at ${width}`,
        );
      }
    }
  }
  console.log(
    "✓ real saved public theme deliveries: scoped Preflight and all default/overridden breakpoint edges",
  );
  cms.answers.DesignPresets = () => ({
    designTokens: { ...themeDocument.deliveries[0].tokens, spacingSizes: [] },
  });
  const restored = await runGq(site, ["frontend", "refresh", "--url", origin, "--json"], {
    FRONTEND_REFRESH_TOKEN: token,
  });
  assert.equal(restored.code, 0, restored.stdout + restored.stderr);
  await page.setViewportSize({ width: 900, height: 900 });
  assert.equal((await page.goto(`${origin}/layout/`)).status(), 200);
  const columns = page.locator(".prose-wp #layout-columns");
  assert.equal(
    await columns.evaluate(
      (element) => element.ownerDocument.defaultView.getComputedStyle(element).display,
    ),
    "flex",
    "native Columns retain their structural display without an authored override",
  );
  console.log("✓ actual saved native Columns structural display without core block CSS");

  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto(`${origin}/media/`);
  const cover = page.locator(".prose-wp .wp-block-cover");
  const background = cover.locator(":scope > .wp-block-cover__image-background");
  await background.evaluate((element) => element.decode());
  const coverBox = await cover.boundingBox();
  assert.equal(coverBox.height, 192, "Cover's authored height bounds its box");
  for (const layer of [background, cover.locator(":scope > .wp-block-cover__background")]) {
    const box = await layer.boundingBox();
    assert.equal(box.width, coverBox.width, "direct Cover layers fill its width");
    assert.equal(box.height, 192, "direct Cover layers fill its authored height");
    assert.equal(box.x, coverBox.x);
    assert.equal(box.y, coverBox.y);
  }
  assert.equal(
    await cover
      .locator(":scope > .wp-block-cover__background")
      .evaluate((element) => element.ownerDocument.defaultView.getComputedStyle(element).opacity),
    "0.5",
  );
  const foreground = cover.locator(":scope > .wp-block-cover__inner-container");
  assert.equal((await foreground.textContent()).trim(), "Readable foreground");
  assert.equal(
    await foreground.evaluate(
      (element) => element.ownerDocument.defaultView.getComputedStyle(element).opacity,
    ),
    "1",
    "overlay opacity never dims foreground content",
  );
  console.log("✓ actual native Cover background, overlay and foreground without core block CSS");
  assert.equal((await page.goto(`${origin}/hero/`)).status(), 200);
  const hero = page.locator(".prose-wp .wp-block-getquick-design-video-hero");
  const heroBox = await hero.boundingBox();
  assert.equal(heroBox.width, 450, "Hero half width stays relative to its containing box");
  assert.equal(heroBox.height, 256, "Hero spacing height is independent of viewport height");
  const media = hero.locator(":scope > .gqd-video-hero__media");
  await media.locator("img").evaluate((element) => element.decode());
  assert.equal(
    await media.evaluate(
      (element) => element.ownerDocument.defaultView.getComputedStyle(element).zIndex,
    ),
    "0",
    "decorative media stays above the Hero background and below its foreground",
  );
  const mediaBox = await media.boundingBox();
  assert.equal(mediaBox.width, 450);
  assert.equal(mediaBox.height, 256);
  const contentBox = await hero.locator(":scope > .gqd-video-hero__content").boundingBox();
  assert.equal(contentBox.width, 450);
  assert.equal(contentBox.height, 256);
  const heroLink = hero.getByRole("link", { name: "Explore the collection" });
  await heroLink.focus();
  assert.equal(
    await heroLink.evaluate((element) => element === element.ownerDocument.activeElement),
    true,
  );
  console.log("✓ real saved Hero box, independent foreground and keyboard-accessible link");
} finally {
  await browser?.close();
  await stopWorker(worker);
  await cms.stop();
  rmSync(work, { recursive: true, force: true });
}

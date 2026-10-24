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
const mediaDocument = JSON.parse(
  readFileSync(new URL("media-source-public.json", fixture), "utf8"),
);
const themeDocument = JSON.parse(readFileSync(new URL("theme-delivery.json", fixture), "utf8"));
const layoutDocument = JSON.parse(readFileSync(new URL("layout-delivery.json", fixture), "utf8"));
const heroSaved = readFileSync(new URL("hero-saved.html", fixture), "utf8");
const carouselDocument = JSON.parse(readFileSync(new URL("carousel-public.json", fixture), "utf8"));
const typographyDocument = JSON.parse(
  readFileSync(new URL("typography-delivery.json", fixture), "utf8"),
);
const queryDocument = JSON.parse(
  readFileSync(new URL("query-composition/post-public.json", fixture), "utf8"),
);
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
  cms.entries.set("/carousel/", { id: "78", title: "Carousel", content: "<p>Carousel proof</p>" });
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
  await page.route("https://example.test/*.svg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><rect width="640" height="320" fill="blue"/></svg>',
    }),
  );
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
  assert.equal(wrapperBox.height, 192, "Image wrapper height uses 48 default spacing units");
  const captionBox = await page.locator(".prose-wp figcaption").boundingBox();
  assert.equal(
    imageBox.height + captionBox.height,
    wrapperBox.height,
    "caption fits inside the authored Image box",
  );
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
  for (const delivery of typographyDocument.cases) {
    cms.entries.set("/typography/", {
      id: "76",
      title: "Typography",
      content: delivery.renderedHTML,
    });
    cms.answers.DesignPresets = () => ({
      designTokens: { ...delivery.tokens, spacingSizes: [] },
    });
    cms.answers.SiteChrome = () => ({
      generalSettings: { siteIcon: null, siteLogo: null },
      menuItems: { nodes: [] },
      header: { title: "Typography", blocksJson: JSON.stringify(delivery.neutralNodes) },
      footer: null,
    });
    const refreshed = await runGq(site, ["frontend", "refresh", "--url", origin, "--json"], {
      FRONTEND_REFRESH_TOKEN: token,
    });
    assert.equal(refreshed.code, 0, refreshed.stdout + refreshed.stderr);
    assert.equal((await page.goto(`${origin}/typography/`)).status(), 200);
    for (const region of [".prose-wp", "header.gqd-content"]) {
      const root = page.locator(region);
      const list = root.locator("ol");
      assert.equal(await list.count(), 1, `${delivery.name} ${region}: ordered list is rendered`);
      assert.equal(await list.getAttribute("start"), "3");
      assert.equal(await list.getAttribute("reversed"), "");
      assert.equal(
        await list
          .locator(":scope > li")
          .evaluate((element) => element.firstChild.textContent.trim()),
        "Parent item",
        `${delivery.name} ${region}: parent rich text survives null list content`,
      );
      assert.equal((await list.locator("ul > li").textContent()).trim(), "Nested item");
      const button = root.getByRole("link", { name: "Go shopping", exact: true });
      assert.equal(await button.getAttribute("href"), "/shop");
      assert.equal(await button.getAttribute("title"), "Spend > save");
      assert.equal(await button.getAttribute("target"), "_blank");
      assert.equal(await button.getAttribute("rel"), "noopener");
      assert.equal(await button.locator("strong").textContent(), "shopping");
    }
  }
  console.log("✓ real typography body and neutral chrome retain nested list and button rich text");
  cms.answers.DesignPresets = () => ({
    designTokens: { ...themeDocument.deliveries[0].tokens, spacingSizes: [] },
  });
  cms.answers.SiteChrome = () => ({
    generalSettings: { siteIcon: null, siteLogo: null },
    menuItems: { nodes: [] },
    header: { title: "Carousel", blocksJson: JSON.stringify([carouselDocument.blocks[0].node]) },
    footer: null,
  });
  const carouselRefresh = await runGq(site, ["frontend", "refresh", "--url", origin, "--json"], {
    FRONTEND_REFRESH_TOKEN: token,
  });
  assert.equal(carouselRefresh.code, 0, carouselRefresh.stdout + carouselRefresh.stderr);
  await page.setViewportSize({ width: 640, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal((await page.goto(`${origin}/carousel/`)).status(), 200);
  const carousel = page.getByRole("region", { name: "Carousel", exact: true, includeHidden: true });
  const slides = carousel.locator(".wp-block-getquick-design-slider img");
  assert.equal(await slides.count(), 3, "the actual public producer retains all ordered slides");
  const visible = await Promise.all([0, 1, 2].map((index) => slides.nth(index).isVisible()));
  assert.deepEqual(
    visible,
    [true, false, false],
    "only the active slide occupies the rendered Carousel",
  );
  assert.equal((await carousel.boundingBox()).height, 150);
  assert.equal(await carousel.getByRole("link").getAttribute("href"), "/first-slide");
  assert.equal(
    await carousel.getByRole("navigation").count(),
    0,
    "saved navigation visible=false remains hidden",
  );
  for (const width of [767, 768, 769, 1279, 1280, 1281]) {
    await page.setViewportSize({ width, height: 900 });
    const box = await carousel.boundingBox();
    if (width >= 768 && width < 1280) {
      assert.equal(box, null, `display:none removes Carousel layout at ${width}`);
    } else {
      assert.ok(box, `Carousel is restored at ${width}`);
      assert.equal(
        await carousel.evaluate(
          (element) => element.ownerDocument.defaultView.getComputedStyle(element).display,
        ),
        "grid",
        "display reset restores the actual Carousel layout",
      );
      if (width >= 1280) assert.notEqual(box.height, 240, "Auto clears inherited explicit height");
    }
  }
  await page.setViewportSize({ width: 640, height: 900 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await carousel.getByRole("link").focus();
  await page.waitForTimeout(3200);
  assert.equal(
    await slides.nth(0).isVisible(),
    true,
    "autoplay pauses while a slide link has focus",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await page.waitForTimeout(3200);
  assert.equal(
    await slides.nth(0).isVisible(),
    true,
    "reduced motion keeps the active slide still",
  );
  console.log("✓ actual saved/public Carousel enhances ordered slides through production chrome");
  // Supporting public-input variant: expose the fixture's existing controls.
  // This variant is not claimed as a separate captured editor save.
  const withControls = structuredClone(carouselDocument.blocks[0].node);
  withControls.children.find(
    (child) => child.name === "getquick-design/carousel-navigation",
  ).attributes.visible = true;
  cms.answers.SiteChrome = () => ({
    generalSettings: { siteIcon: null, siteLogo: null },
    menuItems: { nodes: [] },
    header: { title: "Carousel controls", blocksJson: JSON.stringify([withControls]) },
    footer: null,
  });
  const controlsRefresh = await runGq(site, ["frontend", "refresh", "--url", origin, "--json"], {
    FRONTEND_REFRESH_TOKEN: token,
  });
  assert.equal(controlsRefresh.code, 0, controlsRefresh.stdout + controlsRefresh.stderr);
  await page.goto(`${origin}/carousel/`);
  const next = carousel.getByRole("button", { name: "Next slide", exact: true });
  await next.click();
  assert.equal(await slides.nth(1).isVisible(), true);
  await next.press("ArrowRight");
  assert.equal(await slides.nth(2).isVisible(), true);
  assert.equal(
    await next.evaluate((element) => element === element.ownerDocument.activeElement),
    true,
  );
  await next.press("Home");
  assert.equal(await slides.nth(0).isVisible(), true);
  await carousel.getByRole("button", { name: "Go to slide 3", exact: true }).click();
  assert.equal(await slides.nth(2).isVisible(), true);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.getByRole("button", { name: "Cookie settings", exact: true }).focus();
  await carousel.hover();
  await page.waitForTimeout(3200);
  assert.equal(await slides.nth(2).isVisible(), true, "hover pauses autoplay");
  await page.mouse.move(639, 899);
  await page.waitForTimeout(3200);
  assert.equal(
    await slides.nth(0).isVisible(),
    true,
    "autoplay advances after focus and hover leave",
  );
  console.log("✓ public Carousel controls, keyboard focus, hover pause and autoplay resume");
  const navigation = carousel.getByRole("navigation", { name: "Carousel navigation", exact: true });
  assert.equal(
    await navigation.evaluate(
      (element) => element.ownerDocument.defaultView.getComputedStyle(element).backgroundColor,
    ),
    "rgb(1, 2, 3)",
    "the fixture's navigation background is implemented",
  );
  const queryLoads = [];
  const entryAnswer = cms.answers.EntryByUri;
  cms.answers.EntryByUri = ({ uri }) => {
    const identity = queryDocument.blocks[0].attributes.items.find((item) => item.uri === uri);
    if (!identity) return entryAnswer({ uri });
    queryLoads.push(uri);
    const record = queryDocument.items.find((item) => item.id === identity.id).publishedPost;
    return {
      postBy: {
        ...record,
        id: String(record.databaseId),
        uri,
        content: "",
        excerpt: "",
        date: "2026-10-24T00:00:00",
        status: "publish",
        isRestricted: false,
        modifiedGmt: "2026-10-24T00:00:00",
        featuredImage: null,
      },
      pageBy: null,
      designTokens: { ...themeDocument.deliveries[0].tokens, spacingSizes: [] },
    };
  };
  cms.entries.set("/query/", { id: "81", title: "Query", content: "<p>Query proof</p>" });
  cms.answers.SiteChrome = () => ({
    generalSettings: { siteIcon: null, siteLogo: null },
    menuItems: { nodes: [] },
    header: { title: "Query", blocksJson: JSON.stringify(queryDocument.blocks) },
    footer: null,
  });
  const queryRefresh = await runGq(site, ["frontend", "refresh", "--url", origin, "--json"], {
    FRONTEND_REFRESH_TOKEN: token,
  });
  assert.equal(queryRefresh.code, 0, queryRefresh.stdout + queryRefresh.stderr);
  assert.equal((await page.goto(`${origin}/query/`)).status(), 200);
  const query = page.locator("header.gqd-content");
  assert.deepEqual(await query.locator(".wp-block-post-title").allTextContents(), [
    "00081 Beta",
    "00081 Gamma",
  ]);
  assert.deepEqual(
    queryLoads,
    ["/00081-beta/", "/00081-gamma/"],
    "producer-selected URI loader order",
  );
  const bodies = query.locator(".wp-block-post-content");
  assert.equal(await bodies.count(), 2);
  for (const [index, name] of ["00081 Beta", "00081 Gamma"].entries()) {
    assert.deepEqual(await bodies.nth(index).locator("p").allTextContents(), [
      `${name} content`,
      "Nested item body",
    ]);
  }
  assert.deepEqual(
    await query.locator(":scope > *").evaluateAll((nodes) => nodes.map((node) => node.className)),
    await query
      .locator(
        ":scope > .wp-block-post-title, :scope > .wp-block-post-content, :scope > .wp-block-getquick-design-grid",
      )
      .evaluateAll((nodes) => nodes.map((node) => node.className)),
    "resolved synced references add no layout wrapper",
  );
  for (const width of [767, 768, 1000]) {
    await page.setViewportSize({ width, height: 900 });
    for (const grid of await query.locator(".wp-block-getquick-design-grid").all()) {
      const computed = await grid.evaluate((element) => {
        const style = element.ownerDocument.defaultView.getComputedStyle(element);
        return {
          display: style.display,
          columns: style.gridTemplateColumns.split(" ").length,
          gap: style.gap,
        };
      });
      assert.deepEqual(computed, { display: "grid", columns: width < 768 ? 1 : 2, gap: "16px" });
    }
  }
  for (const heading of await query.getByRole("heading", { name: "Pattern details" }).all()) {
    assert.deepEqual(
      await heading.evaluate((element) => {
        const style = element.ownerDocument.defaultView.getComputedStyle(element);
        return { size: style.fontSize, weight: style.fontWeight };
      }),
      { size: "20px", weight: "700" },
    );
  }
  const buttons = query.getByRole("link", { name: "Read item", exact: true });
  assert.equal(await buttons.count(), 2);
  for (const button of await buttons.all()) {
    assert.equal(await button.getAttribute("href"), "#details");
    assert.deepEqual(
      await button.evaluate((element) => {
        const style = element.ownerDocument.defaultView.getComputedStyle(element);
        return {
          tag: element.tagName,
          padding: style.paddingInlineStart,
          radius: style.borderRadius,
        };
      }),
      { tag: "A", padding: "16px", radius: "8px" },
    );
  }
  console.log(
    "✓ refreshed real Query producer order, publication preloads, recursive content, transparent references and styled links",
  );
} finally {
  await browser?.close();
  await stopWorker(worker);
  await cms.stop();
  rmSync(work, { recursive: true, force: true });
}

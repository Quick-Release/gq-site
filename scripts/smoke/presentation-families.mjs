// Additional immutable producer deliveries through the generated production Site.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const fixture = new URL("../../test/fixtures/presentation/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, fixture), "utf8"));

export async function proveNativeColumns({ page, publish }) {
  const delivery = read("native-columns-delivery.json");
  await publish({
    route: "/native-columns/",
    title: "Native Columns",
    html: delivery.html,
    nodes: delivery.nodes,
  });
  for (const direction of ["ltr", "rtl"]) {
    await page.locator("html").evaluate((element, value) => {
      element.dir = value;
    }, direction);
    for (const width of [640, 781, 782, 783, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      for (const region of ["header.gqd-content", ".prose-wp"]) {
        const groups = page.locator(region).locator(".wp-block-columns");
        assert.equal(await groups.count(), 4);
        for (const [index, fractions] of [
          [0, width < 782 ? [1, 1] : [0.5, 0.5]],
          [1, [0.25, 0.75]],
          [2, [1 / 3, 1 / 3, 1 / 3]],
          [3, width < 782 ? [0.25, 1] : [0.25, 0.75]],
        ]) {
          const parent = groups.nth(index);
          const parentBox = await parent.boundingBox();
          const children = parent.locator(":scope > .wp-block-column");
          for (const [childIndex, fraction] of fractions.entries()) {
            const box = await children.nth(childIndex).boundingBox();
            assert.ok(
              Math.abs(box.width - parentBox.width * fraction) < 0.1,
              `${region} ${direction} native group ${index} column ${childIndex} at ${width}`,
            );
            if (index === 0 && childIndex === 1) {
              const first = await children.first().boundingBox();
              assert.equal(
                box.y > first.y,
                width < 782,
                "native stacking uses its fixed 782px boundary",
              );
            }
          }
        }
        assert.equal(
          await groups
            .nth(0)
            .evaluate(
              (element) => element.ownerDocument.defaultView.getComputedStyle(element).alignItems,
            ),
          "center",
        );
        assert.equal(
          await groups
            .nth(0)
            .locator(":scope > .wp-block-column")
            .nth(1)
            .evaluate(
              (element) => element.ownerDocument.defaultView.getComputedStyle(element).alignSelf,
            ),
          "flex-end",
        );
        assert.equal(
          await groups
            .nth(3)
            .evaluate(
              (element) => element.ownerDocument.defaultView.getComputedStyle(element).alignItems,
            ),
          "center",
          "neutral alignment overrides native bottom",
        );
        assert.equal(
          await groups
            .nth(3)
            .locator(":scope > .wp-block-column")
            .first()
            .evaluate(
              (element) => element.ownerDocument.defaultView.getComputedStyle(element).alignSelf,
            ),
          "center",
        );
      }
    }
  }
  console.log(
    "✓ actual native Columns: fixed mobile boundary, unequal/equal growth, native and neutral alignment without core CSS",
  );
}

export async function proveLayout({ page, publish }) {
  const delivery = read("layout-current-delivery.json");
  await publish({
    route: "/current-layout/",
    title: "Current layout",
    html: delivery.html,
    nodes: delivery.nodes,
  });
  for (const direction of ["ltr", "rtl"]) {
    await page.locator("html").evaluate((element, value) => {
      element.dir = value;
    }, direction);
    for (const width of [
      639, 640, 641, 767, 768, 769, 1023, 1024, 1025, 1279, 1280, 1281, 1535, 1536, 1537,
    ]) {
      await page.setViewportSize({ width, height: 900 });
      for (const region of ["header.gqd-content", ".prose-wp"]) {
        const result = await page.locator(region).evaluate((root) => {
          const style = (selector) =>
            root.ownerDocument.defaultView.getComputedStyle(root.querySelector(selector));
          const grid = style("#layout-grid");
          const narrow = style("#narrow-grid");
          const group = style(".wp-block-group");
          const columns = root.querySelectorAll(".wp-block-columns > .wp-block-column");
          const separator = root.querySelector(".wp-block-separator").getBoundingClientRect();
          const parent = root.getBoundingClientRect();
          return {
            grid: {
              columns: grid.gridTemplateColumns.split(" ").length,
              row: grid.rowGap,
              column: grid.columnGap,
              padding: grid.paddingInlineStart,
            },
            group: {
              display: group.display,
              gap: group.gap,
              direction: group.flexDirection,
              align: group.alignItems,
            },
            spacer: root.querySelector(".wp-block-spacer").getBoundingClientRect().height,
            opacity: style(".wp-block-separator").opacity,
            separator: {
              width: separator.width,
              x: separator.x,
              parentWidth: parent.width,
              parentX: parent.x,
            },
            columnAlign: root.ownerDocument.defaultView.getComputedStyle(columns[1]).alignSelf,
            columnRatio:
              columns[0].getBoundingClientRect().width /
              (columns[0].getBoundingClientRect().width + columns[1].getBoundingClientRect().width),
            narrow: {
              row: narrow.rowGap,
              column: narrow.columnGap,
              parent: root.querySelector("#narrow-parent").getBoundingClientRect().width,
              nested: root.querySelector("#nested-container").getBoundingClientRect().width,
            },
          };
        });
        assert.deepEqual(
          result.grid,
          {
            columns: width >= 1536 ? 3 : width >= 1280 ? 1 : width >= 768 ? 4 : 3,
            row: width >= 768 ? "0px" : "16px",
            column: "16px",
            padding: "8px",
          },
          `${region} ${direction} authored Grid at ${width}`,
        );
        assert.deepEqual(result.group, {
          display: "flex",
          gap: "24px",
          direction: width >= 1024 ? "column" : "row",
          align: "center",
        });
        assert.equal(result.spacer, width >= 1280 ? 0 : width >= 768 ? 32 : 37);
        assert.equal(result.opacity, "0.5");
        assert.equal(result.separator.width, result.separator.parentWidth / 2);
        assert.equal(
          result.separator.x,
          result.separator.parentX + result.separator.parentWidth / 4,
        );
        assert.equal(result.columnAlign, width >= 1024 ? "end" : "center");
        assert.ok(Math.abs(result.columnRatio - 0.25) < 0.001);
        assert.deepEqual(
          result.narrow,
          {
            row: width >= 1280 ? "0px" : width >= 768 ? "16px" : "0px",
            column: width >= 1280 ? "0px" : width >= 768 ? "16px" : "8px",
            parent: 384,
            nested: 368,
          },
          "later gap shorthand overrides earlier rowGap and reset clears both axes inside narrow parent",
        );
      }
    }
  }
  console.log(
    "✓ actual saved layout: Row context, responsive Grid/gap chronology, native widths, Spacer/reset, Separator and narrow parent in LTR/RTL",
  );
}

export async function proveInlineTypography({ page, publish }) {
  for (const delivery of read("typography-inline-delivery.json").cases) {
    await publish({
      route: "/inline-typography/",
      title: "Inline typography",
      html: delivery.renderedHTML,
      nodes: delivery.neutralNodes,
      tokens: delivery.tokens,
    });
    const overridden = delivery.name === "override";
    const threshold = overridden ? 800 : 768;
    for (const width of [threshold - 1, threshold, threshold + 1, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      for (const region of ["header.gqd-content", ".prose-wp"]) {
        const root = page.locator(region);
        const heading = root.locator("h3");
        assert.equal(await heading.textContent(), "Authored heading");
        assert.equal(await heading.locator("strong").textContent(), "head");
        assert.equal(await heading.locator("span.inline-label").textContent(), "ing");
        const link = heading.getByRole("link", { name: "ing", exact: true });
        assert.equal(await link.getAttribute("href"), "/guide");
        assert.equal(await link.getAttribute("title"), "Read > learn");
        const paragraph = root.locator("p").first();
        assert.equal(await paragraph.textContent(), "Default paragraph");
        assert.equal(await paragraph.locator("strong").textContent(), "para");
        assert.equal(await paragraph.locator("span.inline-label").textContent(), "graph");
        const size = overridden ? (width >= threshold ? 32 : 24) : width >= threshold ? 24 : 20;
        const computed = await heading.evaluate((element) => {
          const style = element.ownerDocument.defaultView.getComputedStyle(element);
          return {
            size: style.fontSize,
            weight: style.fontWeight,
            line: style.lineHeight,
            tracking: style.letterSpacing,
            color: style.color,
            align: style.textAlign,
          };
        });
        assert.deepEqual(computed, {
          size: `${size}px`,
          weight: overridden ? "650" : "600",
          line: `${overridden ? (width >= threshold ? 40 : 36) : width >= threshold ? 32 : 28}px`,
          tracking: overridden
            ? width >= threshold
              ? "1.6px"
              : "1.2px"
            : width >= threshold
              ? "0.6px"
              : "0.5px",
          color: "rgb(18, 52, 86)",
          align: "start",
        });
      }
    }
  }
  console.log(
    "✓ actual inline Heading/Paragraph rich text and authored typography at default/overridden theme boundaries",
  );
}

export async function proveLanguageNavigation({ page, publish }) {
  const directory = new URL("language-navigation-flags/", fixture);
  const provenance = JSON.parse(readFileSync(new URL("provenance.json", directory), "utf8"));
  const requested = new Set();
  for (const [url, asset] of Object.entries(provenance.flagAssets)) {
    await page.route(url, (route) => {
      requested.add(url);
      return route.fulfill({
        contentType: asset.contentType,
        body: readFileSync(new URL(asset.file, directory)),
      });
    });
  }
  for (const url of ["http://127.0.0.1:8180/", "http://127.0.0.1:8180/fr/"]) {
    await page.route(url, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Captured language destination</title>",
      }),
    );
  }
  for (const language of ["en", "fr"]) {
    const nodes = JSON.parse(readFileSync(new URL(`${language}-nodes.json`, directory), "utf8"));
    const html = readFileSync(new URL(`${language}-rendered.html`, directory), "utf8");
    await publish({ route: `/language-${language}/`, title: `Language ${language}`, html, nodes });
    await page.setViewportSize({ width: 900, height: 900 });
    for (const region of ["header.gqd-content", ".prose-wp"]) {
      const root = page.locator(region);
      for (const className of ["gqd-capture-language-list", "gqd-capture-language-flags"]) {
        const list = root.locator(`.${className}`);
        assert.equal(await list.getByRole("link").count(), 2);
        for (const [index, label] of ["English", "Français"].entries()) {
          const link = list.getByRole("link", { name: label, exact: true });
          assert.equal(
            await link.getAttribute("href"),
            index === 0 ? "http://127.0.0.1:8180/" : "http://127.0.0.1:8180/fr/",
          );
          const image = link.locator("img");
          await image.evaluate((element) => element.decode());
          assert.deepEqual(
            await image.evaluate((element) => ({
              width: element.naturalWidth,
              height: element.naturalHeight,
            })),
            { width: 16, height: 11 },
          );
          const box = await image.boundingBox();
          assert.equal(box.width, 16);
          assert.equal(box.height, 11);
        }
        // Captured ordinary WordPress HTML remains English even on the FR page;
        // the explicitly resolved neutral layout records FR current correctly.
        const current =
          region === "header.gqd-content" && language === "fr" ? "Français" : "English";
        assert.equal(
          await list.locator("[aria-current]").getAttribute("href"),
          current === "English" ? "http://127.0.0.1:8180/" : "http://127.0.0.1:8180/fr/",
        );
      }
      for (const direction of ["ltr", "rtl"]) {
        await page.locator("html").evaluate((element, value) => {
          element.dir = value;
        }, direction);
        for (const width of [1023, 1024, 1025]) {
          await page.setViewportSize({ width, height: 900 });
          assert.equal(
            await root
              .locator(".gqd-capture-language-list")
              .evaluate(
                (element) => element.ownerDocument.defaultView.getComputedStyle(element).gap,
              ),
            width >= 1024 ? "32px" : "16px",
          );
        }
      }
    }
    const dropdown = page.locator("header .gqd-capture-language-dropdown");
    const summary = dropdown.locator("summary");
    assert.equal(await summary.textContent(), language === "fr" ? "Français" : "English");
    assert.equal(
      await dropdown.locator("a").count(),
      2,
      "hide_current retains the selected dropdown option",
    );
    await summary.focus();
    await summary.press("Enter");
    await dropdown
      .getByRole("link", { name: "Français", exact: true })
      .waitFor({ state: "visible" });
    await summary.press("Escape");
    assert.equal(await dropdown.evaluate((element) => element.open), false);
    assert.equal(
      await summary.evaluate((element) => element === element.ownerDocument.activeElement),
      true,
    );
    const select = page
      .locator(".prose-wp")
      .getByRole("combobox", { name: "Choose a language", exact: true });
    assert.deepEqual(await select.locator("option").allTextContents(), ["English", "Français"]);
    assert.equal(await select.inputValue(), "http://127.0.0.1:8180/");
    assert.equal(await page.locator(".prose-wp script").count(), 0);
    await select.focus();
    await Promise.all([page.waitForURL("http://127.0.0.1:8180/fr/"), select.press("End")]);
    await publish({ route: `/language-${language}/`, title: `Language ${language}`, html, nodes });
    // Native HTML starts English in both captures. Select the opposite actual
    // option without emitting change, so Home exercises a real keyboard change.
    await select.evaluate((element) => {
      element.selectedIndex = 1;
    });
    await select.focus();
    await Promise.all([page.waitForURL("http://127.0.0.1:8180/"), select.press("Home")]);
  }
  assert.equal(requested.size, 2, "both exact captured flag URLs loaded through test transport");
  const accessible = new URL("language-navigation-a11y/", fixture);
  for (const language of ["en", "fr"]) {
    await publish({
      route: `/language-a11y-${language}/`,
      title: `Null-flag language ${language}`,
      html: readFileSync(new URL(`${language}-rendered.html`, accessible), "utf8"),
      nodes: JSON.parse(readFileSync(new URL(`${language}-nodes.json`, accessible), "utf8")),
    });
    for (const region of ["header.gqd-content", ".prose-wp"]) {
      const flags = page.locator(`${region} .gqd-capture-language-flags`);
      assert.equal(
        await flags.locator("img").count(),
        0,
        "null flags remain null, without replacement assets",
      );
      const english = flags.getByRole("link", { name: "English", exact: true });
      const french = flags.getByRole("link", { name: "Français", exact: true });
      assert.equal(await english.count(), 1);
      assert.equal(await french.count(), 1);
      assert.equal(await english.getAttribute("href"), "http://127.0.0.1:8180/");
      assert.equal(await french.getAttribute("href"), "http://127.0.0.1:8180/fr/");
      await english.focus();
      await english.press("Tab");
      assert.equal(
        await french.evaluate((element) => element === element.ownerDocument.activeElement),
        true,
      );
    }
  }
  console.log(
    "✓ actual Free Polylang EN/FR layout and independent HTML: flags decode, labels/current, dropdown keyboard, RTL and original URLs",
  );
}

export async function proveBranding({ page, publish }) {
  const original = read("media-source-public.json").nodes[3];
  const logo = structuredClone(original);
  logo.attributes.logo = {
    url: "https://gqd-media.test/photo.svg",
    alt: "Primary mark",
    width: 640,
    height: 480,
  };
  logo.attributes.logoDark = {
    url: "https://example.test/poster.jpg",
    alt: "Dark mark",
    width: 900,
    height: 600,
  };
  // Supplied Branding context on the actual saved Logo node; no CMS capture claim.
  for (const [route, expectedUrl, expectedAlt] of [
    ["/branding/", "https://gqd-media.test/photo.svg", "Primary mark"],
    ["/presentation-surface-dark/", "https://example.test/poster.jpg", "Dark mark"],
  ]) {
    await publish({ route, title: "Branding context", html: "", nodes: [logo] });
    await page.setViewportSize({ width: 900, height: 900 });
    const image = page.locator("header .wp-block-site-logo img");
    await image.evaluate((element) => element.decode());
    assert.equal(await image.getAttribute("src"), expectedUrl);
    assert.equal(await image.getAttribute("alt"), expectedAlt);
    assert.equal((await image.boundingBox()).height, 192);
  }
  logo.attributes.logoDark = null;
  await publish({
    route: "/presentation-surface-dark/",
    title: "Primary fallback",
    html: "",
    nodes: [logo],
  });
  assert.equal(
    await page.locator("header .wp-block-site-logo img").getAttribute("src"),
    "https://gqd-media.test/photo.svg",
  );
  logo.attributes.logo = null;
  await publish({
    route: "/presentation-surface-dark/",
    title: "Title fallback",
    html: "",
    nodes: [logo],
  });
  assert.equal(await page.locator("header .wp-block-site-logo").textContent(), "Acme");
  console.log(
    "✓ supporting Branding context uses primary, explicit dark surface, primary fallback and actual Site-title fallback",
  );
}

export async function proveCoverBoundaries({ page, publish }) {
  const media = read("media-source-public.json");
  await publish({
    route: "/cover-authored/",
    title: "Saved Cover",
    html: media.html[1],
    nodes: [media.nodes[1]],
  });
  for (const region of ["header.gqd-content", ".prose-wp"]) {
    assert.equal((await page.locator(`${region} .wp-block-cover`).boundingBox()).height, 192);
  }
  // Supporting public omission/aspect variants; no fabricated minHeight DTO.
  const omitted = structuredClone(media.nodes[1]);
  delete omitted.attributes.presentation.base.height;
  const nativeHtml = media.html[1].replace(
    "--gqd-base-height:calc(var(--gqd-spacing, 0.25rem) * 48)",
    "min-height:500px",
  );
  await publish({
    route: "/cover-omitted/",
    title: "Cover omission",
    html: nativeHtml,
    nodes: [omitted],
  });
  assert.equal(
    (await page.locator("header .wp-block-cover").boundingBox()).height,
    430,
    "canonical omission default without WordPress CSS",
  );
  assert.equal(
    (await page.locator(".prose-wp .wp-block-cover").boundingBox()).height,
    500,
    "provided saved-shell height is authoritative",
  );
  omitted.attributes.presentation.base.aspectRatio = "video";
  await page.setViewportSize({ width: 600, height: 900 });
  await publish({ route: "/cover-aspect/", title: "Cover aspect", html: "", nodes: [omitted] });
  const aspect = await page.locator("header .wp-block-cover").boundingBox();
  assert.equal(aspect.width, 600);
  assert.equal(aspect.height, 337.5, "neutral aspect clears native minimum height");
  console.log(
    "✓ actual Cover192 and supporting omission430/source500/aspect337.5 boundaries without a minHeight DTO claim",
  );
}

export async function proveCoverMotion({ page, publish }) {
  const videoUrl = "https://gqd-media.test/cover-motion.webm";
  await page.route(videoUrl, (route) =>
    route.fulfill({
      contentType: "video/webm",
      body: readFileSync(new URL("cover-motion.webm", fixture)),
    }),
  );
  // Supporting playable media, not an additional saved-editor capture.
  const cover = {
    name: "core/cover",
    attributes: { backgroundType: "video", url: videoUrl, presentation: { base: { height: 64 } } },
    content: null,
    children: [
      {
        name: "core/paragraph",
        attributes: { content: '<a href="#motion-next">Cover foreground</a>' },
        content: null,
        children: [],
      },
    ],
  };
  await page.emulateMedia({ reducedMotion: "reduce" });
  await publish({
    route: "/cover-motion/",
    title: "Supporting Cover motion",
    nodes: [cover],
    html: `<div class="wp-block-cover"><video class="wp-block-cover__video-background" src="${videoUrl}" autoplay muted loop playsinline poster="https://example.test/poster.jpg"></video><div class="wp-block-cover__inner-container"><a href="#motion-next">Cover foreground</a></div></div>`,
  });
  const videos = page.locator(".wp-block-cover > video");
  const root = await page.locator("html").elementHandle();
  const waitForPaused = (paused) =>
    page.waitForFunction(
      ({ root, paused }) =>
        [...root.ownerDocument.querySelectorAll(".wp-block-cover > video")].every(
          (video) => video.paused === paused,
        ),
      { root, paused },
    );
  assert.equal(await videos.count(), 2);
  for (const video of await videos.all()) {
    assert.equal(await video.getAttribute("autoplay"), null);
    assert.equal(await video.getAttribute("src"), videoUrl);
    assert.equal(await video.evaluate((element) => element.paused), true);
  }
  assert.equal(
    await page.locator(".prose-wp video").getAttribute("poster"),
    "https://example.test/poster.jpg",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  for (const video of await videos.all()) {
    await video.evaluate(
      (element) =>
        new Promise((resolve, reject) => {
          if (!element.paused && element.currentTime > 0) return resolve();
          const timeout = setTimeout(() => reject(new Error("Cover video did not play")), 10000);
          element.addEventListener(
            "timeupdate",
            () => {
              if (element.paused || element.currentTime <= 0) return;
              clearTimeout(timeout);
              resolve();
            },
            { once: true },
          );
        }),
    );
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await waitForPaused(true);
  const foreground = page.locator(".prose-wp").getByRole("link", { name: "Cover foreground" });
  await foreground.focus();
  assert.equal(
    await foreground.evaluate((element) => element === element.ownerDocument.activeElement),
    true,
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await waitForPaused(false);
  await page
    .locator("html")
    .evaluate((element) => element.ownerDocument.defaultView.dispatchEvent(new Event("pagehide")));
  for (const video of await videos.all())
    assert.equal(await video.evaluate((element) => element.paused), true);
  await page
    .locator("html")
    .evaluate((element) => element.ownerDocument.defaultView.dispatchEvent(new Event("pageshow")));
  await waitForPaused(false);
  console.log(
    "✓ supporting real WebM Cover motion: neutral and published body, preference changes, foreground focus and lifecycle cleanup/remount",
  );
}

export async function provePostContext({ page, publish }) {
  const query = read("query-composition/post-public.json");
  const media = read("media-source-public.json");
  const record = query.items[0].publishedPost;
  // Supporting selection/context: unchanged actual nodes and Post block record,
  // with a supplied featured image. This is not a new saved Design layout.
  await publish({
    route: "/context-post/",
    title: "Post context",
    html: "",
    nodes: [...query.blocks[0].children.slice(0, 2), media.nodes[2], media.nodes[3]],
    record: {
      ...record,
      id: String(record.databaseId),
      featuredImage: {
        node: { sourceUrl: "https://gqd-media.test/photo.svg", altText: "Mountain" },
      },
    },
  });
  const root = page.locator("header.gqd-content");
  assert.equal(await root.locator(".wp-block-post-title").textContent(), "00081 Beta");
  assert.deepEqual(await root.locator(".wp-block-post-content p").allTextContents(), [
    "00081 Beta content",
    "Nested item body",
  ]);
  const image = root.locator(".wp-block-post-featured-image img");
  await image.evaluate((element) => element.decode());
  assert.equal(await image.getAttribute("alt"), "Mountain");
  assert.equal(await image.locator("..").getAttribute("href"), "/context-post/");
  assert.equal((await image.boundingBox()).height, 192);
  assert.equal(await root.locator(".wp-block-site-logo").textContent(), "Acme");
  assert.equal(await root.locator(".wp-block-site-logo a").getAttribute("href"), "/");
  console.log(
    "✓ supporting Site/Post context through existing publication loaders: title, recursive content, featured media and title fallback",
  );
}

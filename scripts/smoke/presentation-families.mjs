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

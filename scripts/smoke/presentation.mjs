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
const installed = join(frontend, "node_modules/@getquick/content");
const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
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
  cms.answers.EntryByUri = () => ({
    postBy: null,
    pageBy: {
      id: "73",
      title: "Presentation",
      content: saved,
      uri: "/presentation/",
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
} finally {
  await browser?.close();
  await stopWorker(worker);
  await cms.stop();
  rmSync(work, { recursive: true, force: true });
}

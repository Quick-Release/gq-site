#!/usr/bin/env node

// GQ Design's fonts in a generated, installed and built commerce Site's
// storefront, which commerce-check.sh runs once per case. The built Worker
// renders its homepage while the CMS's public tokens
// (GET /wp-json/getquick-design/v1/tokens) are answered here:
//
//   fonts  GQ Design 0.10.2 with Inter assigned: one font preload with
//          crossorigin, then the theme's Preflight, the @font-face rules and
//          slot stacks, then the text styles, on the .gqd-content body;
//   0.9    a CMS on GQ Design 0.9.x (contract 2.0.0, no fonts): the theme
//          alone, no font markup;
//   down   a CMS that can't be reached: the page renders, with no design head.
//
//   node scripts/smoke/commerce-fonts.mjs <site> <fonts|0.9|down>
//
// Each case runs in its own process: the storefront keeps the tokens it read
// for a minute per isolate.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [site, scenario] = process.argv.slice(2);
if (!site || !["fonts", "0.9", "down"].includes(scenario ?? "")) {
  throw new Error("Usage: commerce-fonts.mjs <site> <fonts|0.9|down>");
}
const frontend = join(site, "apps/frontend");
const fixture = JSON.parse(
  readFileSync(
    join(frontend, "node_modules/@quick-release/design-contract/fixtures/tokens/default.json"),
    "utf8",
  ),
);
const font = "https://media.example.test/app/uploads/fonts/inter/inter-latin.woff2";
const textStyle = { slot: "sans", weight: "400", lineHeight: "1.5", letterSpacing: "0em" };
const tokens = {
  fonts: {
    ...fixture,
    fonts: {
      families: [
        {
          slug: "inter",
          name: "Inter",
          fallback: null,
          faces: [
            {
              src: [font],
              format: "woff2",
              weight: "100 900",
              style: "normal",
              unicodeRange: "U+0000-00FF",
              display: "swap",
              preload: true,
            },
          ],
        },
      ],
      slots: { sans: "inter", serif: null, mono: null },
    },
    textStyles: {
      heading: {
        ...textStyle,
        weight: "700",
        sizes: { h1: "5xl", h2: "4xl", h3: "3xl", h4: "2xl", h5: "xl", h6: "lg" },
      },
      paragraph: textStyle,
    },
  },
  0.9: older(fixture),
}[scenario];

/** GQ Design 0.9.x's tokens: contract 2.0.0, with no fonts or text styles. */
function older(current) {
  const tokens = { ...current, contractVersion: "2.0.0" };
  delete tokens.fonts;
  delete tokens.textStyles;
  return tokens;
}

const requested = [];
globalThis.fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  requested.push(url);
  if (!url.endsWith("/wp-json/getquick-design/v1/tokens")) throw new Error(`Unexpected ${url}`);
  if (!tokens) throw new TypeError("fetch failed");
  return Response.json(tokens);
};
const warnings = [];
console.warn = (...args) => warnings.push(args.join(" "));

const server = (await import(pathToFileURL(join(frontend, "dist/server/server.js")))).default;
const response = await server.fetch(new Request("http://localhost:3000/"));
const html = await response.text();
const head = /<head>([\s\S]*?)<\/head>/u.exec(html)?.[1] ?? "";

const failures = [];
const check = (ok, what) => {
  if (!ok) failures.push(what);
};
check(response.status === 200, `the homepage answers 200 (got ${response.status})`);
check(
  requested.some((url) => url.endsWith("/wp-json/getquick-design/v1/tokens")),
  "the storefront reads GQ Design's tokens from the CMS",
);
check(/<body class="gqd-content"/u.test(html), "the body is GQ Design's content root");

const preload =
  /<link rel="preload" as="font" href="([^"]+)" type="font\/woff2" crossorigin="anonymous"/u;
const preflight = head.indexOf(".gqd-content.gqd-content *");
if (scenario === "fonts") {
  check(preload.exec(head)?.[1] === font, "one font preload, cross-origin, from the media host");
  check(/@font-face\{font-family:"Inter"/u.test(head), "the @font-face rule");
  check(
    head.includes(':root,.gqd-content.gqd-content{--gqd-font-sans:"Inter", sans-serif;}'),
    "the sans slot stack on :root and the content root",
  );
  check(
    head.includes(".gqd-content.gqd-content h1{font-size:var(--gqd-text-5xl);}"),
    "the heading text style",
  );
  check(preflight > -1, "the theme's Preflight");
  check(head.indexOf('id="gqd-fonts"') > preflight, "the fonts follow the theme's Preflight");
  check(
    head.indexOf('id="gqd-text-styles"') > head.indexOf('id="gqd-fonts"'),
    "the text styles follow the fonts",
  );
  check(!/fonts\.(?:googleapis|gstatic)\.com/u.test(html), "no Google font host");
} else {
  check(!head.includes('as="font"'), "no font preload");
  check(!head.includes("@font-face"), "no @font-face rule");
  check(!head.includes("gqd-fonts") && !head.includes("gqd-text-styles"), "no font styles");
  if (scenario === "0.9") check(preflight > -1, "the theme's Preflight, as before the fonts");
  else {
    check(!head.includes("gqd-theme"), "no theme styles without the tokens");
    check(
      warnings.some((line) => line.includes("no design tokens")),
      "a warning naming the CMS",
    );
  }
}

if (failures.length > 0) {
  console.error(`commerce fonts (${scenario}) failed: ${failures.join("; ")}.`);
  process.exit(1);
}
console.log(
  {
    fonts: "The built storefront renders GQ Design 0.10.2's fonts and text styles after the theme.",
    0.9: "Against a GQ Design 0.9.x CMS, the built storefront renders no font markup.",
    down: "Without the CMS's tokens, the built storefront renders with no design head.",
  }[scenario],
);

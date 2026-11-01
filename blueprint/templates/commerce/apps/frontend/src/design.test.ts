import type { DesignTokens } from "@quick-release/design-contract";
import tokens from "@quick-release/design-contract/fixtures/tokens/default.json";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { designHeadFor, fetchDesignHead, type DesignHead } from "./design.server";
import { rootHead } from "./routes/__root";

// GQ Design's self-hosted fonts and text styles (GQ Design 0.10.2, contract
// 2.1.0): the root route renders them from the CMS's tokens, right after the
// theme's stylesheet. How each part is written is GQ Design's renderer's,
// tested there; these test that the storefront composes it.

// As GQ Design 0.10.2 delivers them: Inter, imported to the media host, on
// the sans slot, which both text styles use.
const fonts = {
  families: [
    {
      slug: "inter",
      name: "Inter",
      fallback: null,
      faces: [
        {
          src: ["https://media.example/app/uploads/fonts/inter/inter-latin.woff2"],
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
};
const textStyle = { slot: "sans", weight: "400", lineHeight: "1.5", letterSpacing: "0em" };
const textStyles = {
  heading: {
    ...textStyle,
    weight: "700",
    lineHeight: "1.2",
    sizes: { h1: "5xl", h2: "4xl", h3: "3xl", h4: "2xl", h5: "xl", h6: "lg" },
  },
  paragraph: textStyle,
};

/** GQ Design 0.10.2's tokens, with Inter assigned. */
const withFonts = { ...tokens, fonts, textStyles } as DesignTokens;

/** A CMS on GQ Design 0.9.x: contract 2.0.0, with no fonts or text styles. */
const beforeFonts: Record<string, unknown> = { ...tokens, contractVersion: "2.0.0" };
delete beforeFonts.fonts;
delete beforeFonts.textStyles;

const CMS = "https://cms.example";

/** A CMS answering GET /wp-json/getquick-design/v1/tokens with `body`. */
function cmsAnswering(body: unknown, status = 200) {
  return vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

/** The head's tags as markup, in the order HeadContent renders them. */
function markup(head: DesignHead) {
  const { links, styles } = rootHead(head);
  return [
    ...links.map((link) =>
      "as" in link
        ? `<link rel="${link.rel}" as="${link.as}" type="${link.type}" href="${link.href}" crossorigin="${link.crossOrigin}">`
        : `<link rel="${link.rel}" href="${link.href}">`,
    ),
    ...styles.map((style) => `<style id="${style.id}">${style.children}</style>`),
  ].join("");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GQ Design fonts", () => {
  it("preloads an assigned font from the media host, after the theme's stylesheet", async () => {
    const cms = cmsAnswering(withFonts);

    const head = await fetchDesignHead(CMS, cms);

    expect(cms).toHaveBeenCalledWith(
      "https://cms.example/wp-json/getquick-design/v1/tokens",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
    expect(head.preloads).toEqual([
      {
        rel: "preload",
        as: "font",
        type: "font/woff2",
        href: "https://media.example/app/uploads/fonts/inter/inter-latin.woff2",
        crossOrigin: "anonymous",
      },
    ]);
    expect(head.styles.map((style) => style.id)).toEqual([
      "gqd-theme",
      "gqd-fonts",
      "gqd-text-styles",
    ]);
    const page = markup(head);
    expect(page).toMatch(/@font-face\{font-family:"Inter";src:url\("https:\/\/media\.example\//);
    // The slot stacks on :root and the content root, which the theme's own system stacks would shadow.
    expect(page).toMatch(
      /:root,\.gqd-content\.gqd-content\{--gqd-font-sans:"Inter", sans-serif;\}/,
    );
    expect(page).toContain(".gqd-content.gqd-content h1{font-size:var(--gqd-text-5xl);}");
    // The fonts and text styles follow the theme's Preflight, which they override.
    const preflight = page.indexOf(".gqd-content.gqd-content *");
    expect(preflight).toBeGreaterThan(-1);
    expect(page.indexOf('id="gqd-fonts"')).toBeGreaterThan(preflight);
    expect(page.indexOf('id="gqd-text-styles"')).toBeGreaterThan(page.indexOf('id="gqd-fonts"'));
    expect(page).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });

  it("renders no fonts or text styles against a CMS on GQ Design 0.9.x", async () => {
    const head = await fetchDesignHead(CMS, cmsAnswering(beforeFonts));

    expect(head.preloads).toEqual([]);
    expect(head.styles.map((style) => style.id)).toEqual(["gqd-theme"]);
    const page = markup(head);
    expect(page).not.toContain('as="font"');
    expect(page).not.toContain("@font-face");
    expect(page).not.toContain('--gqd-font-sans:"');
    expect(page).not.toContain("gqd-text-styles");
  });

  it("never loads a font from Google", () => {
    const google = structuredClone(fonts);
    google.families[0].faces[0].src = ["https://fonts.gstatic.com/s/inter/v1/inter.woff2"];

    const head = designHeadFor({ ...withFonts, fonts: google } as DesignTokens);

    expect(head.preloads).toEqual([]);
    expect(markup(head)).not.toMatch(/gstatic|googleapis/);
  });

  it("renders nothing when the CMS can't give its tokens", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await fetchDesignHead(CMS, cmsAnswering({ message: "down" }, 503))).toEqual({
      preloads: [],
      styles: [],
    });
    expect(
      await fetchDesignHead(CMS, async () => {
        throw new TypeError("fetch failed");
      }),
    ).toEqual({ preloads: [], styles: [] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no design tokens"));
    expect(markup({ preloads: [], styles: [] })).toBe('<link rel="icon" href="/favicon.svg">');
  });
});

import "@tanstack/react-start/server-only";
import type { DesignFonts, DesignTokens } from "@quick-release/design-contract";
import {
  designThemeStyleSheet,
  fontPreloads,
  fontStyleSheet,
  resolveDesignTheme,
  textStyleSheet,
} from "@quick-release/design-renderer";
import { createDesignClient } from "@quick-release/design-renderer/client";

import { cms } from "./storefront.server";

// GQ Design's theme, self-hosted fonts and text styles, read from the CMS's
// public tokens (GET /wp-json/getquick-design/v1/tokens) and rendered into the
// document head by the root route (routes/__root.tsx). The storefront has no
// publication store: each Worker isolate reads the tokens at most once a
// minute, as long as GQ Design lets them be cached.

/** The storefront's content root: Preflight, the slot stacks and the text styles apply under it. */
export const DESIGN_ROOT = ".gqd-content";

/** A `<link rel="preload" as="font">`: always cross-origin, as font requests are. */
export interface FontPreload {
  rel: "preload";
  as: "font";
  href: string;
  type: string;
  crossOrigin: "anonymous";
}

/** A `<style>` for the head, in order: the theme, then the fonts, then the text styles. */
export interface DesignStyle {
  id: "gqd-theme" | "gqd-fonts" | "gqd-text-styles";
  children: string;
}

export interface DesignHead {
  preloads: FontPreload[];
  styles: DesignStyle[];
}

export const EMPTY_DESIGN_HEAD: DesignHead = { preloads: [], styles: [] };

/** Hosts a Site's fonts must never come from (ADR 0006 in gq-design). */
const GOOGLE = /(?:^|\.)(?:googleapis\.com|gstatic\.com|google\.com)$/i;

function selfHosted(src: string): boolean {
  try {
    const url = new URL(src);
    return (url.protocol === "https:" || url.protocol === "http:") && !GOOGLE.test(url.hostname);
  } catch {
    return false;
  }
}

/**
 * The fonts with only faces whose every file is an absolute URL off Google's
 * hosts. GQ Design already refuses any other; this keeps a visitor's browser
 * from ever contacting Google even if the tokens said otherwise.
 */
function selfHostedFonts(fonts: DesignFonts | undefined): DesignFonts | undefined {
  if (!fonts) return undefined;
  return {
    ...fonts,
    families: fonts.families.map((family) => ({
      ...family,
      faces: family.faces.filter((face) => face.src.every(selfHosted)),
    })),
  };
}

/** One part of the head; a value GQ Design's renderer refuses leaves that part out. */
function part(render: () => string): string {
  try {
    return render();
  } catch (error) {
    console.warn(`GQ Design: a design style was left out: ${String(error)}`);
    return "";
  }
}

/**
 * The head for GQ Design's tokens: the theme's scoped Preflight and
 * variables, then at most two font preloads, the `@font-face` rules and the
 * assigned slots' `--gqd-font-*` stacks (on `:root` and the content root),
 * then the text styles, which override the Preflight. A CMS on GQ Design
 * 0.9.x delivers no fonts or text styles, and they render nothing.
 */
export function designHeadFor(tokens: DesignTokens | null): DesignHead {
  if (!tokens) return EMPTY_DESIGN_HEAD;
  const fonts = selfHostedFonts(tokens.fonts);
  const parts: Array<[DesignStyle["id"], () => string]> = [
    ["gqd-theme", () => designThemeStyleSheet(resolveDesignTheme(tokens.theme), DESIGN_ROOT)],
    ["gqd-fonts", () => fontStyleSheet(fonts, DESIGN_ROOT)],
    ["gqd-text-styles", () => textStyleSheet(tokens.textStyles, DESIGN_ROOT)],
  ];
  const styles = parts.flatMap(([id, render]): DesignStyle[] => {
    const children = part(render);
    return children ? [{ id, children }] : [];
  });
  return { preloads: fontPreloads(fonts), styles };
}

/**
 * Reads GQ Design's tokens from `cmsOrigin` and returns their head. A CMS
 * that can't be reached, or answers what GQ Design's contract doesn't allow,
 * gives an empty head: the storefront renders with its own styles.
 */
export async function fetchDesignHead(
  cmsOrigin: string,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): Promise<DesignHead> {
  const client = createDesignClient({
    baseUrl: `${cmsOrigin}/wp-json/getquick-design/v1`,
    fetch: (url, init) => fetcher(url, { ...init, signal: AbortSignal.timeout(5000) }),
  });
  try {
    return designHeadFor(await client.getTokens());
  } catch (error) {
    console.warn(`GQ Design: no design tokens from ${cmsOrigin}: ${String(error)}`);
    return EMPTY_DESIGN_HEAD;
  }
}

const TTL = 60_000;
let cached: { head: Promise<DesignHead>; until: number } | undefined;

/** The storefront's design head, read from the CMS at most once a minute per isolate. */
export function designHead(): Promise<DesignHead> {
  const now = Date.now();
  if (!cached || cached.until <= now) cached = { head: fetchDesignHead(cms), until: now + TTL };
  return cached.head;
}

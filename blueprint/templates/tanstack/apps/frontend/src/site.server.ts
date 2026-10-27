import "@tanstack/react-start/server-only";
import { createContentRuntime } from "@getquick/content/server";
import { createConsentServer } from "@getquick/content/consent/server";
// This export currently has an Astro name, but contains pure HTML functions,
// no Astro dependency. A neutral consent UI export is requested upstream.
import { consentPage } from "@getquick/content/consent/astro";
import {
  responseStatus,
  stripHtml,
  designThemeStyleSheet,
  presentationStyleSheet,
} from "@getquick/content";
import { getRequest, setResponseHeader, setResponseStatus } from "@tanstack/react-start/server";
import { redirect } from "@tanstack/react-router";
import type { WebsiteEnv } from "../../../infra/frontend.run";
import manifest from "../../../gq.ops.json";

async function bindings(): Promise<Partial<WebsiteEnv>> {
  return import("cloudflare:workers").then(({ env }) => env as WebsiteEnv).catch(() => ({}));
}
const ops: {
  project: string;
  domains?: { admin: string; frontend: string };
  wordpress?: import("@getquick/content").WordPressLanguages & { graphqlPath?: string };
} = manifest;
const graphqlEndpoint =
  import.meta.env.PUBLIC_WORDPRESS_GRAPHQL_URL ||
  `https://${ops.domains?.admin ?? "{{project}}-admin.ddev.site"}${ops.wordpress?.graphqlPath ?? "/wp/graphql"}`;
const cmsOrigin = new URL(graphqlEndpoint).origin;
export const content = createContentRuntime({
  site: ops.project,
  cmsOrigin,
  graphqlEndpoint,
  wordpress: ops.wordpress,
  development: import.meta.env.DEV,
  isServer: () => true,
  bindings,
  consent: { cmsSettings: true },
});
export const consent = createConsentServer({ siteId: ops.project, bindings });

export async function page(path: string) {
  const request = getRequest();
  const origin = new URL(request.url).origin;
  const language = content.routeLanguage(path);
  const result = content.isLanguageHome(path)
    ? await content.publishedHome(origin, language)
    : await content.publishedEntry(path, origin);
  setResponseHeader("Cache-Control", "no-cache");
  if (result.kind === "moved") throw redirect({ href: result.uri, statusCode: 301 });
  setResponseStatus(responseStatus(result));
  const emptyConsent = { head: "", body: "", footer: "" };
  if (result.kind !== "found")
    return {
      language: language.locale.replaceAll("_", "-") || "en",
    title: result.kind === "missing" ? "Page not found" : "Content unavailable",
      styles: "",
      body: "",
      header: "",
      footer: "",
      consent: emptyConsent,
    };
  const publication = "home" in result.content ? result.content.home : result.content.entry;
  const body = "page" in publication ? publication.page : publication;
  const chrome = result.content.chrome;
  const configuration = content.consentConfiguration(chrome);
  return {
    language: language.locale.replaceAll("_", "-") || "en",
    title: stripHtml(body.title),
    styles: designThemeStyleSheet(publication.theme) + presentationStyleSheet(publication.theme),
    body: body.designBlocks
      ? content.renderDesignPattern(body.designBlocks, { siteOrigin: origin })
      : body.content,
    header: content.renderDesignPattern(chrome.header, { siteOrigin: origin }),
    footer: content.renderDesignPattern(chrome.footer, { siteOrigin: origin }),
    consent: configuration
      ? consentPage({
          configuration,
          language: language.locale.replaceAll("_", "-"),
          legal: chrome.legal,
          cookie: request.headers.get("Cookie"),
        })
      : emptyConsent,
  };
}

import "@tanstack/react-start/server-only";
import { content } from "./lib/content";
import { createConsentServer, type ConsentBindings } from "@getquick/content/consent/server";
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
import manifest from "../../../gq.ops.json";

const domains = (manifest as { domains?: { frontend: string; frontendTarget?: string } }).domains;
// The Site's public origin (domains.frontend) and the Worker's own host when
// it is another (domains.frontendTarget): behind an external proxy, the
// Worker sees the latter while visitors' browsers post from the former.
const siteOrigins = [domains?.frontend, domains?.frontendTarget]
  .filter((host): host is string => Boolean(host))
  .map((host) => `https://${host}`);
const bindings = async () =>
  ((await import("cloudflare:workers").catch(() => null))?.env ?? {}) as ConsentBindings & {
    CONSENT_RETENTION_DAYS?: string;
    GQ_TRUSTED_PROXIES?: string;
  };

// The Site's reverse proxy's addresses, from GQ_TRUSTED_PROXIES (comma-separated;
// infra/frontend.run.ts binds it for gq.ops.json domains.frontendProxy): the
// visitor's address is read from its X-Forwarded-For only when it is them.
// @getquick/content takes trustedProxies from the release of gq-content #55;
// spread in, an older one ignores it.
const trustedProxies = (value: string | undefined) => {
  const list = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return list.length > 0 ? { trustedProxies: list } : {};
};
export async function handleConsent(request: Request) {
  const { CONSENT_RETENTION_DAYS: retention, GQ_TRUSTED_PROXIES: proxies } = await bindings();
  const server = createConsentServer({
    siteId: manifest.project,
    siteOrigins,
    bindings,
    retentionDays: retention ? Number(retention) : undefined,
    ...trustedProxies(proxies),
  });
  return (await server.handle(request)) ?? new Response(null, { status: 404 });
}

export async function page(path: string) {
  const runtime = content();
  const request = getRequest();
  const origin = new URL(request.url).origin;
  const language = runtime.routeLanguage(path);
  const result = runtime.isLanguageHome(path)
    ? await runtime.publishedHome(origin, language)
    : await runtime.publishedEntry(path, origin);
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
  const configuration = runtime.consentConfiguration(chrome);
  return {
    language: language.locale.replaceAll("_", "-") || "en",
    title: stripHtml(body.title),
    styles: designThemeStyleSheet(publication.theme) + presentationStyleSheet(publication.theme),
    body: body.designBlocks
      ? runtime.renderDesignPattern(body.designBlocks, { siteOrigin: origin })
      : body.content,
    header: runtime.renderDesignPattern(chrome.header, { siteOrigin: origin }),
    footer: runtime.renderDesignPattern(chrome.footer, { siteOrigin: origin }),
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

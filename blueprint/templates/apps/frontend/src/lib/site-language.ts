import ops from "../../../../gq.ops.json";

/**
 * The `<html lang>` for a WordPress locale: its language and region as a
 * BCP 47 tag (pt_PT_ao90 → pt-PT). WordPress's variants (ao90, formal) aren't
 * BCP 47 subtags, so they are left out; no locale means English.
 */
export function htmlLang(locale: string | undefined): string {
  if (!locale) return "en";
  return locale.split("_").slice(0, 2).join("-");
}

/** A language the site serves. */
export interface SiteLanguage {
  /** Its WordPress locale (pt_PT_ao90); empty when gq.ops.json names none. */
  locale: string;
  /** Polylang's slug, its URL directory: the default language's is its language code. */
  slug: string;
  /** Its GraphQL LanguageCodeEnum value: the slug in upper case (pt-br → PT_BR). */
  code: string;
  /** Its `<html lang>`. */
  lang: string;
  isDefault: boolean;
  /** Its home route: / for the default language, /<slug>/ for the others. */
  home: string;
}

interface Manifest {
  locale?: string;
  languages?: Array<{ locale: string; slug: string }>;
}

/**
 * gq.ops.json's languages: wordpress.locale, the default, served at /, then
 * each of wordpress.languages under its slug. A monolingual Site has one.
 */
export function siteLanguages(wordpress: Manifest | undefined): SiteLanguage[] {
  const locale = wordpress?.locale ?? "";
  const language = (locale: string, slug: string, isDefault: boolean): SiteLanguage => ({
    locale,
    slug,
    code: slug.toUpperCase().replaceAll("-", "_"),
    lang: htmlLang(locale),
    isDefault,
    home: isDefault ? "/" : `/${slug}/`,
  });
  return [
    language(locale, locale.split("_")[0] || "en", true),
    ...(wordpress?.languages ?? []).map(({ locale, slug }) => language(locale, slug, false)),
  ];
}

/** The site's languages, read from gq.ops.json when the Frontend is built: the default first. */
export const languages = siteLanguages((ops as { wordpress?: Manifest }).wordpress);
export const defaultLanguage = languages[0]!;
/** Whether the site serves more than one language (gq.ops.json's wordpress.languages). */
export const multilingual = languages.length > 1;

/**
 * A route's language: the one whose slug is its first segment, else the
 * default language, which has no directory.
 */
export function routeLanguage(route: string, among = languages): SiteLanguage {
  const segment = route.split("/")[1];
  return among.find((language) => !language.isDefault && language.slug === segment) ?? among[0]!;
}

/**
 * How logs and reports name something a language has: "the front page" for
 * the default language's, "the en front page" for another's.
 */
export function languageSubject(language: SiteLanguage, what: string) {
  return language.isDefault ? `the ${what}` : `the ${language.slug} ${what}`;
}

/** Whether a route is a language's home (/, /en/): served as a home, never as an entry. */
export function isLanguageHome(route: string, among = languages) {
  return among.some((language) => language.home === route);
}

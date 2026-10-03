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

/**
 * The site's main language, from gq.ops.json's wordpress.locale: the language
 * the CMS deploy gives WordPress, read when the Frontend is built.
 */
export const siteLang = htmlLang((ops as { wordpress?: { locale?: string } }).wordpress?.locale);

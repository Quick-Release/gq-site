import ops from "../../../gq.ops.json";

/**
 * The `<html lang>` for a WordPress locale: its language and region as a
 * BCP 47 tag (pt_PT_ao90 → pt-PT). WordPress's variants (ao90, formal) aren't
 * BCP 47 subtags, so they are left out; no locale means English.
 */
export function htmlLang(locale: string | undefined): string {
  if (!locale) return "en";
  return locale.split("_").slice(0, 2).join("-");
}

// The Site's name and main language, from gq.ops.json's wordpress.locale.
export const site = {
  name: "{{Project}}",
  locale: (ops as { wordpress?: { locale?: string } }).wordpress?.locale ?? "en_US",
  language: htmlLang((ops as { wordpress?: { locale?: string } }).wordpress?.locale),
};

/** Direction of the actual locale script, including explicit script subtags. */
export function htmlDirection(lang: string): "ltr" | "rtl" {
  const script = new Intl.Locale(lang).maximize().script;
  return ["Arab", "Hebr", "Thaa", "Nkoo", "Adlm", "Rohg", "Syrc"].includes(script ?? "")
    ? "rtl"
    : "ltr";
}

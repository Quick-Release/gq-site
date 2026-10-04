import { describe, expect, it } from "vite-plus/test";
import { htmlLang, isLanguageHome, routeLanguage, siteLanguages } from "./site-language";

describe("the site's <html lang>", () => {
  it("is the WordPress locale's language and region", () => {
    expect(htmlLang("en_US")).toBe("en-US");
    expect(htmlLang("pt_PT")).toBe("pt-PT");
    expect(htmlLang("pt_BR")).toBe("pt-BR");
  });

  it("leaves out WordPress's variants, which aren't BCP 47 subtags", () => {
    expect(htmlLang("pt_PT_ao90")).toBe("pt-PT");
    expect(htmlLang("de_DE_formal")).toBe("de-DE");
  });

  it("is a language alone when the locale has no region", () => {
    expect(htmlLang("ja")).toBe("ja");
  });

  it("is English without a locale", () => {
    expect(htmlLang(undefined)).toBe("en");
    expect(htmlLang("")).toBe("en");
  });
});

const bilingual = siteLanguages({
  locale: "pt_PT_ao90",
  languages: [
    { locale: "en_US", slug: "en" },
    { locale: "pt_BR", slug: "pt-br" },
  ],
});

describe("the site's languages", () => {
  it("are wordpress.locale, at /, then wordpress.languages, each under its slug", () => {
    expect(bilingual).toEqual([
      { locale: "pt_PT_ao90", slug: "pt", code: "PT", lang: "pt-PT", isDefault: true, home: "/" },
      { locale: "en_US", slug: "en", code: "EN", lang: "en-US", isDefault: false, home: "/en/" },
      {
        locale: "pt_BR",
        slug: "pt-br",
        code: "PT_BR",
        lang: "pt-BR",
        isDefault: false,
        home: "/pt-br/",
      },
    ]);
  });

  it("are one, at /, for a monolingual Site, with or without a locale", () => {
    expect(siteLanguages({ locale: "en_US" })).toEqual([
      { locale: "en_US", slug: "en", code: "EN", lang: "en-US", isDefault: true, home: "/" },
    ]);
    expect(siteLanguages(undefined)).toEqual([
      { locale: "", slug: "en", code: "EN", lang: "en", isDefault: true, home: "/" },
    ]);
  });
});

describe("a route's language", () => {
  const slugOf = (route: string) => routeLanguage(route, bilingual).slug;

  it("is the language whose slug is the route's first segment", () => {
    expect(slugOf("/en/")).toBe("en");
    expect(slugOf("/en/about/")).toBe("en");
    expect(slugOf("/pt-br/sobre/")).toBe("pt-br");
  });

  it("is the default language otherwise", () => {
    expect(slugOf("/")).toBe("pt");
    expect(slugOf("/sobre/")).toBe("pt");
    expect(slugOf("/english/")).toBe("pt");
    // The default language has no directory.
    expect(slugOf("/pt/sobre/")).toBe("pt");
  });

  it("is a language's home only at its home route", () => {
    expect(isLanguageHome("/", bilingual)).toBe(true);
    expect(isLanguageHome("/en/", bilingual)).toBe(true);
    expect(isLanguageHome("/en/about/", bilingual)).toBe(false);
    expect(isLanguageHome("/pt/", bilingual)).toBe(false);
  });
});

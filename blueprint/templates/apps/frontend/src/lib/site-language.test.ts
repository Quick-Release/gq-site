import { describe, expect, it } from "vite-plus/test";
import { htmlLang } from "./site-language";

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

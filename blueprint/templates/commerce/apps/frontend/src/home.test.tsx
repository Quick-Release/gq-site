import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Home } from "./components/Home";
import { htmlLang, site } from "./site";

describe("Home", () => {
  it("names the Site", () => {
    expect(renderToStaticMarkup(<Home />)).toContain(`<h1>${site.name}</h1>`);
  });
});

describe("htmlLang", () => {
  it("keeps a locale's language and region, as BCP 47", () => {
    expect(htmlLang("pt_PT_ao90")).toBe("pt-PT");
    expect(htmlLang("en_US")).toBe("en-US");
    expect(htmlLang(undefined)).toBe("en");
  });
});

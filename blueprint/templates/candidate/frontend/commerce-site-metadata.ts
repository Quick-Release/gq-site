import { site, htmlDirection } from "./site";
import ops from "../../../gq.ops.json";

const domains = (ops as { domains?: { frontend: string } }).domains;

// Site-owned reviewed defaults. No share image, description or public origin is invented.
// Add only verified public facts before claiming OG-1 readiness.
export const metadataSite = {
  origin: domains?.frontend ? `https://${domains.frontend}` : "",
  name: "{{Project}}",
  language: { lang: site.language, locale: site.locale, dir: htmlDirection(site.language) },
};

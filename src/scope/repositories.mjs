// Which GETQUICK repository owns what (gq-platform ADR 0001), for routing a
// request to its owner and fencing writes into the current repository. `path`
// is the clone's place under the code root (GQ_CODE_ROOT); `terms` are names
// and identifiers distinctive enough that mentioning one names the
// repository.
export const REPOSITORIES = [
  {
    name: "gq-site",
    path: "gq-site",
    owns: "the blueprint: the gq CLI, managed files, the manifest, app skeletons, provisioning, CI and deploy, version pins",
    terms: ["gq-site", "@getquick/site", "gq sync", "gq new", "managed file", "app skeleton"],
  },
  {
    name: "gq-platform",
    path: "gq-platform",
    owns: "platform constraints, research whose owner is unknown, umbrella issues, the shared glossary",
    terms: ["gq-platform"],
  },
  {
    name: "gq-content",
    path: "gq-content",
    owns: "the content runtime: CMS publication events and the Frontend's delivery",
    terms: ["gq-content", "@getquick/content", "content runtime"],
  },
  {
    name: "gq-storefront",
    path: "gq-storefront",
    owns: "the storefront runtime every commerce Site shares: BFF, cart credentials, headless client",
    terms: ["gq-storefront", "@getquick/storefront", "storefront runtime"],
  },
  {
    name: "gq-ecommerce",
    path: "wp-plugins/gq-ecommerce",
    owns: "GQ eCommerce: WooCommerce blocks and templates, customer accounts, the auth contract, cart isolation",
    terms: [
      "gq-ecommerce",
      "GQ eCommerce",
      "getquick-ecommerce",
      "CartBearerIsolation",
      "@getquick/auth-contract",
    ],
  },
  {
    name: "gq-config",
    path: "wp-plugins/gq-config",
    owns: "GQ Config, the must-use plugin with GETQUICK options",
    terms: ["gq-config", "GQ Config", "getquick-config"],
  },
  {
    name: "gq-design",
    path: "wp-plugins/gq-design",
    owns: "GQ Design: templates, block validation and headless layout delivery",
    terms: ["gq-design", "GQ Design", "getquick-design"],
  },
  {
    name: "gq-support",
    path: "wp-plugins/gq-support",
    owns: "GQ Support: the support plugin and its Worker",
    terms: ["gq-support", "GQ Support"],
  },
  {
    name: "gq-theme",
    path: "wp-plugins/gq-theme",
    owns: "the blank placeholder WordPress theme",
    terms: ["gq-theme"],
  },
  {
    name: "getquick-theme",
    path: "wp-plugins/getquick-theme",
    owns: "the GETQUICK block theme",
    terms: ["getquick-theme"],
  },
  {
    name: "getquick-registry",
    path: "internal/getquick-registry",
    owns: "the private Composer registry",
    terms: ["getquick-registry", "Composer registry", "satis.json"],
  },
  {
    name: "gq-ops",
    path: "gq-ops",
    owns: "the gq Ops CLI",
    terms: ["gq-ops"],
  },
  {
    name: "ekis",
    path: "clients/ekis",
    owns: "the Ekis Site",
    terms: ["Ekis"],
  },
];

export const ORGANIZATION = "Quick-Release";
export const DEFAULT_CODE_ROOT = "/data/code/getquick";
export const DEFAULT_WORKSPACES_ROOT = "/data/agents/workspaces";

export function findRepository(name, repositories = REPOSITORIES) {
  return repositories.find((repository) => repository.name === name);
}

# ADR 0017: Generate commerce Sites from the variant alone

- Status: Accepted
- Date: 2026-10-17

## Context

`gq new --variant commerce` was refused, and `--variant commerce` changed no
template, so `gq sync` gave a commerce Site the content Site's Astro Frontend,
WPGraphQL plugins and publication store. New commerce Sites (FPA Shop, Bruaa)
were kept as gated foundations with an always-failing check.
[#28](https://github.com/Quick-Release/gq-site/issues/28) asked what the
commerce variant manages. This ADR answers it for a **new** commerce Site;
what only Ekis's adoption needs stays with
[#18](https://github.com/Quick-Release/gq-site/issues/18).

The evidence is gq-platform's
[commerce architecture research](https://github.com/Quick-Release/gq-platform/blob/main/docs/research/cloudflare-tanstack-commerce-architecture.md)
(FRONTEND-SELECTION, slice 2): keep TanStack Start/Router/Query and a
same-origin BFF Worker deployed with Vite, WooCommerce as the only commerce
authority, no Astro substitution, and a server-held cart-session mapping in
D1. The storefront Runtime is `@quick-release/storefront`; its peer
`@getquick/auth-contract` is not yet released, and GQ Design's contract and
renderer packages are not either
([#32](https://github.com/Quick-Release/gq-site/issues/32)).

## Decision

- **The variant is the only selector.** `variant: "commerce"` decides a Site's
  app skeletons, managed files and defaults. There is no `frontend` selector:
  a commerce Site's Frontend is its storefront (gq-platform glossary), and no
  second commerce Frontend exists. One can be added later, additively, with a
  manifest migration. The variant never changes after creation.
- **Managed files vary by variant through `ownership.json`.** An entry may
  list the `variants` it applies to, as `packages.json` entries do; one
  without applies to both. The content Frontend skeleton, the publication
  store migrations and the event mu-plugins are content-only.
- **`gq new --variant commerce` generates a Site now, without the storefront
  Runtime.** It writes the CMS skeleton, the managed root, infra, CI and
  checks, and a minimal TanStack Start Frontend with Site-owned presentation,
  offline and without secrets. Mounting the storefront Runtime is its own
  slice, blocked on its release; a Site generated before it adds the
  dependency and routes itself, as a guide describes.
- **Packages declare their Cloudflare bindings; the managed deploy applies
  them.** The Frontend is built with Vite+ (Platform ADR 0004) and deployed
  through the same Alchemy pin as content, with `Cloudflare.Website.Vite`.
  When the Frontend depends on `@quick-release/storefront`, the managed deploy
  reads its `infra.json`: the `CART_SESSIONS` D1 database (retained in
  production, migrations applied before the Worker), its rate limiters and its
  secrets and vars, and refuses a deploy missing one. No Site copies a binding
  list.
- **Rate-limit namespace IDs are per Site, in `gq.ops.json`.** They are
  per-account integers; two Sites sharing one share counters. They are absent
  at generation, assigned at provisioning from a fleet register, and the
  deploy refuses without them, until `getquick-fleet` can allocate them.
- **Commerce CMS.** `wordpress.plugins` defaults to `gq-design`,
  `woocommerce`, `getquick-ecommerce`, `gq-support`, `s3-uploads`,
  `simple-history`, `cimo-image-optimizer` and `safe-svg`, in that order. No
  WPGraphQL: the storefront reads the Store API and WordPress REST. The
  generated `admin.sh` is shared by both variants; on commerce it runs
  WooCommerce's database update after activating the plugins. That update is
  forward-only, so a release that changes WooCommerce's database version
  states whether it is rollback-safe (ADR 0016); `gq` never rolls data back.
- **No content delivery on commerce.** A commerce Site gets no publication
  store, publication or settings events, reconciliation or refresh. Product
  presentation delivery is a later decision (CATALOG-GUARANTEE).
- **No commerce readiness yet.** `gq site check` refuses on a commerce Site
  until [#26](https://github.com/Quick-Release/gq-site/issues/26) defines its
  health checks; passing `gq verify`, formatting or manifest validation is
  never readiness. `gq media check` is shared.
- **Defaults.** Commerce checks are content's (`check`, `lint`, `test`,
  `test:scripts`, `infra:check`, `ci:check`, Composer validate/lint/test) plus
  the Frontend's `build`; release paths and version files are content's; the
  required files are `apps/cms/{composer.json,.ddev/config.yaml}` and
  `apps/frontend/{package.json,vite.config.ts}`.
- **Domains and apps.** Commerce keeps the `admin` and `frontend` roles; the
  BFF is same-origin, so there is no checkout or API host. Neither variant
  generates `apps/docs`.
- **Secrets and private packages.** On commerce, `gq frontend secrets`
  generates the storefront's secrets into Sigillo, `gq ci deploy` gives them to
  CI, and the proxy secret also reaches the CMS's environment. A managed
  `.npmrc` names the GitHub Packages registry for `@quick-release`, without a
  token: developers keep a `read:packages` token in their user config and CI
  gets one from Sigillo.
- **Monolingual for now.** A commerce manifest may set `wordpress.locale` and
  is refused `wordpress.languages` until multilingual commerce is decided.
- **Local data.** `db:sync` stays live-to-local only; on commerce, customers
  and orders are anonymised on import, so raw customer data never lands on a
  developer's machine by default.

## Considered options

- **A `frontend: { variant: "storefront" }` selector**, as the TanStack
  research proposed: a matrix (content + storefront, commerce + Astro) nobody
  needs, each pairing tested or refused, under a name the glossary avoids.
- **Keep refusing until the storefront installs**: the foundations could not
  provision their CMS meanwhile, for no gain in safety, since readiness
  refuses anyway.
- **Pin the storefront in the skeleton now**: `pnpm install --frozen-lockfile`
  fails until GQ eCommerce publishes the auth contract.
- **Hash rate-limit IDs from the project name**: collisions are silent.

## Consequences

- Left to [#18](https://github.com/Quick-Release/gq-site/issues/18) (Ekis
  adoption only): Ekis's edited managed paths, its legacy `admin.sh`
  clean-ups and WooCommerce reinstall list, `ekis-blocks`, the dropped
  `credentials` defaults, the site-neutral deploy status marker, and whether
  `ci.directory` is honoured instead of `infra/ci`.
- FPA Shop and Bruaa adopt in their own repositories: remove the foundation
  files that conflict, bump the pin, run `gq sync`.
- Blocked elsewhere: GQ eCommerce releasing `@getquick/auth-contract`;
  gq-storefront releasing without the Ekis git dependency and Ekis-era
  `VITE_*` names; GQ Design's contract and renderer packages (#32).

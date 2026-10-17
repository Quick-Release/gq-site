# ADR 0018: Ship GQ Design's contract and renderer as lockstep packages

- Status: Accepted
- Date: 2026-10-17

## Context

[#32](https://github.com/Quick-Release/gq-site/issues/32) asked for the
shared block renderer's package API and home. The evidence is
[#20's comparison](https://github.com/Quick-Release/gq-site/blob/research/block-renderer-comparison/docs/research/block-renderer-comparison.md):
the content Frontend (the `gq new` skeleton, copied from Lombardi) fetches
WPGraphQL and injects WordPress's rendered HTML, while Ekis renders GQ
Design's contract nodes, read over REST (`getquick-design/v1`), through a
framework-neutral core (`@getquick/design-renderer-core`) and a React
registry. The two share block names and the plugin, not code.

Since that research, Lombardi has been archived, so no client Site depends on
the HTML renderer except through the skeleton (Cooldown Gaming). gq-platform's
[ADR 0001](https://github.com/Quick-Release/gq-platform/blob/main/docs/adr/0001-ownership-of-work-across-getquick-repositories.md)
places the block renderer in gq-design's Runtime layer and says contracts
belong to their provider; GQ Design already hardcodes contract `1.0.0` in its
REST controllers. Its open item was whether the renderer is its own repository
or joins gq-content. gq-platform's
[commerce architecture research](https://github.com/Quick-Release/gq-platform/blob/main/docs/research/cloudflare-tanstack-commerce-architecture.md)
left RENDERER-SEAM here, with one constraint: no React in the canonical
contract. [ADR 0017](0017-generate-commerce-sites-from-the-variant-alone.md)
makes the commerce Frontend TanStack Start with Site-owned presentation, and
leaves the content Frontend Astro.

Ekis's packages are `private`, `workspace:*` and unpublished. GitHub Packages
only accepts the owner's scope, so `@getquick/*` can't be published there.
The blueprint pins GQ Design as `*@stable`, so each Site's lock picks its
version, and `gq packages` knows only Composer packages.

## Decision

- **Content Frontends keep rendering WordPress's HTML.** Both variants
  converge on GQ Design's block names, manifest and fixtures, not on one
  renderer. Moving content to contract nodes is gq-content's later decision.
- **gq-design owns two packages**, both private on GitHub Packages:
  - `@quick-release/design-contract`: generated types (`.`), `./schemas/*`,
    `./fixtures/*`, `./openapi` and `./compatibility.json`, for only what the
    plugin serves at `getquick-design/v1`. The storefront-config and product
    structured-data schemas and the JSON-LD helpers stay in Ekis until
    gq-storefront and GQ eCommerce take them.
  - `@quick-release/design-renderer` (renamed from `design-renderer-core`),
    framework-neutral and generic over its output: `.` (`renderDesignLayout`,
    `walkDesignLayout`, `assertDesignLayout`, `inspectNode`,
    `validateManifestAdapter`, `RendererContractError`, `resolveDesignToken`,
    `presetStyles`, types), `./client` (a REST client for layouts, manifest,
    discovery and previews that takes `fetch` and validates every response),
    `./reference` (`renderReferenceHtml`) and `./testing` (manifest coverage
    and fixture rendering for a registry).
- **Each commerce Site owns its React renderer adapter**: registry,
  components and styling. The commerce skeleton starts it with a minimal
  adapter that passes the coverage check. No shared React adapter exists, and
  no Astro adapter is written while content renders HTML.
- **The content side joins gq-content.** The HTML helpers (block renderer,
  preset styles, container layout) and the WPGraphQL client move to
  `@getquick/content` with no design-package dependency; it is tested against
  the contract fixtures only in gq-content's CI. Until gq-content's cut lands
  ([ADR 0015](0015-hold-only-the-blueprint-in-this-repository.md)) they stay
  in the content skeleton.
- **Site blocks extend the contract by namespace.** A Site's block may declare
  namespaced data requirements (`ekis/customizer`) beside the core values;
  registries compose (`{...core, ...site}`), and `./testing` counts the
  Site's own manifest entries.
- **The contract carries token values.** GQ Design adds the preset palette to
  the contract (a `1.x` addition), and `presetStyles` turns it into the
  `--wp--preset--*` variables, so the editor's palette and the storefront
  agree.
- **Coverage is checked twice.** CI checks a registry against the manifest
  fixture of the pinned contract version plus the Site's blocks. At runtime
  the client compares the CMS's live manifest with the registry and reports a
  difference through `onIssue`, without failing the page.
- **One gq-design tag releases all three in lockstep.** The plugin and both
  packages share a version; `contractVersion` stays the wire version, whose
  major changes only on a breaking wire change.
- **The blueprint pins the lockstep group exactly.** `getquick/gq-design`
  moves from `*@stable` to an exact pin; on commerce, the Frontend skeleton's
  `package.json` pins both packages exactly, as managed keys.
  `blueprint/packages.json` catalogues npm packages and the group, `gq
packages propose` moves the group together or not at all, and `gq doctor`
  fails a Site whose `composer.lock` and `pnpm-lock.yaml` disagree.
  Content Sites install no design package and need no GitHub Packages token.

## Considered options

- **Adopt the contract on content too** (option A): editors would lose every
  block without a renderer, and the publication store, refresh and readiness
  (ADR 0010) are built on stored HTML.
- **Extract the HTML renderer as the shared package** (option B): commerce
  couldn't use it without dropping Ekis's ADR 0002, so it would share nothing.
- **One package for contract and renderer**: the contract has consumers that
  render nothing, such as GQ Design's own producer tests.
- **Their own repository, or staying in Ekis**: the contract changes with the
  plugin's serializer, so splitting them makes every wire change two releases.
- **Public on npmjs as `@getquick/*`**: GQ Design is private and proprietary;
  `@quick-release/storefront` set the precedent.
- **A third `design-html` package in gq-design**: a public `@getquick/content`
  can't depend on a private package, and content Sites would need a registry
  token for a few helpers.
- **A shared React renderer adapter**: it moves React into the platform one
  layer below the contract; presentation is Site-owned (ADR 0017).
- **Independent semver mapped through `compatibility.json`**: it holds no
  plugin version today, and the mapping would be built only to be checked.

## Consequences

- The npm scope differs from the `@getquick/*` names in gq-platform's glossary
  and ADR 0001, whose scope question stays open there.
- Lockstep releases bump packages whose code didn't change.
- Every block GQ Design enables needs a renderer in every commerce Site's
  adapter. Whether the Elements blocks (video hero, grid, loop, social links)
  enter the manifest is GQ Design's decision.
- Ekis's workspace packages stay the source until gq-design's first release;
  Ekis then switches to the published packages and adds the
  `getquick-design/container` renderer it lacks, as part of its adoption
  ([#18](https://github.com/Quick-Release/gq-site/issues/18)).
- Sites already generated keep their copy of the content helpers; only new
  Sites import them from `@getquick/content`.

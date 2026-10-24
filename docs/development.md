# Develop and publish gq-site

[Documentation](README.md)

## Development

Use Node 24.21.0 (the CI version) and the pnpm version pinned in `package.json`.
The published CLI supports Node 22.12.0+; Vite+ 1.0's development tooling
requires Node `^22.18.0 || ^24.11.0 || >=26.0.0`.

```sh
pnpm install --frozen-lockfile
pnpm exec vp run check   # Vite+ formatting/linting, then node:test
pnpm exec vp run format  # format with Vite+ (Oxfmt)
pnpm exec vp run lint    # lint with Vite+ (Oxlint)
pnpm schema             # regenerate schema/gq.ops.schema.json after changing src/manifest/schema.mjs
```

The `pnpm check`, `pnpm format`, `pnpm format:check`, `pnpm lint` and
`pnpm test` scripts run the same tools. Formatting and linting are configured
in `vite.config.ts`; generated schema, upstream skills, the blueprint's
templates and the content-site fixture (`test/fixtures/content-site/`) are
excluded from formatting. The templates keep their own toolchain pins.

`vp check` runs static checks only; `vp run check` also runs the tests.
`vp run test` uses the existing `node:test` suite, not `vp test` (Vitest).

### Source filenames

For this package's CLI source in `src/`:

- Use lowercase kebab-case filenames.
- Use `commands.mjs` for a module's command entry file.
- Use a `legacy-*` filename for a module that only reads an older shape, such as
  `manifest/legacy-release-config.mjs`; current manifest settings stay in
  `manifest/site-settings.mjs`.
- Add a qualifier only when it disambiguates the role: `dotenv-text.mjs` parses
  and edits text, while `cli/env-files.mjs` parses, reads, and writes environment
  files. Keep these coherent modules separate; a naming change does not require
  splitting or merging them.

Apply these conventions when working on ambiguous names, not as a blanket rename
of every file. They do not apply to extracted PHP/Astro app skeletons or upstream
agent skills. Manifest and deployment contracts such as `domains.admin`,
`deploy/ploi/admin.sh`, and `admin.d/` remain unchanged; see
[ADR 0002](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0002-generate-sites-from-a-versioned-manifest.md).

### Tests

Group module-specific suites in `test/<module>/`, named `<subject>.test.mjs`
(for example, `cms/composer.test.mjs` or `sync/ownership.test.mjs`). The folder
supplies the module name; don't repeat it in the filename. Use
`commands.test.mjs` for a module's command suite and lowercase kebab-case for
other subjects. Qualify distinct command subjects when they warrant separate
suites, such as `ploi/inspection-commands.test.mjs` and
`ploi/api-commands.test.mjs`. Keep package-wide `run.test.mjs` and `exec.test.mjs` at the
`test/` root, matching their source modules.

Shared helpers stay in `test/support/`, with filenames describing their roles:

- `fixture-site.mjs`: temporary sites, cleanup, captured output and recording
  adapters at the `run()` seam.
- `generated-site.mjs`: a site produced by `gq new`, file reads, hashes and
  working-tree snapshots, reused by sync and CMS suites.
- `site-settings.mjs`: independent content-variant expectations and release,
  verify and doctor test recipes. Keep expected values independent of production
  defaults so the tests can detect drift.
- `deploy-script.mjs`: the CMS deploy script harness and local tool stand-ins.
- `offboarding.mjs`: the offboarding suites' synced Site and its in-memory
  account (Cloudflare, R2's S3 API, Ploi, Sigillo, `gh`, and git against an
  Artifacts repository, each listing a page at a time), with ZIP, git bundle
  and output helpers.

Keep this small shared helper set rather than adding per-module helper folders
or forwarding modules. Baseline evidence stays in `test/fixtures/`; its
[provenance and preservation rules](https://github.com/Quick-Release/gq-site/blob/main/test/fixtures/README.md) explain how it is
used and why extracted scripts are not package suites.

The `test` script selects root suites and one level of explicitly named module
folders, never recursively through fixtures or support. Add new module folders
to that script's allowlist; extracted site test scripts must not become package
suites. Move coherent suites intact before considering a subject split.

Split by independently meaningful behavior, not file length or test style.
Sync ownership categories have separate suites for generated sections, managed
keys and create-once files; `sync/ownership.test.mjs` keeps their cross-category
checks. Provider-specific command cases belong in the provider folder, while
`run.test.mjs` retains common routing, context, environment and error-reporting
contracts. Preserve existing assertions and the `run()` seam when splitting.

```sh
pnpm test                                        # all package suites
node --test "test/cms/*.test.mjs"                 # one module
node --test test/cms/composer.test.mjs             # one subject
```

Tests call `run()` against a fixture site (a temporary Git repository with a
`gq.ops.json`) with recording fakes for `fetch` and `exec`
([`test/support/fixture-site.mjs`](https://github.com/Quick-Release/gq-site/blob/main/test/support/fixture-site.mjs)). They need
no network, credentials, or provider accounts.

The Frontend skeleton's own tests run in a generated site:
`scripts/smoke/frontend-check.sh` generates a disposable content site, installs
its Frontend dependencies (the networked step) and runs its tests,
`astro check`, lint and format check. These generated sites install
`@getquick/site` from this checkout, packed into a tarball
(`scripts/smoke/this-checkout.sh`), not from npm, so a release push is tested
before npm serves the release. `scripts/smoke/content-pair.sh` proves that
a generated site wires the pinned content runtime
([ADR 0020](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0020-wire-new-content-sites-to-the-gq-content-package-pair.md)):
its pins and their published integrity, the crontab's command against the
CMS plugin's published ZIP, the migrations `infra/frontend.run.ts` resolves,
and the Frontend served in workerd with a local D1 store through its `/gq`
routes. The runtime's own behaviour is proved in Quick-Release/gq-content.
`scripts/smoke/consent.sh` proves that a generated site composes the consent
Runtime (CONSENT-1, LEGAL-1): its Frontend, served the same way with a local
consent database beside the store, passes gq-content's shared acceptance
suite (`runConsentAcceptance`) in Chromium on representative routes, records
a decision through `POST /gq/consent` and reads it back with the bearer, and
is ready by `gq site check`'s consent part with GA4 on, monolingual and
bilingual. It needs Playwright's Chromium (`pnpm exec playwright install
chromium`) or `CHROMIUM` naming one.
`scripts/smoke/cms-polylang.sh` proves a bilingual site's Polylang
configuration (the generated `deploy/ploi/polylang.sh`) on a real WordPress
with Polylang and GQ Polylang for WPGraphQL, read over GraphQL.
`scripts/smoke/ci-composer.sh` builds a generated
site's Cloudflare CI image with Docker and runs its install step's Composer
command as the image's root user on a clean CMS (see
[CMS dependency patches](guides/dependency-patches.md#verification-boundary)). The
wiring proof also installs the CI Worker's dependencies for Wrangler's local
workerd runtime. `scripts/smoke/acceptance.sh` runs `pnpm check` and the
three generated-site proofs in order: spec #38's local acceptance gate. CI runs `pnpm check`,
`frontend-check.sh`, `content-pair.sh`, `consent.sh` and `ci-composer.sh` on every push; the
real-WordPress Polylang proof needs PHP and downloads, and the live gate is the
gq-smoke wizard ([A new content Site, end to end](guides/provisioning.md#a-new-content-site-end-to-end)).

For blueprint source roles, ownership mappings, and deliberate dotless source
names, see the [blueprint map](../blueprint/README.md). `ownership.json` remains
the authority for which site paths are touched.

### Staged presentation consumer checks

Before a coordinated content release is published, set `GQ_CONTENT_TARBALL`
to the absolute path of an immutable `@getquick/content` preview tarball.
The generated-site smoke scripts install it through a local workspace override.
The generated package files retain their published pins; the preview bundles
its shared Design dependencies and needs no private registry access.

```sh
GQ_CONTENT_TARBALL=/absolute/path/to/getquick-content-preview.tgz scripts/smoke/frontend-check.sh
GQ_CONTENT_TARBALL=/absolute/path/to/getquick-content-preview.tgz scripts/smoke/presentation.sh
```

The presentation proof builds the actual generated Astro frontend and serves it
in local workerd with its publication store. The CMS supplies the saved document
after the build, so the browser checks production CSS for late-authored content.
It checks nested Container caps at every default breakpoint boundary and explicit
centering, padding and upward overrides in the page body and selected chrome,
in both LTR and RTL. Versioned fixtures in `test/fixtures/presentation/` retain
the real saved-editor document, WordPress-rendered HTML and neutral public node;
`test/fixtures/README.md` records provenance and hashes. The CMS's HTTP envelope
is stubbed. Editor save/reload and live producer acceptance remain upstream checks.

The same proof also consumes the real native Image/Cover and layout fixtures,
checks resolved-theme changes without rebuilding, and verifies the saved Hero's
box, media layer and focusable foreground. The theme fixture checks heading,
list and media Preflight against both captured resolved themes. Preview6 also
checks actual typography list/button semantics in body and neutral chrome,
Carousel responsive hiding/restoration, keyboard/focus and autoplay behavior,
and the refreshed standard Post Query fixture through the existing publication
loader. Query checks include ordered repetition, recursive Post Content,
transparent references and responsive Grid/Heading/Button CSS. Carousel controls
use a clearly labelled supporting visibility variant of the captured input.
The actual saved navigation capture also checks mobile open/Escape/focus return,
ordered links and native descendants, Social Links visibility, and authored
styles at every default breakpoint edge in LTR/RTL. Its body HTML and neutral
tree differ upstream and are asserted independently, as the fixture provenance
records. Ordinary native/custom body menus also open and close through the
configured package's existing HTML-delivery enhancement and the same initializer.
Additional actual captures exercise native Columns without core CSS
at 781/782/783px (stacking, unequal/equal growth and native/neutral alignment),
the latest layout's narrow parent and gap-reset chronology, and source-derived
inline Heading/Paragraph content with computed typography at both captured
themes' thresholds.

The conditional language proof uses real Free Polylang EN/FR captures, serving
the exact captured flag PNGs at their original URLs. It independently checks
neutral layout current state and native body current state, names/flags-only
accessibility, dropdown controls, RTL spacing and scriptless native select
navigation. A separate null-flag native capture checks accessible names without
invented assets. These cases do not claim Pro or broad HTML/neutral parity.
Supporting Site/Post context cases use existing publication loaders and public
home settings for recursive post content, Featured Image and primary/dark/title
Branding fallback; they do not establish a valid saved dynamic Design layout.
Supporting Cover cases check omission/aspect/source-shell height boundaries and
real WebM playback with reduced-motion pause/resume and cleanup/remount. The
WebM is generated test media, not a new CMS Cover-video capture. Lifecycle event
checks exercise cleanup/remount; they do not establish browser back-forward
cache behavior.

The script also runs a separate Hero production build that temporarily declares
YouTube in the disposable Site configuration, restoring that source afterwards.
It checks saved HTML and registered REST dispatcher nodes through consent grant,
reduced motion, responsive iframe geometry and withdrawal, with all player
requests fulfilled locally. The saved self-hosted case has an empty video URL;
it does not establish streaming-video playback. Report these cases separately
from pending submenu interactions and valid saved dynamic typography layout
delivery; the bounded proof does not
establish full catalog or fleet acceptance.

Staged preview success does not establish that the currently published content
version supports the new exports. Advance the managed CMS/npm pair only after
the coordinated version is published, then rerun without the local override.
The accepted phase-6 evidence uses immutable content preview10 from runtime commit
`52bbd6db056adc99915eaa18525a85f9c231d42a`, bundled Design commit
`634f58c8e42c8a1e7f8334e937126b472387d405` (Design 0.9/wire 2). Archive SHA-256:
`14d1f7675af9d7e8e4102de529a286e913be442501d8f634bca111ab7d845edd`.

Subsequent independent installed-facade verification used content candidate
`cbb447f27174c12b01f4f4ec0848debda4609f6c`, bundling both Design archives at
`c4bcc5a9ef72ecad2b48495596464c9d4daa8c8b`. Archive
`getquick-content-c4bcc5a-final-candidate.tgz` SHA-256:
`d9977fe89e6e76eead1761fa9591f5dc95322d15aa6cb557d3dec6ff164a2af2`.
With only `GQ_CONTENT_TARBALL` changed to that archive, `frontend-check.sh`
passed 15 monolingual and 15 bilingual tests, both Astro checks reported zero
errors/warnings/hints, and frontend lint/format passed. `presentation.sh`
passed all 22 production groups, including the separate saved Hero consent run.
The Site implementation stayed at reviewed commit `0bddf43`; no new runtime
implementation or fixture substitution was needed. This verifies the final
installed facade through the bounded starter paths, retaining all provenance
and coverage limits above. Root `pnpm check` previously passed 768 tests at
that implementation commit; the dependency-independent root suite was not rerun
for this archive-only verification.

Published managed CMS/npm pins remain `0.3.1`; Tailwind pins are exactly `4.3.3`.
Commerce generation and gq-design #12 Actions package access remain separately
owned prerequisites, outside these consumer checks.

## Releasing

1. Bump `version` in `package.json`, add its section to `CHANGELOG.md`, and
   commit.
2. Tag the commit `v<version>` and push the commit and tag.
3. `pnpm release:publish` checks that `HEAD` carries that tag and that
   `pnpm check` passes, then runs `npm publish` under Sigillo's `operations`
   environment (`gq.ops.json`), where `NPM_TOKEN` lives. The token is never
   written to disk. It is a granular token that expires within 90 days, so
   rotate it before then.

The [`run()` interface and injected adapters](reference/programmatic-use.md)
are the seam used by the fixture-site tests. For working on a generated site
rather than this package, see [Local site development](guides/local-development.md).

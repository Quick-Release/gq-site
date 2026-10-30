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
before npm serves the release. `scripts/smoke/commerce-check.sh` generates a disposable commerce site
([ADR 0017](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0017-generate-commerce-sites-from-the-variant-alone.md)),
installs it twice (the second with a frozen lockfile) and runs `gq sync
--check` and `gq verify`; that proves generation and the skeleton's checks,
never commerce readiness. `scripts/smoke/content-pair.sh` proves that
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
`scripts/smoke/cms-rest-gate.sh` proves a generated CMS's REST gate
(`content-api.php`) on a real WordPress over HTTP: an anonymous POST to
`/gf/v2/forms/<id>/submissions` reaches its route while gq-content's forms
module has Gravity Forms active (a stand-in for both), and the REST index,
reading forms or entries, method overrides and every other route stay 401.
`scripts/smoke/cms-content.sh` proves the agent's content route
(`gq content`, [gq-platform ADR 0011](https://github.com/Quick-Release/gq-platform/blob/main/docs/adr/0011-agent-access-to-production-cms-content.md))
on a real WordPress over HTTP, behind the generated `content-api.php`, as an
Editor agent user with an application password: `get`, `diff` and `put`
over REST with a new revision confirmed, the block editor's validation in a
headless Chrome (valid, invalid, deprecated and unregistered blocks), and the
server script `gq wp` sends for a break-glass `post update`. It needs PHP,
curl and Chrome or Chromium (`CHROMIUM`), and runs locally. `gq content
validate`'s DDEV wiring is covered by the package suite with stand-ins.
`scripts/smoke/ci-composer.sh` builds a generated
site's Cloudflare CI image with Docker and runs its install step's Composer
command as the image's root user on a clean CMS (see
[CMS dependency patches](guides/dependency-patches.md#verification-boundary)). The
wiring proof also installs the CI Worker's dependencies for Wrangler's local
workerd runtime. `scripts/smoke/acceptance.sh` runs `pnpm check` and the
three generated-site proofs in order: spec #38's local acceptance gate. CI runs `pnpm check`,
`frontend-check.sh`, `commerce-check.sh`, `content-pair.sh`, `consent.sh`, `cms-rest-gate.sh` and `ci-composer.sh` on every push; the
real-WordPress Polylang proof, which also needs PHP and downloads, runs locally, and the live gate is the
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

The `0.23.2` release adopts the published `0.3.2` pair from source/tag
`698b98965b8138d25e273d9cdafe84f8397ca66d`, independently verifying the npm
archive SHA-256 `18df1f27ca3284338e611c611bef1f22707b9578f5145be670b7be50ab6b0373`
and public CMS ZIP SHA-256
`89706f3f1796e78d20bbe34ea6205834709052b9fa3446b58ae102dfc169d774`.
The normal npm lock holds the published SRI, and both managed fragments and
full skeletons pin `0.3.2`. No content archive override is used for release
checks: `pnpm check` passes 768 tests, generated frontend checks pass 15+15
with zero Astro diagnostics, and presentation checks pass all 22 production
groups. The broader consent smoke passes 32 monolingual and 56 bilingual
shared checks, plus generated routes/records/third-party probes. The
paired-package smoke also verifies the published npm lock integrity, CMS ZIP
identity, managed keys, crontab, migrations and actual package route delivery.
The schema probe now checks the published runtime's `databaseId`, `getquickBlocksJson`
and `theme` fields; its existing coverage guard exposed the missing fields.
The earlier accepted preview evidence retained published `0.3.1` pins and is
recorded separately above. Tailwind pins are exactly `4.3.3`.
Commerce generation and gq-design #12 Actions package access remain separately
owned prerequisites, outside these consumer checks.

The `0.24.0` release adopts the published `0.4.0` pair (headless Gravity
Forms, gq-platform ADR 0009) from source/tag
`61f51f4f98e7974e1447fd7cb45a0135c847a1c7`, independently verifying the npm
archive SHA-256 `0dd95243e83a74ba918c44c3fdb4cf4289e8f48eeb56711b3a89f3664af19482`
(SRI `sha512-YSKKFoil…Rmg==`, as in the npm lock) and public CMS ZIP SHA-256
`1d177a9f1508e501b2c495881748a51d89e1a88d3f03d868f6eb0a2e858a85fc`, the
archive Composer serves for `getquick/gq-content` `0.4.0`. No content archive
override is used for release checks: the root suite passes 787 tests,
`frontend-check.sh` passes, including its forms leg (a Site declaring
`forms` with Turnstile syncs the form route and passes Astro check with zero
diagnostics, tests, lint and format), and the paired-package smoke passes all
33 checks. The forms checks run the synced route in workerd: GET is a 405, a
post missing required fields is checked against the descriptor stored with its
page, a form its page doesn't reference is refused, neither post reaches the
CMS, and other paths under `/gq/forms/` are 404s. No run has used a real
Gravity Forms install; that is the first adopting Site's work.

The `0.26.0` release adopts the published `0.4.2` pair (`trustedProxies` on
the form and consent servers, IPv6 /64 rate-limit keys) from source/tag
`043afbebc06ff5d047ca0906e08d1f7208c8827b`. Its npm archive SHA-256 is
`1d2add1a11fea4807816984282fc1a1823870ac681e62ac8acc8086d63e2aab9` (SRI
`sha512-Phkk8tZ/…SivQ==`, as in the npm lock), and its CMS ZIP SHA-256 is
`a0a28adda5ef17d09574bb65174fde553fefd70171b2382521bc0bbce2d1baa7`. Both
match the release's `release-manifest.json`. The root suite passes 822 tests
and `frontend-check.sh` passes, forms leg included. A generated TanStack Site
with `forms` and `domains.frontendProxy` passes `tsc` against 0.4.2, and a
misspelt `trustedProxies` fails it.

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

# Test fixtures

These files are baseline evidence, not current site configuration.
Do not regenerate expected fixtures from the production implementation. Shared
test recipes belong in [`test/support/`](../support/), not here.

## Provenance and use

The `presentation/` snapshots come from gq-design commits `4db472b` and
`76ad385` (#73). `container-saved.html` is the real Gutenberg document after
sidebar authoring, serialization, parse and valid rerender. The Base controls
set Width 1/2, Margin inline Auto and Padding inline 4; md sets Width Full and
lg sets Max width lg. `container-rendered.html` is WordPress `do_blocks` output
with that plugin's neutral render filter. `container-public.json` is the
schema-valid public TemplateSerializer node from the same document and real
`parse_blocks`; it is serializer evidence, not a live REST/GraphQL capture.
The production presentation proof feeds the HTML through the delivered page
body and the public node through selected chrome patterns. Its HTTP CMS is a
stub; it does not replace upstream editor/producer tests.

Immutable SHA-256 values (keep the fixture bytes unchanged):

- `container-saved.html`: `4dfa37339a789fbc2708f183f8050aed723160ebc0068baecef472f1a62bc7e9`
- `container-rendered.html`: `4de246453e6ed3977082cb51676565b21723cba2ee22e46224887f750b82992d`
- `container-public.json`: `25ea94c114c1d9381b78a95a2043f9e67d459cabce29674a773886ccf3f966a4`

The `media-saved.html` and `media-public.json` snapshots are unchanged from
gq-design `c5dc50a`, `tests/fixtures/media-presentation/{saved.html,public.json}`.
The saved document uses Gutenberg 7.0 with shared Image controls and valid reopen;
the public file records real `parse_blocks`, TemplateSerializer and native
`render_block` output from a read-only request. The linked Image and Cover have
real HTML. Featured Image HTML is empty without a post, and Site Logo assets are
null without branding context; neither proves those consumers. The SVG URL is
fulfilled locally during browser checks.

- `media-saved.html`: `656b3dbaf0037de44209119bc90a064201431077383e863dfa3477d061e73c92`
- `media-public.json`: `0e600dd03a342a31d87832815eaa5a0da6203fdc4e2dbb8ffe00e626702988a7`

`media-source-public.json` is unchanged from gq-design
`2b40c7eb78b7b7a41f7fc4ebb5158c88e4162f26`,
`tests/fixtures/media-presentation/public.json`. The production proof now reads
this newer capture; the original snapshot above remains preserved. It adds the
actual REST producer comparison (`restNodes`) and authoritative Image source
attributes recovered from saved HTML (`sourceNode`), including safe source sets,
intrinsic dimensions and link metadata. The captured Image/Cover HTML is
unchanged. Canonical `728a60d` also reserves caption space inside the authored
Image figure: the proof therefore checks the figure's 192px height and that its
media plus caption fit inside, rather than requiring the image alone to be
192px. The starter supplies no source parser or caption CSS.

- `media-source-public.json`: `385b5b07f800c9189b7a2a52a98f88ea9d6a7addb0839ff5fd262c50a698f4ff`

`theme-delivery.json` is unchanged from gq-design `2a181bf`,
`tests/fixtures/theme-presentation-delivery.json`. Its embedded provenance records
the WordPress 7.0 capture, test and saved-document hashes. Both deliveries retain
the real saved/reopened document, public WordPress-rendered HTML, producer nodes
and complete resolved tokens for the default and overridden themes. The starter
uses the actual HTML and theme values through its stubbed GraphQL envelope; an
empty legacy `spacingSizes` list completes that envelope without changing the
fixture values. This is frontend rendering evidence, not a live CMS transport test.

- `theme-delivery.json`: `8c1f5a1af6b58a02c9f282f2999d4e808d3c9f5469dd5779ad0b118c9e84a41d`

`layout-delivery.json` is unchanged from gq-design `720b84a`,
`tests/fixtures/layout-presentation-saved.json`. It records actual Gutenberg 7.0
Grid columns, native Group gap and Column alignment inspector edits, valid
save/reload, and actual REST-rendered HTML and producer nodes. Native unequal
columns, nonstacking behavior, Spacer units/resets and Separator opacity are
part of the captured document. Its embedded provenance identifies the capture.

- `layout-delivery.json`: `682377d90e6d87554d31dd80062733a00a7054594fbca23fe7ec05131aec51f4`

The original layout snapshot remains preserved. `layout-current-delivery.json`
is unchanged from gq-design `893ea2d4aba9ceaf8de4e83e71c679b34bb9c098`,
`tests/fixtures/layout-presentation-saved.json`: six actual saved/reopened roots,
real public HTML/nodes, Row context and a narrow nested Grid with Base gap/row-gap,
md gap and xl reset. `native-columns-delivery.json` is unchanged from gq-design
`3a5d6be`, `tests/fixtures/native-columns-structural-saved.json`. It captures four
actual native Columns groups: default stacking/vertical alignment, unequal
nonstacking columns, equal three-column growth and neutral width/alignment
overrides. Neither capture requires WordPress core CSS in the consumer proof.

- `layout-current-delivery.json`: `13bec5f6a2b8a427f919c35ca90d0ec192b5b876e4dcf184608a696f6c7d5630`
- `native-columns-delivery.json`: `adf20a3ca0ffe09581e0544e61237a561121e9d52edb7bcb1e83e4029daab501`

`hero-saved.html` and `hero-youtube.html` are unchanged snapshots of gq-design
`4e6f3dd`, `tests/fixtures/video-hero-{presentation,youtube}.html`. They are real
Gutenberg saved documents with half-width, 64 spacing-unit height, nested links
and independent media/foreground presentation. The YouTube document includes
deferred `data-src`, localized title and cover/contain/reset overrides. These
files establish saved-input provenance, not a live REST capture or consent proof.

- `hero-saved.html`: `ceb2ddc6360274c5ab97e18836f3755df641fc720a5e2aefe931ff01b9c92239`
- `hero-youtube.html`: `dbdf5b59fb89f673f8f780fbedae4360e60a76a31a6cdfd5461fde2d7440b4f4`

`hero-saved-public.json` is unchanged from gq-design
`e696635af5fdb4f841debe78f9372ebbf07b6bf0`,
`packages/design-contract/fixtures/blocks/video-hero-saved.json`. It contains
the real registered anonymous REST dispatcher output for the two unchanged
`4e6f3dd` saved documents above, refreshed at canonical source `374904a` with
source-derived paragraph inline attributes. Its adjacent upstream
`video-hero-saved.md` records exact capture and cleanup; this is registered
`rest_do_request` evidence, not an external HTTP request. The first document has
a poster and an empty self-hosted URL, so it supplies no saved streaming-video
playback evidence. The separate Hero consumer proof declares YouTube in the
generated Site configuration and tests both saved body HTML and the actual
public YouTube node, without inventing nested link content.

- `hero-saved-public.json`: `0fc5b229f2e67658fb2844098bfa56eea3891b658747990d678a399b377a9cc2`

`carousel-public.json` is unchanged from gq-design `3232d3c`,
`packages/design-contract/fixtures/blocks/carousel-presentation.json`. It is the
actual anonymous WordPress 7.0 REST `getquickBlocks` tree for the saved #78
Gutenberg document; actual HTTP GraphQL tree equality and strict public schema
validation passed upstream. The capture ran plugin checkout `bf709f59` through
integration `f57ae3e`. Its source/provenance companion is
`packages/design-contract/fixtures/blocks/carousel-presentation.md` at that commit.
The actual fixture authors navigation hidden. A separately labelled supporting
public-input variant changes only navigation visibility to exercise controls;
that variant is not claimed as a second captured editor document.

- `carousel-public.json`: `ddb58fb636e28b3da412575775b22a0f73aae30f3afbb5d1728a007a4a7cc6f2`

`typography-delivery.json` is unchanged from gq-design `b11b763`,
`tests/fixtures/typography-presentation-delivery.json`. Both theme cases contain
the actual saved/reopened Gutenberg page, public rendered HTML, neutral nodes,
tokens and post/site context. The production proof uses captured body HTML and
the neutral nodes as selected chrome, preserving list-item `attributes.content`
and button rich text. That chrome selection is a consumer test envelope, not a
captured Design layout. The fixture records `layout.available=false`: the
preview-only template was rejected with HTTP 422 for missing region references.
It supplies no valid delivered dynamic Site/Post layout nodes, so those families
and layout-endpoint acceptance remain pending.

The preview5 (`991e399`) run failed the neutral selected-chrome ordered list.
Preview6 (`6695e02`) passes captured body and neutral chrome list/button semantics
through the actual production route. The starter adds no local renderer. Theme
typography and dynamic-layout acceptance are not established by those semantic
checks.

- `typography-delivery.json`: `55916b46bbfed0bb4ee64bd89a0ff9c39ab5f4e8fe8039db0099dc3a94a32d77`

`typography-inline-delivery.json` is unchanged from gq-design
`57f5ba68b1bee247fc453389699d39fa6ab79e33`,
`tests/fixtures/typography-presentation-delivery.json`. It refreshes the same real
capture with source-derived Heading/Paragraph `attributes.content`, rich links,
strong text and `span.inline-label`, preserving quoted `>` titles. Both actual
theme cases retain the same layout HTTP 422 limitation documented above; they
do not supply a valid published dynamic layout. The original `b11b763` capture
remains preserved separately.

- `typography-inline-delivery.json`: `de1acd7589c1ef52d95bf212f21e20e18be4cb243d45d5f6dbd49d80593b7921`

`presentation/query-composition/post-{public.json,saved.html}` are unchanged from
gq-design `6b5f746`, `tests/fixtures/query-composition/`. They replace `627d5e6`
as the semantic acceptance input: real REST selects the standard Posts
`00081 Beta` then `00081 Gamma`, and each untouched `publishedPost` records the
actual public WPGraphQL response. The latest producer supplies Button
`url="#details"`, `text="Read item"` and `tagName="a"`; none are added locally.
The preview6 production proof selects the actual neutral Query as chrome, loads
the two Post URI records through the publication loader, and supplies the shared
preloader's synchronous callback. It checks producer order without reselection,
matching recursive Post Content, transparent synced references, Grid geometry
at 767/768/1000px, Heading CSS and Button href/text/tag/padding/radius. GraphQL
envelopes add required transport metadata around the unchanged captured records;
the HTTP server is a stub. The CPT variant is not adopted as loader evidence.

- `query-composition/post-public.json`: `74af8206e68cddc5a2488f7a460ccf5f99ac435bbd8608a28729f17205af782b`
- `query-composition/post-saved.html`: `b353c7430aa9a2edcb9cabacc46581b015f23fa3cc3b4eb65e4028335a8e158f`

`presentation/navigation/` preserves all seven files unchanged from gq-design
`802c9a198471497760328e585aadbd5726d8c660`,
`tests/fixtures/producer/navigation-presentation/`. The embedded provenance names
the source checkout `4db8b85`, real Gutenberg save/reload and anonymous public
HTTP 200 capture. `nodes.json` is the exact public `getquickBlocks` array;
`rendered.html` is the same response's `content.rendered`. The other files retain
the full public response and saved page/navigation-reference source. All six
payload hashes in the unchanged `SHA256SUMS` verify. Transient IDs and URLs are
historical and are not fetched by the consumer proof. The actual composition
includes custom/native menus, reference children, page lists and Social Links;
it contains no language switcher. Language-switcher/browser acceptance remains
separate.

The two captured deliveries differ: neutral native-navigation children omit
`Private draft`, resolve News to `/public-navigation-destination-80/`, and include
the dynamic branch. WordPress `rendered.html` retains `Private draft` at
`/stale-draft` and News at `/stale-public`, and omits that branch. The consumer
checks each delivery as captured; it does not reconstruct or filter the public
body HTML. Neutral filtering/resolution proof is not HTML parity evidence.

`presentation/language-navigation-flags/` is unchanged from gq-design
`ed0afd9c3f4e7307a3204aa9bf846c3db96429e7`,
`tests/fixtures/producer/language-navigation-flags/`. It retains the complete
actual WordPress 7.0/Polylang Free 3.8.10 capture, provenance, notices and all 16
verified payload/asset hashes. Explicit EN/FR layout nodes and ordinary post
REST nodes remain separate; their current metadata is not asserted equivalent.
The original DTO URLs are retained. The two captured PNG assets may be served
at their original URLs by test transport, without rewriting DTO values. The
capture covers names+flags, flags-only and dropdown modes. Preview9 production
checks decode both exact PNGs at their original URLs, preserve resolved home
links and independently check neutral-layout and native-body current metadata.
Preview10 additionally restores native-body select navigation through the shared
initializer, after configured delivery removes the captured inline controller.
The starter adds no replacement language policy or controller. Both list modes
and the neutral dropdown retain accessible names and keyboard focus; the
separate native null-flag capture below verifies names without invented images.

`presentation/language-navigation-a11y/` is unchanged from gq-design
`2e7e447fb27dfc8d9b750d96b6aabed177363cc2`,
`tests/fixtures/producer/language-navigation-a11y/`. All 14 captured payload
hashes verify. This separate real native rendering capture follows the owning
`e2cc4dc` missing-name fix: flags-only/null-flag links gain accessible names
without changed URLs, options or current metadata. It supplies no bitmap assets;
`ed0afd9` above remains the PNG authority. Older captures remain historical.

`presentation/cover-motion.webm` is a locally generated supporting playback
resource, not captured CMS media or a saved-editor document. SHA-256:
`edadb262415c87d3c11051cd037f60cde1926bf7810afc4cf68702244d2f1f6c`.
It was generated with `ffmpeg -f lavfi -i color=c=red:s=160x90:r=12 -t 1 -an
-c:v libvpx -b:v 20k -metadata creation_time=1970-01-01T00:00:00Z
test/fixtures/presentation/cover-motion.webm`. Test transport serves its exact
bytes to supporting neutral and ordinary published Cover inputs. This checks
the shared motion lifecycle through the actual starter, without claiming a new
CMS Cover-video capture.

| Fixture                                                    | Origin                                                                                                                 | Used by                                                                                                                                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content-site/`                                            | The expected eighteen CI Worker, Frontend deploy, consent and release-step files for `manifests/content-site.v1.json`. | [`sync/deploy-files.test.mjs`](../sync/deploy-files.test.mjs) compares rendered files and lock hashes with this baseline.                           |
| `manifests/content-site.v0.json`, `manifests/ekis.v0.json` | Unversioned `gq.ops.json` inputs: a fictional content site's and Ekis's.                                               | [`manifest/schema-and-migrations.test.mjs`](../manifest/schema-and-migrations.test.mjs) checks migration, dropped legacy keys and command refusals. |
| `manifests/content-site.shop-devtools.config.mjs`          | The content site's legacy release configuration, in the `@getquick/site` 0.8.0 format.                                 | The same migration suite checks folding site additions into the manifest while preserving release, verify and doctor behavior.                      |
| `manifests/content-site.v1.json`                           | The populated schema-v1 generation input, including plugins and site-specific release additions.                       | The deploy-file suite renders the content site's wiring from its manifest values.                                                                   |

The `v0` and `v1` suffixes identify manifest schema versions, not package
versions. The content site (`larkspur`) is fictional; the package tests need no
network, credentials or provider accounts.

The optional CMS Access integration updates the content site's
`infra/frontend.run.ts`, `infra/ci/cloudflare.ci.ts` and `infra/ci/env.ts`
baselines alongside their sources: only the GraphQL service pair is forwarded
by CI and bound privately to the Frontend. Automation credentials are excluded.
These are reviewed behavioral additions, not regenerated snapshots.

The production GraphQL path updates the content site's
`infra/frontend.run.ts` and `infra/scripts/deploy-frontend.mjs` baselines:
`wordpress.graphqlPath` selects `/graphql` or the default
`/wp/graphql`, and a public production URL binding reaches Astro's build child on
Alchemy beta.79. No secret binding changes. `sync/graphql-path.test.mjs`
independently exercises both paths, explicit overrides and local isolation.

The consent records ([ADR 0019](../../docs/adr/0019-record-visitors-consent-in-a-separate-eu-database.md))
add two baselines, `infra/consent.ts` and `apps/frontend/workers/consent-purge.ts`,
and update `infra/frontend.run.ts`, `infra/scripts/deploy-frontend.mjs`,
`infra/ci/cloudflare.ci.ts`, `infra/ci/env.ts` and `scripts/ci-release.mjs`:
a Frontend with the consent Runtime binds its own `eu` consent database, its
rate limiter and `CONSENT_READ_TOKEN`, and a purge Worker runs the Runtime's
purge; CI forwards the token like the Frontend's other secrets. Written by
hand and reviewed against the templates, not regenerated.

The Site's consent retention ([#115](https://github.com/Quick-Release/gq-site/issues/115))
updates the content site's `infra/consent.ts`, `infra/frontend.run.ts` and
`apps/frontend/workers/consent-purge.ts` baselines alongside their sources:
`infra/consent.ts` reads `gq.ops.json`'s `consent.retentionDays` at deploy
and, when it is set, both the Frontend and the purge Worker bind it as the
plain variable `CONSENT_RETENTION_DAYS`; the purge entry passes it to
`createConsentServer` as `retentionDays`. The content site's manifest has no
retention, so its deploy binds none and the Runtime's default applies.
`sync/graphql-path.test.mjs` exercises both bindings and runs the purge entry
against a node:sqlite D1 stand-in.

The CI image's Composer fix updates the content site's `infra/ci/Dockerfile`
baseline alongside its source: GNU `patch` for the CMS dependency patch, and
`COMPOSER_ALLOW_SUPERUSER=1` so Composer runs the allowed plugins as the
container's root user. `scripts/smoke/ci-composer.sh` builds and exercises
the rendered image.

The content package pair (ADR 0020) updates the content site's
`infra/frontend.run.ts` and `infra/scripts/deploy-frontend.mjs` baselines
alongside their sources: the publication migrations, which switch the store
on, come from a Site's own `apps/frontend/migrations` when it has them, and
otherwise, on a Site whose `contentRuntime` is `package`, from
`@getquick/content` installed in `apps/frontend` (its
`./migrations` export). The bindings, secrets and store names are unchanged.
`scripts/smoke/content-pair.sh` runs the rendered resolution against an
installed package.

The optional private draft preview adoption updates `infra/frontend.run.ts`,
`infra/scripts/deploy-frontend.mjs`, `infra/ci/env.ts`,
`infra/ci/cloudflare.ci.ts` and `scripts/ci-release.mjs` alongside the managed
sources. Preview uses Worker bindings outside explicit `Website.env`, but
Alchemy merges bindings before build and the build process can read credentials.
Build plugins and dependencies are trusted; this is not build-process isolation.
The dedicated Site CMS credential pair is required when preview is configured
and optional Access credentials stay separate. CI forwards these private
secrets only to the release step.
`sync/graphql-path.test.mjs` exercises the rendered runtime and validation;
`ci/commands.test.mjs` checks secret-store forwarding. These are explicit
behavioral baseline changes, not a snapshot refresh.

## Preservation

- Preserve fixture paths, contents and version identifiers during organization,
  naming and formatting changes. Do not replace historical inputs with today's
  site configuration or rewrite expected files from rendered blueprint output.
- `vite.config.ts` excludes `test/fixtures/content-site/**` from formatting and
  linting. Its files retain their own toolchain pins; they do not
  follow this package's source-file conventions.
- If a baseline must change, make it an explicit behavioral change: record the
  reason and review the corresponding assertions; do not silently refresh
  snapshots.

## Discovery

`pnpm test` selects root suites and one level of explicitly named module folders.
It intentionally excludes `test/fixtures/` and `test/support/`. Do not replace
that allowlist with recursive discovery through `test/`.

In particular, `content-site/scripts/ci.test.mjs` is a generated site test script,
not a package suite. The deploy-file suite controls when its generated copy runs
in a temporary site. New fixture files must not become independently discovered
package tests.

For helper roles and targeted test commands, see
[the development guide](../../docs/development.md#tests).

## wpgraphql-blocks 2.2.0

`wpgraphql-blocks-2.2.0/plugin.php`, `utils.php` and `LICENSE` are unmodified
upstream files from https://downloads.wordpress.org/plugin/wpgraphql-blocks.2.2.0.zip
(accessed 2026-10-17). `utils.php` is upstream `includes/utils.php`.
The GPL-3 license is retained. Source SHA-256 values:

- plugin.php: `1f3f0190cde9c8b5172239b95411ed15c86b708cac284b89a6c8f1ab4a735e98`
- utils.php: `c5a2fda8bce3e540e893428a4df1da94762159dc0d9cf5616b11b73ce1ee68f7`

The dependency-patch suite uses these independent bytes to reproduce the
warnings, apply/repair the managed patch, reject drift, lint PHP and compare
actual registered resolver/scalar responses before and after. Do not regenerate
these fixtures from the patched output. The patch originates in
[Nomia PR #3](https://github.com/Quick-Release/nomia-bnq/pull/3), commit
`0d0d65a3058d9da306b70d3535dfb91b8266e413`, and retains those reviewed bytes.

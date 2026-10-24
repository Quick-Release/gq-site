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

`hero-saved.html` and `hero-youtube.html` are unchanged snapshots of gq-design
`4e6f3dd`, `tests/fixtures/video-hero-{presentation,youtube}.html`. They are real
Gutenberg saved documents with half-width, 64 spacing-unit height, nested links
and independent media/foreground presentation. The YouTube document includes
deferred `data-src`, localized title and cover/contain/reset overrides. These
files establish saved-input provenance, not a live REST capture or consent proof.

- `hero-saved.html`: `ceb2ddc6360274c5ab97e18836f3755df641fc720a5e2aefe931ff01b9c92239`
- `hero-youtube.html`: `dbdf5b59fb89f673f8f780fbedae4360e60a76a31a6cdfd5461fde2d7440b4f4`

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

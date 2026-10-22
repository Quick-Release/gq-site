# Test fixtures

These files are baseline evidence, not current site configuration.
Do not regenerate expected fixtures from the production implementation. Shared
test recipes belong in [`test/support/`](../support/), not here.

## Provenance and use

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

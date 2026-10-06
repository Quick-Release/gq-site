# Test fixtures

These files are baseline evidence, not current site configuration.
Do not regenerate expected fixtures from the production implementation. Shared
test recipes belong in [`test/support/`](../support/), not here.

## Provenance and use

| Fixture                                                    | Origin                                                                                                       | Used by                                                                                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content-site/`                                            | The expected sixteen CI Worker, Frontend deploy and release-step files for `manifests/content-site.v1.json`. | [`sync/deploy-files.test.mjs`](../sync/deploy-files.test.mjs) compares rendered files and lock hashes with this baseline.                           |
| `manifests/content-site.v0.json`, `manifests/ekis.v0.json` | Unversioned `gq.ops.json` inputs: a fictional content site's and Ekis's.                                     | [`manifest/schema-and-migrations.test.mjs`](../manifest/schema-and-migrations.test.mjs) checks migration, dropped legacy keys and command refusals. |
| `manifests/content-site.shop-devtools.config.mjs`          | The content site's legacy release configuration, in the `@getquick/site` 0.8.0 format.                       | The same migration suite checks folding site additions into the manifest while preserving release, verify and doctor behavior.                      |
| `manifests/content-site.v1.json`                           | The populated schema-v1 generation input, including plugins and site-specific release additions.             | The deploy-file suite renders the content site's wiring from its manifest values.                                                                   |

The `v0` and `v1` suffixes identify manifest schema versions, not package
versions. The content site (`larkspur`) is fictional; the package tests need no
network, credentials or provider accounts.

The optional CMS Access integration explicitly updates the Lombardi
`infra/frontend.run.ts`, `infra/ci/cloudflare.ci.ts` and `infra/ci/env.ts`
baselines alongside their sources: only the GraphQL service pair is forwarded
by CI and bound privately to the Frontend. Automation credentials are excluded.
These are reviewed behavioral additions, not regenerated snapshots.

The production GraphQL-path follow-up explicitly updates the Lombardi
`infra/frontend.run.ts` and `infra/scripts/deploy-frontend.mjs` baselines:
`wordpress.graphqlPath` selects `/graphql` or the unchanged `/wp/graphql`
default, and a public production URL binding reaches Astro's build child on
Alchemy beta.79. No secret binding changes. `sync/graphql-path.test.mjs`
independently exercises both paths, explicit overrides and local isolation.

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

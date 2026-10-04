# Develop and publish gq-site

[Documentation](README.md)

## Development

Use Node 24.21.0 (the CI version) and the pnpm version pinned in `package.json`.
The published CLI still supports Node 22.12.0+; Vite+ 1.0's development tooling
requires Node `^22.18.0 || ^24.11.0 || >=26.0.0`.

```sh
pnpm install --frozen-lockfile
pnpm exec vp run check   # Vite+ formatting/linting, then node:test
pnpm exec vp run format  # format with Vite+ (Oxfmt)
pnpm exec vp run lint    # lint with Vite+ (Oxlint)
pnpm schema             # regenerate schema/gq.ops.schema.json after changing src/manifest/schema.mjs
```

The existing `pnpm check`, `pnpm format`, `pnpm format:check`, `pnpm lint`
and `pnpm test` scripts remain available. Formatting and linting are configured
in `vite.config.ts`; generated schema, upstream skills, and extracted blueprint
and Lombardi fixtures are excluded from formatting. The extracted templates keep
their own toolchain pins. See [the migration research](https://github.com/Quick-Release/gq-site/blob/main/docs/research/vite-plus-tooling-migration.md).

`vp check` runs static checks only; `vp run check` also runs the tests.
`vp run test` uses the existing `node:test` suite, not `vp test` (Vitest).

### Source filenames

For this package's CLI source in `src/`:

- Use lowercase kebab-case filenames.
- Use `commands.mjs` for a module's command entry file.
- Use `legacy-*` for compatibility-only modules, such as
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
  account (Cloudflare, R2's S3 API, Ploi, Sigillo and `gh`, each listing a
  page at a time), with ZIP and output helpers.

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
before npm serves the release. `scripts/smoke/frontend-runtime.sh` is
the durable published content runtime proof (see
[Durable published content](guides/provisioning.md#durable-published-content)),
then its bilingual variant (`frontend-languages.mjs`, each language served
from its own rows);
`scripts/smoke/cms-events.sh` adds a real WordPress for publication and
settings events, and real WPGraphQL for `gq site check`'s CMS readiness.
`scripts/smoke/cms-polylang.sh` proves a bilingual site's Polylang
configuration (the generated `deploy/ploi/polylang.sh`) on a real WordPress
with Polylang and GQ Polylang for WPGraphQL, read over GraphQL, and the
events its CMS sends per language (the site's `publication-events.php` and
`settings-events.php`). The
runtime proof also installs the CI Worker's dependencies for Wrangler's local
workerd runtime. `scripts/smoke/acceptance.sh` runs `pnpm check` and the
three proofs in order: spec #38's local acceptance gate. CI runs `pnpm check`,
`frontend-check.sh` and `frontend-runtime.sh` on every push; the
real-WordPress proof needs PHP and downloads, and the live gate is the
gq-smoke wizard ([A new content Site, end to end](guides/provisioning.md#a-new-content-site-end-to-end)).

For blueprint source roles, ownership mappings, and deliberate dotless source
names, see the [blueprint map](../blueprint/README.md). `ownership.json` remains
the authority for which site paths are touched.

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

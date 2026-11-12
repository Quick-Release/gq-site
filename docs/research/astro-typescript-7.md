# TypeScript 7 in the Astro Frontend

Read on 2026-11-12 against gq-site `main` 982e28c (0.41.1), for
[#184](https://github.com/Quick-Release/gq-site/issues/184). Sources are the
npm registry, the published tarballs of `astro` 7.4.11, `@astrojs/check`
0.9.12, `@astrojs/language-server` 2.17.3 and `@astrojs/ts-content-mapper`
0.2.0, and withastro/astro at
[`f9a1062`](https://github.com/withastro/astro/tree/f9a10629af1945f55aea4bb9a5ef08800dc70c8c)
(`main` on 2026-11-12). Nothing was run against a generated Site, because the
verdict is not ready. Points marked _inferred_ come from reading the code.

## Verdict

**Not ready.** No released checker accepts TypeScript 7, and TypeScript 7.1 is
still a beta. Either of these unblocks it:

1. **`astro check` on TypeScript 7.** This needs two releases together:
   - an `@astrojs/check` whose `peerDependencies.typescript` admits `^7`, on
     a `@astrojs/language-server` that no longer throws on TypeScript 7's API;
   - an `astro` whose `packages/astro/src/cli/check/index.ts` drops the
     `getMajor(typescriptVersion) >= 7` guard. While that guard is there,
     `astro check` exits 1 on TypeScript 7 before it loads `@astrojs/check` at
     all, so a new `@astrojs/check` alone does not help.
2. **The mapper as a supported checker.** This also needs two things:
   - `typescript` `latest` dist-tag at 7.1.x. The 7.1 plan has RC on
     2026-11-10 and stable on 2026-11-24. The RC had not been published on
     2026-11-12;
   - Astro calling `@astrojs/ts-content-mapper` supported, not experimental.
     That means the `astro check` message drops "Experimental", or
     docs.astro.build documents the mapper as the way to type-check, or the
     mapper reaches 1.0.

   After both, the swap still needs the proof below with zero diagnostics.

Astro says `astro check` "will be deprecated in a future Astro release", so
path 2 is the likelier one.

## 1. `@astrojs/check` and `@astrojs/language-server`

Both now live in withastro/astro under `packages/language-tools/`
([`astro-check`](https://github.com/withastro/astro/tree/f9a10629af1945f55aea4bb9a5ef08800dc70c8c/packages/language-tools/astro-check),
[`language-server`](https://github.com/withastro/astro/tree/f9a10629af1945f55aea4bb9a5ef08800dc70c8c/packages/language-tools/language-server)),
which is also the `repository.directory` in their npm metadata.
[withastro/language-tools](https://github.com/withastro/language-tools) is
archived. Its last push was on 2025-11-17.

| Package                    | Dist-tags                                                                                               | `typescript` peer                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `@astrojs/check`           | `latest` 0.9.12 (2026-10-21), `beta` 0.9.7-beta.1, `alpha` 0.9.6-alpha.0                                | 0.9.12: `^5.0.0 \|\| ^6.0.0`. The beta and alpha: `^5.0.0`                                       |
| `@astrojs/language-server` | `latest` 2.17.3 (2026-10-21), `beta` 2.16.1-beta.1, `alpha` 2.16.1-alpha.0, `next` 2.0.0-next.12 (2023) | None. It peers only on `prettier` and `prettier-plugin-astro`, and builds on `typescript` ^6.0.3 |

Sources: [`@astrojs/check`](https://registry.npmjs.org/@astrojs/check) and
[`@astrojs/language-server`](https://registry.npmjs.org/@astrojs/language-server)
on the npm registry, and
[`astro-check/package.json`](https://github.com/withastro/astro/blob/f9a10629af1945f55aea4bb9a5ef08800dc70c8c/packages/language-tools/astro-check/package.json#L46-L48)
on `main`, which is still `^5.0.0 || ^6.0.0` at 0.9.12. The newest change to
the peer was 0.9.9's "Adds support for TypeScript v6"
([CHANGELOG](https://github.com/withastro/astro/blob/f9a10629af1945f55aea4bb9a5ef08800dc70c8c/packages/language-tools/astro-check/CHANGELOG.md)).

**No released `@astrojs/check` or language server supports TypeScript 7**,
and the block is structural, not a peer range:

- The language server's checker refuses any `typescript` without the JS
  compiler API. `assertCompatibleTypeScript()` throws "TypeScript's native
  compiler (7.0 and later) does not ship this API yet … run `astro check`
  with … (6.x)", and links
  [withastro/roadmap#1321](https://github.com/withastro/roadmap/discussions/1321)
  to track support
  ([`language-server/src/check.ts`](https://github.com/withastro/astro/blob/f9a10629af1945f55aea4bb9a5ef08800dc70c8c/packages/language-tools/language-server/src/check.ts#L253-L262)).
  That discussion has no Astro answer: its last comment (2026-10-21) asks
  whether the 7.1 API is enough.
- TypeScript 7 does not have that API. `require("typescript")` on 7.0.2 and on
  7.1.0-beta exports only `version` and `versionMajorMinor`. 7.1.0-beta adds a
  new API under `typescript/sync` and `typescript/async`, not the old one
  (checked against both installed packages, 2026-11-12).
- The `astro` CLI guard is still in astro 7.4.11 and on `main`. If the
  installed `typescript` major is 7 or higher, it logs the error, returns
  `true`, and the CLI exits 1
  ([`cli/check/index.ts` L14-L24](https://github.com/withastro/astro/blob/f9a10629af1945f55aea4bb9a5ef08800dc70c8c/packages/astro/src/cli/check/index.ts#L14-L24),
  [`cli/index.ts` L241-L248](https://github.com/withastro/astro/blob/f9a10629af1945f55aea4bb9a5ef08800dc70c8c/packages/astro/src/cli/index.ts#L241-L248)).
  The guard came in with
  [#18053](https://github.com/withastro/astro/pull/18053) on 2026-09-17,
  "explain TypeScript 7 support", which fixed
  [#17268](https://github.com/withastro/astro/issues/17268). The file's only
  later change, [`402c0fa`](https://github.com/withastro/astro/commit/402c0fae01d251c97298c255804008ff566802f9)
  (#18589, 2026-11-02), concerns missing packages. `main` has no pending
  changeset for `astro`'s check or `@astrojs/check`
  ([`.changeset/`](https://github.com/withastro/astro/tree/f9a10629af1945f55aea4bb9a5ef08800dc70c8c/.changeset)).

The message, verbatim:

> astro check does not currently support TypeScript 7.0. To continue using
> astro check, install TypeScript 6 instead.
>
> astro check will be deprecated in a future Astro release. Experimental
> support for type-checking Astro files with TypeScript 7.1+ is available
> through @astrojs/ts-content-mapper. See its README for setup instructions

## 2. TypeScript 7.1 and `@astrojs/ts-content-mapper`

### TypeScript 7.1

TypeScript 7 is published from
[microsoft/TypeScript](https://github.com/microsoft/TypeScript/releases).
[microsoft/typescript-go](https://github.com/microsoft/typescript-go) is
archived. Its description is "Staging repo for development of native port of
TypeScript".

Dist-tags on 2026-11-12 ([registry](https://registry.npmjs.org/typescript)):

| Tag      | Version               | Published  |
| -------- | --------------------- | ---------- |
| `latest` | 7.0.2                 | 2026-07-08 |
| `beta`   | 7.1.0-beta            | 2026-10-20 |
| `rc`     | 7.0.1-rc (the 7.0 RC) | 2026-06-18 |
| `next`   | 7.1.0-dev.20261112.1  | nightly    |

**TypeScript 7.1 is not stable.** There is no 7.1 RC. The GitHub release
[v7.1-beta](https://github.com/microsoft/TypeScript/releases/tag/v7.1-beta)
is marked pre-release. The
[7.1 iteration plan](https://github.com/microsoft/TypeScript/issues/63703)
schedules the RC for 2026-11-10 and stable for 2026-11-24. The RC date has
passed without a release. "Stabilize API: Content Mapper API" is one of the
plan's items. The content mapper protocol landed in
[microsoft/TypeScript#63936](https://github.com/microsoft/TypeScript/pull/63936)
(merged 2026-08-21) and still changed the contract there (`protocolVersion`
removed, diagnostic `code` required). 7.1.0-beta's `tsc --help --all` lists
`--runExternalCode` ("Allow loading external content mapper plugins that
execute code during compilation"). 7.0.2 has no such flag.

### `@astrojs/ts-content-mapper`

- **Versions**: 0.0.0 (2026-09-17) and 0.2.0 (2026-09-22). `latest` is 0.2.0
  and there are no other dist-tags
  ([registry](https://registry.npmjs.org/@astrojs/ts-content-mapper)).
  Source:
  [`packages/language-tools/ts-content-mapper`](https://github.com/withastro/astro/tree/f9a10629af1945f55aea4bb9a5ef08800dc70c8c/packages/language-tools/ts-content-mapper).
- **Peers**: none. It doesn't declare the TypeScript 7.1 it needs. Its
  dependencies are `@astrojs/astro2tsx` ^0.1.0 and `vscode-jsonrpc` ^9.0.1.
  It builds against `typescript` ^6.0.3 as a devDependency.
- **README** (identical in the 0.2.0 tarball and on `main`,
  [README](https://github.com/withastro/astro/blob/f9a10629af1945f55aea4bb9a5ef08800dc70c8c/packages/language-tools/ts-content-mapper/README.md)):
  it "lets TypeScript 7.1+ (`tsc`) parse and type-check Astro components
  directly". Setup is a `contentMappers` entry in `tsconfig.json`
  (`{ "package": "@astrojs/ts-content-mapper", "extensions": [".astro"] }`)
  and `tsc --noEmit --runExternalCode`. The README itself doesn't say
  "experimental". It also gives no support statement or stability promise.
- **What Astro says**:
  - The `astro check` message (above) calls it "Experimental support".
  - The PR that added it,
    [#17835](https://github.com/withastro/astro/pull/17835), says "run `tsc`
    normally (well, with a flag for now)". It says E2E tests can't be added
    "until TypeScript 7.1 is fully out", and that no docs page is needed
    "since this is only for nightly right now".
  - Its only CHANGELOG entry is "Adds the initial release"
    ([CHANGELOG](https://github.com/withastro/astro/blob/f9a10629af1945f55aea4bb9a5ef08800dc70c8c/packages/language-tools/ts-content-mapper/CHANGELOG.md)).
  - Editor integration,
    [#17852](https://github.com/withastro/astro/pull/17852), is an open
    draft.
  - The Astro docs don't mention the mapper. The TypeScript guide still says
    `tsc` ignores `.astro` files and points to `astro check`
    ([`guides/typescript.mdx` L47](https://github.com/withastro/docs/blob/5a21a804aff3a25d5ab2c9e7d3fd716bef1fb78b/src/content/docs/en/guides/typescript.mdx#L47)).
  - Two bugs where `tsc` with the mapper reported errors in Astro's own
    shipped components are fixed:
    [#18219](https://github.com/withastro/astro/issues/18219) and
    [#18471](https://github.com/withastro/astro/issues/18471).

**The mapper is experimental and not yet a supported replacement.**

## 3. What replacing `astro check` changes

### Blueprint touch points

Behaviour:

- [`blueprint/templates/apps/frontend/package.json`](../../blueprint/templates/apps/frontend/package.json):
  - `build` and `check` are both `astro check` (L8-L9);
  - `@astrojs/check` ^0.9.12 (L21);
  - `typescript` ^6.0.3 (L27).

  On the mapper path, `@astrojs/check` gives way to
  `@astrojs/ts-content-mapper`, `typescript` moves to 7.1.x, and both
  scripts become something like `astro sync && tsc --noEmit --runExternalCode`
  (_inferred_; see coverage below).

- [`blueprint/templates/apps/frontend/tsconfig.json`](../../blueprint/templates/apps/frontend/tsconfig.json):
  needs the `contentMappers` entry.
- [`scripts/smoke/frontend-check.sh` L46-L47](../../scripts/smoke/frontend-check.sh):
  the probe `await import("@astrojs/check"); await import("typescript");`
  surfaces import errors that Astro reports as missing packages. With the
  mapper there is no `@astrojs/check` to import. On TypeScript 7,
  `import("typescript")` loads only `lib/version.cjs`, so the probe would
  check nothing. It becomes a probe of the mapper (_inferred_). The script
  runs `pnpm check` monolingual, bilingual and with forms (L48, L63, L79).
- [`scripts/smoke/ci-node.sh` L95](../../scripts/smoke/ci-node.sh): runs the
  Frontend's `check` on the CI image's Node. Its comment (L12-L13) names
  `astro check`.

`content-pair.sh`, `consent.sh` and `presentation.sh` don't run `astro check`
or `pnpm check`. They generate an Astro Site, install it and build it through
Alchemy's Astro builder
([`frontend-runtime-lib.mjs` L170](../../scripts/smoke/frontend-runtime-lib.mjs)).
They are affected by the `typescript` bump through install and build, not by
the checker.

Docs and comments:

- [`docs/reference/frontend-frameworks.md`](../reference/frontend-frameworks.md#versions):
  L25, L72 and L80, and the gap at L89-L94.
- `blueprint/templates/apps/frontend/README.md` L129.
- `docs/development.md` L105 and L169.
- `docs/guides/consent.md` L338.
- `.github/workflows/ci.yml` L50 and L65.
- `scripts/smoke/acceptance.sh` L10.
- `src/manifest/site-settings.mjs` L72 ("the content Frontend's build is astro
  check").

Not part of #184: the commerce Frontend
([`blueprint/templates/commerce/apps/frontend/package.json` L30](../../blueprint/templates/commerce/apps/frontend/package.json))
is TanStack but also pins `typescript` ^6.0.3, while the content TanStack
skeleton has 7.0.2.

Existing Sites: `apps/frontend/package.json` is create-once, with managed
keys only for `@getquick/content`
([Alchemy migration plan](alchemy-cloudflare-package-migration.md#problem)).
A skeleton change reaches new Sites only, and existing Sites move by hand
(_inferred_).

### Coverage: `astro check` against `tsc` with the mapper

| What                                    | `astro check` (6.x)                                                                                                                                                                                                                                                     | `tsc --runExternalCode` + mapper (7.1)                                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.astro` frontmatter and template types | Converts with `@astrojs/astro2tsx` `convertToTsx` ([`language-server/src/core/astro2tsx.ts`](https://github.com/withastro/astro/blob/f9a10629af1945f55aea4bb9a5ef08800dc70c8c/packages/language-tools/language-server/src/core/astro2tsx.ts))                           | The same `convertToTsx`, with `ambientTypes: true` because no language server injects Astro's globals ([`transform.ts` L98-L104](https://github.com/withastro/astro/blob/f9a10629af1945f55aea4bb9a5ef08800dc70c8c/packages/language-tools/ts-content-mapper/src/transform.ts#L98-L104)). Processed `<script>` modules are mapped as `.mts` |
| `.ts` files in the project              | Every root file of the tsconfig                                                                                                                                                                                                                                         | Every file of the tsconfig, natively                                                                                                                                                                                                                                                                                                       |
| Generated types (`.astro/types.d.ts`)   | Runs `astro sync` first, unless `--noSync` ([`cli/check/index.ts` L43](https://github.com/withastro/astro/blob/f9a10629af1945f55aea4bb9a5ef08800dc70c8c/packages/astro/src/cli/check/index.ts#L43))                                                                     | Nothing runs sync. The script must run `astro sync` itself (_inferred_). The skeleton has no content collections, but its tsconfig includes `.astro/types.d.ts`                                                                                                                                                                            |
| Astro compiler diagnostics              | Errors, warnings and hints                                                                                                                                                                                                                                              | Errors only, as code 1000. Warnings and hints are dropped ([`transform.ts` L78-L96](https://github.com/withastro/astro/blob/f9a10629af1945f55aea4bb9a5ef08800dc70c8c/packages/language-tools/ts-content-mapper/src/transform.ts#L78-L96))                                                                                                  |
| TS diagnostics in `.astro`              | Some are filtered or rewritten for `.astro` (2307 and others, in [`plugins/typescript/diagnostics.ts`](https://github.com/withastro/astro/blob/f9a10629af1945f55aea4bb9a5ef08800dc70c8c/packages/language-tools/language-server/src/plugins/typescript/diagnostics.ts)) | Raw `tsc` diagnostics. It may report what `astro check` hides (_inferred_)                                                                                                                                                                                                                                                                 |
| Output                                  | Its own format and a "Result (N files)" summary                                                                                                                                                                                                                         | `tsc`'s format                                                                                                                                                                                                                                                                                                                             |
| Exit code                               | 1 when there are errors (`--minimumFailingSeverity` defaults to errors)                                                                                                                                                                                                 | Non-zero when there are errors                                                                                                                                                                                                                                                                                                             |

On paper, coverage can be kept intact for what the Blueprint relies on:

- Both type-check `.astro` templates through the same converter.
- Both fail the run on errors.
- `astro sync` can be run explicitly before `tsc`.

What is lost: Astro compiler warnings and hints. `pnpm check` doesn't fail
on those today, so the gate is unchanged. What is unknown: whether the
unfiltered `tsc` diagnostics on the skeleton's `.astro` files come to zero.
Only the proof can settle that.

## Proof, once unblocked

Not run (the verdict is not ready). When a trigger above fires, do this in
scratch, not in the repo:

1. `node bin/gq.mjs new <dir> --project <name> --variant content --framework astro`,
   and link this checkout as `frontend-check.sh` does (`this-checkout.sh`).
2. In that Site's `apps/frontend`, move `typescript` to the stable 7.x and the
   checker to the released one. For the mapper path that means adding the
   mapper, the `contentMappers` entry and the new `check`/`build` scripts.
3. Run `pnpm check` and require zero diagnostics.
4. Run `frontend-check.sh`'s bilingual and forms passes, then `content-pair.sh`,
   `consent.sh` and `presentation.sh` on the same pins.
5. Break one `.astro` prop type and one `.ts` type on purpose. Both must fail
   `pnpm check`, which shows that coverage did not silently drop.

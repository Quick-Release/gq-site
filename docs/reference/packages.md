# Blueprint packages

[Documentation](../README.md)

`gq packages` finds new releases of the GETQUICK packages the blueprint knows
about, Composer packages (WordPress plugins and themes) and npm packages on
GitHub Packages, and proposes upgrades to the blueprint's version pins. It covers this repository's blueprint only. It
never changes a Site, a lockfile, the registry or any other repository.

```sh
gq packages check [--json]
gq packages propose --latest [--write] [--json]
```

Both commands need no `gq.ops.json`. They read the blueprint of the gq-site
checkout they run in, or else the blueprint of the installed `@getquick/site`.

## The catalogue

[`blueprint/packages.json`](https://github.com/Quick-Release/gq-site/blob/main/blueprint/packages.json)
lists each package with these fields:

| Key           | Meaning                                                                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | The Composer or npm name. A package keeps it: a rename is a migration, not an upgrade.                                                                                |
| `ecosystem`   | `composer` (the default) or `npm`.                                                                                                                                    |
| `upstream`    | The GitHub repository and how releases are discovered there: `tags` (Satis `vcs` packages), or `releases` with the release `asset` the registry mirrors.              |
| `install`     | The canonical install source: a Composer repository in the CMS `composer.json` (`getquick`, the private registry's proxy), or `github-packages` for npm. No fallback. |
| `variants`    | The Site variants that install it.                                                                                                                                    |
| `requirement` | `blueprint` (the CMS `composer.json` requires it and gq proposes it), `site` (a Site requires it itself and it is only reported) or `none` (no variant installs it).  |
| `policy`      | `caret` proposes the newest installable version inside the current caret range, `exact` the newest installable version as an exact pin. `manual` only reports.        |
| `lockstep`    | A group released together at one version by one upstream: pinned to that version and moved together, or not at all.                                                   |
| `holds`       | `{ from, reason }`: versions from `from` upwards are never proposed.                                                                                                  |
| `formerNames` | Earlier Composer names. If one is required again, discovery stops until a migration exists.                                                                           |
| `migrations`  | Explicit rename, replace, remove or activate steps, with their status. Any listed migration blocks automatic proposals.                                               |

The catalogue holds **no version constraints**. The pins live in the CMS
skeletons and the npm pins: Composer packages in the `require` keys of
`blueprint/templates/apps/cms/composer.json` (`composerFile`, the content
skeleton) and of `blueprint/templates/commerce/apps/cms/composer.json`
(`variantComposerFiles.commerce`, the commerce skeleton), and npm
packages in the `dependencies` of `npmFile`,
`blueprint/templates/fragments/commerce-frontend-package.keys.json`, the
commerce Frontend's managed keys (so `gq sync` sets them in a commerce Site's
`apps/frontend/package.json`). A test checks that the catalogue and these
files agree. Each CMS `composer.json` must pin every `blueprint` package
whose `variants` include its variant and no other catalogued package; no
`site` or `none` package may be pinned; a package both skeletons pin has one
pin; every requirement served by a catalogued Composer registry and every
`@quick-release` dependency in `npmFile` must be catalogued; and a lockstep
group's members must be pinned to one exact version. The initial entries come
from that file and from the registry's `satis.json` and
`release-packages.json`. Packages the registry serves for other projects are
not added.

The commerce skeleton's own GETQUICK pin, `getquick/getquick-ecommerce`, is
catalogued for the commerce variant (manual policy). WooCommerce isn't a
GETQUICK package and isn't catalogued.

The blueprint's required GETQUICK Composer packages use exact versions. Most
use `manual` policy: `check` reports new releases and `propose --write` does
not change them. The `caret` policy is available for requirements using caret
ranges.

### The GQ Design lockstep group

GQ Design releases its plugin, `getquick/gq-design`, and its npm packages,
`@quick-release/design-contract` and `@quick-release/design-renderer`, from
one tag at one version
([ADR 0018](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0018-ship-gq-designs-contract-and-renderer-as-lockstep-packages.md)).
All three are catalogued with `lockstep: "gq-design"` and `exact` policy, and
pinned to one version: the plugin in both CMS skeletons' `composer.json`
(content and commerce), the npm packages in the commerce Frontend's managed
keys. Content Sites install no design package and need no GitHub Packages
token.

- `gq packages check` reports the group's target: the newest stable version
  that **every** member's registry serves, the Composer registry for the
  plugin and GitHub Packages for the packages. A member that hasn't got the
  others' newest version is named as lagging (`lockstep-lag`).
- `gq packages propose` moves the whole group to that target, or nothing. A
  member blocked for any reason (a failed read, its identity, a reference
  mismatch, PHP) holds every member (`lockstep`), and so do members pinned to
  different versions (`lockstep-drift`). `--write` edits both pin files, each
  in memory first, so a refusal writes neither.
- `gq doctor` fails a Site whose `apps/cms/composer.lock` locks
  `getquick/gq-design` at another version than `pnpm-lock.yaml` locks the npm
  packages, naming both. It warns when there is no `composer.lock` yet, or the
  plugin is locked to a branch. A Site that locks no design package passes.

The pin is `0.9.4`: the newest version the Composer registry serves (built
from tag `v0.9.4`, commit `812919e`) that GitHub Packages also serves for both
packages.

`getquick/getquick-theme` 0.6.1 and `getquick/getquick-ecommerce` 0.4.3 both
require `getquick/gq-design` `^0.9.0`, so they install beside it (see
[Recorded requirements](#recorded-requirements)). 0.29.0 and 0.29.1 pinned
GQ Design 0.9.4 beside getquick-theme 0.5.1 and getquick-ecommerce 0.3.5,
which require `^0.3.1`, so neither skeleton's `composer install` resolved.

`getquick/gq-theme` is catalogued as `none`/`manual`. It is a separate
package from `getquick/getquick-theme`, which registers the primary menu
location and supplies design defaults that `deploy/ploi/admin.sh`,
`admin.d/10-theme.sh` and `gq site readiness` rely on. Replacing that theme
needs a planned migration. gq never adds or activates `gq-theme`.

### Recorded requirements

A pin is only installable if every other pinned package accepts it: Composer
refuses a root that pins GQ Design 0.9.4 beside a theme requiring `^0.3.1`.
[`blueprint/package-requirements.json`](https://github.com/Quick-Release/gq-site/blob/main/blueprint/package-requirements.json)
(the catalogue's `requirementsFile`) records, for each pinned GETQUICK
Composer package, what its pinned version requires of the packages its
registry serves, as the registry's metadata declares it:

```json
"getquick/getquick-theme": {
  "version": "0.6.1",
  "require": {
    "getquick/gq-config": ">=0.4.0 <1.0",
    "getquick/gq-design": "^0.9.0",
    "getquick/gq-support": ">=0.1.0 <1.0"
  }
}
```

The same catalogue test, offline, requires every pinned GETQUICK package to
be pinned exactly and recorded at its pin, no record for a package the
blueprint doesn't pin, and every recorded requirement to be satisfied by the
pin of each CMS `composer.json` that pins the package (an unpinned GETQUICK
requirement is refused too). Constraints are read as Composer reads them
(carets, tildes, wildcards, hyphen ranges, comparisons, `||`); one it can't
read is refused rather than guessed.

The record comes from the registry, so it can drift: `gq packages check`
compares each record with the registry's metadata for the pinned version
and fails on a difference (`requirements-drift`). Move a pin by hand only
together with its record; `propose --write` updates both. The credentialed
proof is `scripts/smoke/cms-resolve.sh`, which resolves both generated
skeletons against the registry (see [Develop and publish](../development.md)).

## `gq packages check`

This command only reads. For each package it reports:

- the current blueprint constraint;
- the newest **stable upstream** version, with its tag and commit, or its
  release asset and SHA-256 digest;
- the newest **installable registry** version, with its dist reference and
  SHA-1;
- the target and every blocker.

Versions are ordered by SemVer precedence, not by publication date. Drafts,
prereleases (by GitHub flag or SemVer suffix), `dev-*` branches, tags that
aren't versions (`plugin-v0.1.4`) and releases without the expected asset are
left out. Upstream releases the registry doesn't serve yet are flagged as
`registry-lag` and never proposed.

Each recorded package also shows what its pin `requires`.

The exit code is 1 when any source couldn't be read, so an incomplete report
can't pass silently, and when the current pins' recorded requirements differ
from the registry's or aren't satisfied by the pins (`requirements-drift`).

### Credentials

gq uses the credentials it already uses elsewhere. It never stores them and
never prints them.

- **Registry:** `COMPOSER_AUTH`'s `http-basic` login for the registry host.
  Run gq through `gq sigillo run`, which reads the fleet's from GQ Platform
  `ops`. Without it the registry is not requested at all.
- **GitHub:** `GITHUB_TOKEN` or `GH_TOKEN`. Public repositories can be read
  without one.
- **GitHub Packages:** a `read:packages` token from `GITHUB_PACKAGES_TOKEN`
  (the fleet's, which `gq sigillo run` reads from GQ Platform `ops`, and CI's
  name for it), else your user-level npm config's
  `//npm.pkg.github.com/:_authToken` (or its `tokenHelper`), as pnpm reads
  it. The repository's `.npmrc` is never read for one. Without a token GitHub
  Packages isn't requested.

### Failures

Each request times out after 15 seconds. Each package reads at most 300 tags
or releases. Failures are classified as follows:

| Code                  | Meaning                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `missing-credentials` | No `COMPOSER_AUTH` login, no GitHub Packages token, or a private repository read without a token |
| `permission-denied`   | The login or token was rejected or can't read the source                                         |
| `not-found`           | The registry doesn't serve the package, or GitHub has no such repository                         |
| `malformed`           | The response isn't valid JSON, or doesn't have the expected shape                                |
| `unavailable`         | Timeout, network failure, 5xx, or GitHub's rate limit                                            |

## `gq packages propose --latest`

Builds the upgrade proposal from the same discovery. By default it writes
nothing. A proposal raises a caret constraint's floor to the newest version
that the registry serves inside the current range, for example `^0.3.1` → `^0.3.3`.
It is held back when any of these apply:

- **`breaking`:** a newer version is outside the range. It waits for review
  and any migration. The compatible step can still be proposed.
- **`hold`, `manual`:** catalogue policy.
- **`php`:** the target requires a newer PHP than the blueprint's `php`
  floor.
- **`identity`, `migration-required`:** a rename, a replacement or a
  migration that is still listed.
- **`reference-mismatch`:** the registry's build of a version comes from a
  different commit than the upstream tag.
- **`discovery-failed`:** either source couldn't be read.
- **`unsupported-constraint`:** the constraint isn't a caret constraint (or,
  for `exact` policy, an exact version).
- **`lockstep`, `lockstep-drift`:** a lockstep group member can't move, so none
  does; or the group's members are pinned to different versions.
- **`unsatisfied`:** with the move, a pinned package's requirement wouldn't
  accept another pin: the target requires something the pins don't satisfy,
  or another pinned package's recorded requirement excludes the target (GQ
  Design 0.10.0 while getquick-theme requires `^0.9.0`). Its lockstep group
  holds with it.
- **`requirements-drift`:** a pin's record differs from what the registry
  says that version requires, or the registry no longer serves the pin.
- **`manual`:** an exact pin under `manual` policy is only reported.

`--write` applies the proposed changes to every CMS `composer.json` that
pins the package, the npm pins, and the moved packages' records in
`package-requirements.json` (from the registry). It works only in a gq-site checkout, never in an installed
package or a Site. Only the string values of the proposed `require` and
`dependencies` keys change.
Every other byte stays as it was, including other keys, `require-dev`,
formatting and site-specific entries. gq checks this before it writes, and it
writes atomically. Running it again changes nothing.

**Applying a proposal doesn't approve it.** Discovery shows what is released
and installable. It doesn't show that the newest combination works with
WordPress, the other packages or a Site's own code. The proposal still goes
through review, a branch and CI like any other blueprint change. Nothing is
committed, pushed or published.

## A Site on a branch

A Site may install a GETQUICK package from a branch instead of a release,
for example to ship GQ Design's `main` before it is tagged. Composer needs an
inline alias whenever another package constrains it: getquick-theme requires
`getquick/gq-design` `>=0.3.19 <1.0`, so plain `dev-main` doesn't resolve.

```json
"getquick/gq-design": "dev-main as 0.5.99"
```

with the CMS `composer.json`'s `"minimum-stability": "dev"` and
`"prefer-stable": true` (the blueprint's defaults). Pick an alias inside every
dependant's range and above the newest release, then
`pnpm cms:composer:update getquick/gq-design` locks the branch's newest commit.
gq leaves the requirement and the lock alone: `gq sync` (the file is
create-once; only `--recreate apps/cms/composer.json` writes the blueprint's
again), the release commands and `gq ploi release` never rewrite or reject
either. `pnpm release:package getquick/gq-design` locks main's newest commit,
commits and deploys it ([release package](release.md)).

The server's `composer install` downloads the dist the lock names with the
registry login only, so the registry must serve the branch's archive; a dist
URL on `api.github.com` needs a GitHub token the deploy doesn't have. Return
to a release by setting the caret constraint again and updating the package.

## Deferred: fleet rollout

These are later phases of the
[blueprint rollout plan](https://github.com/Quick-Release/gq-site/blob/main/docs/plans/getquick-blueprint-rollout.md).
None of them is implemented:

- Updating Sites. A Site's `apps/cms/composer.json` is create-once scaffolding
  today. Managed keys for it
  ([gq-platform ADR 0001](https://github.com/Quick-Release/gq-platform/blob/main/docs/adr/0001-ownership-of-work-across-getquick-repositories.md))
  and update PRs for each Site come later.
- Resolving or updating `composer.lock`.
- Platform release records of tested package combinations, and compatibility
  by variant.
- Opening PRs, Renovate integration, rollout state, health gates and
  promotion.
- npm packages other than GQ Design's lockstep group (the storefront Runtime
  is pinned in the commerce Frontend skeleton by hand), WordPress core, and
  third-party plugins.

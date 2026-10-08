# Blueprint packages

[Documentation](../README.md)

`gq packages` finds new releases of the GETQUICK Composer packages (WordPress
plugins and themes) that the blueprint knows about, and proposes upgrades to
the blueprint's version pins. It covers this repository's blueprint only. It
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

| Key           | Meaning                                                                                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | The Composer name. A package keeps it: a rename is a migration, not an upgrade.                                                                                      |
| `upstream`    | The GitHub repository and how releases are discovered there: `tags` (Satis `vcs` packages), or `releases` with the release `asset` the registry mirrors.             |
| `install`     | The canonical install source: the name of a Composer repository in the CMS `composer.json` (`getquick`, the private registry's proxy). There is no fallback.         |
| `variants`    | The Site variants that install it.                                                                                                                                   |
| `requirement` | `blueprint` (the CMS `composer.json` requires it and gq proposes it), `site` (a Site requires it itself and it is only reported) or `none` (no variant installs it). |
| `policy`      | `caret` proposes the newest installable version inside the current caret range. `manual` only reports.                                                               |
| `holds`       | `{ from, reason }`: versions from `from` upwards are never proposed.                                                                                                 |
| `formerNames` | Earlier Composer names. If one is required again, discovery stops until a migration exists.                                                                          |
| `migrations`  | Explicit rename, replace, remove or activate steps, with their status. Any listed migration blocks automatic proposals.                                              |

The catalogue holds **no version constraints**. The pins live in one place:
the `require` keys of `blueprint/templates/apps/cms/composer.json`. A test
checks that the catalogue and that file agree. Every `blueprint` package must
be required there, no `site` or `none` package may be, and every requirement
served by a catalogued registry must be catalogued. The initial entries come
from that file and from the registry's `satis.json` and
`release-packages.json`. Packages the registry serves for other projects are
not added.

`getquick/gq-theme` is catalogued as `none`/`manual`. It is a separate
package from `getquick/getquick-theme`, which registers the primary menu
location and supplies design defaults that `deploy/ploi/admin.sh`,
`admin.d/10-theme.sh` and `gq site readiness` rely on. Replacing that theme
needs a planned migration. gq never adds or activates `gq-theme`.

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

The exit code is 1 when any source couldn't be read, so an incomplete report
can't pass silently.

### Credentials

gq uses the credentials it already uses elsewhere. It never stores them and
never prints them.

- **Registry:** `COMPOSER_AUTH`'s `http-basic` login for the registry host.
  Run gq through `gq sigillo run` to get it. Without it the registry is not
  requested at all.
- **GitHub:** `GITHUB_TOKEN` or `GH_TOKEN`. Public repositories can be read
  without one.

### Failures

Each request times out after 15 seconds. Each package reads at most 300 tags
or releases. Failures are classified as follows:

| Code                  | Meaning                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| `missing-credentials` | No `COMPOSER_AUTH` login, or a private repository read without a token   |
| `permission-denied`   | The login or token was rejected or can't read the source                 |
| `not-found`           | The registry doesn't serve the package, or GitHub has no such repository |
| `malformed`           | The response isn't valid JSON, or doesn't have the expected shape        |
| `unavailable`         | Timeout, network failure, 5xx, or GitHub's rate limit                    |

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
- **`unsupported-constraint`:** the constraint isn't a caret constraint.

`--write` applies the proposed changes to the blueprint's CMS `composer.json`.
It works only in a gq-site checkout, never in an installed package or a Site.
Only the string values of the proposed `require["getquick/…"]` keys change.
Every other byte stays as it was, including other keys, `require-dev`,
formatting and site-specific entries. gq checks this before it writes, and it
writes atomically. Running it again changes nothing.

**Applying a proposal doesn't approve it.** Discovery shows what is released
and installable. It doesn't show that the newest combination works with
WordPress, the other packages or a Site's own code. The proposal still goes
through review, a branch and CI like any other blueprint change. Nothing is
committed, pushed or published.

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
- Frontend npm packages, WordPress core, and third-party plugins.

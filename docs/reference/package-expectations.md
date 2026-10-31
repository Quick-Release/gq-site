# Package expectations

[Documentation](../README.md)

A Site that lists Composer packages in `gq.ops.json`
`deployment.guardedPackages` (see [Deployment policy](deployment-policy.md))
prepares and deploys them only with an approval record looked up from
gq-support's approval service. Two inputs are kept apart:

- **The Site's expectation**, `deploy/ploi/package-expectations.json`: which
  version and which approved release the Site's reviewed source intends, and
  where Composer installs it. Anyone who can change the Site can edit it, so
  it is never authority.
- **The approval record** (`gq-support.composer-approval/v1`, owned by
  gq-support), which the approval lookup returns. It is the only authority:
  the package's identity (its published tag's commit) and its exact file list
  come from it, never from a caller or the Site.

There is no signature, verification key or remote endpoint. Without a
configured lookup (below), every guarded preparation and deploy refuses:

```
No package approval lookup is configured, so gq can't look up getquick/gq-support 0.1.11 (phase deploy); a guarded package refuses. deploy/ploi/package-expectations.json is an expectation, not an approval.
```

No command-line flag, typed digest, reference or boolean stands in for it.

## The Site's expectation (v1)

```json
{
  "schemaVersion": 1,
  "packages": [
    {
      "name": "getquick/gq-support",
      "version": "0.1.11",
      "releaseId": 11,
      "installPath": "web/app/plugins/gq-support"
    }
  ]
}
```

Strict: an unknown key (`approved`, `filesDigest`, `lockReference`, …)
fails. `releaseId` is the approval service's ID for the release, the key a
lookup takes; the service refuses one that isn't its current approved
release. `installPath` is relative to `apps/cms`: `web/app/plugins/<slug>`,
`web/app/mu-plugins/<slug>` or `web/app/themes/<slug>`.
`gq release package --to … --release-id …` writes the entry (below); review
it with the lock change.

## The approval record

gq-support defines it ([gq-support PR 154](https://github.com/Quick-Release/gq-support/pull/154),
provisional until merged); gq reads exactly these keys and refuses a record
with a missing or unknown one:

```json
{
  "schema": "gq-support.composer-approval/v1",
  "stage": "prod",
  "slot": "nomia/production",
  "phase": "prepare | deploy",
  "release_id": 11,
  "package": { "name": "getquick/gq-support", "version": "0.1.11", "zip_sha256": "<64 hex>" },
  "provenance": { "source_commit": "<40 hex>", "release_run": "<decimal run id>" },
  "published_tag": { "name": "v0.1.11", "commit": "<40 hex>" },
  "files": { "gq-support.php": "<sha256>", "…": "…" },
  "files_digest": "<64 hex>",
  "normalization": "gq-support.files/v1",
  "observed_at": "<ISO 8601>"
}
```

gq acts on a record only when:

- it is for the slot and stage `gq.ops.json` `deployment.approval` names, the
  phase asked, the package, the exact version and the release ID asked;
- its `files` hash to its `files_digest` (`gq-support.files/v1`, below);
- its `observed_at` is within five minutes of now (at most one minute ahead).

Identity:

- `composer.lock`'s `source.reference` for the package must be
  `published_tag.commit`, the commit the approved tag points to. The lock's
  version must be `package.version`, in `packages` (the server's `--no-dev`
  install skips `packages-dev`).
- `provenance.source_commit` is gq-support's source commit. It is never
  compared with the lock.
- `package.zip_sha256` is the approved release-workflow ZIP, not the Composer
  registry's dist ZIP, which may be repacked: the registry's bytes, its
  `dist.shasum` and its `dist.reference` are never compared.

### gq-support.files/v1

gq-support's own normalization: every regular file in the package, no
exclusions. Paths are ASCII, relative to the package root, `/`-separated,
matching `^[A-Za-z0-9_-][A-Za-z0-9._-]*(/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$`
(no traversal, spaces or empty segments). Each file's SHA-256 is of its raw
bytes. `files_digest` is the SHA-256 of the `<path>\0<sha256>\n` lines sorted
by path bytes. File modes aren't compared; a symlink or any other non-regular
installed file fails, as does any extra, missing or changed file.

## The lookup

`run()` takes an `approvals` adapter, `{ lookup(request) }`, where `request`
is `{ phase, project, releaseId, releaseCommit?, package: { name, version } }`
and the result is the record, or a rejection. Without one, gq builds the
Operator CLI adapter from the environment, and without that configuration
there is no lookup at all.

The Operator CLI adapter runs gq-support's read-only command with the
Operator's own Cloudflare and GitHub logins:

```
<GQ_SUPPORT_APPROVAL_COMMAND> [<GQ_SUPPORT_APPROVAL_ARGS>...] composer-approval \
  <slot> <release-id> <GQ_SUPPORT_ARTIFACT_DIR> <prepare|deploy> \
  --stage <stage> --account-id <GQ_SUPPORT_ACCOUNT_ID> \
  --database-id <GQ_SUPPORT_DATABASE_ID> --ledger-database-id <GQ_SUPPORT_LEDGER_DATABASE_ID>
```

| Setting                                                                            | Where                                                                                                      |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `deployment.approval.slot`, `.stage`                                               | `gq.ops.json`, a reviewed Site change; required with `guardedPackages`.                                    |
| `GQ_SUPPORT_APPROVAL_COMMAND`                                                      | The environment: the executable (for example a wrapper around `pnpm --filter gq-support-worker operator`). |
| `GQ_SUPPORT_APPROVAL_ARGS`, `GQ_SUPPORT_APPROVAL_CWD`                              | Optional: a JSON array of arguments before `composer-approval`, and the directory to run it in.            |
| `GQ_SUPPORT_ACCOUNT_ID`, `GQ_SUPPORT_DATABASE_ID`, `GQ_SUPPORT_LEDGER_DATABASE_ID` | The approval service's IDs for the stage.                                                                  |
| `GQ_SUPPORT_ARTIFACT_DIR`                                                          | The downloaded release artifact (`gq-support.zip`, `gq-support.manifest.json`, `provenance.json`).         |

For example, with a reviewed gq-support checkout pinned at the merge commit
that introduced the command
([`29de3c7`](https://github.com/Quick-Release/gq-support/commit/29de3c7ec66ad96d6726bae20766c2acc7fcc312)),
an Operator's environment might hold:

```sh
GQ_SUPPORT_APPROVAL_COMMAND=pnpm
GQ_SUPPORT_APPROVAL_ARGS='["--filter","gq-support-worker","operator"]'
GQ_SUPPORT_APPROVAL_CWD=/path/to/gq-support   # checked out at 29de3c7
GQ_SUPPORT_ACCOUNT_ID=…
GQ_SUPPORT_DATABASE_ID=…
GQ_SUPPORT_LEDGER_DATABASE_ID=…
GQ_SUPPORT_ARTIFACT_DIR=/path/to/downloaded/release-artifact
```

This is an example, not an enabled target: until the approval service has an
approved release and the Site's slot is bound to it (reviewed gq-support
follow-ups), the command refuses, and so does every guarded package.

No shell runs: each value is one argument. A lookup takes at most two minutes
and prints at most 4 MiB. A non-zero exit, output that isn't exactly one JSON
object, a record for another slot or stage, or any check above failing is a
refusal. A configured command with a setting missing refuses every lookup.

## Preparing a guarded package

`gq release package <package> --to <version> --release-id <id> [--pin] [--expect-before <version>] --no-deploy`
(see [release package](release.md)):

1. looks up a `phase: "prepare"` record for exactly that release and version,
   before Composer runs; no record means nothing changes;
2. locks exactly `<version>` of only that package (`composer update
<package> --with <package>:<version> --no-install`, with the usual
   guards). A requirement that already admits `<version>` (`^0.1.3`, `*`)
   stays as it is; one that doesn't refuses unless `--pin` sets it to exactly
   `<version>`. A range never authorizes the registry's latest;
3. refuses, restoring everything, unless the lock's `source.reference` is the
   record's `published_tag.commit`;
4. sets the package's entry in `deploy/ploi/package-expectations.json`
   (`<version>`, the record's `release_id`, the install path, kept or
   `web/app/plugins/<name>` for a new entry);
5. commits `composer.lock`, the expectations file and, with `--pin`,
   `composer.json`, and nothing else.

`--reference` is refused for a guarded package: the record names it. With
`--no-deploy` the lookup is the only outside call: nothing is uploaded and
the Ploi site isn't touched. A `prepare` record never authorizes an install.
The version is any exact approved version: a recovery drill from 0.1.12 back
to 0.1.11 is `--to 0.1.11 --release-id <0.1.11's id> --expect-before 0.1.12`.

## Deploying a guarded package

`gq ploi release` (and so `gq release package` without `--no-deploy`, and the
CI release step):

1. reads the expectations and `composer.lock` **from the release commit**, and
   refuses when either is missing or a guarded package isn't stated;
2. refuses unless the release commit's deploy script carries the
   `GUARDED_PACKAGES="…"` line `gq sync` renders, so the server checks again;
3. looks up a `phase: "deploy"` record for each package's expected release,
   and refuses unless the lock installs exactly its package (version and
   published tag commit);
4. uploads the archive with `PACKAGE_EXPECTATIONS`: the record's file list and
   digest, and the sha256 of the lock it checked, under an archive key that
   includes that file's digest;
5. **runs every deploy lookup again, immediately before changing the Ploi
   site** (the deploy script sync, then the deploy). A failed lookup, or a
   record that differs in any field but `observed_at`, stops the release with
   the Ploi site unchanged.

On the server, `deploy/ploi/admin.sh` runs after `composer install`, the
restore of shipped plugins and the dependency patch, and **before** PHP-FPM
reloads and any WP-CLI activation, database update, deploy extension or
rewrite flush. (A full deploy has already turned maintenance mode on, as
before; a Composer-only deploy runs no WP-CLI at all.) It computes
`gq-support.files/v1` over the installed directory and refuses when:

- the Site guards a package and the archive has no `PACKAGE_EXPECTATIONS`, or
  doesn't state that package;
- `apps/cms/composer.lock` isn't the lock gq checked;
- the installed files differ from the record's: each `missing`, `changed` or
  `extra` path is listed, or a non-regular file is there.

The installed version isn't read separately: it is the lock's (checked
against the record before upload, and the lock's hash again on the server),
and the package's own files, its version header included, must be exactly the
approved ones.

### What a refusal leaves

The install is **not atomic**. A refusal on the server fails the deploy
(`<PROJECT>_DEPLOY_STATUS=failed`, and `gq ploi release` exits 1) after
Composer has already replaced files: they stay on disk, not yet loaded by a
PHP-FPM reload, and a full deploy leaves maintenance mode as its cleanup
leaves it. Nothing rolls back. Recovery is another guarded release of an
approved version, which needs its own fresh approval; a version the approval
service doesn't approve (an unsigned legacy package among them) can't be
deployed through this path.

### Remaining gaps

- The server can't reach the approval service: the fresh lookup is gq's,
  immediately before it triggers the deploy, and Ploi's deploy then runs
  within minutes. The server verifies the files against that record.
- `bin/gq.mjs` passes no adapter of its own: an Operator configures the CLI
  adapter through the environment, or guarded packages refuse.

# Package expectations

[Documentation](../README.md)

A Site that lists Composer packages in `gq.ops.json`
`deployment.guardedPackages` (see [Deployment policy](deployment-policy.md))
prepares and deploys them only with an approval looked up from an
authenticated, read-only approval service. Two inputs are kept apart:

- **The Site's expectation**, `deploy/ploi/package-expectations.json`: what
  the Site's reviewed source expects. Anyone who can change the Site can edit
  it, so it is never authority.
- **The approval record** (`gq-support.composer-approval/v1`), which the
  `approvals` adapter passed to `run()` looks up. It is the only authority, and
  its exact file list is what the server verifies.

gq-site ships no adapter, verification key or signature format. Without an
adapter, every guarded preparation and deploy refuses:

```
No authenticated package approval service is configured, so gq can't look up getquick/gq-support 0.1.11 (phase deploy); a guarded package refuses. deploy/ploi/package-expectations.json is an expectation, not an approval.
```

No command-line flag, typed digest or boolean stands in for it.

## The Site's expectation (v1)

```json
{
  "schemaVersion": 1,
  "packages": [
    {
      "name": "getquick/gq-support",
      "version": "0.1.11",
      "lockReference": "<the reference composer.lock records for this version>",
      "installPath": "web/app/plugins/gq-support",
      "filesDigest": "<gq-support.files/v1 digest of the approved files>"
    }
  ]
}
```

Every object is strict: an unknown key (`approved`, `signature`, …) fails.
`gq release package --to` writes the entry for a guarded package (below);
review it with the lock change.

| Field           | Checked against                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`       | The `apps/cms/composer.lock` entry in `packages` (the server's `--no-dev` install skips `packages-dev`), and the approval record's `package.version`.            |
| `lockReference` | Every reference the lock entry records (`dist.reference`, `source.reference`). It is the published package's reference, not the source repository's main commit. |
| `installPath`   | Where Composer installs the package, relative to `apps/cms`: `web/app/plugins/<slug>`, `web/app/mu-plugins/<slug>` or `web/app/themes/<slug>`.                   |
| `filesDigest`   | The approval record's `files_digest`.                                                                                                                            |

## The approval record (gq-support.composer-approval/v1, provisional)

```json
{
  "stage": "…",
  "slot": "…",
  "phase": "prepare | deploy",
  "release_id": "…",
  "package": { "name": "getquick/gq-support", "version": "0.1.11", "zip_sha256": "<64 hex>" },
  "provenance": { "source_commit": "<40 hex>", "release_run": "…" },
  "files": { "gq-support.php": "<sha256>", "…": "…" },
  "files_digest": "<64 hex>",
  "normalization": "gq-support.files/v1",
  "observed_at": "<ISO 8601>"
}
```

gq acts on a record only when it is for the phase, package and exact version
asked; its `files` hash to its `files_digest`; and its `observed_at` is
within five minutes of now (and at most one minute ahead). An optional
`schema` must be `gq-support.composer-approval/v1`. Other keys are dropped,
never trusted. `zip_sha256` and `provenance` identify the release to the
service; gq never compares the source commit with the lock, and never
compares a registry ZIP's bytes, which a repack can change while the files
stay the same.

### gq-support.files/v1

gq-support's own `filesDigest`: every regular file the package ships, no
exclusions. Paths are relative to the package root, ASCII segments of letters,
digits, `.`, `_` and `-` not starting with a dot, joined by `/` (no
traversal, spaces or empty segments). Each file's SHA-256 is of its raw
bytes. The digest is the SHA-256 of the `<path>\0<sha256>\n` lines sorted by
path bytes. File modes don't count; a symlink or any other non-regular
installed file fails, as does any extra, missing or changed file.

## The adapter

```js
await run(argv, { approvals: { lookup }, ... });
// lookup({ phase, project, releaseCommit?, package: { name, version } })
//   → the service's current record for that package and phase, or a rejection
//     (never approved, withdrawn, unreachable).
```

The adapter authenticates to the service, maps `project` to its stage and
slot, and resolves the published package identity against the approved
contents. None of that is in gq-site.

## Preparing a guarded package

`gq release package <package> --to <version> [--pin] [--expect-before <version>] [--reference <ref>] --no-deploy`
(see [release package](release.md)):

1. looks up a fresh `phase: "prepare"` record for exactly `<version>`, before
   Composer runs; no record means nothing changes;
2. locks exactly `<version>` of only that package (`composer update
<package> --with <package>:<version> --no-install`, the usual guards). A
   requirement that already admits `<version>` (`^0.1.3` for 0.1.11) stays
   as it is; one that doesn't refuses unless `--pin` sets it to exactly
   `<version>`. A compatible range never authorizes the registry's latest;
3. sets the package's entry in `deploy/ploi/package-expectations.json`:
   `<version>`, the reference the lock now records, the install path (kept, or
   `web/app/plugins/<name>` for a new entry) and the record's `files_digest`;
4. commits `composer.lock`, the expectations file and, with `--pin`,
   `composer.json`, and nothing else. With `--no-deploy` no provider is
   called.

Preparing isn't permission to deploy. The version is any exact version: the
same command moves forward or back (a recovery from 0.1.12 to 0.1.11 is
`--to 0.1.11 --expect-before 0.1.12`).

## Deploying a guarded package

`gq ploi release` (and so `gq release package` without `--no-deploy`, and the
CI release step):

1. reads the expectations and `composer.lock` **from the release commit**, and
   refuses when either is missing, a guarded package isn't stated, or the lock
   doesn't install the stated version at the stated reference;
2. refuses unless the release commit's deploy script carries the
   `GUARDED_PACKAGES="…"` line `gq sync` renders, so the server checks again;
3. looks up a `phase: "deploy"` record for each package (with the release
   commit), and refuses unless its `files_digest` is the expectation's;
4. uploads the archive with `PACKAGE_EXPECTATIONS`: the record's file list and
   the sha256 of the lock it checked, under an archive key that includes that
   file's digest;
5. **looks every record up again, fresh, right before changing the Ploi site**
   (the deploy script sync, then the deploy). A withdrawn, unreachable, stale
   or changed record (`release_id`, `files_digest`, `package.zip_sha256`)
   stops the release with the Ploi site unchanged. The first lookup is not
   permission.

On the server, `deploy/ploi/admin.sh` runs after `composer install`, the
restore of shipped plugins and the dependency patch, and **before** PHP-FPM
reloads and any WP-CLI activation, database update, deploy extension or
rewrite flush. (A full deploy has already turned maintenance mode on, as
before; a Composer-only deploy runs no WP-CLI at all.) It refuses when:

- the Site guards a package and the archive has no `PACKAGE_EXPECTATIONS`, or
  doesn't state that package;
- `apps/cms/composer.lock` isn't the lock gq checked;
- a stated package's installed files differ: each `missing`, `changed` or
  `extra` path is listed, or a non-regular file is there.

A refusal fails the deploy (`<PROJECT>_DEPLOY_STATUS=failed`) and
`gq ploi release` exits 1. The files Composer already replaced stay on disk,
not yet loaded by a PHP-FPM reload; redeploying the previous release commit
restores them.

### Remaining gaps

- The server can't reach the approval service: the fresh lookup is gq's,
  immediately before it triggers the deploy, and Ploi's deploy then runs
  within minutes. The server verifies the files against that record.
- No adapter exists in gq-site; `bin/gq.mjs` passes none, so guarded Sites
  stay unable to prepare or deploy their guarded packages until one does.

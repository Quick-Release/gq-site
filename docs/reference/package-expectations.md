# Package expectations

[Documentation](../README.md)

A Site that lists Composer packages in `gq.ops.json`
`deployment.guardedPackages` (see [Deployment policy](deployment-policy.md))
deploys them only as stated in `deploy/ploi/package-expectations.json`, and
only once an authenticated approval service confirms them.

**The file is an expectation, not an approval.** Anyone who can change the
Site can edit it. gq-site ships no approval service, verification key or
signature format, so until one is wired into `run()` (the `approvals`
adapter), every deploy of a Site guarding a package refuses with:

```
No authenticated package approval service is configured, so gq can't confirm getquick/gq-support 0.2.0 (v0.2.0) is approved; a guarded deploy refuses. deploy/ploi/package-expectations.json is an expectation the server checks, not an approval.
```

## Contract v1

```json
{
  "schemaVersion": 1,
  "packages": [
    {
      "name": "getquick/gq-support",
      "version": "0.2.0",
      "tag": "v0.2.0",
      "tagCommit": "<40-hex commit the published tag points at>",
      "lockReference": "<the reference composer.lock records for this version>",
      "installPath": "web/app/plugins/gq-support",
      "tree": {
        "normalization": "gq-tree-v1",
        "digest": "<sha256 of the listing below>",
        "files": [{ "path": "gq-support.php", "sha256": "<sha256 of the file>" }]
      },
      "sourceCommit": "<optional: the source commit the release was built from>"
    }
  ]
}
```

Every object is strict: an unknown key (`approved`, `signature`, …) fails
validation, so the file can't claim authority it doesn't have.

| Field              | Compared with                                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`          | The `apps/cms/composer.lock` entry's version, in `packages` (a dev package isn't installed by the server's `--no-dev` install).                |
| `lockReference`    | Every reference the lock entry records (`dist.reference`, `source.reference`): all must equal it.                                              |
| `tag`, `tagCommit` | Sent to the approval service as the published identity. Not compared locally.                                                                  |
| `sourceCommit`     | Nothing. The source repository's main commit differs from the published tag commit, and is never compared with the lock or the files.          |
| `installPath`      | Where Composer installs the package, relative to `apps/cms`: `web/app/plugins/<slug>`, `web/app/mu-plugins/<slug>` or `web/app/themes/<slug>`. |
| `tree`             | The installed files on the server, after `composer install`.                                                                                   |

The tree is compared, not the package archive: the registry may repack a
package's ZIP, so its bytes and `dist.shasum` can differ while the installed
files are the same, and the same bytes say nothing about files changed after
installation.

### gq-tree-v1

The installed tree's regular files, paths relative to `installPath` (POSIX,
no empty, `.` or `..` parts, no backslash or control character), sorted by
their bytes, one `sha256sum` line each (`<64 hex>  <path>\n`). The digest is
the sha256 of those lines concatenated. Directories are implied; a symlink or
any other non-regular file fails the check. It is what
`find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum` prints in
the install directory, without each path's leading `./`.

gq refuses a file whose `digest` doesn't match its own `files`.

## What a guarded release does

Before anything is uploaded (`gq ploi release`, and so `gq release package`
and the CI release step):

1. it reads `deploy/ploi/package-expectations.json` and `apps/cms/composer.lock`
   **from the release commit**, and refuses when either is missing, the file is
   invalid, a guarded package isn't stated, or the lock doesn't install the
   stated version at the stated reference;
2. it refuses unless the release commit's deploy script carries the same
   `GUARDED_PACKAGES="…"` line `gq sync` renders from `gq.ops.json` (so the
   server checks again);
3. it asks the approval service to confirm each stated package
   (`approvals.confirm(request)`, below), and refuses when it doesn't;
4. it ships the checked expectations in the release archive as
   `PACKAGE_EXPECTATIONS`, with the sha256 of the lock it checked, under an
   archive key that includes that file's digest (so an archive packed before
   is never reused).

On the server, `deploy/ploi/admin.sh` runs after `composer install`, after
restoring shipped plugins and after the dependency patch, and **before**
PHP-FPM reloads and any WP-CLI activation, database update, deploy
extension or rewrite flush (a full deploy has already turned maintenance mode
on, as before; a Composer-only deploy runs no WP-CLI at all). It refuses when:

- the Site guards a package and the archive has no `PACKAGE_EXPECTATIONS`, or
  doesn't state that package;
- `apps/cms/composer.lock` isn't the lock gq checked;
- a stated package's installed files differ: each `missing`, `changed` or
  `extra` path is listed.

A refusal fails the deploy (`<PROJECT>_DEPLOY_STATUS=failed`), and
`gq ploi release` exits 1. The files Composer already replaced stay on disk,
not yet loaded by a PHP-FPM reload; redeploying the previous release commit
restores them.

### Approval request

```json
{
  "project": "<gq.ops.json project>",
  "releaseCommit": "<the Site's release commit>",
  "package": {
    "name": "getquick/gq-support",
    "version": "0.2.0",
    "tag": "v0.2.0",
    "tagCommit": "<40 hex>",
    "lockReference": "<as in the lock>",
    "installPath": "web/app/plugins/gq-support",
    "tree": { "normalization": "gq-tree-v1", "digest": "<64 hex>", "fileCount": 42 }
  }
}
```

`approvals.confirm(request)` resolves when an authenticated service confirms
this package identity and tree are approved for this project, and rejects
otherwise. What the service checks, how it authenticates and where its
records live (the Operator's D1 approvals) belong to that service; gq-site
defines only this request and refuses without an answer.

## Preparing a guarded package

`gq release package <package> --to <version> [--reference <ref>] [--expect-before <version>] --no-deploy`
pins the exact version, updates only that package in the lock and commits
it without deploying; see [release package](release.md). It doesn't write
the expectations file: that comes from the package's published release, and
its authority from the approval service.

# Package expectations

[Documentation](../README.md)

A Site that lists Composer packages in `gq.ops.json`
`deployment.guardedPackages` (see [Deployment policy](deployment-policy.md))
prepares and deploys them only with an approval record looked up from
gq-support's approval service. Two inputs are kept apart:

- **The Site's expectation**, `deploy/ploi/package-expectations.json`: which
  version and which approved release the Site's reviewed source intends.
  Anyone who can change the Site can edit it, so it is never authority.
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
  "packages": [{ "name": "getquick/gq-support", "version": "0.1.11", "releaseId": 11 }]
}
```

Strict: an unknown key (`approved`, `filesDigest`, `lockReference`,
`installPath`, …) fails. `releaseId` is the approval service's ID for the
release, the key a lookup takes; the service refuses one that isn't its
current approved release. `gq release package --to … --release-id …` writes
the entry (below); review it with the lock change.

Where the package installs isn't the Site's to state: gq derives it from the
release commit's `apps/cms/composer.json` `extra.installer-paths` and the
lock entry's package type, as composer/installers does (the one pattern
naming the package, its `type:` or its `vendor:`, with `{$name}` and
`{$vendor}`; the package's `installer-name` when it has one). No matching
pattern, more than one, a non-WordPress type or a path outside
`web/app/plugins`, `web/app/mu-plugins` or `web/app/themes` refuses. For
gq-support in a GETQUICK Site that is `web/app/plugins/gq-support`.

## The approval record

gq-support defines it ([gq-support PR 154](https://github.com/Quick-Release/gq-support/pull/154),
merged in [`29de3c7`](https://github.com/Quick-Release/gq-support/commit/29de3c7ec66ad96d6726bae20766c2acc7fcc312)).
gq reads exactly these keys, in every object but `files`, and refuses a record
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

- it is for exactly the stage and slot the Site's reviewed `gq.ops.json`
  `deployment.approval` names (every lookup carries them, whatever adapter
  answers), the phase asked, the package, the exact version and the release ID
  asked;
- its `files` hash to its `files_digest` (`gq-support.files/v1`, below);
- its `observed_at`, the Operator CLI's point-in-time observation, not the
  approval's time, is within five minutes of now (at most one minute ahead).
  That is a ceiling, not a cache: every deploy-phase check runs the lookup
  afresh, and a slow lookup can expire.

Identity:

- `composer.lock`'s `source.reference` for the package must be
  `published_tag.commit`, the commit the approved tag points to, verified by
  gq-support against the approved files. A lock entry without a source
  reference refuses. Its `dist.reference`, when there is a dist, must be the
  same commit: a repacked registry ZIP doesn't make another commit the
  package. The lock's version must be `package.version`, in `packages` (the
  server's `--no-dev` install skips `packages-dev`).
- `provenance.source_commit` is gq-support's source commit. It is never
  compared with the lock.
- `package.zip_sha256` is the approved release-workflow ZIP, not the Composer
  registry's dist ZIP: the registry's bytes and its `dist.shasum` are never
  compared.

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
is `{ phase, project, stage, slot, releaseId, releaseCommit?, package: { name,
version } }` and the result is the record, or a rejection. A caller can
instead pass `approvalLookup({ project, projectRoot })`, which builds the
adapter for the Site being released. Without either, there is no lookup and
every guarded package refuses.

Only the `gq` command (`bin/gq.mjs`) passes one: the Operator CLI adapter,
built from its own process environment. A program calling `run()` gets no
lookup unless it passes its own.

### The Operator CLI adapter

It runs gq-support's read-only command exactly as the pinned commit's
`operator` script does, from a reviewed gq-support checkout, with the
Operator's own Cloudflare (Wrangler) and GitHub (`gh`) logins. gq holds no
key or secret for it, and every prepare or deploy check runs the command
afresh: no saved record is ever accepted. Nothing about the command is
configurable:

```
<node> --import <checkout>/worker/node_modules/alchemy/bin/register-oxc.js \
  scripts/operator.ts composer-approval <slot> <release-id> <artifactDir> <prepare|deploy> \
  --stage <stage> --account-id <accountId> --database-id <databaseId> --ledger-database-id <ledgerDatabaseId>
```

in `<checkout>/worker`.

**Where its configuration is.** Only in the home directory of the user
running `gq`, as the system's user database has it (`os.userInfo()`):
`~/.config/gq/support-approval.json`. `HOME`, `XDG_CONFIG_HOME`, `PATH`, a
Site's `.env`, `ops.env`, Sigillo values (`gq sigillo run` sets the
environment of the `gq` it runs) and `gq.ops.json` never select or change
it. An environment that sets `GQ_SUPPORT_APPROVAL_CONFIG` is refused rather
than ignored. A configuration file, executable, checkout or artifact
directory inside the Site refuses.

```json
{
  "schemaVersion": 2,
  "node": "/usr/local/bin/node",
  "git": "/usr/bin/git",
  "checkout": "/srv/gq-support",
  "targets": {
    "nomia": {
      "stage": "prod",
      "slot": "nomia/production",
      "accountId": "…",
      "databaseId": "…",
      "ledgerDatabaseId": "…",
      "releases": {
        "0.1.11": { "releaseId": 11, "artifactDir": "/srv/gq-support-artifacts/v0.1.11" }
      }
    }
  }
}
```

- `node` and `git` are the absolute executables gq uses: never one found on a
  `PATH` a Site or its `node_modules/.bin` could shadow. Strings are compared
  exactly: no surrounding whitespace.
- **The checkout**, before each lookup, with that `git`, a fixed environment
  and no user or system git configuration, hooks or fsmonitor: its HEAD must
  be the commit gq-site pins (`29de3c7ec66ad96d6726bae20766c2acc7fcc312`, a
  reviewed gq-site change to move), its work tree clean (untracked files
  count), no file flagged assume-unchanged or skip-worktree (`git status`
  doesn't look at those), and every tracked file's bytes (symlinks' targets)
  equal to the pinned tree's blobs, hashed by gq itself, whatever the index
  says; `worker/scripts/operator.ts` must be a tracked regular file.
  Otherwise it refuses before the command runs.
- **Its dependencies are a trusted prerequisite.** `node_modules` is ignored
  by git, so the pin doesn't verify it. The Operator installs it with
  `pnpm install --frozen-lockfile` at the pinned commit; gq checks that pnpm
  recorded installing exactly the tracked `pnpm-lock.yaml`
  (`node_modules/.pnpm/lock.yaml`), that the loader resolves inside the
  checkout's `node_modules`, and that no ignored `node_modules` exists outside
  the workspace's own dependency directories (`node_modules`,
  `worker/node_modules`, `plugin/app/node_modules`), where one could shadow
  the entry point's imports. That is evidence of the install, not a
  verification of every installed file: anyone who can write the
  checkout's `node_modules` can change what runs.
- `targets` binds each project to its approval target. A lookup refuses
  unless the Site's `deployment.approval` names that same stage and slot.
- `releases` binds each gq-support version the Operator may look up to the
  approved release's ID and its downloaded release artifact (`gq-support.zip`,
  `gq-support.manifest.json`, `provenance.json`). A lookup for a version it
  doesn't bind, for another release ID, or for a package other than
  `getquick/gq-support` refuses before the command runs.
- **The process**: no shell, its own process group, at most two minutes and
  4 MiB on each of stdout and stderr, read as they stream. When it exits or
  passes a bound, the whole group is killed, and so it is if `gq` itself is
  interrupted or terminated meanwhile. stderr is discarded. Its environment
  is fixed: `HOME`, `USER` and `LOGNAME` from the user database, `PATH` from
  the configured `node`'s directory and `/usr/bin:/bin`, `LANG=C.UTF-8` and
  `TMPDIR=/tmp`; no tokens, CA overrides or `NODE_OPTIONS`. A login that
  needs anything else (a proxy, a keyring through `DBUS_*`) fails closed.
- It must exit 0 and print exactly one JSON object, with no repeated member
  name, which gq then checks as above. Every refusal is a fixed message: none
  carries the command's output or a path from the configuration, and nothing
  from the configuration goes into a release archive.

Only the `gq` command wires this adapter in. This configuration isn't enabled
anywhere yet: until the approval service has an approved release and the
Site's slot is bound to it (reviewed gq-support follow-ups), the command
refuses, and so does every guarded package.

## Preparing a guarded package

`gq release package <package> --to <version> --release-id <id> [--pin] [--expect-before <version>] --no-deploy`
(see [release package](release.md)):

1. reads the working tree's and the default branch's current policy (see
   [Deployment policy](deployment-policy.md)): an unreadable one, offboarding
   or differing approval targets refuse; a package either guards is guarded.
   With `--no-deploy` a held Site may still be prepared (nothing is uploaded
   or deployed); without it, a hold refuses here, before Composer runs;
2. looks up a `phase: "prepare"` record for exactly that release and version,
   before Composer runs; no record means nothing changes;
3. locks exactly `<version>` of only that package (`composer update
<package> --with <package>:<version> --no-install --no-scripts
--no-plugins`: none of the Site's Composer scripts or plugins run). A
   requirement that
   already admits `<version>` (`^0.1.3`, `*`) stays as it is; one that
   doesn't refuses unless `--pin` sets it to exactly `<version>`. A range
   never authorizes the registry's latest;
4. refuses unless the lock changed only that package's entry: every other
   `packages` and `packages-dev` entry and every other top-level field
   (aliases, platform, stability flags, minimum-stability,
   plugin-api-version) exactly as before, and `content-hash` unchanged, or,
   with `--pin`, exactly the hash Composer computes for the pinned
   `composer.json` (gq computes it, and only trusts that after reproducing
   the lock's current hash);
5. refuses unless the lock's references are the record's
   `published_tag.commit`;
6. sets the package's entry in `deploy/ploi/package-expectations.json`
   (`<version>`, the record's `release_id`);
7. checks the version files without syncing them, and commits (with the
   Site's git hooks off, for that commit only) exactly `composer.lock`, the expectations file and, with `--pin`,
   `composer.json`: anything else changed refuses, and the index must hold
   exactly those paths.

Any failure up to the commit puts back the files gq changes, undoes its own
staging, and names (without touching) anything else that changed.
`--reference` is refused for a guarded package: the record names it. With
`--no-deploy` the lookup is the only outside call: nothing is uploaded and
the Ploi site isn't touched. A `prepare` record never authorizes an install.
The version is any exact approved version: a recovery drill from 0.1.12 back
to 0.1.11 is `--to 0.1.11 --release-id <0.1.11's id> --expect-before 0.1.12`.

## Deploying a guarded package

`gq ploi release` (and so `gq release package` without `--no-deploy`, and the
CI release step), after the [deployment policy](deployment-policy.md) checks:

1. reads the expectations, `composer.lock` and `apps/cms/composer.json`
   **from the release commit**, and refuses when one is missing or a guarded
   package isn't stated;
2. refuses unless the release commit's deploy script carries the
   `GUARDED_PACKAGES="…"` line `gq sync` renders, so the server checks again;
3. looks up a `phase: "deploy"` record for each package's expected release,
   refuses unless the lock installs exactly its package (version and
   references), and derives where it installs;
4. uploads the archive with `PACKAGE_EXPECTATIONS`: the install path, the
   record's file list and digest, and the sha256 of the lock it checked,
   under an archive key that includes that file's digest;
5. syncs the deploy script, then **runs every deploy lookup again,
   immediately before the deploy request**. A failed lookup, or a record that
   differs in any field but `observed_at`, stops the release before the
   deploy is requested.

On the server, `deploy/ploi/admin.sh`:

- right after unpacking the archive, before it replaces, installs or runs
  anything, refuses when the Site guards a package and the archive has no
  `PACKAGE_EXPECTATIONS`, when a line of it isn't one gq writes, when it
  doesn't state exactly the packages the Site guards, or when the release's
  `composer.lock` isn't the lock gq checked;
- after `composer install`, the restore of shipped plugins and the dependency
  patch, and **before** PHP-FPM reloads and any plugin activation, database
  update, deploy extension or rewrite flush, computes `gq-support.files/v1`
  over the install path and refuses when the files differ from the record's:
  each `missing`, `changed` or `extra` path is listed, or a non-regular file
  is there.

A full deploy runs `wp core is-installed` and turns maintenance mode on
before Composer, as it always has; a Composer-only deploy runs no WP-CLI at
all. The installed version isn't read separately: it is the lock's (checked
against the record before upload, and the lock's hash again on the server),
and the package's own files, its version header included, must be exactly the
approved ones.

### Held for the whole deploy: the request admission

The install is **not atomic**: Composer replaces files as it goes, and
nothing rolls them back. So a guarded Site is **held** before the deploy
replaces or installs anything, in a full and a Composer-only deploy alike,
and stays held until that deploy has verified its packages and finished
every step. The hold is `deploy/ploi/admission.sh` (managed by `gq sync`,
shipped in the release), one module the deploy calls as `admission.sh begin`
and `admission.sh lift`. Everything it writes is outside what Composer or
the release's rsync own:

| Path                                        | What                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `$SITE/.gq/admission.php`                   | the gate: PHP-FPM prepends it to every script under the web root                       |
| `$SITE/.gq/hold`                            | present: held. Its content is this hold's nonce, public freshness evidence (no secret) |
| a managed block in `apps/cms/web/.user.ini` | `auto_prepend_file` for the gate; every other setting there stays                      |

The release's rsync protects `web/.user.ini` (a release that ships one is
refused), and Composer never writes under `.gq/`, so a Composer install that
deletes and reinstalls `web/wp` (as `roots/wordpress` does) leaves the hold
alone; WordPress's own `.maintenance` lives in `web/wp` and doesn't survive
one.

While held, the gate answers every **non-CLI PHP request** 503 (`Retry-After`,
`Cache-Control: no-store`, `X-GQ-Hold: <nonce>`, a body naming nothing)
before any other PHP code runs: WordPress, its installer and upgrader,
`setup-config.php` (which loads `wp-settings.php` without `wp-config.php` or
`.maintenance`), and a plugin's own PHP file requested directly.
Command-line PHP (WP-CLI: this deploy's own steps, and a recovery) is never
held. **The gate covers PHP only**: nginx still serves static files.

`begin`, after the deploy's preflight and before anything changes:

1. refuses, changing nothing, a managed path that is a symlink or not a
   regular file (`.gq` not a directory), a `.user.ini` that already sets
   `auto_prepend_file` outside gq's block (gq neither replaces nor chains
   unknown prepend code), an admin domain (`gq.ops.json` `domains.admin`)
   that isn't a plain hostname, and a PHP-FPM master for the CLI's PHP
   version (`php-fpm: master process (/etc/php/<v>/fpm/php-fpm.conf)`) that
   this user can't see;
2. writes the gate and the `.user.ini` block if they differ, and the hold
   with a fresh nonce, each atomically (a rename in the same directory);
3. reloads PHP-FPM (`sudo -n service php<v>-fpm reload`), which must succeed:
   new workers read the new `.user.ini` and the gate (PHP caches both per
   worker, and opcache may not revalidate files);
4. waits, bounded (`GQ_ADMISSION_DRAIN_SECONDS`, 120 by default), until no
   worker of that master that existed before the reload still runs
   (matched by pid and start time, wherever it is now), so no request that
   started before the hold still runs WordPress code when packages change.
   Another PHP version's pools aren't reloaded, so they aren't waited for;
5. requests, over TLS for the admin domain resolved to 127.0.0.1 with the
   certificate checked, no redirect followed, bounded timeouts and only the
   headers kept, the front page and `/wp/wp-admin/setup-config.php`, each of
   which must answer 503 with this hold's nonce;
6. requires a worker of that master to be visible (so the drain wasn't
   vacuous).

If any step fails, `begin` fails before any package file changes. It removes
a hold it created (the Site's code is still the previous, verified one) and
keeps one an earlier failed deploy left. It says what it did change (the
gate, `.user.ini`, a reload) rather than "nothing changed".

`lift` removes the hold. The gate checks the hold file on every request (stat
cache cleared, never opcache), so lifting needs no reload, and nor does a
hold appearing. Only the end of a deploy that verified the guarded packages
and finished every step lifts it. A failed Composer install, a failed
verification, a failed later step (activation, database, an extension), a
timeout or a killed deploy leaves it: nothing (no exit trap, no timer)
releases the hold. Recovery is another guarded deploy of an approved
version, which needs its own fresh approval; removing `.gq/hold` by hand
serves files that didn't verify. An unguarded Site's deploy uses WordPress's
own maintenance mode, as before.

#### What the server must provide

The admission refuses or fails closed when one of these doesn't hold; none
is provisioned by gq:

- PHP-FPM honours `.user.ini` (`user_ini.filename` is the default) and
  `auto_prepend_file` in it under the web root;
- nginx answers HTTPS for the admin domain on 127.0.0.1 with a certificate
  the server trusts;
- the deploy user may run `sudo -n service php<v>-fpm reload` (Ploi's own
  deploy scripts reload PHP-FPM this way);
- PHP-FPM's processes are visible to the deploy user (no `hidepid` on
  `/proc`).

A reload restarts every pool of that PHP version's master, other Sites'
included, as Ploi's own deploy reload already does. With PHP-FPM's default
`process_control_timeout = 0`, the reload ends requests in flight at once
(they get a 502); with a positive one, they finish first, up to that long,
and `begin` waits for them. Either way no pre-hold request still runs when
packages change.

#### Checked on a real stack

`scripts/smoke/admission.sh` (CI job `admission`) generates a guarded Site
and runs its `admission.sh` verbatim in a disposable Docker container
(`scripts/smoke/admission/`): nginx over TLS for the admin domain (a
throwaway CA), PHP-FPM with `opcache.validate_timestamps=0` running a static
pool as the Site's user, the WordPress the CMS skeleton pins installed by
Composer under the generated Bedrock config, on SQLite. It checks a
pre-hold slow request with both reload behaviours; every PHP route answering
503 with the nonce while no WordPress or plugin code runs; static files
still served; WP-CLI while held; a real `composer reinstall` deleting
`web/wp` while held; lifting and holding without a reload; a killed and a
late-failing deploy staying held; a failed `begin` keeping an earlier hold
and removing its own; and `.user.ini` settings kept and a foreign prepend
refused. The generated `admin.sh`'s order of steps (hold proven before the
rsync and Composer, lifted only at the end) is checked with stand-ins in
`test/cms/deploy-script.test.mjs`.

### Remaining gaps

- The server can't reach the approval service: the fresh lookup is gq's,
  immediately before it requests the deploy, and Ploi's deploy then runs
  within minutes. The server verifies the files against that record.
- No Operator machine is configured yet, so guarded packages refuse.

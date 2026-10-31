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
and `admission.sh lift`.

**The gate is enforced by the server, not by gq's files.** A guard gq wrote
into a per-directory INI file could be turned off by any package: a
`.user.ini` in a plugin's directory that sets `auto_prepend_file =` runs that
plugin's PHP file ungated (checked on PHP-FPM; `php_value` in the pool is no
better). Only `php_admin_value[auto_prepend_file]` in the PHP-FPM pool can't
be changed by a `.user.ini` of any `user_ini.filename`, by `php_value` or by
`ini_set`. So the admission needs a server that already prepends its gate
that way, and refuses on any other. gq never configures PHP-FPM, nginx or
Ploi; guarded deployment stays **unavailable on a real host** until the
hosting contract below holds there and has been reviewed.

What gq owns, all outside what Composer or the release's rsync write:

| Path                                         | What                                                                                                                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$SITE/.gq/admission.php`                    | the gate the pool prepends; rewritten only when it differs, never removed                                                                                                        |
| `$SITE/.gq/state`                            | the admission state: the Site is served only while the gate reads exactly `open`; `held <nonce>` (public freshness evidence, no secret) and every other outcome hold it          |
| `$SITE/apps/cms/web/gq-admission/<attempt>/` | one attempt's challenge (`probe.php` and INI files that empty `auto_prepend_file`), removed by that attempt; a killed attempt's stays, harmless, and no other attempt removes it |

The release's rsync protects `web/gq-admission/`, and a release that ships
anything there is refused. gq writes no `.user.ini`.

**The state fails closed.** The gate reads `.gq/state` on every request, as
data (never through opcache, never inferred from a failed stat), and serves
only when the read succeeds and returns exactly `open` and a newline. No
state file, one PHP can't read (its permissions, or an `open_basedir` a
package's `.user.ini` sets that lets the gate itself load but hides the
state), a symlink, a directory, `held <nonce>` or any other content: held.
So a package that restricts `open_basedir` that way gets its own scripts
held even while the Site is open, and one whose `.user.ini` starves PHP's
memory gets its scripts failed (both checked on PHP-FPM). These are the
per-directory settings checked; it isn't a claim that no other one could
matter.

While held, the gate answers every **non-CLI PHP request for the Site's web
root** 503 (`Retry-After`, `Cache-Control: no-store`, `X-GQ-Gate: <nonce>`, a
body naming nothing) before any other PHP code runs: WordPress, its
installer and upgrader, `setup-config.php`, a plugin's own PHP file, a
script a package's `.user.ini` sits beside. Command-line PHP (WP-CLI: this
deploy's own steps, and a recovery) is never held. **The gate covers PHP
only**: nginx still serves static files. The gate tells the Site's requests
from another Site's sharing the pool by the server's `SCRIPT_FILENAME` and
`DOCUMENT_ROOT`, resolved: only a request whose script and document root
both resolve outside the Site's web root passes untouched; one with either
value missing or unresolvable is treated as the Site's.

`begin`, after the deploy's preflight and before anything changes:

1. refuses, changing nothing, a managed path that is a symlink or not a
   regular file (a directory for `.gq` and `gq-admission`), an admin domain
   (`gq.ops.json` `domains.admin`) that isn't a plain hostname, and a drain
   limit above 120 seconds;
2. installs the gate if it differs (atomically: a rename in the same
   directory);
3. **the challenge**: writes a fresh `web/gq-admission/<attempt>/` with
   `probe.php` and a `.user.ini` that sets `auto_prepend_file =`, and
   requests it over TLS for the admin domain resolved to 127.0.0.1 (the
   certificate checked, no redirect followed, bounded timeouts). The gate
   must answer it: if `probe.php` itself runs, the nested override won, and
   the pool doesn't enforce the gate (no prepend, `php_value`, a root
   `.user.ini`, or a pool without it), so `begin` refuses. The gate reports
   `PHP_VERSION`, its worker's pid and `user_ini.filename`; a custom file
   name (a safe base name, or the deploy refuses) is challenged again in
   another fresh directory, so no worker's INI cache hides it;
4. **binds the serving pool**: PHP-FPM `<version>`'s master
   (`/etc/php/<version>/fpm/php-fpm.conf`, the version the gate reported,
   not the CLI's) must be visible, and the worker that answered must be one
   of its workers; that worker's pool is the Site's. A version whose master
   isn't there, or a worker of another master, refuses;
5. writes the state `held <nonce>` (a fresh nonce), reloads PHP-FPM `<version>` (`sudo -n
service php<version>-fpm reload`), which must succeed, and waits, at
   most 120 seconds (`GQ_ADMISSION_DRAIN_SECONDS` may only shorten it),
   until no worker of that master that ran before the reload still runs
   (matched by pid and start time, wherever it is now): no request that
   started before the hold still runs WordPress code;
6. requires 4 more probes to answer 503 with this hold's nonce, each from a
   worker of **the same pool** that started **after** the reload.

If a step fails in a way `begin` checks for, it fails before any package
file changes, removes its own challenges, and says exactly what it changed
(the gate, the state, a reload) and what the state is now. The state goes
back to `open` only if the Site was open before and the state is still this
attempt's own hold (the Site's code is still the previous, verified one); a
Site that was held (an earlier failed deploy, or no state at all) stays
held. If `begin` stops any other way (an unexpected error), it removes only
its own temporary and challenge files it knows of, never opens the Site,
and says what the state is; a temporary file can remain if the shell itself
dies. A `begin` killed with SIGKILL runs no cleanup: its hold (and its
challenge directory) can remain **before** Composer has changed anything,
and the Site stays held until a guarded deploy finishes.

`lift` writes `open`: the only way to open the Site besides that restore,
run only at the end of a deploy that verified the guarded packages and
finished every step. The gate reads the state on every request, so opening
and holding need no reload. A failed Composer install, a failed
verification, a failed later step (activation, database, an extension), a
timeout or a killed deploy leaves it held: nothing (no exit trap, no timer)
opens it. Recovery is another guarded deploy of an approved version, which
needs its own fresh approval; writing `open` by hand serves files that
didn't verify. An unguarded Site's deploy uses WordPress's own maintenance
mode, as before.

#### The hosting contract

None of this is provisioned by gq, and each item needs a human hosting
review before any guarded deploy on a real host:

- **P1, the prepend:** the PHP-FPM pool serving the Site has
  `php_admin_value[auto_prepend_file] = <SITE_PATH>/.gq/admission.php`, a
  fixed path outside Composer and the release. The pool's other settings,
  `user_ini.filename` among them, are the host's.
- **P1, routing:** nginx sends **every** PHP script under the admin web root
  to that one pool. The probes sample the workers serving one URL: they
  prove that pool's enforced setting, not how nginx routes every other
  location, and they authenticate nothing about the host's configuration.
  Per-location routing to different pools is unsupported unless reviewed
  separately.
- **P1, one gate per pool:** the setting names one Site's gate. Sites
  sharing a pool aren't held by it (the gate passes their requests), but
  two guarded Sites can't share one pool: each needs its own pool, or a
  different reviewed design.
- **P2:** nginx answers HTTPS for the admin domain on 127.0.0.1 with a
  certificate the server trusts, its document root is the managed
  `apps/cms/web` (Ploi's web directory set to it, or a `public` symlink to
  it already in place) **before** the first guarded deploy, and it serves
  `/gq-admission/` (no rule denying it). The deploy script's own `public`
  symlink fix runs after the hold, too late for the challenge: on a fresh
  Ploi Site with its default `/public` web directory, the challenge gets
  nginx's 404 and the deploy refuses (safely); that setup is unsupported
  until reviewed.
- **P3:** the deploy user may run `sudo -n service php<version>-fpm reload`
  (Ploi's own deploy scripts reload PHP-FPM this way).
- **P4:** PHP-FPM's processes are visible to the deploy user (no `hidepid`
  on `/proc`).
- **P5, the reload's effects:** a reload restarts every pool of that PHP
  version's master, other Sites' included, as Ploi's own deploy reload
  already does. With PHP-FPM's default `process_control_timeout = 0` it
  ends requests in flight at once (a 502, a cut-off write included); with a
  positive one they finish first, up to that long. gq changes neither;
  which one a host runs needs that review.

**Bootstrap**, by a person, once per Site, in this order: make nginx serve
`apps/cms/web` (P2); install the gate with `SITE_PATH=… APP_PATH=apps/cms
bash deploy/ploi/admission.sh prepare` (from a checkout of a release that
carries it; it writes no state and touches no package); then add P1 to the
pool and reload PHP-FPM. From then on the Site is **held** (no state reads
`open`) until the first guarded deploy finishes, so schedule it. With P1
set and the gate missing, every PHP request of that pool fails (500):
fail-closed, but an outage, so the gate goes first. The first guarded
deploy needs neither WordPress core nor `web/index.php` (the challenge is
its own script). There is no workaround through an unguarded install.

#### Checked on a real stack

`scripts/smoke/admission.sh` (CI job `admission`) runs the generated
`deploy/ploi/admin.sh` and `admission.sh` verbatim, as a `ploi` user, in a
disposable Docker container (`scripts/smoke/admission/`): real nginx over TLS
(a throwaway CA), real PHP-FPM with `opcache.validate_timestamps=0` and two
pools of one version, real rsync, real Composer and real WP-CLI on the
WordPress the CMS skeleton pins (on SQLite). Stand-ins, and only these: the
release archive is a local file instead of R2, there is no Ploi, the
GETQUICK packages are local Composer path packages with their names (the
registry is private), and the release's `apps/cms` is the generated one
with that `composer.json`, a no-op `patch-dependencies.php`, the SQLite
drop-in and the checks' instruments. The server's nginx and PHP-FPM
configuration is the smoke's own; **Ploi's production templates are not
checked**. It checks:

- false controls, each refused before any hold or package change: no
  prepend, `php_value`, a root `.user.ini`, `php_value` with a custom
  `user_ini.filename`, and `php_admin_value` on one pool while nginx sends
  the admin domain to another pool of the same PHP-FPM;
- a missing gate under P1 failing closed (500);
- a pre-hold request: ended by the reload under the default
  `process_control_timeout` (502), finished before the hold is proven with
  a positive one;
- the whole generated deploy: a first bootstrap without core or
  `web/index.php`; an installed Site's activation; a deploy that reinstalls
  core and installs a package shipping `.user.ini` with `auto_prepend_file
=` during Composer; a late extension failure; a refused reload keeping an
  earlier hold; a kill during Composer; and the recoveries. Among the
  packages Composer installs during the held deploys, one ships a
  `.user.ini` emptying `auto_prepend_file`, and one ships the exploit's
  `.user.ini` (an `open_basedir` that allows the gate and the web root but
  not the state), plus a directory whose `.user.ini` starves memory. A poller
  requests the Site's PHP routes throughout, and must-use and plugin
  markers note any WordPress or plugin code a web request runs: in every
  held window (the "Held:" line to the state reading `open`, less 100ms for the
  watcher's granularity) nothing runs and every request answers 503;
- while held: every PHP route and plugin file answering 503 with the nonce,
  a script reaching PHP without `DOCUMENT_ROOT` held, static files served,
  another Site in the same pool not held, WP-CLI working;
- the state, on PHP-FPM with `opcache.validate_timestamps=0` and no reload:
  unreadable, malformed, absent, a symlink to a file saying `open`, or a
  directory each hold every PHP request; exactly `open` again serves;
- open: the `open_basedir` package's scripts are held (503), the
  starved-memory script doesn't run;
- a custom `user_ini.filename` (`.htuser`) under P1 challenged and passing.

What it can't show: the same-version pools stand in for two PHP versions
(binding to another version's master is checked with stand-ins in
`test/cms/deploy-script.test.mjs`), and nothing here checks a real Ploi
server's nginx, pools or reload.

### Remaining gaps

- The server can't reach the approval service: the fresh lookup is gq's,
  immediately before it requests the deploy, and Ploi's deploy then runs
  within minutes. The server verifies the files against that record.
- No Operator machine is configured yet, so guarded packages refuse.

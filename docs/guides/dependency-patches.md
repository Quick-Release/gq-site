# CMS dependency patches

[Documentation](../README.md)

`@getquick/site` 0.18.2 ships the wpgraphql-blocks **2.2.0** warning fix
reviewed from [Nomia PR #3](https://github.com/Quick-Release/nomia-bnq/pull/3).
It guards missing array keys and optional properties and declares the Block
properties in their historical assignment order. Cleanup removes absent
optional properties before JSON serialization. DOM parsing captures libxml
diagnostics locally and restores the previous libxml mode. It does not change
PHP's error reporting or install a warning-silencing must-use plugin.

0.44.2 adds a second round that guards the accesses the first round missed,
which production logged on sparse image and cover blocks (see
[Adopt the 0.44.2 round](#adopt-the-0442-round)). It is appended to the same
patch file as a delta on the first round, which stays byte-for-byte as it was.

The dependency stays pinned to `wp-plugin/wpgraphql-blocks: 2.2.0` in the
CMS skeleton. This is blueprint dependency maintenance, not a new GETQUICK
runtime plugin. A future plugin version needs a fresh source review and
response comparison before rebasing or retiring the patch.

## Execution and ownership

`gq sync` manages these files, including for existing CMS apps:

- `apps/cms/patches/wpgraphql-blocks/2.2.0-quiet-unsafe-access.patch`
- `apps/cms/scripts/patch-dependencies.php`
- `deploy/ploi/admin.sh`

The CMS `composer.json` remains create-once and site-owned. New sites get the
Composer scripts below automatically; existing sites deliberately merge them.
Unrelated dependencies, scripts and lockfile choices remain the site's.

Composer's `post-autoload-dump` event runs the patch after `install`, `update`
and `dump-autoload`, including `--no-dev --optimize-autoloader`. It uses
`@php`, so it runs under Composer's PHP without Node, WordPress or dev
dependencies. `gq cms composer reinstall` follows Composer's reinstall with
an autoload dump because Composer reinstall does not emit that event itself.
After a **direct** `composer reinstall`, run `composer dump-autoload` too.
`--no-scripts` deliberately bypasses Composer events: explicitly run
`composer run patch:dependencies` afterwards before using the CMS.

Both full and `COMPOSER_ONLY=true` Ploi deployments also run the same PHP
runner after Composer and after restoring any shipped plugins/themes, before
PHP reload and plugin activation/database updates. A patch failure fails the
deploy. Deploy extensions are not needed to apply this dependency patch.

The runner requires PHP compatible with the CMS (8.4.1+) and **GNU patch**
on PATH (Linux: `patch`; macOS: install GNU patch and put its `patch` on PATH).
Check `patch --version` locally and on the Ploi host before adoption. The
managed Cloudflare CI image installs it from 0.18.3, and sets
`COMPOSER_ALLOW_SUPERUSER=1` so Composer runs the allowed plugins as the
container's root user; without that, `composer/installers` doesn't run and
the runner finds no installed plugin (see
[Adopt the CI image fix](#adopt-the-ci-image-fix-0183)).
It stages copies, applies each hunk with zero fuzz, then verifies both complete
files against reviewed SHA-256 values and runs `php -l` using its own PHP.
Only then does it replace installed files, with an atomic rename per file.
An interruption between files or complete hunks is repaired on the next run.
An edit inside a hunk, unrelated source drift, a missing plugin/file or an
unsupported version fails clearly without committing staged changes. Reruns
verify hashes and syntax without rewriting already-correct installed files.
Concurrent dependency installations in the same CMS directory are unsupported.

The expected patched hashes, from 0.44.2, are:

```text
plugin.php          eabf9f60970ee041b55821200726c2138eab7a672d9e58726809379034c432b5
includes/utils.php  57f42e4d825347f416e70b110632cf53b186996f0f708b8aaacff0944c214a7f
```

0.18.2 through 0.44.1 expected the first round's bytes, which match Nomia
PR #3:

```text
plugin.php          7dee3f7934efa6a70c8c1666f36cb65dd0805ca0a8570ec03d577fb87edc0499
includes/utils.php  6c391ea3dbe2e0dc819f45fd267a61d7a3d4f60f3e0eed6d6086dd19cafd2624
```

The patch file is layered: it holds the first round's sections unchanged,
then a second section per file whose hunks are a delta on the first round.
The runner applies hunks one at a time in that order, so a pristine plugin
gains both rounds, and a plugin carrying the first round skips those hunks
(already applied) and gains the second. A further round is appended the same
way; never edit an earlier round's hunks, or installs carrying it stop
matching.

## Adopt on an existing Site

Do this in a **new session and worktree of that Site's repository**, after
0.18.2 is published. No downstream files or production systems are changed
by the blueprint PR.

1. Check PHP and GNU patch on the developer and deployment hosts. Upgrade the
   exact root pin and sync:

   ```sh
   pnpm add -D -E @getquick/site@0.18.2
   pnpm exec gq sync --check
   pnpm exec gq sync
   ```

   Review sync conflicts; keep site-owned changes and resolve managed-file
   edits deliberately. For Nomia, the existing patch at the managed path
   should be byte-identical and can be adopted as-is. If it differs, compare
   it before deleting that copy and letting sync regenerate it. Do not force
   unrelated managed output over local edits.

2. Merge these entries into `apps/cms/composer.json`'s `scripts` object,
   retaining existing event handlers and adding the patch handler once:

   ```json
   {
     "patch:dependencies": "@php scripts/patch-dependencies.php",
     "post-autoload-dump": ["@patch:dependencies"]
   }
   ```

   Verify `require.wp-plugin/wpgraphql-blocks` and the installed/locked version
   are 2.2.0. If they differ, stop and review that version; do not downgrade
   an unknown Site blindly. If a reviewed constraint change is needed, update
   that package through the site's normal authenticated Composer workflow
   and commit its lockfile. Merely adding scripts does not select new versions.

3. Run `pnpm cms:composer`, then run it again. Both must succeed, with the
   second reporting the patch already applied. Run the site's checks and
   compare representative GraphQL response bodies locally, with and without
   `postTemplate`, including the actual Frontend query. Do not hide warnings
   during this comparison. Confirm `gq sync --check` is clean. Commit the
   package pin, pnpm lockfile, generated files, `gq.lock.json`, Composer
   scripts and any deliberately changed Composer lockfile in the Site PR.

4. Follow that Site's release process and obtain its production enablement
   decision. Deploy through its normal pipeline/Ploi release command. The
   Composer-only branch is covered too, but choosing it remains Site-local.
   Require a successful dependency-patch result before considering rollout
   complete. A source-drift failure is a blocker to investigate, not a reason
   to disable the runner.

5. Verify the Site's real GraphQL requests and compare responses and warning
   counts with the local baseline. Production log paths, credentials, sample
   windows and audits stay **Site-local**. Roll out first on the Reference
   Site, Cooldown Gaming, then on each approved content Site separately.

## Adopt the 0.44.2 round

The first round left some accesses unguarded. With `WP_DEBUG` off, core
still reports `E_WARNING`, and with no `error_log` set PHP-FPM sends each
warning to nginx over FastCGI stderr. On a page with many image or cover
blocks that output overflows nginx's FastCGI header buffer: nginx logs
`upstream sent too big header` and returns a 502 for `POST /wp/graphql`, and
`@getquick/content` retries without blocks, so the page loses its blocks.
Production logged these for core/image blocks without `width`, `height`, `id`
or `url` and core/cover blocks without `useFeaturedImage` (a default the
editor doesn't serialize).

The second round guards them, plus the same pattern elsewhere in both files.
Missing still means falsy, exactly as PHP evaluated it, minus the warning:

- `plugin.php`: the `dynamicContent`, `originalContent`, `htmlContent` and
  `attributes` arguments; core/audio `src`, `preload`, `autoplay` and `loop`;
  core/site-logo's image when the logo's attachment is gone; core/media-text
  `mediaId`; core/cover `useFeaturedImage` and `id`; core/image `width`,
  `height`, `id` (lookup and alt) and `url`; core/query pagination's
  `perPage` and `queryId`; core/comments' post `comment_status`.
- `includes/utils.php`: the posts index (home template) branch, which never
  sets `$blocks`, `$the_post_id` or `$the_post_content`, and the
  `postTemplate` argument.

Left as they are: keys that `parse_blocks()` and the plugin's own synthetic
blocks always set (`blockName`, `innerHTML`, `innerBlocks`), and
`RootQuery.coreQuery`, which throws before its unguarded code runs (see
[Verification boundary](#verification-boundary)).

In a **new session and worktree of the Site's repository**, after 0.44.2 is
published:

1. Bump the exact pin and sync:

   ```sh
   pnpm add -D -E @getquick/site@0.44.2
   pnpm exec gq sync
   pnpm exec gq sync --check
   ```

   The managed changes are `apps/cms/patches/wpgraphql-blocks/2.2.0-quiet-unsafe-access.patch`
   and `apps/cms/scripts/patch-dependencies.php` (plus `gq.lock.json`).
   `apps/cms/composer.json` already has the patch scripts from 0.18.2.

2. Run `pnpm cms:composer` (any Composer install, update or
   `dump-autoload` runs the patch). It reports
   `wpgraphql-blocks 2.2.0 warning patch applied`, and `already applied` on a
   second run. If the CMS's plugin was committed patched, commit the two
   updated plugin files with the Site PR.

3. Deploy as usual. Both the full and the `COMPOSER_ONLY=true` Ploi deploys
   run the runner after Composer, so the deployed plugin gets the new bytes
   from the deploy itself. Confirm the deploy log shows the patch line, then
   that the nginx site error log stops gaining `Undefined array key` lines
   from `wpgraphql-blocks` and `upstream sent too big header` lines on block-
   rich pages.

A Site whose own deploy extension checks the first round's hashes (Nomia's
`deploy/ploi/admin.d/20-wpgraphql-blocks-quiet.sh`, if it still has it) sees
the new bytes as unexpected: retire that extension first, as described below.

## Adopt the CI image fix (0.18.3)

A Site on 0.18.2 whose Cloudflare CI install step fails with
`Composer plugins have been disabled for safety` and
`GETQUICK dependency patch failed: Missing or unsupported wpgraphql-blocks`
needs 0.18.3. Do this in a **new session and worktree of that Site's
repository**; the blueprint PR changes no Site.

1. Upgrade the exact pin and sync:

   ```sh
   pnpm add -D -E @getquick/site@0.18.3
   pnpm exec gq sync
   pnpm exec gq sync --check
   ```

   The only managed change is `infra/ci/Dockerfile` (plus `gq.lock.json`).
   `apps/cms/composer.json` is not touched: keep its `allow-plugins` as it is.
   A Site that removed `composer/installers` or
   `roots/wordpress-core-installer` from it still has its WordPress packages
   in `vendor/`, and must restore them.

2. **Redeploy the CI Worker** from the synced checkout: `pnpm ci:deploy`.
   Wrangler builds and pushes the new image with the Worker; CI keeps running
   the old image until then. The Worker's secrets are re-sent unchanged.

3. Commit and push the Site PR. Its CI run is the check: the install step's
   log shows `wpgraphql-blocks 2.2.0 warning patch applied and PHP syntax
verified.` and no `plugins have been disabled` line. Release as usual
   afterwards. A release workflow that already failed on 0.18.2 isn't rerun
   by this; tag or rerun only through the Site's normal release decision.

## Retire Nomia's extension without a rollout gap

Nomia's separate session belongs in `Quick-Release/nomia-bnq`, local clone
`/data/code/getquick/clients/apa/nomia-bnq`, in a new worktree.

`deploy/ploi/admin.d/20-wpgraphql-blocks-quiet.sh` is Nomia's own deploy
extension (site-owned: `gq sync` never adds, changes or deletes it). On
0.18.2 to 0.44.1 its expected hashes matched the shared patch's, so it
skipped after the shared runner and could stay as a fallback. **From 0.44.2
it must go in the same Site PR as the bump:** the shared runner leaves the
plugin with the second round's bytes, which the extension doesn't expect, so
it re-runs `patch` against the new two-round patch file, fails its hash check
and fails every full deploy. Delete the extension, keep the managed patch file
at the same path (`gq sync` rewrites it), and delete or rewrite the old
site-owned `apps/cms/patches/wpgraphql-blocks/README.md`, which still
describes the extension as a fallback.

Keep `scripts/ops/nomia-502-hotfix/log-audit-remote.mjs` and its production
audit evidence in Nomia. Once the patched code is verified, retire any active
`gq-silence-low-severity.php` suppression in that Site's own release/operations
session, then run its read-only audit against fresh representative requests
to confirm warning/502 counts without suppression. An audit while the
silencer is active is insufficient evidence. Do not execute the old hotfix
application script as part of shared adoption.

For rollback, keep the shared patch/scripts while reverting unrelated Site
changes. Rolling back the blueprint version and removing its patch machinery
requires restoring the old Nomia extension **and its patch file** together
before a full deployment; the old extension alone does not cover local or
Composer-only installs. Old release archives may reinstall pristine sources.
Never remove the fallback before a verified replacement is deployed.

## Publish and coordinate

The blueprint release commit bumps `package.json` to 0.18.2 and records the
change in `CHANGELOG.md`. After reviewing and merging the draft PR, check out
the clean release commit on main, tag it `v0.18.2`, push that tag, and run
`pnpm release:publish` following [Develop and publish](../development.md#releasing).
This uses the existing Sigillo operations environment and requires a valid
`NPM_TOKEN`. The PR does not publish or deploy. Confirm npm serves 0.18.2
before downstream adoption.

Each Site owns its upgrade PR, hook retirement, production decision and audit.
If a platform-wide release record, cross-repository policy or rollout
coordination is needed, start a separate session in
`Quick-Release/gq-platform`, local clone `/data/code/getquick/gq-platform`,
in its own worktree. No gq-platform change is required to publish this patch.

## Verification boundary

`node --test test/cms/dependency-patch.test.mjs` exercises pristine upstream
sources, an upgrade from the first round's bytes (including an upgrade
interrupted between files), clean/rerun application, partial file/hunk repair, drift rejection,
real PHP syntax and Composer lifecycle execution. The response harness invokes
the actual registered `ContentNode.blocks` resolver and JSON scalar with
deterministic WordPress substitutes across all 32 Boolean argument combinations,
nested blocks, query loops, sparse attributes (image, cover, audio,
media-text, site-logo, comments and pagination blocks), template on/off, and
the posts index alongside an entry. It compares
raw JSON bytes (including field presence/order) and WordPress query arguments,
and requires zero warnings after reproducing the pristine warning flood.
Deploy tests cover both paths and failure before activation/database updates.
CI provisions PHP 8.4, DOM and Composer for these checks.

`scripts/smoke/ci-composer.sh` (Docker and network) proves the Cloudflare CI
path: it builds a generated Site's CI image and runs the install step's
Composer command as root on a clean CMS without the GETQUICK registry
packages (they need `COMPOSER_AUTH`). Composer skips its root check when it
detects Docker, which Cloudflare's containers aren't, so the proof turns that
detection off with an `open_basedir = /` PHP ini. It checks installer paths,
WordPress core, the reviewed hashes, the CMS lint and tests, that
`allow-plugins` still refuses an unlisted plugin, and that the install fails
without `COMPOSER_ALLOW_SUPERUSER`.

This is not a full WordPress/GraphQL server test or an exhaustive repair of
every wpgraphql-blocks issue. In particular, pristine 2.2.0's `RootQuery.coreQuery`
calls `get_mapped_blocks` without its required argument and throws; this patch
does not change that unrelated behavior. Nomia's five real DDEV query comparisons
remain reference evidence; each Site still runs its own real-query rollout gate.

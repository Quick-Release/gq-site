# CMS dependency patches

[Documentation](../README.md)

`@getquick/site` 0.18.2 ships the wpgraphql-blocks **2.2.0** warning fix
reviewed from [Nomia PR #3](https://github.com/Quick-Release/nomia-bnq/pull/3).
It guards missing array keys and optional properties and declares the Block
properties in their historical assignment order. Cleanup removes absent
optional properties before JSON serialization. DOM parsing captures libxml
diagnostics locally and restores the previous libxml mode. It does not change
PHP's error reporting or install a warning-silencing must-use plugin.

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
Check `patch --version` locally and on the Ploi host before adoption.
It stages copies, applies each hunk with zero fuzz, then verifies both complete
files against reviewed SHA-256 values and runs `php -l` using its own PHP.
Only then does it replace installed files, with an atomic rename per file.
An interruption between files or complete hunks is repaired on the next run.
An edit inside a hunk, unrelated source drift, a missing plugin/file or an
unsupported version fails clearly without committing staged changes. Reruns
verify hashes and syntax without rewriting already-correct installed files.
Concurrent dependency installations in the same CMS directory are unsupported.

The expected patched hashes are:

```text
plugin.php          7dee3f7934efa6a70c8c1666f36cb65dd0805ca0a8570ec03d577fb87edc0499
includes/utils.php  6c391ea3dbe2e0dc819f45fd267a61d7a3d4f60f3e0eed6d6086dd19cafd2624
```

They match Nomia PR #3. Retaining its reviewed patch bytes makes takeover of
an already-patched Nomia installation idempotent. The new runner fixes gaps
in its deployment coverage, staging, rerun linting and partial-hunk repair.

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

## Retire Nomia's extension without a rollout gap

Nomia's separate session belongs in `Quick-Release/nomia-bnq`, local clone
`/data/code/getquick/clients/apa/nomia-bnq`, in a new worktree.

Keep `deploy/ploi/admin.d/20-wpgraphql-blocks-quiet.sh` for the first adoption
release if desired: its expected hashes match the shared patch, so it will
skip safely after the shared runner. It remains a full-release fallback
until the shared path is verified. Then remove that deploy extension in a
follow-up Site release. The patch file itself is now **managed**: retain it
at the same path and remove/replace only its old site-owned README as needed.
Do not delete the managed patch as part of retiring the Nomia-specific copy.

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
sources, clean/rerun application, partial file/hunk repair, drift rejection,
real PHP syntax and Composer lifecycle execution. The response harness invokes
the actual registered `ContentNode.blocks` resolver and JSON scalar with
deterministic WordPress substitutes across all 32 Boolean argument combinations,
nested blocks, query loops, sparse attributes and template on/off. It compares
raw JSON bytes (including field presence/order) and WordPress query arguments,
and requires zero warnings after reproducing the pristine warning flood.
Deploy tests cover both paths and failure before activation/database updates.
CI provisions PHP 8.4, DOM and Composer for these checks.

This is not a full WordPress/GraphQL server test or an exhaustive repair of
every wpgraphql-blocks issue. In particular, pristine 2.2.0's `RootQuery.coreQuery`
calls `get_mapped_blocks` without its required argument and throws; this patch
does not change that unrelated behavior. Nomia's five real DDEV query comparisons
remain reference evidence; each Site still runs its own real-query rollout gate.

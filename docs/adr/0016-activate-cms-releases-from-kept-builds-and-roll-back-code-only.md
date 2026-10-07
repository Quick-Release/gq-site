# ADR 0016: Activate CMS releases from kept builds, and roll back code only

- Status: Accepted
- Date: 2026-10-07

## Context

The generated `deploy/ploi/admin.sh` updates the CMS in place. It downloads
the release archive, rsyncs it over `apps/cms` and runs `composer install` on
the server, which needs the private registry while it runs. It then
activates the release in maintenance mode. A failure can leave half a release
live, and there is no earlier release to go back to. Releases deploy CMS
first, then Frontend. When the Frontend fails, only a CI exit code says the
Site is mixed.

Ploi offers zero-downtime deployments and a rollback button, but its
zero-downtime mode needs a git repository attached to the site. Sites that
`gq ploi provision` sets up use custom deployments with no repository; Ekis's
Ploi site is still attached to its GitHub repository. The rollback has no API
endpoint, its script can't use the deploy variables, and what it reruns is
not documented.

## Decision

- **CI builds the complete CMS release**: `vendor/`, WordPress core, plugins
  and themes. The server unpacks it and never resolves or downloads a
  dependency during promotion, so it needs no Composer login. Language packs
  are installed into the new release before its switch.
- **The generated `admin.sh` owns the layout; Ploi's zero-downtime mode stays
  off.**
  - Within the Ploi site directory, the layout is `releases/<version>-<sha>/`,
    `shared/` (uploads; Ploi's site-root `.env` is linked in as
    `apps/cms/.env`) and a `current` symlink. `public` points at
    `current/apps/cms/web`.
  - A release is prepared and checked beside the live one, then `current` is
    switched atomically. `gq` provisioning sets nginx to `$realpath_root`, so
    PHP-FPM is not reloaded.
  - The live release and the two before it are kept on the server. Older
    ones are reached by deploying their tag again from its R2 archive.
- **Activation is one path.** After a switch, the release's own script
  activates `wordpress.plugins`, runs `wp core update-db`, applies the
  languages, runs the deploy extensions and flushes the rewrite rules. A
  health check then queries the Site's GraphQL endpoint through nginx. A code
  rollback runs exactly this activation for the kept release it switches to.
- **Rollback is code only.** No database is restored, because editors' work
  since a snapshot would be lost. So each release must work beside the one
  before it: its CMS with the previous Frontend, and the previous CMS code
  with its database. A release that can't is marked as not rollback-safe in
  its changelog, and rollback refuses it without `--force`.
- **`gq release rollback [<version>]` rolls back the Site**, in the reverse of
  deploy order: the Frontend first (a Workers rollback), then the CMS. It skips
  an app already at the target. `gq ploi rollback` is the CMS-only
  operator command.
- **A failure after the switch rolls the CMS back by itself.** If activation
  or the health check fails, the previous kept release is activated. If that
  fails too, the CMS stays in maintenance mode. A failure before the switch
  leaves the live release untouched.
- **Each release has a record** in the Site's R2 releases bucket: each app's
  status and the version live per app. A live CMS with a failed Frontend is
  a **partial release**, and CI fails with that status. `gq release status`
  reads the record; deploys and rollbacks write it.
- **Existing sites convert on their first deploy** with this script. A
  release whose script predates this layout can't be deployed. A site still
  attached to a git repository in Ploi, such as Ekis, moves to custom
  deployments first.

## Considered options

- **Ploi's zero-downtime mode, with a placeholder repository.** Rejected: its
  layout and retention are undocumented or fixed, and its rollback can't be
  called through the API. It would bypass both the release record and the
  activation path.
- **Building on the server from `composer.lock`.** Rejected: promotion would
  depend on the registry and the network. A kept release would also not be
  the exact build CI checked.
- **Restoring a database snapshot on rollback.** Rejected: it loses editors'
  and customers' writes. Restoring a database stays a separate, deliberate
  act.
- **Loading the deploy script from the current `gq` version instead of the
  release.** Rejected: it breaks the link between a release and the script
  generated for it.

## Consequences

- A plugin only the rolled-back release added stays active in the
  database. Its files are gone, so WordPress deactivates it.
- Deploy extensions already had to be idempotent, since they run on every
  deploy. They now also run on a rollback.
- The server needs room for three complete releases.
- Ploi's site file backup copies the whole site directory, so each backup
  holds every kept release, about three times today's size (Ekis keeps 14
  daily). How backups skip the releases that aren't live is settled before
  Ekis converts.

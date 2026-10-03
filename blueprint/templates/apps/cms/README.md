# {{Project}} CMS

A [Bedrock](https://roots.io/bedrock/) WordPress installation for managing
{{Project}}'s content. The Frontend reads it through
[WPGraphQL](https://www.wpgraphql.com/) at `/wp/graphql`; this host serves no
public WordPress frontend (`web/app/mu-plugins/content-api.php`).

## Stack

- Bedrock, with WordPress exact-pinned (`roots/wordpress`)
- The GETQUICK plugins and `getquick-theme`, from the private GETQUICK
  Composer registry
- [WPGraphQL](https://wp-packages.org/packages/wp-plugin/wp-graphql) and
  [WPGraphQL Blocks](https://wp-packages.org/packages/wp-plugin/wpgraphql-blocks),
  S3 Uploads (media on R2), Simple History, Cimo Image Optimizer and Safe SVG,
  from [WP Packages](https://wp-packages.org/)
- PHP 8.3+, MariaDB

Composer installs every plugin and theme, so none is committed. A plugin or
child theme of the site's own goes in `web/app/plugins` or `web/app/themes`,
unignored in `.gitignore`. Commit `composer.lock` once the first
`pnpm cms:composer` writes it, so deploys install exactly what you tested.

## Local setup

DDEV is the local runtime. From the repository root:

```sh
pnpm cms:composer   # install through the GETQUICK registry login in Sigillo
pnpm cms:dev        # start DDEV and write apps/cms/.env from .env.example
```

Install WordPress at `https://{{project}}-admin.ddev.site/wp/wp-admin/install.php`.
The GraphQL endpoint is `https://{{project}}-admin.ddev.site/wp/graphql`.
`.env.example` holds DDEV's database and local-only salts; never copy it to a
server.

## Deploys

`gq ploi provision` renders the server's `.env` from `.env.production.example`
(real database credentials and salts replace its placeholders) and
`gq ploi release` deploys a release with `deploy/ploi/admin.sh`. That script is
generated from `gq.ops.json`: it activates `wordpress.plugins`, installs and
activates the language `wordpress.locale` names (the admin can't install
one: production disallows file modifications), then runs the site's own
steps in `deploy/ploi/admin.d` (`10-theme.sh` activates
`getquick-theme`).

## Publication events

`web/app/mu-plugins/publication-events.php` tells the Frontend when a page or
post is published or updated, so it refreshes its public copy without a
deploy. It signs each event with `PUBLICATION_EVENT_SECRET` (in the server's
`.env`, from `pnpm ploi:events`) and sends it to `GETQUICK_FRONTEND_URL` at
the end of the request; publishing never waits on it or fails because of it.
Unpublishing, making private, password-protecting, trashing or deleting a
published entry sends a withdrawal, which makes the Frontend stop serving it
at once. Each entry records its last event and how it went (post meta
`_gq_publication_event`; for a deleted entry, the option
`gq_publication_events_deleted` until it is delivered). Without the key,
outside production, nothing is sent. On the server:

```sh
wp gq-events check            # the Frontend accepts this Site's events
wp gq-events status           # entries whose last event is pending or failed
wp gq-events retry <post-id>  # send an entry's event again
```

`web/app/mu-plugins/settings-events.php` does the same for the shared
settings, so a change reaches every page without republishing them: the menus
(a menu shown at a theme location, or the locations), the logo (`site_logo`),
the site's identity (`blogname`, `blogdescription`, `site_icon`) and the
design presets (the theme's global styles, or the active theme). It sends one
event per setting at the end of the request, with the publication events' key
and endpoint, and records each setting's last event and how it went (option
`gq_settings_event_<setting>`).

```sh
wp gq-events settings status           # each setting's last event
wp gq-events settings retry <setting>  # menus, logo, identity or design
```

`web/app/mu-plugins/delivery-retries.php` retries the events the Frontend
didn't confirm, entries' and settings' alike: after 1, 2, 5, 10 and 30
minutes, then hourly, up to 12 attempts. The server's cron runs it every
minute (`pnpm ploi:events` adds the Ploi crontab; WP-Cron isn't used).
Editors see delayed public delivery in the editor, the page and post lists
and on the Dashboard; Site Health has a "Public website delivery" test.

Each run then asks the Frontend to reconcile with WordPress, which catches a
change no event was recorded for (a hook that didn't fire, a change made
outside the editor). The Frontend compares what it serves with what WordPress
publishes and refreshes what differs. The outcome is kept in the option
`gq_reconciliation`, and Site Health warns when the Frontend hasn't matched
WordPress for ten minutes. The `gq_events_reconcile` filter turns it off.

```sh
wp gq-events retry-due  # send what is due, then reconcile (the cron runs it with --quiet)
wp gq-events reconcile  # reconcile now
wp gq-events delays     # what the Frontend hasn't confirmed, the cron's last run and the last reconciliation
```

## Checks

`pnpm cms:lint` (Pint) and `pnpm cms:test` (Pest) cover this site's own PHP.
Registry packages run their own checks in their repositories.

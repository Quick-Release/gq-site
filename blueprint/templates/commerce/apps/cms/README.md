# {{Project}} CMS

A [Bedrock](https://roots.io/bedrock/) WordPress installation running
{{Project}}'s shop: WooCommerce is its only commerce authority, and GQ
eCommerce gives the storefront (`apps/frontend`) its Store API, sign-in and
cart through the storefront's same-origin BFF. This host serves no public
WordPress frontend; WordPress permalinks point at the storefront.

## Stack

- Bedrock, with WordPress, plugins and themes exact-pinned in `composer.json`,
  except GQ Design, which accepts any stable release from the GETQUICK registry
- WooCommerce, from [WP Packages](https://wp-packages.org/)
- GQ eCommerce, the other GETQUICK plugins and `getquick-theme`, from the
  private GETQUICK Composer registry
- S3 Uploads (media on R2), Simple History, Cimo Image Optimizer and Safe SVG,
  from WP Packages
- PHP 8.4.1+, MariaDB

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
The Store API is at `https://{{project}}-admin.ddev.site/wp-json/wc/store/v1`.
`.env.example` holds DDEV's database and local-only salts; never copy it to a
server.

`pnpm db:sync` copies the live database into DDEV only, never the other way,
and replaces customers' and orders' personal data as it imports them.

## Deploys

`gq ploi provision` renders the server's `.env` from `.env.production.example`
(real database credentials and salts replace its placeholders) and
`gq ploi release` deploys a release with `deploy/ploi/admin.sh`. That script is
generated from `gq.ops.json`: it activates `wordpress.plugins`, runs
WooCommerce's database update, installs and activates the language
`wordpress.locale` names (the admin can't install one: production disallows
file modifications), then runs the site's own steps in `deploy/ploi/admin.d`
(`10-theme.sh` activates `getquick-theme`).

WooCommerce's database update only goes forward: a release that upgrades
WooCommerce to a new database version says in its changelog whether the
release before it still runs on the updated database. If it doesn't, it isn't
rollback-safe.

## Checks

`pnpm cms:lint` (Pint) and `pnpm cms:test` (Pest) cover this site's own PHP.
Registry packages run their own checks in their repositories.

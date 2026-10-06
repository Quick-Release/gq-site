# Generate and sync a site

[Documentation](../README.md)

`gq new` creates a site from the blueprint; `gq sync` keeps it in step with
the installed `gq` ([ADR 0002](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0002-generate-sites-from-a-versioned-manifest.md)):

```sh
gq new acme --project acme --variant content   # a complete content site, gq.lock.json, git init
gq new acme --project acme --variant content --locale pt_PT_ao90   # …whose main language is Portuguese (AO90)
gq sync           # migrate gq.ops.json, regenerate managed files, update gq.lock.json
gq sync --check   # report every pending change, exit 1, write nothing
gq sync --recreate README.md   # write a create-once file again
```

`gq new` writes everything a content site needs to pass `pnpm verify`
without network access or secrets: a v1 `gq.ops.json` whose
`wordpress.plugins` are the CMS skeleton's, the managed files below, and
the create-once scaffolding, the CMS and Frontend skeletons among it. In a
terminal it asks for the directory, project or variant its arguments lack;
elsewhere it names them and stops. It asks for the site's main language too
(`--locale`, a WordPress locale), and writes `en_US` without one outside a
terminal. The project must be lowercase letters,
digits and hyphens starting with a letter, since it names the site's
packages, Workers and DDEV project. `--variant commerce` is refused, and so
is a target directory that isn't empty. It then prints the
provisioning sequence (fill in `gq.ops.json`, `gq sync`, `ploi provision`,
`cloudflare deploy-token`/`releases`/`media`/`ci`, `ploi media`,
`github setup`, `frontend secrets`, `ci deploy`, `ploi events`, the releases,
`frontend refresh` to prepare the Site, prove media with an upload, and
`site check`, the readiness gate) and runs none of it; see
[A new content Site, end to end](provisioning.md#a-new-content-site-end-to-end).

## Managed-file ownership

[`blueprint/ownership.json`](../../blueprint/ownership.json), published with the
package, lists every path the blueprint touches by category: fully
generated, generated section, managed keys, and create-once. Anything it
doesn't list is site-owned, and `gq sync` never reads or writes it. Only
`--variant content` is generated.

The fully generated files are the toolchain pins (`.mise.toml`, `.nvmrc`), the Git hooks
(`.vite-hooks/pre-commit` formats and lints staged files, `pre-push` runs
`pnpm verify`), the staged lint/format config (`vite.config.ts`), the
READMEs of `docs/adr`, `docs/plans`, `docs/research` and `docs/agents`, the
agent reference docs in `docs/agents`, and the `.claude/skills` symlink to
`../.agents/skills`. A site's own ADRs, plans and research beside those
READMEs are site-owned. The site's deploy wiring is fully generated too:
the Cloudflare CI Worker (`infra/ci`: its Wrangler config, CI and mirror
Workflows, webhook, release check and sandbox image), the Frontend deploy
configuration and script (`infra/frontend.run.ts`,
`infra/scripts/deploy-frontend.mjs`, `infra/package.json`), the CI release
step (`scripts/ci-release.mjs`) and the tests of the CI Worker and release
step (`scripts/ci.test.mjs`), and the CMS deploy script Ploi runs
(`deploy/ploi/admin.sh`, with `deploy/ploi/polylang.sh` for a bilingual
site's languages).

## Generated deploy wiring

The deploy wiring is rendered from `gq.ops.json`: the Worker, its Workflows
and its vars from `ci.worker`, `ci.backupBucket`, `artifacts`,
`cloudflare.accountId` and `github.repository`; package, Frontend Worker
and Alchemy names from `project`; the sandbox image's pnpm from the
blueprint's `packageManager` pin, and the infra package's Node engine
from its `engines.node` pin. A value `gq.ops.json` doesn't have yet is
written as a placeholder naming its key (`"<ci.worker>"`), so a new site can
be generated before it is provisioned; fill the value in and `gq sync`
rewrites the files. The Frontend deploy reads `domains` and
`cloudflare.accountId` from `gq.ops.json` when it runs. When the Frontend
skeleton includes `apps/frontend/migrations`, the deploy also declares and
migrates the retained D1 publication store bound as `PUBLICATION_DB`; a
site-owned Frontend without migrations deploys without a store.

The CMS deploy script activates the plugins `wordpress.plugins` lists, in
order (each must be installed by Composer; a name must be a plugin slug),
and prints the `<PROJECT>_DEPLOY_STATUS` line named after `project`. To add
a plugin, list it in `gq.ops.json` and run `gq sync`. Any other site step
goes in a deploy extension: each `deploy/ploi/admin.d/*.sh` runs with `bash`
from `apps/cms` after the plugins are activated and the database is updated,
in lexical (byte) order of file name, with `SITE_PATH` and `APP_PATH` set. One that exits non-zero
fails the deploy with its exit code (maintenance mode is still turned off).
Extensions run only once WordPress is installed, and not on a Composer-only
deploy. `deploy/ploi/admin.d` is the site's, created once with a README.

### The CMS GraphQL endpoint

Production defaults to `https://<domains.admin>/wp/graphql`. A Site whose CMS
serves the canonical `/graphql` endpoint sets this public manifest value
(alongside its existing plugins and locale):

```json
"wordpress": {
  "plugins": ["wp-graphql"],
  "graphqlPath": "/graphql"
}
```

Only `/graphql` and `/wp/graphql` are accepted, with no whitespace, query,
trailing slash or full URL. `gq site check` uses that exact production endpoint;
there is no fallback or redirect following. This does not configure WordPress,
origin-plugin routes, DNS or Access policies: they must already match.

The generated deploy script and `infra/frontend.run.ts` derive
`PUBLIC_WORDPRESS_GRAPHQL_URL` from `domains.admin` and `wordpress.graphqlPath`.
An explicit process `PUBLIC_WORDPRESS_GRAPHQL_URL` still takes precedence:
remove or align an old `/wp/graphql` override when adopting `/graphql`.
On the pinned Alchemy / frontend-frameworks `2.0.0-beta.79`, a string in
`Website.env` is passed into Astro's build child's `process.env`, overriding
its local `.env`; the production public URL is declared there, with or without
a publication store. This is not a secret binding. Direct production Alchemy
plans/deploys use the same manifest default as the deploy script.

Local development is separate: the Frontend's DDEV env template, local CMS
readiness and the database post-import check keep `/wp/graphql`, regardless of
this production setting. Production Access credentials are not sent to a
different local origin. Do not copy production secrets into local `.env` files.

**Existing Site adoption:** update to a Blueprint release containing this
setting, edit `gq.ops.json`, inspect `gq sync --check`, then run `gq sync` to
regenerate managed infra and its lock. Resolve managed-file conflicts through
sync; do not hand-edit the Site's managed outputs. The Frontend source is
Site-owned: separately adopt the server-only Access reads described in
[CMS Access](cms-access.md), if needed. Review any explicit public URL override
before the next authorized deploy and readiness gate.

For Cooldown Gaming, the required manifest addition is
`wordpress.graphqlPath: "/graphql"` on `cms.cooldowngaming.com`, matching its
existing Access child and origin plugin. Its current manifest omits the key;
without this adoption the default remains `/wp/graphql`. This guide does not
perform adoption, deployment or live checks; leave DNS, origin and Access
unchanged for the operator's live gate.

### The site's language

`wordpress.locale` in `gq.ops.json` is the site's main language, as the
WordPress locale WordPress.org names its language packs by: `en_US`,
`pt_PT`, `pt_PT_ao90` (Portuguese, 1990 spelling agreement), `de_DE_formal`.
`gq new --locale` sets it; to change it later, edit it and run `gq sync`,
then release.

- **The CMS.** On each deploy, after the database update and before the
  extensions, the deploy script installs the locale's core language pack
  when it is missing and makes it the site's language (`WPLANG`), then
  installs and updates the translations WordPress.org has for the installed
  plugins and themes. Production disallows file modifications, so the
  WordPress admin can't install a language; the deploy can. A core pack that
  can't be installed fails the deploy; a plugin or theme without a
  translation (the GETQUICK plugins have none) only warns. `en_US` ships
  with WordPress, so for it the deploy only sets the language. The language
  packs in `apps/cms/web/app/languages` belong to the server: a deploy keeps
  them, and `.gitignore` leaves them out. Without `wordpress.locale` the
  deploy leaves the site's language as it is.
- **The Frontend.** `<html lang>` is the locale's language and region
  (`pt_PT_ao90` → `pt-PT`), read from `gq.ops.json` when the Frontend is
  built (`apps/frontend/src/lib/site-language.ts`), so it follows the next
  release.
- **Locally.** `gq db sync` installs the locale's language packs in DDEV
  after the import, so the local admin is in the site's language too.

### More languages

A bilingual site lists its other languages in `wordpress.languages`, each
with the URL directory (`slug`) its pages live under. `wordpress.locale`
stays the default language, without a directory:

```json
"wordpress": {
  "plugins": ["…", "polylang-pro", "gq-polylang-graphql"],
  "locale": "pt_PT_ao90",
  "languages": [{ "locale": "en_US", "slug": "en" }]
}
```

Portuguese pages are then at `/sobre/`, and English ones at `/en/about/`.
`gq new` makes a monolingual site; to add a language, edit `gq.ops.json`,
run `gq sync` (it updates `deploy/ploi/admin.sh`), and release.

- **What `gq sync` refuses.** A locale that isn't a WordPress locale, a slug
  that isn't a lowercase URL segment (`en`, `pt-br`), `languages` without
  `locale`, and a locale or slug listed twice. The default language's slug
  is its language code (`pt` for `pt_PT_ao90`), so no other language may
  use it.
- **The plugins.** A bilingual site needs Polylang, and
  [GQ Polylang for WPGraphQL](https://github.com/Quick-Release/gq-polylang-graphql)
  for the Frontend to read each language through GraphQL. Require both in
  `apps/cms`, from the GETQUICK registry (its existing login), and list
  them in `wordpress.plugins` so the deploy activates them; `gq sync`
  refuses `languages` until both are listed:

  ```sh
  cd apps/cms
  composer require getquick/polylang-pro getquick/gq-polylang-graphql
  ```

  Polylang Pro is the plugin GETQUICK licenses. The free plugin
  (`composer require wp-plugin/polylang`, listed as `polylang`) works too.

- **The deploy.** After it sets the site's language and before the
  extensions, the deploy script installs each language's core language
  pack, then runs `deploy/ploi/polylang.sh` with WP-CLI to make Polylang's
  languages match `gq.ops.json`. It creates each missing language, the
  default first, and updates one whose locale or order changed. It makes
  `wordpress.locale` Polylang's default language, and sets the URL mode:
  the language as a directory, the default language's hidden. Then it gives
  every post and term without a language the default one, so content
  written before the site had languages is in the default language. Running
  it again changes nothing.
- **Removing a language.** The deploy never deletes a language. One
  Polylang has that `gq.ops.json` doesn't list stops the deploy, named,
  before anything changes: move or delete its content and delete the
  language in WordPress (Languages), then deploy again. That includes a
  default language set up by hand under another slug than its language
  code (`pt-pt` rather than `pt`). Without `languages` at all, the deploy
  leaves Polylang alone.
- **The Frontend.** Each language is served from its own rows in the
  publication store (`home:en`, `chrome:en`), with its own `<html lang>`,
  menu, title and tagline, `hreflang` alternates and a language switcher. A
  page without a translation in a language is a 404 there: there is no
  fallback across languages. See the Frontend's README, "Languages". The
  Frontend is site-owned, so an existing site adopts this from a new site's
  skeleton (see the changelog).
- **Keeping each language current.** The CMS's events name the language a
  change is in, so publishing an English page refreshes only its `/en/`
  entry, and changing English's menu or tagline only English's rows.
  Reconciliation reads every language's front page and chrome, and catches
  up fewer entries per run as languages are added. `gq frontend refresh`
  lists each language, and `gq site check` is ready only when every
  language exists in Polylang and its front page, chrome and homepage are
  served
  ([ADR 0013](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0013-serve-each-language-from-its-own-shared-rows.md)).
  The CMS's event plugins are site-owned too: adopt
  `publication-events.php`, `settings-events.php` and
  `delivery-retries.php` from a new site's skeleton.
- **Shared slugs.** Polylang Pro's "Share slugs" module has no setting: it
  turns on by itself with language directories, so an editor can give a
  translation its original's slug. Keep translated slugs unique per
  language (`/sobre/`, `/en/about/`).

## Shared and create-once files

A site shares four more kinds of file with the blueprint:

- **Generated sections.** `AGENTS.md` holds the blueprint's base guidance
  and `.gitignore` its ignore rules, each between a `BEGIN gq` line and an
  `END gq` line. `gq sync` rewrites only what is between them; the site's
  guidance and rules go outside, before or after. A file without the
  section gets it appended; markers it can't pair (one missing, or two
  sections) stop sync with an error.
- **Managed keys.** In the root `package.json`, `gq` sets the
  `packageManager` and `engines.node` pins, the hook install (`prepare`),
  the root scripts that wrap `gq` (`verify`, `cms:*`, `ploi:*`,
  `release*` and the rest), and the ones that run the deploy wiring
  (`deploy:frontend`, `deploy:frontend:raw`, `plan:frontend`,
  `infra:check`, `ci:check`, `test:scripts`, `media:check*` and
  `frontend:refresh`). Every other key, including
  the site's own scripts and its dependencies, is the site's: `gq` edits
  the file as text, so those keys stay byte for byte. A managed key the site removed is added
  back after its siblings, in the file's indentation. One the blueprint
  retires is removed, unless the site changed it, in which case it is the
  site's.
- **Create-once files.** `gq.ops.json`, the glossary (`GLOSSARY.md`),
  `README.md`, `VERSION`, the workspace config (`pnpm-workspace.yaml`), the
  deploy extension directory's README (`deploy/ploi/admin.d/README.md`) and
  the app skeletons are written when absent, and recorded in the lock as
  created once they exist, whoever wrote them. From then on they are the
  site's: `gq sync` never rewrites them, nor restores one the site deleted,
  unless `gq sync --recreate <path>` asks for it (repeat it for several
  files; `gq.ops.json` can't be recreated). A missing root `package.json`
  is created holding the site's own starting keys (Frontend scripts,
  `@getquick/site` pinned to the installed version, Sigillo, Vite+) before
  the managed ones.
- **App skeletons.** The CMS (`apps/cms`: Bedrock with the GETQUICK
  plugins and `getquick-theme` from the registry, the content API
  mu-plugin, DDEV config, Pint and Pest, and its env templates) and the
  Frontend (`apps/frontend`: Astro on WPGraphQL with its own copy of the
  block renderer, rendered-route tests, a durable homepage backed by a D1
  publication store, and its env template). Neither carries a site's own
  plugins, child theme or pages. The env templates hold public configuration
  and placeholders only (`gq ploi provision` renders the server's `.env` from
  `.env.production.example`).
  The CMS skeleton requires `getquick/gq-config ^0.4.0` and
  `getquick/getquick-theme ^0.5.1`. The config package is a must-use plugin,
  not an entry in `wordpress.plugins`; its load check uses
  `GETQUICK_CONFIG_VERSION`. A CMS app is site-owned, so `gq sync` doesn't
  change its Composer requirements: a site whose CMS requires
  `getquick/getquick-config` replaces it with `getquick/gq-config ^0.4.0`,
  raises the theme requirement to `^0.5.1`, and updates and commits
  `composer.lock` alongside `composer.json`.
  `deploy/ploi/admin.d/10-theme.sh`, which activates `getquick-theme`,
  belongs to the CMS skeleton. A skeleton's files are written only with
  their app: while its directory is missing, so `gq sync` never adds files
  to an app the site already has.

## Locks and conflicts

`gq.lock.json`, committed at the site root, records the `gq` version, the
schema version, a hash of each managed file (a symlink's target), section
and key as `gq` last wrote it, and the create-once files it has created. A
managed file, section or key whose hash differs from the lock (or that
differs from the template when the site has no lock yet), a retargeted
symlink, or a directory where either belongs is a local edit: `gq sync`
prints a diff against what it would write and writes nothing, not even a
pending migration. A managed file that lost its executable bit (a hook) is
not an edit: `gq sync` makes it executable again. Revert the edit, or delete
the file (the section, or the key) and `gq sync` regenerates it.
A lock written by a newer `gq` is refused rather than downgraded. Neither
command needs network access or secrets.

## Next steps

See the [manifest reference](../reference/manifest.md) for site settings,
[local development](local-development.md) for setup and checks, and
[provisioning](provisioning.md) for Ploi, Cloudflare and CI.

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
packages, Workers and DDEV project. `--variant commerce` is refused until
phase 4, and so is a target directory that isn't empty. It then prints the
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
`--variant content` is generated until phase 4.

The fully generated files are extracted from Lombardi. They are the
toolchain pins (`.mise.toml`, `.nvmrc`), the Git hooks
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
(`deploy/ploi/admin.sh`).

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
migrates the retained D1 publication store bound as `PUBLICATION_DB`; existing
site-owned Frontends without migrations deploy as before.

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
  Frontend (`apps/frontend`: Astro on WPGraphQL with its own copy of
  Lombardi's block renderer, rendered-route tests, a durable homepage backed
  by a D1 publication store, and its env template) are extracted from Lombardi
  without Lombardi's plugins, child theme and pages. The env templates hold
  public configuration and placeholders only
  (`gq ploi provision` renders the server's `.env` from
  `.env.production.example`).
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

# Changelog

All notable changes to `@getquick/site` are recorded here. Versions follow
[Semantic Versioning](https://semver.org/); each release is tagged `v<version>`.

## 0.17.5 — 2026-10-04

### Changed

- **New CMS skeletons install `getquick/gq-config ^0.4.0`**, replacing
  `getquick/getquick-config ^0.3.4`, and require
  `getquick/getquick-theme ^0.5.1`, which depends on the renamed package.
  The must-use plugin load check still uses `GETQUICK_CONFIG_VERSION`;
  existing API identifiers remain unchanged.
  - **Existing sites:** the CMS is site-owned, so `gq sync` does not migrate
    its Composer requirements. Remove `getquick/getquick-config`, require
    `getquick/gq-config ^0.4.0` and `getquick/getquick-theme ^0.5.1`, then
    update and commit the site's `composer.lock` together with `composer.json`.
    Verify the must-use plugin loads and the site's existing API routes work
    before deploying. No consumer migration is performed by this release.

## 0.17.4 — 2026-10-04

### Changed

- **`docs/agents/issue-tracker.md` spells out every `/wayfinder` operation**,
  not just its map issue: child tickets as sub-issues of the map, blocking
  through GitHub's native issue dependencies, the frontier query, claiming
  and resolving a ticket. It matches the `setup-matt-pocock-skills`
  GitHub template, so `/wayfinder` no longer guesses how tickets link and
  block. Existing sites pick it up with `gq sync`.

## 0.17.3 — 2026-10-04

### Added

- **`gq offboard` supports Artifacts-only Sites** (no `github.repository`),
  which needed GitHub before
  ([ADR 0011](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0011-offboard-a-site-by-cutting-access-before-archiving.md)).
  Such a Site needs `artifacts.namespace` and `artifacts.repo` instead, and
  gq calls no `gh` for it.
  - The cut disables the `GETQUICK <PROJECT> Artifacts` token right after the
    backup, then revokes the repository's active git tokens, so nobody can
    push and start CI. `--restore` re-enables the token.
  - `--archive` adds `code.bundle` to the Site Archive, a git bundle of every
    ref of the Artifacts repository, with its refs in `manifest.json`. The
    verification reads the repository's refs again, so a push since the
    bundle stops the run before anything is deleted. The repository is then
    deleted, and there is no webhook to delete or record to push.

- **Artifacts namespaces are created in the EU by default**,
  `artifacts.jurisdiction` in `gq.ops.json`: `"eu"` (the default when it's
  left out), `"us"` or `"unrestricted"` (the opt-out). Cloudflare can't
  change a namespace's jurisdiction after it is created
  ([ADR 0014](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0014-keep-a-sites-code-in-the-eu-unless-it-opts-out.md)).
  - `gq cloudflare ci` creates a missing namespace there. An existing one
    elsewhere stops it, naming the namespace, both jurisdictions and the
    ways out: set `artifacts.jurisdiction` to match, or delete the
    namespace, run `gq cloudflare ci` again and push the code again. With
    its Artifacts token already stored, it checks before changing anything,
    `--dry-run` included; otherwise once the token exists, still before the
    repository.
  - `gq doctor` fails on the same mismatch. It reads the namespace with
    `ARTIFACTS_API_TOKEN` from the environment or Sigillo `staging`, and
    says when it has neither.

### Changed

- **Existing sites:** one without `artifacts.jurisdiction` whose Artifacts
  namespace is unrestricted (every namespace `gq cloudflare ci` created
  before this release) now stops `gq cloudflare ci` and fails `gq doctor`.
  No `gq sync` migration sets it for them (ADR 0014): set
  `"jurisdiction": "unrestricted"` to keep it, or recreate it in the EU
  (see [Cloudflare provisioning and CI](https://github.com/Quick-Release/gq-site/blob/main/docs/guides/provisioning.md#cloudflare-provisioning-and-ci)).

### Fixed

- **Empty Artifacts-only code archives report no bundle.** The archive summary
  no longer points to a nonexistent `code.bundle` when the repository has no
  refs. Resumed archives read the saved manifest to report the actual archived
  files, even after the Artifacts repository has been deleted.

## 0.17.2 — 2026-10-04

### Fixed

- **A bilingual Site's Frontend tests pass.** Two bugs in the Frontend
  skeleton's tests, which 0.17.1's checks missed because the generated site
  they test is named Acme and monolingual:
  - `src/languages.test.ts` expected every page's `<title>` to end in
    "— Acme", the stub CMS's name, where the page renders the site's own
    name. It failed 4 tests on any site not named Acme.
  - The monolingual suites (`entries`, `events`, `homepage`,
    `reconciliation`, `retries`, `routes`, `settings`, `withdrawals` and
    `lib/wordpress`) read the site's real `gq.ops.json`, so they failed
    (about 190 tests) once it listed `wordpress.languages`. Each now
    mocks it without `languages`, the Site it describes;
    `languages.test.ts` and `language-updates.test.ts` cover the bilingual
    one.
  - `scripts/smoke/frontend-check.sh` (CI's `generated-frontend`) now
    generates a site not named Acme, and runs its tests and `astro check`
    again after listing English in `wordpress.languages`.
  - **Existing sites:** the Frontend is site-owned, so syncing doesn't
    change it. A bilingual site copies these tests from a new site's
    `apps/frontend/src`, or in a copy it already adapted, replaces the
    `— Acme</title>` assertions with its own name and adds the
    `gq.ops.json` mock to each monolingual suite. A monolingual site needs
    neither.

## 0.17.1 — 2026-10-04

### Added

- **Bilingual content Sites**, `wordpress.languages` in `gq.ops.json`: the
  languages beside `wordpress.locale` (the default), each a `locale` and the
  `slug` of its URL directory (`{ "locale": "en_US", "slug": "en" }` for
  `/en/`). See
  [More languages](https://github.com/Quick-Release/gq-site/blob/main/docs/guides/sites.md#more-languages).
  - `gq sync` refuses an invalid or repeated locale or slug, a slug that is
    the default language's (its language code), `languages` without
    `locale`, and `languages` without Polylang (`polylang-pro` or
    `polylang`) and `gq-polylang-graphql` in `wordpress.plugins`.
  - The CMS deploy script installs each language's core language pack, then
    runs the new generated `deploy/ploi/polylang.sh`, which makes Polylang's
    languages match with WP-CLI: it creates or updates each language, sets
    the default and the URL mode (a directory per language, the default's
    hidden), and gives content without a language the default one. It
    never deletes a language: one `gq.ops.json` no longer lists stops the
    deploy, named, before anything changes. A site without `languages`
    deploys as before.
  - `scripts/smoke/cms-polylang.sh` proves it on a real WordPress with
    Polylang and GQ Polylang for WPGraphQL.
  - **Existing sites:** `gq sync` adds `deploy/ploi/polylang.sh`, whether
    or not the site lists `languages`.
- **A new Frontend serves each language from its own rows** (the Frontend
  skeleton). See the Frontend's README, "Languages".
  - A route's language is its first segment when that is another language's
    slug, and the default language otherwise. `/en/` is English's home.
  - The store keeps `home` and `chrome` for the default language and adds
    `home:<slug>` and `chrome:<slug>` for each other one; `design` stays
    shared. Entries are stored with their language and translations. No
    migration: the rows are new keys, and the new body fields are optional.
  - A whole-Site refresh reads each language's front page (`nodeByUri`),
    title and tagline (`language(code:)`) and menu
    (`menuItems(where: { location, language })`). The report lists the other
    languages under `languages`.
  - Each page has its language's `<html lang>`, chrome and home link,
    `hreflang` alternates to its published translations plus `x-default`,
    and a language switcher. The 404, "Temporarily unavailable" and
    placeholder pages are in the page's language (English and Portuguese,
    `src/lib/copy.ts`); a monolingual Site keeps them in English.
  - No fallback: a route without an entry in its language is a 404, and so
    is every page of a language whose home was never stored. A front page
    reached at another route moves to its language's home (`/en/home/` →
    `/en/`), and withdrawing a language's front page withdraws its home.
  - A monolingual Site renders, stores and reads the CMS as before.
  - `frontend-runtime.sh` adds a bilingual variant
    (`scripts/smoke/frontend-languages.mjs`) that serves `/en/` from the
    store through an outage and a restart.
  - **Existing sites:** the Frontend is site-owned, so syncing doesn't
    change it. A site going bilingual copies from a new site's
    `apps/frontend`: `src/lib/site-language.ts`, `copy.ts`, `delivery.ts`,
    `publications.ts`, `wordpress.ts` and `reconciliation.ts`,
    `src/components/Home.astro`, `src/layouts/Layout.astro`, both pages in
    `src/pages`, and `src/languages.test.ts`.
- **Every language kept current and checked**
  ([ADR 0013](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0013-serve-each-language-from-its-own-shared-rows.md),
  which amends ADRs 0003, 0004, 0005, 0007, 0009 and 0010).
  - **Publication events** (the CMS skeleton's `publication-events.php`) name
    the entry's `language`, and its `uri` is in that language's directory.
    A language's front page sends its home (`/en/`), not `/`. The Frontend
    refreshes that language's home for a home URI, and the entry otherwise;
    it refuses an entry whose language isn't its URI's.
  - **Settings events** (`settings-events.php`) name the language a change
    is in: English's menu locations (Polylang's `nav_menus`) or a menu
    assigned in English refresh only `chrome:en`, and English's string
    translations (its title and tagline) only `home:en`. The logo, the icon,
    the design and the site's own title and tagline name no language and
    refresh every language's rows. Each language's settings are recorded
    and retried apart (`menus:en`, `identity:en` in
    `wp gq-events settings`).
  - **Refresh.** A whole-Site refresh is `ready` only once every language's
    front page and chrome are stored, and `gq frontend refresh` lists each
    language. A targeted refresh refuses `/en/` as it refuses `/`.
  - **Reconciliation** reads the design and each language's front page and
    chrome (1 + 2 per language of its 40 requests), so it catches up fewer
    entries per run on a bilingual Site, and lists every language's entries
    (`language: ALL`).
  - **`gq site check`** asks the CMS for its languages and requires each
    `gq.ops.json` declares, validates each language's front page, title and
    menu, requires every language's front page and chrome in the store
    (naming one that is missing) and every language's front page published,
    and fetches `/` and each `/<slug>/` (`homepage-<slug>`). The signed check reports the other languages' rows
    as `store.languages`.
  - A monolingual Site's events, refresh, reconciliation and readiness are
    unchanged.
  - `scripts/smoke/cms-polylang.sh` proves the CMS's events per language on
    a real WordPress with Polylang.
  - **Existing sites:** a site going bilingual also copies, from a new
    site, `apps/frontend/src/lib/events.ts` and
    `src/pages/gq/refresh.ts`, `src/language-updates.test.ts`, and the CMS's
    `web/app/mu-plugins/publication-events.php`, `settings-events.php` and
    `delivery-retries.php`. A monolingual site needs none of them.

### Fixed

- `gq cms start` names DDEV's own local URL on a slow machine. It waited only
  a second for `ddev describe`, which asks Docker, and otherwise fell back to
  `.env.example`'s URL; it now looks it up beside launching the startup, so
  waiting up to five seconds never delays startup. This was also the
  intermittent failure in `test/cms/ddev.test.mjs` under a loaded test run.

## 0.17.0 — 2026-10-03

### Added

- **The site's main language**, `wordpress.locale` in `gq.ops.json`: a
  WordPress locale such as `pt_PT_ao90`. See
  [The site's language](https://github.com/Quick-Release/gq-site/blob/main/docs/guides/sites.md#the-sites-language).
  - `gq new` takes `--locale` and asks for it in a terminal. Without the
    flag outside a terminal, the site gets `en_US`.
  - The CMS deploy script installs the locale's core language pack when it
    is missing and makes it the site's language. It then installs and
    updates the plugin and theme translations WordPress.org has for it. A
    missing core pack fails the deploy; a missing plugin or theme
    translation only warns. Without `wordpress.locale`, the deploy leaves
    the language alone, as before.
  - The deploy no longer deletes `apps/cms/web/app/languages`, and the
    generated `.gitignore` section ignores it.
  - A new Frontend's `<html lang>` follows `wordpress.locale`
    (`pt_PT_ao90` → `pt-PT`), through `src/lib/site-language.ts`.
  - `gq db sync` installs the locale's language packs in DDEV.
  - **Existing sites:** add `wordpress.locale` to `gq.ops.json`, run
    `gq sync` (it updates `deploy/ploi/admin.sh` and `.gitignore`) and
    release. The Frontend is site-owned, so syncing doesn't change it: copy
    `src/lib/site-language.ts` (and its test) from a new site, and in
    `src/layouts/Layout.astro` import `siteLang` from it and write
    `<html lang={siteLang}>`.

## 0.16.2 — 2026-10-03

### Fixed

- A new site's first commit no longer edits the managed `scripts/ci.test.mjs`.
  0.16.0 gave its push-event test a shorter repository, and the pre-commit
  hook's formatter joined a line the template had wrapped, so `gq sync` then
  reported the file as a local edit. The template now has the line as the
  formatter writes it.
  - **Existing sites:** if `gq sync` reports `scripts/ci.test.mjs` as edited
    for this reason, delete it and run `gq sync`.

## 0.16.1 — 2026-10-03

### Fixed

- A new content site's Frontend tests pass whatever its project is called.
  `src/routes.test.ts`, `src/entries.test.ts` and `src/settings.test.ts`
  expected page titles ending in "— Acme". The layout ends them with the
  project's name, so any project but `acme` failed 14 tests. They now expect
  `{{Project}}`.
  - **Existing sites:** the Frontend is site-owned, so syncing doesn't change
    it. In those three files, replace "— Acme</title>" with your project's
    name.

## 0.16.0 — 2026-10-03

### Added

- **Artifacts-only Sites** ([ADR 0012](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0012-keep-a-sites-code-in-artifacts-when-it-has-no-github-repository.md)).
  A Site whose `gq.ops.json` names no `github.repository` keeps its code in
  its Cloudflare Artifacts repository, and pushes there start CI without
  GitHub.
  - `gq git artifacts setup` adds the Artifacts repository as `origin` when
    there is none. It exits 1 when `origin` points elsewhere, and says how to
    fix it. Its credential helper mints one-hour write tokens for such a
    Site, so `git push` and `pnpm push` work.
  - `gq ci deploy` no longer requires `GITHUB_CI_TOKEN` and
    `GITHUB_WEBHOOK_SECRET` for such a Site. `gq github setup` says there is
    nothing to connect and exits 0.
  - The generated CI Worker skips GitHub commit statuses, and answers
    `/github/webhook` with a 404, when its `GITHUB_REPOSITORY` is empty.
    `gq sync` now renders an absent `github.repository` as empty, not as the
    `<github.repository>` placeholder.
  - `gq doctor` checks that such a Site's `origin` pushes to Artifacts
    through gq's credential helper. `gq new` prints the Artifacts-only step.
  - `gq offboard` still needs `github.repository`.
  - **Existing sites:** sites on GitHub are unchanged. `gq sync` updates the
    CI Worker files and `scripts/ci.test.mjs` (its push-event test now uses a
    fixed repository); redeploy with `pnpm ci:deploy`.

## 0.15.2 — 2026-10-03

### Fixed

- A new content site's Frontend serves its entries on a CMS whose permalinks
  point at the Frontend, as a GETQUICK CMS's do. WPGraphQL then gives every
  entry's `uri` as an absolute URL (`https://acme.example/team/`; only the
  front page is `/`), and the Frontend took it for a path: every entry looked
  moved to `/https://acme.example/team//`, and the list of published routes
  named routes that don't exist. `src/lib/wordpress.ts` now reduces each URI
  WordPress gives to its path (`uriPath`), keeping its percent-encoding and
  trailing slash, so refreshes, events, withdrawals and reconciliation see
  the routes visitors use.
  - **Existing sites:** the Frontend is site-owned, so syncing doesn't change
    it. To adopt, copy `uriPath` and its two uses (in `normalizePost` and
    `getPublishedEntries`) from a newly generated site's
    `src/lib/wordpress.ts`, keeping the site's own changes, then run
    `gq frontend refresh`. Without it, a CMS with absolute URIs has every
    entry stored as moved.
- `gq frontend refresh` reports every record the Frontend's refresh returns,
  not only the front page, chrome and design presets: a record a Site adds to
  its own refresh, such as its design patterns, is listed by its name with
  its outcome, and a kept one says why.
- `scripts/smoke/frontend-check.sh`, `frontend-runtime.sh` and
  `cms-events.sh` install `@getquick/site` from this checkout, packed with
  `pnpm pack` and set as a `pnpm-workspace.yaml` override, rather than from
  npm. CI no longer fails on a release push until npm serves the new
  version. The generated site's `package.json` is unchanged, and generation
  stays offline.
- `gq offboard --archive` now records the Site as archived in `gq.ops.json`
  before it archives the GitHub repository, and commits and pushes that
  record itself first. Until now the record was written after
  `gh repo archive`, and the read-only repository refused the push. gq
  pushes only from the default branch, with nothing else changed in the
  checkout, to the repository being archived, and as a fast-forward.
  Otherwise the plan says why, and the repository stays unarchived until
  you push `gq.ops.json` and run `gq offboard --archive` again. That rerun
  needs neither Cloudflare nor Ploi.
- `gq offboard --archive` no longer stops with
  `Ploi DELETE /system-users/<id> failed with 422` after deleting the Ploi
  site. Ploi deletes a site in the background and refuses to delete its
  system user meanwhile. gq now waits until Ploi no longer shows the site,
  and retries a refused system-user deletion: 2 s, doubling up to 10 s, for
  5 minutes at most each. Past that the run stops with Ploi's reasons.
- Ploi errors now show a refused request's validation `errors` (field by
  field, redacted), not only "The given data was invalid.". This covers both
  gq's Ploi clients, `gq ploi api` included.

## 0.15.1 — 2026-10-03

### Fixed

- `gq offboard --archive` no longer stops with
  `R2 listing <bucket> failed with 401` on the bucket keys it mints for the
  run. R2 rejects a new token's key for a while, so each key's requests are
  retried on 401 or 403 until R2 first accepts it: 2 s, doubling up to 10 s,
  for 90 s in all. After that a 401 or 403 fails at once. A key R2 still
  rejects after 90 s fails with an error that says the key was minted just
  now and how long gq waited. A presigned URL (the database dump Ploi's
  server uploads) is handed out only once R2 accepts its key.
- `gq cms stop` on macOS no longer fails with `kill EPERM` when the background
  DDEV startup's processes have exited but are not yet reaped. macOS answers
  EPERM to a signal sent to a process group whose members are all zombies or
  part-way through exit. gq now takes that group as exited, and still reports
  EPERM for a group that belongs to another user. `gq cms status` and
  `gq cms start` also no longer take such a startup for one still running.

## 0.15.0 — 2026-10-03

### Added

- `gq offboard` cuts a leaving client's Site off, deleting nothing
  ([ADR 0011](docs/adr/0011-offboard-a-site-by-cutting-access-before-archiving.md),
  [Offboarding a Site](docs/guides/offboarding.md)). It first records
  `offboarded` in `gq.ops.json` (new in the schema; commit it), so the guards
  hold even if a later step fails. Then: a final database backup, the GitHub
  push webhook and the CI Worker's workers.dev (so no push mid-cut deploys),
  the CMS's retry crontab and the Ploi site (suspended), the custom domains,
  workers.dev and preview URLs of the Frontend Worker and of its other stages
  (each a `<project>-fe-<stage>` Worker whose `PUBLICATION_DB` binding is
  `<project>-fe-publications-<stage>`), the media bucket's domain, and last
  every `GETQUICK <PROJECT> …` Cloudflare token (disabled), however many pages
  the account lists them on. A CI Worker or media bucket not named
  `<project>-ci` or `<project>-media` may be shared, so it is left for the
  operator. It notes each change in `offboarded.cut` once made. It prints the
  plan (`✓` done, `-` to cut, `!` by hand), needs `--yes` outside a terminal,
  supports `--dry-run`, and only cuts what is still exposed, so a failed run
  is finished by running it again. It refuses to start unless the managed
  deploy files are as `gq sync` writes them, when `ploi.siteId` names a Ploi
  site other than `domains.admin` or one not running as `ploi.systemUser`, or
  when the site's `.env` names another database than `ploi.database`. Run it
  from an up-to-date deploy branch with gh 2.48 or later, and push
  `gq.ops.json` straight after.
- `gq offboard --restore` reverses exactly what the cut recorded, in the
  reverse order: it re-enables the tokens the cut disabled (never creating
  them again; one disabled before stays so), the media domain, every detached
  Worker domain, each Worker's workers.dev and preview URLs as they were, the
  Ploi site, the retry crontab if the cut deleted one, and the webhook, and
  removes `offboarded`.
- While `offboarded` is set, every command that would expose the Site again
  refuses and names `gq offboard --restore`: `cloudflare media`,
  `deploy-token`, `ci`, `releases`, `github setup`, `ci deploy`,
  `ploi provision`, `events`, `media`, `release`, `ploi api` operations that
  write, `release push`, `release tag`, `frontend refresh` and `secrets`. So
  do the generated `infra/scripts/deploy-frontend.mjs` and
  `scripts/ci-release.mjs`, and `infra/frontend.run.ts` drops the domain and
  every workers.dev and preview URL. Checks, `gq db backup` and `ploi api`
  GETs keep working.
- `gq offboard --archive` archives an offboarded Site, then deletes it
  ([Offboarding a Site](docs/guides/offboarding.md#archive-a-site)). It
  refuses a Site whose cut isn't recorded. It asks for the project's name in a
  terminal (`--yes` elsewhere), and supports `--dry-run`. It archives to the
  private, shared R2 bucket `offboarded-clients` under
  `<project>/<UTC date>/`: `uploads.zip` (every object of the project's own
  media bucket, keys kept, streamed), `database.sql.gz` (a fresh dump),
  `publications.sql` (the D1 store's export, and one per other stage),
  `backups/` (the Site's own, or everything under `backups.prefix` when the
  backups bucket goes whole),
  `gq.ops.json` and `manifest.json` (each file's size and sha256, and the
  source resources). Each media object and backup must hold the bytes its
  bucket lists, or the run stops and says to move what it wrote aside. It
  reads every file back and stops before deleting anything
  if one differs, or if `uploads.zip` doesn't hold every media object. It
  won't start a new archive over objects already under its prefix, once a
  source is gone, without the cut's final backup, or when the Ploi site or
  its `.env` database isn't the Site's. Then, in gq-smoke-down's
  order, it deletes the Ploi site (forgetting `ploi.siteId`), database and
  system user (kept while another site runs as it), the Frontend Workers and
  their D1 stores (every stage), the CI Worker, Workflows and container
  application, the media domain, the media, releases and CI backup buckets
  (emptied with keys scoped to each), the Site's own backups (the backups
  bucket itself stays: other Sites may share it), the Artifacts repository,
  only the `A`, `AAAA` and `CNAME` records of the Site's own hosts on the
  shared zone (never at its apex), then the project's tokens. It deletes
  nothing not named exactly as gq names the project's own (`<project>-media`,
  `-releases`, `-ci-backups`, `-fe`, `-fe-publications`, `-ci`, `-mirror`,
  `-ci-cisandbox`, and the Artifacts repository `<project>`) or tied to it by
  a stage's binding, listing it for the operator instead, with a shared media
  bucket's domain and DNS records. It says something is deleted only once an
  exact lookup finds it gone. Last, it deletes the GitHub webhook and archives the
  repository. It records
  `offboarded: { phase: "archived", archive: { bucket, prefix, manifestSha256 } }`
  (new in the schema), and a rerun after a failure resumes without archiving
  again. `gq offboard --restore` refuses once the archive is recorded.
- The Cloudflare commands find their tokens across every page of the
  account's listing: `gq cloudflare deploy-token`, `ci` and `releases` no
  longer create a duplicate of a token that isn't among the first 50. A
  listing without page totals is read until an empty page, and Ploi listings
  past 50 pages fail instead of stopping silently.
- Managed `package.json` scripts `offboard`, `offboard:restore` and
  `offboard:archive`, through `gq sigillo run operations`. **Existing sites:**
  `gq sync` adds them and updates the three deploy files.

## 0.14.1 — 2026-10-03

### Fixed

- `gq ploi api` no longer prints credentials. Responses, `--dry-run` requests
  and the confirmation prompt replace with `"[redacted]"` the value of any URL
  query parameter named as a credential (token, key, secret, signature), such
  as the `token` in a site's `deploy_webhook_url` that `sites.get-site`,
  `sites.suspend-site` and `sites.resume-site` return, and the strings and
  numbers under any field named as a secret (token, password, secret, key,
  private), keeping the JSON's shape. The other `ploi` and `cloudflare`
  commands already print only selected, non-secret fields.
- `gq release push` refuses to run unless HEAD is on the default branch
  (`origin/HEAD`, else `main`), before bumping, committing or tagging, and
  names the branch it found. Run from a feature branch, it used to push that
  branch with the release commit while CI deployed the tag.

## 0.14.0 — 2026-10-03

### Added

- New content sites serve their published pages and posts (entries) from the
  publication store too
  ([ADR 0004](docs/adr/0004-serve-entries-from-the-store-with-a-cold-lookup.md)),
  with the stored menu, logo and icon and the design presets each was read
  with, through CMS outages of any length, restarts and redeploys. A stored
  entry is never read from the CMS on a visit. An entry the store has never
  held is looked up once (the cold lookup): stored and served if published, a
  404 if WordPress confirms nothing is there, a 503 if the CMS or the store
  fails, never a 404. Until the chrome is stored, entries are a 503 like the
  homepage.
- `gq frontend refresh` now prepares the whole Site: the front page, the
  chrome, and every page and post WordPress lists as published or the store
  already holds, so a changed menu or design preset reaches every entry and a
  removed entry becomes a 404. `--uri <path>` (repeatable) refreshes only
  those entries, such as a new publication. An entry found at a new route is
  stored there and its old routes redirect to it (301); a failed read keeps
  the stored entry; password-protected and unpublished entries are never
  stored. The report lists each entry's outcome and the moves.
- The Frontend skeleton's `src/entries.test.ts` renders entries through
  preparation, outages, restarts, the cold lookup, new, moved and removed
  publications, failed entry, chrome and list refreshes, shared-setting
  changes, excluded editorial content, ordering, invalid requests and Site
  isolation. `scripts/smoke/frontend-runtime.sh` covers entries in workerd.
- **Existing sites** that adopted the durable homepage: copy
  `migrations/0002_entries.sql`, `src/entries.test.ts`, and the updated
  `src/lib/delivery.ts`, `src/lib/publications.ts`, `src/lib/runtime.ts`,
  `src/lib/wordpress.ts` (and its test), `src/pages/[...slug].astro`,
  `src/pages/gq/refresh.ts`, `src/routes.test.ts` and `src/test/` from a newly
  generated site, deploy and run `pnpm frontend:refresh`. The entry query now
  asks WordPress for `status` and `isRestricted`.
- New content sites refresh a published page or post on the Frontend when an
  editor publishes or updates it, without a deploy
  ([ADR 0005](docs/adr/0005-refresh-publications-through-signed-cms-events.md)).
  The CMS skeleton's `web/app/mu-plugins/publication-events.php` sends a
  publication event to the Frontend's `/gq/events`. The event is signed with
  `PUBLICATION_EVENT_SECRET` (HMAC-SHA256, valid for five minutes), names the
  Site and carries an id, the time it happened and the entry's URI, plus the
  URI it left if it moved. It never carries content. The Frontend refreshes
  that route from WordPress anonymously, so only published, complete content
  is promoted. An event for the front page refreshes the homepage.
- The Frontend refuses unsigned, stale, tampered, wrong-Site, unsupported and
  malformed events without reading the CMS or changing anything. It accepts
  neither the refresh token nor a deploy token as the event key.
- Every accepted event is recorded (migration `0003_publication_events.sql`).
  A duplicate isn't processed twice. A delayed event older than one already
  refreshed for the same entry is superseded and never read. One whose
  refresh failed is recorded as failed for a retry, and the previous version
  stays served.
- Publishing never waits on the Frontend. The event is sent at the end of the
  request, after the editor's response under PHP-FPM, with a 15-second
  timeout. The entry records its delivery: `refreshed`, or `failed` with the
  reason (`network`, `refresh`, `rejected` or `not-configured`).
- `wp gq-events status`, `retry <post>` and `check` list pending and failed
  events, send one again, and prove the key against the Frontend.
- `gq ploi events` (`pnpm ploi:events`) sets `PUBLICATION_EVENT_SECRET` in
  the Ploi site's `.env` from Sigillo staging, without showing it.
  `gq frontend events check` (`pnpm frontend:events:check`) sends a signed
  check event that changes nothing, to prove the deployed Frontend has the
  key bound. `gq new` lists both after the Frontend's deploy and refresh.
- `pnpm deploy:frontend` binds `PUBLICATION_EVENT_SECRET` to the Worker next
  to `FRONTEND_REFRESH_TOKEN`. It refuses either if it is shorter than 32
  characters and warns when either is missing.
- Cloudflare CI releases now bind both secrets as well: `gq ci deploy` gives
  them to the CI Worker when Sigillo has them, and the release step passes
  them to the Frontend deploy only when the Worker has them.
  `scripts/ci-release.mjs` reports whether each is set, never its value.
- The Frontend skeleton's `src/events.test.ts` renders the event path:
  publications, updates, moves, the front page, duplicate and delayed events,
  each failed-refresh kind, a retry after a restart, excluded editorial
  content, refused and rejected events, disabled events, credential
  separation, Site isolation and an unreadable store.
- `scripts/smoke/frontend-runtime.sh` now checks the Worker's event key in
  workerd. `scripts/smoke/cms-events.sh` runs a real WordPress (the pinned
  version on SQLite, with WP-CLI) with the site's plugin against that Worker,
  covering drafts, publications, updates, renames, the Frontend being down,
  retries, failed refreshes, another key and a missing key.
- **Existing sites** that adopted durable entries can adopt events:
  - From a newly generated site, copy `migrations/0003_publication_events.sql`,
    `src/lib/events.ts`, `src/pages/gq/events.ts`, `src/events.test.ts` and
    the updated `src/lib/delivery.ts`, `src/lib/publications.ts` and
    `src/lib/runtime.ts`.
  - Copy the CMS's `web/app/mu-plugins/publication-events.php` and the
    `PUBLICATION_EVENT_SECRET` lines of `config/application.php` and
    `.env.production.example`.
  - Add `PUBLICATION_EVENT_SECRET` to Sigillo staging, rerun `pnpm ci:deploy`,
    deploy the Frontend, run `pnpm ploi:events` and release the CMS.
- **Not yet:** automated retries with editor-facing delay reports (#46).
- New content sites refresh their shared settings through events: a change to
  the menus, the logo, the site's identity (title, tagline, icon) or the
  design presets reaches the homepage and every entry without republishing
  them, and outlives later CMS outages
  ([ADR 0007](docs/adr/0007-refresh-shared-settings-through-settings-events.md)).
  - The CMS skeleton gains `web/app/mu-plugins/settings-events.php`. It sends
    a signed `settings` event, with the publication events' key and endpoint,
    when WordPress saves a menu shown at a theme location or the locations,
    `site_logo`, `blogname`, `blogdescription`, `site_icon`, the theme's
    global styles (GQ Design's palette) or the active theme. One event per
    setting per request is sent at the end of it, and each setting records its
    last event and delivery in `gq_settings_event_<setting>`.
    `wp gq-events settings status` and `wp gq-events settings retry <setting>`
    list and resend them.
  - The Frontend refreshes only the shared rows every page is served with,
    not each entry: the chrome, the front page (title and tagline) or the new
    shared `design` row, which the homepage and every entry are served with
    once stored. A whole-Site refresh stores it too, and `gq frontend refresh`
    reports it. A failed read keeps the stored menus, branding and design. A
    setting's events are recorded like an entry's (subject `setting:<name>`),
    so duplicates, delayed events and retries follow the same rules.
  - `src/settings.test.ts` covers each setting on the homepage and two
    entries, outages, each failed read kind, a partly failed identity refresh
    and its retry, duplicate, delayed and racing events, Sites prepared before
    the shared presets, and refused events. `scripts/smoke/cms-events.sh` now
    changes each setting through WordPress's own APIs, including a palette
    saved through the global-styles REST route.
  - **Existing sites** that adopted events: copy `settings-events.php`,
    `src/settings.test.ts` and the updated `src/lib/delivery.ts`,
    `src/lib/events.ts`, `src/lib/wordpress.ts`, `src/pages/gq/events.ts` and
    `src/test/wordpress-stub.ts` from a newly generated site.
- New content sites withdraw a page or post from the Frontend when an editor
  unpublishes it, makes it private, adds a password, trashes it or deletes it
  ([ADR 0006](docs/adr/0006-withdraw-publications-through-signed-cms-events.md)).
  The CMS plugin sends a signed `withdraw` event with the entry's id and the
  URI it had while published. The Frontend makes every route of that entry a
  404 at once, without reading the CMS, so the withdrawal holds through CMS
  outages and restarts. Other publications are untouched.
- The Frontend records each withdrawal (migration `0004_withdrawals.sql`) and
  applies it in one D1 transaction. While a withdrawal is in force, nothing
  promotes that entry again: not a refresh, a cold lookup, a CMS (or a cache
  in front of it) that still returns it, a duplicate, or an older read still
  in flight. Refresh reports show such a read as `withdrawn`.
- Ordering follows the CMS: a publication older than the withdrawal is
  superseded, a withdrawal older than a recorded publication changes
  nothing, and a later publication lifts the withdrawal and refreshes the
  entry as usual. A password-protected entry now sends a withdrawal rather
  than a publication.
- A deleted entry's withdrawal is kept in the option
  `gq_publication_events_deleted` until it is delivered.
  `wp gq-events status` lists it and `wp gq-events retry <post>` sends it.
- The homepage and entry pages answer with `Cache-Control: no-cache`, so no
  browser or proxy reuses a copy without asking the Worker.
- The Frontend skeleton's `src/withdrawals.test.ts` renders withdrawals
  through outages and restarts, stale CMS answers, refreshes and cold
  lookups racing them, delayed, duplicate and reordered events,
  republications, moved entries, the front page, refused events and Site
  isolation. `scripts/smoke/frontend-runtime.sh` checks a withdrawal in
  workerd with a local D1. `scripts/smoke/cms-events.sh` checks unpublishing,
  password-protecting, trashing and deleting (also while the Frontend is
  down) with a real WordPress.
- **Existing sites** that adopted events:
  - From a newly generated site, copy `migrations/0004_withdrawals.sql`,
    `src/withdrawals.test.ts` and the updated `src/lib/delivery.ts`,
    `src/lib/events.ts`, `src/lib/publications.ts`, `src/lib/wordpress.ts`,
    `src/pages/index.astro`, `src/pages/[...slug].astro` and
    `src/test/sqlite-d1.ts`.
  - Copy the CMS's updated `web/app/mu-plugins/publication-events.php`.
  - Deploy the Frontend before releasing the CMS: an older Frontend answers a
    withdraw event 422 (unsupported), which the CMS records as `rejected`.
- New content sites retry the events the Frontend didn't confirm, without
  visits or republishing, and report delayed public delivery
  ([ADR 0008](docs/adr/0008-retry-event-delivery-from-the-cms-on-a-server-cron.md)).
  - The CMS skeleton gains `web/app/mu-plugins/delivery-retries.php`. It
    reads the entries' and settings' delivery records as one list, whatever
    the event's action (publish, withdraw or settings; another kind joins
    through `gq_events_deliveries`).
    `wp gq-events retry-due` resends the same event once its delay has passed:
    1, 2, 5, 10 and 30 minutes, then hourly, up to 12 attempts. It also sends
    a pending event its own request never sent. A lock keeps runs from
    overlapping, and each run records itself.
  - `gq ploi events` now also adds the Ploi crontab that runs it every minute
    as the site's system user. Production disables WP-Cron, which isn't used.
  - Editors see public delivery apart from publication: a block-editor notice
    on opening an entry and after each save (pending, delayed with the reason
    and next retry, failed, or recovered), the same in the classic editor,
    "Public update pending/delayed/failed" in the page and post lists, and a
    summary on the Dashboard, the lists and the Menus, Themes and General
    Settings screens.
  - Operators get a Site Health test ("Public website delivery"), critical for
    a failed delivery or a scheduler that hasn't run in production, and
    `wp gq-events delays`. Neither shows the key or content. A refresh failure
    now records the Frontend's reason instead of only "HTTP 503".
  - `src/retries.test.ts` (rendered Frontend, controlled clock) covers retries
    hours on, settings retries, work interrupted by a Worker restart, a late
    retry that can't overwrite a newer publication, and replayed signatures.
    `scripts/smoke/cms-events.sh` drives the scheduler on a real WordPress:
    dispatch and refresh failures recovered by `retry-due`, backoff, an
    interrupted request, exhausted attempts, the lock, and, when the local
    `ddev/ddev-webserver` image is present, a real cron daemon running the
    crontab `gq ploi events` installs.
  - **Existing sites** that adopted events: copy `delivery-retries.php` and
    the updated `publication-events.php`, then run `pnpm ploi:events` to add
    the crontab.
- New content sites reconcile their Frontend with WordPress every minute, so a
  change whose event was never sent still reaches visitors within the
  five-minute target while the CMS is healthy. Examples are a hook that didn't
  fire, a plugin or script writing the database, or a request that died before
  recording its event
  ([ADR 0009](docs/adr/0009-reconcile-missed-changes-on-the-cms-scheduler.md)).
  - After its retries, each `wp gq-events retry-due` run (the existing crontab)
    sends the Frontend a signed `reconcile` event. `wp gq-events reconcile`
    sends one at once, and the `gq_events_reconcile` filter turns it off. No
    new crontab, secret or Cloudflare resource is needed.
  - The Frontend (`src/lib/reconciliation.ts`) compares the front page, the
    chrome and the design presets with what it stores, by content. It
    compares WordPress's list of published pages and posts (id, URI and
    `modifiedGmt`) with its stored entries. It refreshes a new, changed, moved
    or removed entry, and a withdrawn one WordPress modified after its
    withdrawal. It also re-reads two stored entries each run, so a change that
    kept its modification time is caught too, later.
  - The same rules as events apply. A changed entry is processed as a
    publication event dated by its modification time, with an id derived from
    the change, so it is ordered, superseded and retried like the CMS's own.
    A failed read keeps what is stored, an incomplete list removes nothing,
    and only WordPress confirming an entry missing makes it a 404. An older
    scan or a read in flight can't undo a withdrawal.
  - A run makes at most 40 CMS requests (Workers' Free plan allows 50
    subrequests) and leaves the rest for the next minute, reporting `behind`.
    A lease in D1 keeps runs from overlapping, and an interrupted run's lease
    expires.
  - Migration `0005_reconciliation.sql` adds `publications.modified_at` and the
    one-row `reconciliation` table: the lease, the last outcome, counts, the
    first failure, and when the store last matched WordPress. The entry query
    and the list of published routes now also ask WPGraphQL for `modifiedGmt`
    (and the list for `id`).
  - Diagnostics: the Frontend answers 200 when reconciled, behind or busy and
    503 with the first failure when a read failed. The signed `check` answer
    includes the last reconciliation, which `gq frontend events check`
    prints. The CMS keeps each run in `gq_reconciliation`; `wp gq-events
delays` shows it, and Site Health turns "recommended" after ten minutes
    without a match. None shows content or a secret.
  - `src/reconciliation.test.ts` covers, on a controlled clock with the
    scheduler every minute:
    - a lost publication, update, move, removal, republication and each
      shared setting, each public within five minutes without a visit
      reading the CMS;
    - outages of any length without lost pages or false withdrawals, then
      recovery;
    - a failed list or entry read;
    - withdrawals against older scans and reads in flight;
    - overlapping and interrupted runs;
    - 50 changes over several runs within the request budget;
    - refused requests.

    `scripts/smoke/frontend-runtime.sh` reconciles in workerd with a local D1,
    including 60 changes within 40 CMS requests per run.
    `scripts/smoke/cms-events.sh` makes changes with WordPress's hooks
    removed and checks that `retry-due` brings them to visitors, and that a
    failed run is reported. With the local `ddev/ddev-webserver` image, it
    checks that a real cron brings such a change to visitors within five
    minutes.

  - **Existing sites** that adopted retries: from a newly generated site, copy
    `migrations/0005_reconciliation.sql`, `src/lib/reconciliation.ts`,
    `src/reconciliation.test.ts` and the updated `src/lib/delivery.ts`,
    `src/lib/events.ts`, `src/lib/publications.ts`, `src/lib/wordpress.ts`,
    `src/events.test.ts` and `src/test/wordpress-stub.ts`. Copy the CMS's
    updated `delivery-retries.php` and `publication-events.php`. Deploy the
    Frontend before releasing the CMS: an older Frontend answers `reconcile`
    422, which the CMS records as a failed reconciliation. Stored entries
    have no modification time until read again, so the first runs re-read
    them, 18 per run.
- `gq site check` (`pnpm site:check`) is the one readiness gate for a new
  content Site's resilience guarantee
  ([ADR 0010](docs/adr/0010-declare-a-new-content-site-ready-through-one-readiness-gate.md)).
  It exits 1 until ready, and says per check what holds and what to run:
  - CMS: WordPress installed (a redirect to its installer is named),
    WPGraphQL active, and every field the Frontend reads present, validated
    by GraphQL itself with each field skipped, so nothing is read. Missing
    fields name gq-design, wpgraphql-blocks or getquick-theme.
  - Frontend: the signed check (event key and store bound), the refresh token
    (proven by a refresh of no routes, refused after authorisation), a
    prepared store, and a homepage served 200 with `Cache-Control: no-cache`
    and no edge cache hit.
  - Event delivery: a reconciliation that matched WordPress within ten
    minutes (proof that the CMS's cron runs and its events are accepted),
    failed events as delays, and the Ploi `.env` key and crontab.
  - Independent media: `gq media check --upload`, always.

  `gq site check --local` (`pnpm site:check:local`) checks this machine's
  DDEV CMS the same way: a running DDEV isn't a ready CMS.

- The Frontend's signed `check` answer reports the store: the front page's,
  the chrome's and the design presets' states, entries by state, withdrawals
  in force and failed events. States and counts only, never content.
- `gq frontend secrets` (`pnpm frontend:secrets`) generates
  `FRONTEND_REFRESH_TOKEN` and `PUBLICATION_EVENT_SECRET` into Sigillo
  staging when missing or shorter than 32 characters, never printing them.
- `gq new` prints the whole flow in an order that works: `frontend:secrets`
  before `ci:deploy`, `ploi:events` with the provisioning, then the releases,
  `frontend:refresh`, `media:check:upload` and `site:check`. The managed root
  scripts gain `frontend:secrets`, `site:check` and `site:check:local`.
- Proofs: `scripts/smoke/cms-events.sh` installs the public WPGraphQL plugin
  and walks `gq site check`'s transitions (uninstalled, without WPGraphQL,
  without the GETQUICK fields; a Worker unprepared, then unreconciled, then
  ready) on the real WordPress and workerd. `scripts/smoke/frontend-runtime.sh`
  serves a store aged by a year and refuses another Site's, malformed,
  unsupported and stale events. `scripts/smoke/acceptance.sh` runs the local
  gate in order. CI also runs `frontend-check.sh` and `frontend-runtime.sh`.
- The gq-smoke wizard provisions the Frontend's secrets and the CMS's events,
  prepares the store, passes `gq site check`, and drives the live
  editor-to-visitor acceptance (`scripts/smoke/live-acceptance.mjs`): a
  publication with an uploaded image, a tagline change, a change with no
  event, a 15-minute CMS outage, a withdrawal and a redeploy. Teardown deletes
  the retained D1 store.
- **Existing sites:** nothing changes until they adopt. A Frontend from before
  this release is reported by `gq site check` as predating it; copy the
  updated `src/lib/events.ts`, `src/lib/publications.ts` and
  `src/events.test.ts` from a newly generated site and deploy.

### Fixed

- The Frontend's deploy token ("Staging Alchemy") can create and migrate the
  publication store: it gains D1 Read and D1 Write. `pnpm cf:deploy-token`
  adds a missing permission to an existing token, keeping its value; run it
  once before the next Frontend deploy.

## 0.13.5 — 2026-10-02

### Fixed

- Generated site formatting and lint hooks exclude imported agent skills so
  commits preserve their exact upstream contents and lockfile hashes.

### Added

- `gq skills update` installs and updates registered upstream agent skills in
  `.agents/skills` without needing `gq.ops.json`. Registrations live in
  `.agents/skills.json`, `skills-lock.json` records the installed commit,
  per-file hashes and modes, `--check` is read-only, GitHub tokens are read
  from `GITHUB_TOKEN`/`GH_TOKEN`, unregistered local skills are untouched, and
  drift, unsafe paths, symlink anchors and concurrent writers are refused.
- `gq media check` reports whether a site's WordPress uploads are hosted
  independently of its CMS, with an actionable step for each check that
  isn't ready and exit 1 until they are. Through `gq sigillo run staging`
  it checks the `media` configuration, that the media domain is neither the
  CMS's nor the Frontend's host, that the deploy activates `s3-uploads`, the
  Ploi `.env`'s `S3_UPLOADS_*` lines (compared, never shown), the bucket
  credentials, the public domain and the Frontend's rendered homepage
  (`configured`). `--upload` proves the upload path: it uploads a probe
  image through the CMS's REST API as `CMS_CHECK_USER` with the application
  password `CMS_CHECK_APP_PASSWORD`, requires its URL on the media domain,
  compares the bucket's object with what the media domain serves, and
  deletes the probe (`ready`). `--local` checks local development offline:
  uploads stay on disk unless `apps/cms/.env` holds R2 credentials.
  `--json` prints the result for other tooling.
- New sites get the `media:check`, `media:check:upload` and
  `media:check:local` scripts. `gq new`'s provisioning sequence now includes
  `ploi:media` after `cf:media`, and ends with `media:check:upload`.
- `gq doctor` reports local media, and fails when `apps/cms/.env` holds R2
  credentials, which would make the local CMS write to the live bucket.
- The gq-smoke wizard proves independent media on its disposable site
  (stage 17).
- New Frontends test their routes: `src/routes.test.ts` renders the home and
  entry pages through Astro's Container API (`vitest.config.ts`) against a
  stubbed CMS and checks their content and HTTP status.
  `scripts/smoke/frontend-check.sh` runs a disposable generated site's
  Frontend tests, `astro check`, lint and format check.
- **Existing sites:** the Frontend is site-owned, so syncing doesn't change
  it. To adopt, copy `src/lib/wordpress.ts`, its test, `src/routes.test.ts`,
  the two pages, `src/layouts/Layout.astro` and `vitest.config.ts` from a
  newly generated site (and add `vitest.config.ts` to `tsconfig.json`),
  keeping the site's own changes.
- New content sites serve a durable last-known-good homepage
  ([ADR 0003](docs/adr/0003-serve-published-content-from-a-durable-store.md)).
  The Frontend serves the front page and its menu, logo, site identity and
  design presets from its publication store, a D1 database of its own
  (`<project>-fe-publications`, retained in production) that
  `infra/frontend.run.ts` declares, migrates from `apps/frontend/migrations`
  and binds as `PUBLICATION_DB`. Visits never read the CMS, so the homepage
  outlives CMS outages of any length, Worker restarts and redeploys. Until a
  refresh has stored it, the homepage is a 503, never a placeholder or a 404.
- `gq frontend refresh` (`pnpm frontend:refresh`) is the trusted refresh: it
  posts to the Frontend's `/gq/refresh` with `FRONTEND_REFRESH_TOKEN` (a
  per-site secret in Sigillo staging, bound to the Worker by
  `pnpm deploy:frontend`). The Frontend reads the CMS anonymously and promotes
  each complete, valid read; a timeout, network, HTTP or GraphQL error,
  missing required data or a front page without its blocks keeps the stored
  version, a failed chrome read doesn't touch the stored front page, and an
  older read never overwrites a newer one. The report says what was kept and
  why; the command exits 1 until the homepage is ready and refreshed. Without
  the token bound, the Frontend refuses every refresh. `gq new` lists the
  deploy and refresh after media.
- The Frontend skeleton's `src/homepage.test.ts` renders the homepage through
  refreshes, outages, time far beyond any cache expiry, restarts, refused
  refreshes and unreadable or incompatible stored state, with the store on
  SQLite and the same migrations. `scripts/smoke/frontend-runtime.sh` proves
  it on a disposable generated site without Cloudflare: Alchemy's Astro
  build served in workerd with a local D1 store, through a CMS outage, a
  Worker restart and a rebuilt redeploy.
- **Existing sites:** `infra/frontend.run.ts` only creates the store when
  `apps/frontend/migrations` exists, so syncing changes nothing for a
  site-owned Frontend that doesn't have it. To adopt, copy `migrations/`,
  `src/lib/delivery.ts`, `src/lib/publications.ts`, `src/lib/runtime.ts`,
  `src/pages/gq/refresh.ts`, `src/test/`, `src/homepage.test.ts`, the updated
  `src/pages/index.astro`, `src/layouts/Layout.astro`, `src/env.d.ts` and
  `src/routes.test.ts` from a newly generated site, add
  `FRONTEND_REFRESH_TOKEN` to Sigillo staging, deploy and run
  `pnpm frontend:refresh`.
- **Not yet:** Cloudflare CI releases don't pass `FRONTEND_REFRESH_TOKEN`, so
  a CI release disables refresh (stored content is still served) until the
  next `pnpm deploy:frontend`; entries still read the CMS live; refresh is
  manual until WordPress events arrive.

### Fixed

- New content sites' Frontends no longer present a CMS failure as a missing
  page. `src/lib/wordpress.ts` returns `found`, `missing` (WordPress confirms
  nothing is published there) or `unavailable` with the reason (`timeout`,
  `network`, `http`, `graphql` or `schema`), and logs each unavailable read.
  A missing entry is a 404; a timeout, HTTP or GraphQL error (even next to
  partial data) or an answer without the required GETQUICK fields is a 503.
  Outside `astro dev`, an unreadable front page is a 503 instead of the
  "Content is on its way" placeholder, which local development without a CMS
  keeps; a site with no front page set is a 404 that still says how to set
  one. A failed menu/logo/icon read is `unavailable` rather than an empty menu,
  and the page is still served without them.
- The front page retries without blocks after a CMS 5xx, like entries do; a
  timeout isn't retried, and a failed retry is unavailable, never missing.

## 0.13.4 — 2026-10-02

### Changed

- Clarified CLI and provider source ownership and role-based filenames while
  preserving the package's public exports and command behavior.
- Made the README an entry point to focused site guides, command references
  and contributor documentation, all included in the published package.
- Distinguished blueprint section and managed-key fragments from whole-file
  sources without changing generated site paths or ownership rules.
- Organized tests by module and subject, clarified shared helper roles and
  documented fixture provenance. Test discovery still excludes extracted site
  scripts, and existing fixture contents are preserved.

## 0.13.3 — 2026-10-02

### Fixed

- Local Design overrides support `gq-design.php` and the `gq-design` plugin
  slug while preserving legacy checkouts and the `getquickDesign` config key
  (`gqDesign` is also accepted). The exact dangling link from a sibling
  checkout rename is migrated under the existing operation lock, with separate
  registry backups for each package, regenerated DDEV mounts/hooks, and
  protection for both slugs when no override is active. Composer failures and
  package rollback retain registry fallback copies and relink before autoload
  refresh; unsafe or ambiguous local state is refused without overwriting it.
  An interrupted backup copy is discarded rather than replacing the intact
  release with a partial copy.
- New-site scaffolds require `getquick/gq-design ^0.3.1` and parent theme
  `^0.5.0`, and activate the renamed `gq-design` plugin.

## 0.13.2 — 2026-10-02

### Changed

- The repository is renamed `Quick-Release/gq-site` (was
  `getquick-site`); the package stays `@getquick/site`. The published
  `repository` URL, the managed `AGENTS.md` section's link and the links in
  new sites' `README.md` and `GLOSSARY.md` point at the new name; old links
  keep working through GitHub's redirect.
- Ploi requests identify as `gq-site/<version>` instead of
  `getquick-site/<version>`.

## 0.13.1 — 2026-10-02

### Fixed

- `scripts/ci.test.mjs` no longer writes into the site's own repository when
  a Git hook runs it (a worktree's `pre-push` → `pnpm verify`). Git exports
  `GIT_DIR`, `GIT_INDEX_FILE` and the like to hooks, and the mirror test
  passed them on to its throwaway repositories: each push set
  `core.bare = true` on the site's repository and left empty commits and a
  local `v1.0.0` tag behind. The test now drops every `GIT_*` variable before
  running `git`. **Existing sites:** after syncing, check for a stray
  `v1.0.0` tag (`git tag -d v1.0.0`), commits by `t <t@t>`, and
  `core.bare = true` (`git config --unset core.bare`) left by earlier pushes.

## 0.13.0 — 2026-10-02

### Changed

- The site glossary is `GLOSSARY.md`, not `CONTEXT.md`: `gq new` writes
  `GLOSSARY.md`, and the generated `AGENTS.md` section, `docs/agents/domain.md`
  and the README and `docs/adr/README.md` templates point at it. `gq` doesn't
  rename the file in an existing site, since a create-once file is the
  site's: synced without renaming, the site gets a fresh `GLOSSARY.md` next
  to its `CONTEXT.md`.
- **Existing sites:** run `git mv CONTEXT.md GLOSSARY.md` before syncing to
  this version, and update the site's own links to the old name. The lock
  then records `GLOSSARY.md` as created and drops `CONTEXT.md`.

## 0.12.0 — 2026-10-02

### Added

- The managed files that need no site values, extracted from Lombardi: the
  Git hooks (`.vite-hooks/pre-commit` and `pre-push`, written executable),
  the Node version file (`.nvmrc`), the staged lint/format config
  (`vite.config.ts`), the docs skeleton's READMEs (`docs/adr`, `docs/plans`,
  `docs/research`, `docs/agents`), the agent reference docs (issue tracker,
  triage labels, domain) and the agent-skills symlink
  (`.claude/skills` → `../.agents/skills`). A site's own ADRs, plans and
  research next to them stay site-owned.
- Generated sections: `AGENTS.md` gets the blueprint's base guidance and
  `.gitignore` its ignore rules (Lombardi's), each between `BEGIN gq` and
  `END gq` lines. Content outside the markers is the site's.
- Managed keys in the root `package.json`: the `packageManager` and
  `engines.node` pins, the hook install (`prepare`) and the root scripts
  that wrap `gq`, taken from Lombardi. `package.json` is edited as text, so
  every other key is left byte for byte. A managed key the blueprint
  retires is removed unless the site has changed it.
- Create-once files: the glossary (`CONTEXT.md`) and `README.md`, written by
  `gq new` (or `gq sync`) when absent and recorded in the lock as created
  once present, so they are never rewritten or restored after.
  `gq sync --recreate <path>` writes one again.
- The site's deploy wiring, fully generated from `gq.ops.json` and
  extracted from Lombardi: the Cloudflare CI Worker (`infra/ci`: Wrangler
  config, CI and mirror Workflows, webhook, release check, sandbox image),
  the Frontend deploy configuration and script (`infra/frontend.run.ts`,
  `infra/scripts/deploy-frontend.mjs`, `infra/package.json`), the CI release
  step (`scripts/ci-release.mjs`) and their tests (`scripts/ci.test.mjs`).
  Worker, Workflow, namespace, bucket, account and repository names come
  from `ci`, `artifacts`, `cloudflare` and `github`, the rest from
  `project`; a value the manifest doesn't have yet is written as a
  placeholder naming its key (`<ci.worker>`). Lombardi's manifest renders
  Lombardi's files byte for byte.
- Managed root scripts for the deploy wiring: `deploy:frontend`,
  `deploy:frontend:raw` (the release step's Frontend deploy),
  `plan:frontend`, `infra:check`, `ci:check` and `test:scripts` (checks the
  content variant's `gq verify` runs).
- The CMS deploy script Ploi runs (`deploy/ploi/admin.sh`), fully generated
  and extracted from Lombardi: release download, Composer with the registry
  login, the copy-back of shipped plugins and themes, maintenance mode, the
  PHP-FPM reload and the `<PROJECT>_DEPLOY_STATUS` line. It activates the
  plugins `wordpress.plugins` lists, in order, then runs the site's deploy
  extensions (`deploy/ploi/admin.d/*.sh`, created once with a README) in
  lexical order; one that exits non-zero fails the deploy. Lombardi's
  manifest renders Lombardi's script without its own steps (its theme, the
  plugin retirements and the clean-up of its git-based deploys), which move
  to an extension.
- `gq new` writes a complete content site: create-once CMS and Frontend
  skeletons extracted from Lombardi without its plugins, child theme and
  pages (the CMS installs the GETQUICK plugins and `getquick-theme` from the
  registry, a `10-theme.sh` deploy extension activates the theme, and the
  Frontend renders GETQUICK blocks over WPGraphQL with its own copy of
  Lombardi's block renderer), env templates holding public configuration and
  placeholders only, the workspace config (`pnpm-workspace.yaml`),
  `VERSION`, and a root `package.json` started with the site's own scripts
  and dependencies (`@getquick/site` pinned to the installed version). Its
  `gq.ops.json` lists the skeleton's plugins in `wordpress.plugins`. A
  generated site passes `pnpm verify`.
- `gq new` asks for the directory, project or variant it is missing when
  run in a terminal, and names them otherwise. It then prints the
  provisioning sequence (`ploi provision`, `cloudflare …`, `github setup`,
  `ci deploy`), running none of it.
- An app skeleton's create-once files are written only with their app:
  `gq sync` creates them while the app's directory (`apps/cms`,
  `apps/frontend`) is missing, never into an app the site already has.

### Changed

- `gq new` refuses a project name that isn't lowercase letters, digits and
  hyphens starting with a letter, since it names packages, Workers and the
  DDEV project, and an unknown `--variant`.
- `wordpress.plugins` in `gq.ops.json` takes plugin slugs only (letters,
  digits, `-`, `_` and `.`, starting with a letter or digit), since the
  deploy script activates each one.
- `gq.lock.json` also records a hash for each generated section
  (`sections`) and managed key (`keys`), and the create-once files it has
  created (`created`). A lock from 0.11.0 is upgraded on the next sync. An
  edit inside a section, or to a managed key, stops `gq sync` with a diff of
  the whole file, like an edited managed file.
- `gq sync` manages symlinks and executable files. A retargeted symlink, or
  anything else standing in its place, is a local edit, shown as a diff of
  the targets. A managed file that lost its executable bit is made
  executable again rather than taken for an edit.

## 0.11.0 — 2026-10-01

### Added

- `gq new <dir> --project <name> --variant content`, which writes a v1
  `gq.ops.json`, the blueprint's managed files and `gq.lock.json`, then runs
  `git init`. It uses no network and no secrets; `--variant commerce` is
  refused until phase 4.
- The blueprint's ownership manifest, `blueprint/ownership.json`, published
  with the package: fully generated files, generated sections, managed keys
  and create-once files. Its one managed file so far is the toolchain pins
  (`.mise.toml`).

### Changed

- `gq sync` regenerates the managed files after migrating `gq.ops.json` and
  records their hashes in `gq.lock.json`. A managed file that differs from
  the lock is a local edit: sync prints a diff and writes nothing.
  `gq sync --check` reports every pending change, and `--manifest` still
  limits sync to the manifest.

## 0.10.0 — 2026-10-01

### Added

- `gq.ops.json` v1 `release` (`jsonFiles`, `textFiles`, `paths`), `verify`
  (`checks`) and `doctor` (`requiredFiles`): additions appended to the
  blueprint's defaults for the site's variant, validated like every other
  key. The `content` defaults are Lombardi's release config; `commerce` has
  none yet. A text-file pattern is `{ regexp, flags?, replacement }`, with
  `{version}` in the replacement.
- `gq sync --manifest` folds a site's `shop-devtools.config.mjs` into
  `gq.ops.json` (with the v0 → v1 migration, or into a manifest gq 0.9.0
  already migrated) and removes it, keeping only what differs from the
  variant's defaults. It warns about `releaseBranch` (dropped), each default
  the module left out (now added) and each check it moves after the
  defaults, and refuses `composer`, `deploys`,
  `docsChangelogPath`, another `versionFile` or `changelogPath`, and
  replacements that aren't fixed text around the version. `--check` reports
  the fold as pending.

### Changed

- `gq release`, `gq version`, `gq verify` and `gq doctor` read their settings
  from `gq.ops.json` and the variant's defaults. While
  `shop-devtools.config.mjs` is still beside it, the release commands and
  `gq verify` refuse to run and `gq doctor` fails.
- `version sync` and `release prepare` end with the same "All project
  packages are synced" line as `version check`.

### Removed

- `gq release push --no-deploy` and the release config's `deploys`:
  Cloudflare CI deploys the pushed `v*` tag.
- The release config's `composer` packages pinned to the release version.

## 0.9.0 — 2026-10-01

### Added

- `gq.ops.json` schema v1, validated before any command runs: an integer
  `schemaVersion`, `project`, `variant` (`content` or `commerce`), `domains`
  with the roles `admin`, `frontend` and an optional `docs`, a
  `wordpress.plugins` list, and the blocks commands already read. Unknown
  keys fail by their path. The JSON Schema editors load through `$schema`
  ships as `schema/gq.ops.schema.json`, generated from the zod schema.
- `gq sync [--manifest] [--check] [--variant <content|commerce>]`, which
  applies pending manifest migrations and writes `gq.ops.json` back, or with
  `--check` reports them and exits 1 without writing. The v0 → v1 migration
  takes the variant from `--variant`, and drops and names `credentials`,
  `github.environment`, `github.secrets` and `github.variables`.

### Changed

- Every command refuses a manifest without `schemaVersion` (v0), pointing at
  `gq sync --manifest`, and one newer than the installed `gq` reads. Sites
  migrate with `gq sync --manifest --variant <content|commerce>`.
- `gq ploi provision` records a new site ID through the validated manifest
  writer, so it also works when `ploi.siteId` is absent.

### Removed

- `gq github actions sync`: its `github.secrets`/`github.variables` are not
  part of v1, and no site deploys from GitHub Actions.

## 0.8.0 — 2026-10-01

### Added

- Lombardi's workspace runners as `gq setup [--no-ddev]`, `gq doctor` and
  `gq verify [--ci]` (`scripts/setup.mjs`, `doctor.mjs` and `verify.mjs`).
  The site still supplies what they check: `verify` runs the release config's
  `checks`, and `doctor` reads the required app files from its new
  `doctor.requiredFiles`, the Node minimum from `engines.node`, the toolchain
  pins from `packageManager` and `.mise.toml`/`.nvmrc`, and the DDEV project
  from `apps/cms/.ddev/config.yaml`.
- A check can declare `requires: ["php" | "ddev"]`; locally `verify` skips
  (and reports) a check whose requirement is missing. Without it, a
  `composer` check needs PHP, as before.
- `doctor` reports the running `@getquick/site` version, warning when it
  differs from the site's pin, and the Node pin from `.mise.toml`/`.nvmrc`.

### Changed

- `setup`'s next steps name `pnpm deploy:frontend` (not the missing
  `deploy:fe`).
- `verify`'s summary counts the checks it skipped.

## 0.7.0 — 2026-10-01

### Added

- Lombardi's local CMS commands as `gq cms start [--foreground]`, `status`,
  `stop` and `describe` (`scripts/ddev.mjs`, with
  `scripts/lib/ddev-background.mjs` and `cms-dev-links.mjs`): background DDEV
  startup by a detached `gq` worker whose phase and log stay in
  `apps/cms/.local-plugins/`, foreground waiting, and `apps/cms/.env` wiring.
  The startup panel's title comes from `gq.ops.json` `project`.
- `gq cms composer install|update|reinstall|test|lint|lint:fix`
  (`scripts/cms-composer.mjs`), and `gq cms design [refresh]`
  (`scripts/cms-local-design.mjs`), which the Design override's DDEV hooks run.
- `exec` takes `timeout`, and `background: { log }` for a detached child that
  it doesn't wait for (resolving with its `pid`).

### Changed

- The local Design override's generated DDEV hooks run
  `../../node_modules/.bin/gq cms design [refresh]` instead of Lombardi's
  `scripts/cms-local-design.mjs`; the next `gq cms start` rewrites them.

## 0.6.0 — 2026-10-01

### Added

- Lombardi's Cloudflare provisioning as `gq cloudflare deploy-token`,
  `releases`, `media` and `ci` (each `[--dry-run]`;
  `scripts/cloudflare-deploy-token.mjs`, `cloudflare-releases.mjs`,
  `cloudflare-media.mjs` and `cloudflare-ci.mjs`), with their account-scoped
  Cloudflare and Artifacts clients. Token names derive from `gq.ops.json`
  `project`; account, zone, buckets, domain and Artifacts repository come
  from `cloudflare`, `releases`, `media`, `artifacts` and `ci`. What they mint
  goes to the `staging` Sigillo environment over stdin.
- Lombardi's CI Worker commands as `gq ci deploy` and `gq ci runs`
  (`scripts/ci-deploy.mjs`), `gq github setup [--dry-run]`
  (`scripts/github-setup.mjs`) and `gq git artifacts setup|get|store|erase`
  (`scripts/git-artifacts.mjs`). The Worker lives in the new
  `gq.ops.json` `ci.directory` (default `infra/ci`); the GitHub repository is
  `github.repository`. The credential helper `setup` registers is the site's
  own `gq` under `gq sigillo run staging`, so existing clones re-run
  `git artifacts setup`.
- `run()` takes `stdin`, the readable stream `git artifacts get` reads git's
  credential request from; `bin/gq.mjs` passes `process.stdin`.
- `artifactsRemoteUrl({ accountId, namespace, repo })`, the Artifacts git
  remote, for a site's health check.

## 0.5.0 — 2026-10-01

### Added

- Lombardi's database sync as `gq db sync [--yes]` (`scripts/db-sync.mjs`
  with `db-sync-run.mjs`'s relaunch under mkcert's CA) and `gq db backup`
  (`db-sync.mjs --backup-only`). It stays live → local only, and the
  export-only guard still refuses, before Ploi receives it, any server script
  that could write to a database. Site values come from `gq.ops.json`
  `backups`, `domains`, `ploi` and `cloudflare`, plus the new `local`:
  `local.adminEmail` (required by `sync`) is the local `dev` administrator's
  address, and `local.frontendUrl` (default `http://localhost:4321`) the
  local frontend the live one is replaced with.
- The modules `db sync` needs from Lombardi's local CMS tooling, as is: the
  local Design source override (`scripts/lib/cms-local-design.mjs`, with an
  async `withDesignRegistryInstall` and `runDesignCommand` through `exec`),
  the host Composer install around it (`cms-composer.mjs`'s
  `composerInstall`), DDEV status and `apps/cms/.env` wiring
  (`scripts/lib/ddev.mjs`, `cms-env.mjs`; `S3_UPLOADS_BUCKET_URL` defaults
  from `media.domain`). They have no commands of their own yet, and the
  override's generated DDEV hooks still run Lombardi's
  `scripts/cms-local-design.mjs` until its DDEV startup moves into `gq`.

### Changed

- The export marker is named after `gq.ops.json` `project`:
  `<PROJECT>_DB_EXPORT`, so Lombardi's `LOMBARDI_DB_EXPORT` is unchanged.

## 0.4.0 — 2026-10-01

### Added

- Lombardi's Ploi workflows as `gq ploi provision [--dry-run | --yes]`
  (`scripts/ploi-provision.mjs`), `gq ploi release [--ref <ref>]
[--git-dir <dir>]` (`scripts/ploi-release.mjs`) and `gq ploi media
[--dry-run]` (`scripts/cloudflare-media.mjs --ploi-env`), with their
  server-scoped Ploi client, R2 client and `.env` editing. Site values come
  from `gq.ops.json` `ploi`, `domains`, `releases`, `media` and `cloudflare`;
  a missing key is a configuration error naming it. `release` still syncs
  Ploi's stored deploy script from the release commit before every deploy and
  hands `COMPOSER_AUTH` over as the `composer_auth` deploy variable, failing
  before any upload when it is missing.
- `run()` takes `lookup` (node:dns/promises' signature) for the DNS check
  behind `ploi provision`'s certificate step; `bin/gq.mjs` passes the real
  one.
- `ploiReleaseShippedPaths`, the paths a release archive ships, for a site's
  test of its deploy script.

### Changed

- The deploy status line `ploi release` waits for is named after
  `gq.ops.json` `project`: `<PROJECT>_DEPLOY_STATUS` (upper-cased, other
  characters as `_`), so Lombardi's `LOMBARDI_DEPLOY_STATUS` is unchanged.
- Outside a terminal the workflows print plain progress lines instead of
  Clack's spinners; the plan and results are the same.
- Hints name `gq` commands rather than Lombardi's `pnpm` scripts.

## 0.3.0 — 2026-10-01

### Added

- The Sigillo wrapper (Lombardi's `scripts/sigillo/sigillo-run.mjs` and
  `sigillo-cli.mjs`) as `gq sigillo`: `run <environment> -- <command>`,
  `login`, `setup <environment>` and `secrets <environment> [arguments...]`.
  The project, API URL and environments come from `gq.ops.json` `sigillo`; a
  missing or placeholder value is a configuration error. The argv-safe form,
  per-command injection, bootstrap scrubbing and re-entry guard carry over;
  the guard variable is now the site-neutral `GQ_SIGILLO_REENTRY`. `setup`
  and `secrets` refuse `download` and `--mount` (also as `--mount=<path>`).
- `exec` accepts `stdio: "inherit"` for children that need the terminal; a
  child killed by a signal then exits 128 + the signal number.

### Changed

- `run()` resolves to a wrapped command's own exit code.

### Not carried over

- The wrapper's Windows `sigillo.cmd`/`npx.cmd` lookup, which could not run:
  `exec` spawns without a shell, and Node refuses `.cmd` files then.

## 0.2.0 — 2026-10-01

### Added

- The release and version commands of the vendored `shop-devtools`
  (Lombardi's copy) under `gq`, still reading the site's
  `shop-devtools.config.mjs`: `gq version check|sync [version]`,
  `gq release prepare [version]`, `gq release tag [version]`, and
  `gq release push <major|minor|fix> [--no-deploy]`. They replace
  `shop-devtools check|sync`, `prepare`/`release`, `tag` and `push`. Every git,
  check and deploy command runs through `run()`'s `exec`.
- `exec` forwards a child's output to `stdout`/`stderr` streams passed in its
  options as it arrives, so a release's checks and pushes stream as before.

### Changed

- `release prepare` covers both `shop-devtools prepare` and
  `shop-devtools release`, which differed only in the closing hint; it always
  prints it, naming `gq release tag`.
- File paths in the release config resolve from the site root (the directory
  with `gq.ops.json`), not the current directory.

### Fixed

- `release push` leaves a blank line between the new changelog entry and the
  previous one.

### Not carried over

- `docsChangelogPath` (the Starlight docs changelog page) and the legacy
  `wrangler` deploys, which Lombardi no longer used. A release config that
  still sets `docsChangelogPath` is an error rather than silently ignored.

## 0.1.1 — 2026-10-01

### Fixed

- The README describes the published package: install, configuration,
  commands, `run()`, and releasing.
- `exec` no longer crashes the process when a child exits without reading
  its input, and decodes output as UTF-8 so multibyte characters survive
  chunk boundaries.
- `run()` rejects a call without `stdout` and `stderr` up front instead of
  failing while reporting another error.
- `release:publish` stops with a clear message when a `git` check fails,
  instead of reading a failed `git status` as a clean tree.

## 0.1.0 — 2026-09-30

First release: `gq-ops` 0.1.0 (`Quick-Release/gq-ops@d972d12`) as the `gq` bin
of `@getquick/site`.

### Added

- `run(argv, { cwd, env, fetch, exec, stdout, stderr })`, the in-process entry
  point behind `gq`. It resolves to the exit code; commands read no
  `process.env` or `process.cwd()`, and every provider request and child
  process goes through the injected `fetch` and `exec`.
- A fixture-site test harness (`test/support/fixture-site.mjs`): a temporary
  Git repository with a `gq.ops.json`, and recording `fetch` and `exec` fakes.
- `pnpm release:publish`, which publishes a tagged version with `NPM_TOKEN`
  from Sigillo.

### Carried over from gq-ops, unchanged

- `gq context show`, `gq ploi …` (including all 225 `ploi api` operations),
  `gq cloudflare …`, and `gq github actions sync`, with the same forms, output,
  and `gq.ops.json` discovery.

### Changed

- Without `XDG_CONFIG_HOME` or `HOME` in `env`, no machine `gq/ops.env` is read.
- Ploi requests identify as `getquick-site/<version>` instead of
  `gq-ops/<version>`.

### Removed

- `gq credentials configure`, which wrote provider tokens to `.env`; sites
  inject them per command from Sigillo instead.
- `gq test post-deploy`, which only ran a site's own `pnpm gq test post-deploy`
  script.

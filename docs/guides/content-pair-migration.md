# Move an existing Site onto the content package pair

A Site generated before `@getquick/site` 0.20.0 runs a copy of the content
runtime: `gq new` wrote it into the Site once, and the Site may have changed
it since. New Sites run the pair from Quick-Release/gq-content instead: the CMS
plugin `getquick/gq-content` and the npm package `@getquick/content`, pinned
to one version
([ADR 0020](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0020-wire-new-content-sites-to-the-gq-content-package-pair.md)).
This guide moves an existing Site onto the pair at the blueprint's pin,
0.4.2. Nothing moves it
for you: until its `gq.ops.json` says `"contentRuntime": "package"`, `gq sync`
leaves the copy alone.

The move keeps the Site's data. The CMS plugin uses the copy's options, post
meta, WP-CLI commands and crontab line (`wp gq-events retry-due`), so delivery
history and pending retries carry over. The package's five D1 migrations have
the copy's file names and bytes, so the publication store's migration history
carries over and nothing is reapplied. The Worker's bindings and secrets
(`PUBLICATION_DB`, `FRONTEND_REFRESH_TOKEN`, `PUBLICATION_EVENT_SECRET`, the
GraphQL client) keep their names.

Do the whole move on one branch and release it as one: the CMS can't load the
plugin beside its copied mu-plugins, and the Frontend's managed routes import
`src/lib/content.ts`, which the copy doesn't have.

## 1. Upgrade and opt in

1. Upgrade `@getquick/site` to 0.20.0 or later in the root `package.json`.
2. Add `"contentRuntime": "package"` to `gq.ops.json`.
3. Add `"@getquick/content"` to `minimumReleaseAgeExclude` in
   `pnpm-workspace.yaml` if it isn't there (it is created once, so a Site
   older than 0.19.1 lacks it), so a pair released today installs.

## 2. Delete the copied runtime

Delete these files, whether or not the Site changed them. Carry any change
the Site made over first (section 4).

Frontend, in `apps/frontend`:

- `migrations/` (all five `000N_*.sql`). The deploy takes the store's
  migrations from the Site's own `migrations/` whenever it exists, and only
  otherwise from the installed `@getquick/content`; deleting the directory is
  what switches the deploy to the package
  (`infra/frontend.run.ts`, `infra/scripts/deploy-frontend.mjs`).
- `src/pages/gq/events.ts` and `src/pages/gq/refresh.ts`, and
  `src/pages/gq/consent.ts` and `src/pages/gq/consent/[...rest].ts` if the
  Site composed consent by hand. On a Site on the pair they are managed files. gq never recorded the copies in `gq.lock.json`,
  so while they exist `gq sync` treats them as local edits, names them and
  writes nothing.
- `src/lib/delivery.ts`, `events.ts`, `publications.ts`, `reconciliation.ts`,
  `runtime.ts`, `site-language.ts`, `wordpress.ts`, `wp-block-renderer.ts`,
  `wp-block-styles.ts`, `wp-container-layout.ts`.
- Their tests: `src/lib/site-language.test.ts`, `wordpress.test.ts`,
  `wordpress-access.test.ts`, `wp-block-renderer.test.ts`,
  `wp-block-styles.test.ts`, `wp-container-layout.test.ts`, and in `src/`
  `entries.test.ts`, `events.test.ts`, `homepage.test.ts`,
  `language-updates.test.ts`, `languages.test.ts`, `reconciliation.test.ts`,
  `retries.test.ts`, `settings.test.ts`, `withdrawals.test.ts`. The
  package's own tests prove that behaviour now. Delete their helper
  `src/test/sqlite-d1.ts` too, unless a test the Site keeps still uses it
  (say, one that proves the Site's own pages through a refresh): then keep
  it, and point it at the package's migrations
  (`@getquick/content/migrations`) instead of the deleted directory. The
  package doesn't export a D1 test store.

CMS, in `apps/cms/web/app/mu-plugins`: `publication-events.php`,
`settings-events.php` and `delivery-retries.php`. The plugin declares the
same PHP namespace, so WordPress stops if both load.

## 3. Sync and configure

1. If `apps/frontend/package.json` already depends on `@getquick/content` (a
   Site that adopted consent added 0.1.0 by hand), set it to exactly the
   blueprint's pin (`0.4.0`) or remove it. gq sync takes over a pin that
   already matches; a different one is the Site's own, and gq sync stops on
   it as a local edit.
2. Run:

   ```sh
   gq sync --recreate apps/frontend/src/lib/content.ts
   ```

   This writes the two `/gq` route adapters and sets both pins
   (`require.getquick/gq-content` in `apps/cms/composer.json`,
   `dependencies.@getquick/content` in `apps/frontend/package.json`).
   `src/lib/content.ts` is a create-once skeleton file, written only into a
   new Frontend, so an existing one gets it only through `--recreate`. It
   configures the runtime from `gq.ops.json` (identity, languages, CMS
   origin), the build environment and the Worker's bindings. If sync still
   names a file as edited, that file is a copy step 2 missed.

   A Site coming from a blueprint older than 0.19.1 also gets the consent
   files from this sync: `infra/consent.ts`,
   `apps/frontend/workers/consent-purge.ts` and the consent wiring in
   `infra/frontend.run.ts`. Every Site has them, but they create resources
   only once `@getquick/content` is installed, which this move does (see
   section 5).

3. Add the Site's identity to `apps/cms/config/application.php`, which is
   created once too, so sync doesn't touch it:

   ```php
   // The Site its events are for: gq.ops.json's project, the identity the
   // Frontend's content runtime accepts (apps/frontend/src/lib/content.ts).
   Config::define('GQ_CONTENT_SITE_ID', '<project>');
   ```

   The copied mu-plugins had it as a constant; the plugin refuses to sign
   events without it.

4. `composer update getquick/gq-content` in `apps/cms` and `pnpm install`,
   then commit both lockfiles.
5. `gq sync --check` passes once both pins agree.

## 4. Port the Site's pages and its runtime changes

The pages, layout, components and words stay the Site's. Wherever they
imported the deleted files, they now use the package: the runtime's
methods through `content()` from `src/lib/content.ts`, and its helpers from
`@getquick/content`. Find each import with
`grep -rnE "lib/(delivery|wordpress|wp-block-styles|wp-block-renderer|wp-container-layout|site-language|publications|runtime|events)" apps/frontend/src`.

| The copy's                                                                                              | The pair's                                                  |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `publishedHome`, `publishedEntry`, `pageChrome` (`lib/delivery`)                                        | `content().publishedHome`, `.publishedEntry`, `.pageChrome` |
| `routeOf`, `formatDate`, `responseStatus`, `blockPresetStyles`, types such as `SiteChrome`, `Alternate` | the same names from `@getquick/content`                     |
| `frontendBindings` (`lib/runtime`)                                                                      | the `bindings` `content.ts` passes the runtime              |

The skeleton's own pages show the result: compare the Site's
`src/pages/index.astro`, `[...slug].astro`, `components/Home.astro` and
`layouts/Layout.astro` with the templates in
`node_modules/@getquick/site/blueprint/templates/apps/frontend/src/`.

A change the Site made to the copied runtime moves into the Site's own code.
The pair (since 0.2.0) covers the changes a Site made to show its own content
([gq-content ADR 0004](https://github.com/Quick-Release/gq-content/blob/v0.2.0/docs/adr/0004-carry-a-sites-own-content-as-a-typed-extension.md)):

- **Fields of its own on pages and posts** (a block tree a plugin exposes as
  JSON, a page setting), which the copy added to its WPGraphQL queries and
  stored rows: pass `createContentRuntime<X>` an `extension` in
  `src/lib/content.ts`:
  - `fields: { page?, post? }`, the GraphQL selections added to front pages
    and pages, and to posts (`"wpBlocksJson"`); they are read with the blocks;
  - `read(node)`, the Site's value from `node.fields` (and `node.kind`), or
    undefined for none;
  - `parse(stored)`, that value read back from JSON, or undefined when the
    Site can't serve it.

  It is stored with the publication and served as `entry.extension`, and as
  `home.page.extension` for a front page, through outages like the rest of
  the page.

- **Design presets for a page that isn't a publication** (a block preview):
  `content().designPresets()`.
- **Internal link origins**: `content().internalOrigins(siteOrigin)`.
- **Preset classes under another container, or on `:root`**:
  `blockPresetStyles(spacing, colors, scope)` and
  `presetRootStyle(spacing, colors)` from `@getquick/content`.

A change the pair has no seam for belongs in gq-content: raise it there before
moving the Site. The Site's tests of what it renders stay; tests of the
copied runtime go with it.

## 5. Release, then refresh the whole Site

Release the CMS and the Frontend together, as one Site release. Then, right
after the Frontend deploy:

```sh
pnpm frontend:refresh   # gq sigillo run staging -- gq frontend refresh
```

with no `--uri`, so it refreshes the whole Site. Rows the copy stored keep
serving, but without the Site's extension: the copy stored its own content
under its own key, which the package doesn't read, and rows stored before an
extension existed serve without one. Until the refresh re-stores every page,
pages render without the Site's own content. The command exits 1 until every
front page and the site chrome are stored, so a script can wait on it.

Then check:

- `gq frontend events check`: the Frontend accepts the CMS's signed events.
- `wp gq-events version` on the CMS prints the pinned version (`0.4.0`), and `wp gq-events status`
  shows no stuck deliveries.
- `pnpm doctor` and `pnpm site:check`.

Installing `@getquick/content` also opts the Frontend into consent: the first
deploy with it creates the Site's EU consent database, purge Worker and rate
limiter ([ADR 0019](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0019-record-visitors-consent-in-a-separate-eu-database.md)).
Run `pnpm frontend:secrets` before that deploy, so `CONSENT_READ_TOKEN`
exists; [Consent and legal pages](consent.md) covers the rest.

## Upgrading a Site already on the pair

A Site on the pair moves to a new version of it by upgrading
`@getquick/site` and running `gq sync`, which sets both pins; then
`composer update getquick/gq-content` in `apps/cms` and `pnpm install`, and
commit both lockfiles. Each version's notes are in gq-content's
`docs/releases/`. What a version asks of the Site beyond that is below.

### 0.2.0 to 0.3.0 (`@getquick/site` 0.22.0)

0.3.0 serves the header and footer editors select in GQ Design's Header &
Footer with the site chrome, as `chrome.header` and `chrome.footer`
([gq-content ADR 0006](https://github.com/Quick-Release/gq-content/blob/v0.3.0/docs/adr/0006-serve-cms-selected-header-and-footer-patterns-with-site-chrome.md),
[release notes](https://github.com/Quick-Release/gq-content/blob/v0.3.0/docs/releases/0.3.0.md)).
There is no new D1 migration.

1. **Require GQ Design 0.4.1 or newer.** The blueprint then required
   `getquick/gq-design` at `*@stable` (it pins an exact version since
   0.29.0), so the Site's `composer.lock` decides its version: `composer update getquick/gq-design` in `apps/cms` if it is
   older. With GQ Design 0.2.17 to 0.4.0 both regions are null and the Site
   keeps its own header and footer; before 0.2.17 the chrome is still served,
   both null, with a warning that names the version needed.
2. **Render the regions in the layout.** `layouts/Layout.astro` is created
   once, so `gq sync` doesn't change an existing Site's. Port what the
   blueprint's layout now does
   (`node_modules/@getquick/site/blueprint/templates/apps/frontend/src/layouts/Layout.astro`):
   render each with `content().renderDesignPattern(chrome?.header, { siteOrigin, home, blocks, onUnrendered })`,
   and keep the Site's own header or footer when it returns an empty string.
   A Site block in a pattern that has no saved HTML (a menu-backed
   navigation block such as `getquick/header-navigation`) renders only
   through a renderer the Site passes in `blocks`; see
   `@getquick/content`'s README, "Header and footer patterns".
3. **Fix chrome stubs and fixtures.** `SiteChrome.header` and `.footer` are
   required. A test that builds a `SiteChrome` adds `header: null, footer: null`;
   so does a stubbed WordPress that answers the `SiteChrome` query, or the
   chrome read fails its schema check (`header: Required; footer: Required`).
4. **Release, then refresh the whole Site.** A Site release deploys the CMS
   before the Frontend, so the CMS's new `patterns` settings event (and
   `archives`, for collections) can reach the old Frontend first; it is
   refused and retried. Rows 0.2.0 stored serve both regions as null until
   the next chrome refresh, so run `pnpm frontend:refresh` with no `--uri`
   after the deploy, as in section 5.

Patterns aren't per language yet: every language is served the same
selection ([gq-design #53](https://github.com/Quick-Release/gq-design/issues/53)).

### 0.3.0 to 0.3.1 (`@getquick/site` 0.23.1)

The grid fix needs both the paired runtime upgrade and its shared stylesheet.
Upgrade the root `@getquick/site` dependency,
run `pnpm install`, `pnpm exec gq sync`, then `pnpm install` again and
`composer update getquick/gq-content` in `apps/cms`. Commit both lockfiles
and check `pnpm exec gq sync --check`. Let sync update the managed runtime
keys; do not edit those keys by hand.

**Existing Sites must also edit their own layout.** `Layout.astro` is
create-once, so sync does not add this wiring. In its frontmatter add:

```ts
import { designGridStyle } from "@getquick/content";
```

Render the CSS once inside the document's `<head>`:

```astro
<style is:inline set:html={designGridStyle()} />
```

Use the same wiring in another shared layout if the Site owns a different
document shell. The stylesheet covers both chrome and content, including
grids outside `.prose-wp`; do not copy the grid rules into site styles.
New Sites receive this wiring in the layout skeleton.

Release the CMS and Frontend together through the Site's release workflow.
No CMS resave or data migration is required. Existing configured column
counts remain in force: three desktop columns with two children leave an
empty third track. Adjust the editor setting only if the design calls for
two columns.

### 0.3.1 to 0.3.2 (`@getquick/site` 0.23.2)

Upgrade the root `@getquick/site` pin to `0.23.2`, run `pnpm install`, then
`pnpm exec gq sync`. Sync updates both managed content keys to exactly `0.3.2`;
there is no per-Site version override. Run `pnpm install` again and, in
`apps/cms`, `composer update getquick/gq-content getquick/gq-design --with-all-dependencies`.
The paired CMS release requires Design `0.9.0`; verify both installed versions
and review any Site-owned Design constraint through its normal package policy. Review
and commit `gq.lock.json`, `pnpm-lock.yaml` and `apps/cms/composer.lock`, then
check `pnpm exec gq sync --check`. Install the published packages through the
normal registries; local preview archives are not release dependencies.

**Adopt Site-owned presentation wiring deliberately.** Sync does not rewrite
create-once layouts, pages, runtime configuration or styles. Compare the new
starter's `Layout.astro`, `Home.astro`, `[...slug].astro` and `global.css` with
the Site's equivalents. Compose the resolved publication theme through shared
`designThemeStyleSheet`, `presentationStyleSheet`, `navigationStyleSheet`,
`designCarouselStyle` and `videoHeroStyleSheet`; use `.gqd-content` for body
and selected chrome. Use the shared `design/client` mounts for navigation,
Carousel, Hero and Cover videos, with cleanup/remount in the Site lifecycle.
Remove superseded local Container/Hero appearance rules after reviewing the
Site's intended design. Do not copy a model, parser or playback policy into
the Site. Tailwind is pinned to exactly `4.3.3` in new starter output.

Supply authorized post context with `designPostContext` only when neutral
blocks were delivered. Site title/description come from already loaded public
home settings, with an explicit frontend home URL. Preload producer-selected
standard Post/Page Query records outside synchronous rendering; do not apply
offset/order/count again or infer an unsupported CPT loader.

This adopts neutral Base/upward presentation and scoped reset defaults, with
deliberate appearance changes: no implicit Container centering/padding and no
implicit Hero viewport breakout/foreground centering. Check the Site's actual
saved body, selected chrome, theme/breakpoints, native layout, links, consent
and reduced-motion behavior. Supporting contexts and media tests are not new
CMS editor captures or proof of every dynamic layout. Release the CMS and
Frontend together through the Site's normal workflow; a blueprint upgrade
does not deploy either half.

### 0.3.2 to 0.4.0 (`@getquick/site` 0.24.0)

Upgrade the root `@getquick/site` pin to `0.24.0`, run `pnpm install`, then
`pnpm exec gq sync`. Sync updates both managed content keys to exactly
`0.4.0`. Run `pnpm install` again and, in `apps/cms`,
`composer update getquick/gq-content`. Review and commit `gq.lock.json`,
`pnpm-lock.yaml` and `apps/cms/composer.lock`, then check
`pnpm exec gq sync --check`.

0.4.0 adds headless Gravity Forms, and nothing changes for a Site that
doesn't opt in: no migration, no new binding and no new route. Its CMS
module stays dormant without Gravity Forms. To use forms, follow
[Headless Gravity Forms](forms.md). Release the CMS and the Frontend together.

### 0.4.0 to 0.4.2 (`@getquick/site` 0.26.0)

Upgrade the root `@getquick/site` pin to `0.26.0`, run `pnpm install`, then
`pnpm exec gq sync`. Sync updates both managed content keys to exactly
`0.4.2`. Run `pnpm install` again and, in `apps/cms`,
`composer update getquick/gq-content`. Review and commit `gq.lock.json`,
`pnpm-lock.yaml` and `apps/cms/composer.lock`, then check
`pnpm exec gq sync --check`.

0.4.2 adds `trustedProxies` to the form and consent servers, for a Frontend
behind an external proxy (`domains.frontendProxy`, see
[A Frontend behind an external proxy](provisioning.md#a-frontend-behind-an-external-proxy)).
Their rate limits now key an IPv6 visitor by its /64, with or without a
proxy. Nothing else changes: no migration, no new route, and no new binding
for a Site without `frontendProxy`. Release the CMS and the Frontend together.

## Rolling back

Revert the branch and release it. The CMS rolls back its code (its options
and post meta are the ones the copy used), and the Frontend's restored
`migrations/` have the names already applied. The copy doesn't read the
package's `extension` key either, so refresh the whole Site again after the
rollback deploy.

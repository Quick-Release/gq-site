# {{Project}} Frontend

Astro, server-rendered on Cloudflare Workers, reading published content from
the CMS (`../cms`) through WPGraphQL. Its Worker is declared in
`../../infra/frontend.run.ts` and deployed by Alchemy, not Wrangler.

## Development

From the workspace root:

```sh
pnpm install
cp apps/frontend/.env.example apps/frontend/.env   # or: pnpm setup
pnpm dev
```

`PUBLIC_WORDPRESS_GRAPHQL_URL` in `.env` points at the CMS's GraphQL endpoint
(`https://{{project}}-admin.ddev.site/wp/graphql` with `pnpm cms:dev`). With no
CMS running, `pnpm dev` renders a placeholder front page, so the Frontend can be
built before the CMS exists.

## Missing and unavailable content

`src/lib/wordpress.ts` reads the CMS and says what each read established:
`found`, `missing` (WordPress answered, with valid data, and has nothing
published there) or `unavailable` (a timeout, unreachable CMS, HTTP or GraphQL
error, or an answer without the GETQUICK fields the Frontend requires). Pages
answer `responseStatus()`: 200, 404 for missing content and 503 for
unavailable content, never a 404 for a CMS failure. Outside `pnpm dev`, a page
that can't be served is a 503 too. In `pnpm dev`, when only the menu, logo and
icon can't be read, the page is still served without them. Each unavailable
read is logged with its reason.

## Durable published content

The deployed Frontend serves the front page, the entries (published pages and
posts) and the site chrome (menu, logo, icon, site identity, design presets)
from its publication store, a D1 database bound as `PUBLICATION_DB`
(`../../infra/frontend.run.ts`). `src/lib/delivery.ts` decides what is served
and what may be stored; `src/lib/publications.ts` is the store: one row per
publication (`home`, `chrome`, `design`, `entry:<route>`), with the `format` of its body,
the WordPress entry it holds and when its CMS read started, so an older read
never replaces a newer one. `migrations/` holds its schema, which Alchemy
applies on deploy: add a new numbered file for a change, and keep it
compatible with the Worker version it replaces.

A refresh fills the store: `pnpm frontend:refresh` from the workspace root
(`gq frontend refresh`), which posts to `/gq/refresh` (`src/pages/gq/refresh.ts`)
with `FRONTEND_REFRESH_TOKEN`. Without `--uri` it prepares the whole Site: the
front page, the chrome, and every page and post WordPress lists as published
or the store already holds. `--uri /about/` refreshes only that entry, such as
a new publication or a renamed one. Each complete, valid read is promoted; a
failed one keeps the stored version, so pages outlive CMS outages, restarts
and redeploys without an age limit. Until a refresh has stored the front page
and the chrome, pages are a 503. `/gq/` is reserved for these endpoints.

- A stored entry is served without reading the CMS. One WordPress confirmed
  missing is a 404; one published at another route now redirects there (301).
- An entry the store has never held is looked up in the CMS on the visit
  (the cold lookup): published, it is stored and served; confirmed missing, it
  is a 404 and nothing is stored; if the CMS fails, a 503, never a 404. An
  unreadable store is a 503 without reading the CMS.
- Only public content is stored: reads are anonymous, and an entry WordPress
  returns password-protected or unpublished is missing.

The CMS refreshes an entry when an editor publishes or updates it: its
publication event, signed with `PUBLICATION_EVENT_SECRET`, arrives at
`/gq/events` (`src/pages/gq/events.ts`), and `src/lib/events.ts` checks the
signature, the Site and the action, records the event in the store
(`publication_events`) and refreshes the entry's route, and the route it left
if it moved. A duplicate isn't processed twice, an event older than one
already refreshed for the same entry is superseded, and one whose refresh
failed stays recorded as failed while the stored version is still served.
Each action has its own handler there.

A shared setting's change (the CMS's `settings` event for the menus, the logo,
the site's identity or the design presets) refreshes only the shared rows
every page is served with: the chrome, the front page (its title and tagline)
or `design`, the presets every page uses once a refresh has stored them. So it
reaches the homepage and every entry without re-reading them. Each setting's
events are ordered on their own, like an entry's, and a failed read keeps the
stored menus, branding and design.

When an editor unpublishes, password-protects, trashes or deletes an entry,
the CMS sends a `withdraw` event instead. The Frontend makes every route of
that entry a 404 at once, without reading the CMS (`withdrawEntry` in
`src/lib/delivery.ts`). It records the withdrawal in `withdrawals`, and the
store refuses to promote that entry again, whatever a read returns, until a
publication that happened later lifts it. Pages answer with
`Cache-Control: no-cache`; don't put a cache in front of the store that could
outlive a withdrawal.

The CMS retries an event (a publication, a withdrawal or a setting) the Frontend didn't confirm (its
`delivery-retries.php`, on the server's cron) by sending the same event again,
signed anew, so a failed event is processed again and the rules above still
order it. The Frontend has no scheduler of its own.

Each of those cron runs also sends a signed `reconcile` event, which catches a
change whose own event was never sent (`src/lib/reconciliation.ts`). The
Frontend reads the shared rows and WordPress's list of published entries (id,
URI, modification time), compares them with the store (`modified_at`,
migration `0005_reconciliation.sql`), and refreshes what differs: a new, changed,
moved or removed entry, or a withdrawn one WordPress modified after its
withdrawal. A changed entry is processed as a publication event dated by its
modification time, so the rules above still order it. A run makes at most 40
CMS requests and leaves the rest for the next minute. A lease keeps runs from
overlapping, and the last outcome is kept in `reconciliation`, which the signed
`check` event reports. A failed read keeps what is stored, and an incomplete
list removes nothing.

The `check` answer also says what the store holds, in states and counts only
(the front page's, the chrome's and the design presets' states, entries by
state, withdrawals in force and failed events), so `pnpm site:check`
(`gq site check`) can tell a prepared Site from a Worker that merely answers.

`pnpm dev` has no store: it reads the CMS live, as before.

## Languages

A bilingual Site lists its other languages in `gq.ops.json`
(`wordpress.languages`, beside the default `wordpress.locale`), and its CMS
runs Polylang with GQ Polylang for WPGraphQL. `src/lib/site-language.ts`
reads them when the Frontend is built. A route's language is its first
segment when that is another language's slug (`/en/about/` is English), and
the default language otherwise; `/en/` is English's home, served by
`src/pages/[...slug].astro` as `/` is by `index.astro`
(`src/components/Home.astro`).

- **Store.** The default language keeps `home` and `chrome`; each other
  language has `home:<slug>` and `chrome:<slug>`, its front page (with the
  title and tagline in that language) and its menus. `design` is shared, and
  entries stay `entry:<route>`, each stored with its language and its
  translations, so rendering needs no CMS read. A whole-Site refresh reads
  every language's front page and chrome.
- **Rendering.** Each page has its language's `<html lang>`, chrome and home
  link, `<link rel="alternate" hreflang>` to each published translation (plus
  `x-default`, the default language's), and a language switcher to them, or
  to the other language's home when there is none. The Frontend's own words
  (the 404, "Temporarily unavailable", the placeholders) are in
  `src/lib/copy.ts`, in English and Portuguese.
- **No fallback.** A route with no entry in its language is a 404, even
  when another language has the page, and so is every page of a language
  whose home the store has never held.

A monolingual Site has none of this: its pages, store and CMS reads are as
they were.

## Blocks

`src/lib/wp-block-renderer.ts` renders the GETQUICK Design blocks WPGraphQL
Blocks returns (the Video Hero; containers through `wp-container-layout.ts`),
and `wp-block-styles.ts` turns the CMS's spacing and color presets into the
CSS saved block classes need. It is the site's own copy of the renderer, so
change it here; a shared renderer package is planned.

## Checks

`pnpm check` (`astro check`), `pnpm lint` (`vp lint`) and `pnpm test`
(`vp test`) run from the workspace root, and in `pnpm verify`. `src/routes.test.ts`
renders the pages through Astro's Container API against a stubbed CMS
(`vitest.config.ts` gives Vitest Astro's Vite config); `src/homepage.test.ts`,
`src/entries.test.ts`, `src/events.test.ts`, `src/settings.test.ts`,
`src/withdrawals.test.ts`, `src/retries.test.ts`,
`src/reconciliation.test.ts` and `src/languages.test.ts` (a bilingual Site)
drive the durable homepage, entries, publication
events, shared settings, withdrawals, the CMS's retries and reconciliation
through refreshes, outages, restarts, new and moved publications, refused,
duplicate, delayed, racing, failed, retried and missed events, with the store
on SQLite (`src/test/sqlite-d1.ts`, the same migrations and SQL).

## Deploys

Releases deploy the Frontend from the `v*` tag in Cloudflare CI
(`infra/ci`). Deploys build with `PUBLIC_WORDPRESS_GRAPHQL_URL` set to
`https://<domains.admin>/wp/graphql` from `gq.ops.json`; `pnpm deploy:frontend`
redeploys by hand with the token in Sigillo `staging`.

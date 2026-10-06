# ADR 0013: Serve each language from its own shared rows

- Status: Accepted
- Date: 2026-10-04

## Context

[#66](https://github.com/Quick-Release/gq-site/issues/66) makes a content Site
bilingual: Portuguese by default at `/`, English under `/en/`, with Polylang
(Pro) in the CMS and [GQ Polylang for WPGraphQL](https://github.com/Quick-Release/gq-polylang-graphql)
for GraphQL. `gq.ops.json` declares the languages beside the default
(`wordpress.languages`), and a Site without them is monolingual.

On their own, ADRs 0003 to 0010 describe one language:

- [ADR 0003](0003-serve-published-content-from-a-durable-store.md) and
  [ADR 0004](0004-serve-entries-from-the-store-with-a-cold-lookup.md) store one
  `home` (the front page, with the site's only title and tagline) and one
  `chrome` (the only menu), and a route resolving to the front page moves to
  `/`.
- [ADR 0005](0005-refresh-publications-through-signed-cms-events.md)'s events
  send `/` for the front page, and `/` refreshes the one front page.
- [ADR 0007](0007-refresh-shared-settings-through-settings-events.md)'s
  settings events name a setting but no language. They watch the plain
  `blogname` and `blogdescription` options and the theme's menu locations.
  Polylang keeps each language's menu locations in its own `polylang` option
  (`nav_menus`), the theme's mods holding only the default language's, and
  the title and tagline's translations in each language term's
  `_pll_strings_translations` meta.
- [ADR 0009](0009-reconcile-missed-changes-on-the-cms-scheduler.md) budgets
  three shared reads per run.
- [ADR 0010](0010-declare-a-new-content-site-ready-through-one-readiness-gate.md)
  requires one front page and one chrome, and fetches only `/`.

GQ Polylang for WPGraphQL resolves `nodeByUri("/en/")` to the English front
page (`uri: "/en/"`, `isFrontPage: true`), translates the title and tagline
in `language(code:)`, reads a language's menu with
`menuItems(where: { location, language })`, and returns every language from
a connection without a `language` filter. It resolves a URI only to content
in that URI's language.

## Decision

- **Per-language rows.** The default language keeps `home` and `chrome`, so a
  monolingual Site needs no migration. Each other language has `home:<slug>`
  and `chrome:<slug>`: its front page, title and tagline, and its menus.
  `design` stays shared, and entries stay `entry:<route>`, since `/en/…`
  routes are already distinct. Each page is served with its own language's
  rows.
- **No fallback across languages.** A route with no entry published in its
  language is a 404, even when another language has the page. Every page of
  a language whose home the store has never held is a 404 too.
- **A language's front page is at its home.** `/` for the default language,
  `/<slug>/` for the others. A route resolving to one moves to that home
  (`/en/home/` → `/en/`). Withdrawing it withdraws that language's home only.
- **Entry events name their language.** A publish or withdraw event's `entry`
  carries `language` (Polylang's slug), and its `uri` is in that language's
  directory. A language's front page sends its home, `/<slug>/`, not `/`,
  since Polylang filters `page_on_front` per language: the CMS finds it among
  the static front page's translations. The Frontend refreshes that
  language's `home` for a home URI, and the entry otherwise. It refuses an
  entry whose language isn't its URI's, so a CMS with a language the
  Frontend doesn't serve has its events retried and reported, never stored
  in another language.
- **Settings events name the language a change is in.** A language has its
  own menus and its own title and tagline:
  - its menu locations changed (`nav_menus` in the `polylang` option, or the
    theme's mods for the default language), or a menu assigned in it saved:
    `menus` with `language`, which refreshes only that language's chrome;
  - its string translations changed: `identity` with `language`, which
    refreshes only that language's home.

  The logo, the icon, the design, the site's own `blogname` and
  `blogdescription` (which a language without a translation shows) and a
  deleted menu are shared: their events name no language and refresh every
  language's rows. Polylang moves every language's translations when the
  site's own title or tagline changes; that change sends only the shared
  event. The Frontend refuses a language on `logo` and `design`, and one it
  doesn't serve.

- **Each language's settings are ordered apart.** A language's change is
  recorded as `setting:<name>:<slug>` (`node_id`), and in the CMS as the
  option `gq_settings_event_<name>:<slug>`. ADR 0005's duplicate, supersede
  and retry rules apply per setting and language. `wp gq-events settings`
  and ADR 0008's retries list and resend them.
- **Readiness covers every language.**
  - A whole-Site refresh reads every language's home and chrome, is `ready`
    only once all of them are stored, and reports the others under
    `languages`. `gq frontend refresh` lists each language.
  - The signed check reports the other languages' rows as `store.languages`.
  - `gq site check`:
    - asks the CMS for its `languages` and requires each the manifest
      declares;
    - validates each language's front page, `language(code:) { title
description }` and menu, and the entries' `language` and
      `translations`;
    - requires every language's home and chrome in the store, naming the one
      missing, and every language's front page published: a language without
      one has no way in, so unlike a monolingual Site's, it isn't a warning;
    - fetches `/` and each `/<slug>/` (`homepage-<slug>`), each required to
      answer 200.
- **Reconciliation reads every language.** A run's shared reads are the
  design and each language's home and chrome: 1 + 2 per language (3 for a
  monolingual Site). The 40-request budget holds, so fewer entries are
  caught up per run, which its `pending` count shows. `contentNodes` asks
  for `language: ALL`, so translations are reconciled too.

## Considered options

- **Falling back to the default language.** Serving `/en/sobre/` from the
  Portuguese page would hide a missing translation from editors and give
  search engines duplicate content under two languages. The requester chose
  a 404.
- **Keying the default language's rows by its slug too (`home:pt`).** It
  would be uniform, but every monolingual Site's store would need a
  migration, and the default language has no directory to key by.
- **One settings event per change, listing the languages.** The record has
  one subject per event, as ADR 0007 decided for settings, so a combined
  event couldn't be ordered or superseded per language.
- **Treating every settings event as shared.** It is simpler, but a menu
  reassigned in English would re-read every language's chrome, and a lost
  English event couldn't be retried apart from a Portuguese one.
- **Reading only the changed language in reconciliation.** WordPress can't
  say which language's shared settings changed, so each run compares them
  all, as ADR 0009 does for one.

## Consequences

- A Site that adds a language adopts the Frontend and the CMS's
  `publication-events.php`, `settings-events.php` and `delivery-retries.php`
  from a new site's skeleton, since they are site-owned.
- Until both are deployed, an English event a monolingual Frontend receives
  is refused (its URI is in the default language there), and the CMS
  retries it.
- Each language adds two CMS reads to every reconciliation run, and two to a
  shared settings event.
- Every string translation of a language (not only the title and tagline)
  sends that language's `identity` event: one extra read of its home.
- Polylang versions before 3.4 keep string translations in `polylang_mo`
  posts, which aren't watched. GQ Polylang for WPGraphQL requires Polylang
  3.7.
- This amends ADRs 0003, 0004, 0005, 0007, 0009 and 0010 wherever they say
  "the" front page, chrome, title or homepage: on a multilingual Site, each
  language has its own.

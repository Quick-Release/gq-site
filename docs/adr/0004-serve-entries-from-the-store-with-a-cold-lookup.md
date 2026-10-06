# ADR 0004: Serve entries from the store, with a cold lookup

- Status: Accepted (design presets amended by
  [ADR 0007](0007-refresh-shared-settings-through-settings-events.md); each
  language's chrome, and its front page at its own home, amended by
  [ADR 0013](0013-serve-each-language-from-its-own-shared-rows.md))
- Date: 2026-10-02

## Context

[ADR 0003](0003-serve-published-content-from-a-durable-store.md) made the
publication store serve the homepage and the shared chrome. [#42](https://github.com/Quick-Release/gq-site/issues/42)
extends it to the supported entries, WordPress's published pages and posts,
each at its own route. Unlike the homepage, entries come and go: a refresh has
to learn which routes exist, a new publication has to become available, a
renamed entry must stop being presented at its old route, and a request for a
route the store has never held has to be answered honestly. #42 asks for a
cached entry to be served without reading the CMS, for an uncached one to be a
503 while the CMS or the store is unavailable (an empty store is no evidence of
absence), and for the healthy cold path to be explicit.

## Decision

- **One row per route.** An entry is stored at `entry:<route>`, the route
  percent-decoded and between slashes, in the same `publications` table, with
  the same ordering rule (`read_started_at`) and body `format`. Migration
  `0002_entries.sql` adds `node_id`, the WordPress entry a row holds
  (WPGraphQL's global id), so a withdrawal can find every route that served an
  entry ([ADR 0006](0006-withdraw-publications-through-signed-cms-events.md)). An entry's body keeps the design presets it was read with; menu, logo
  and icon come from the shared `chrome` row, which an entry needs to be
  served (without it, the Site is not ready: 503).
- **Preparation is a whole-Site refresh.** `POST /gq/refresh` with `{}` (`gq
frontend refresh`) reads the front page, the chrome, WordPress's list of
  published pages and posts (`contentNodes`, paged, anonymous) and then every
  listed route plus every route the store already holds, so a removed or moved
  entry is reconciled and a changed shared setting reaches every entry. A
  failed list still refreshes the stored routes and removes none.
- **Targeted refresh.** `{"uris": ["/about/"]}` (`gq frontend refresh --uri
/about/`, up to 100) refreshes only those routes: the path a publication
  event takes for a new or changed publication
  ([ADR 0005](0005-refresh-publications-through-signed-cms-events.md)).
- **Cold lookup.** A visit to a route with no row, on a Site whose chrome is
  stored and whose store is readable, reads that one entry from the CMS,
  anonymously: published and complete, it is promoted and served; confirmed
  missing, it is a 404 and nothing is stored (anyone can make up a URL); a CMS
  failure is a 503. A stored entry is never read from the CMS on a visit, and
  an unreadable store is a 503 without one. This amends ADR 0003's "a visit
  never reads the CMS" for this one case.
- **Moves redirect.** When a refresh or lookup finds an entry at a route other
  than the ones that served it, those older rows become `moved` and their
  routes answer `301` to the new one (`Cache-Control: no-store`, since a later
  refresh can change it), including a route WordPress confirms empty. A
  route that resolves to the front page moves to `/`. A row read since the
  refresh started is never rewritten as moved.
- **Only public content.** An entry WordPress returns as restricted
  (password-protected) or with a status other than `publish` is missing
  content, not stored content. Reads send no visitor cookies or credentials.
- **Accepted state is servable.** A read is promoted only if its body parses
  with the shape this Frontend serves, so nothing the renderer can't read is
  accepted.

## Considered options

- **No cold lookup; 404 for routes missing from the last complete list.** No
  visit would read the CMS, but a publication made after the last refresh
  would be a 404 during an outage, the failure #42 rules out.
- **A cold lookup that doesn't store.** No visitor writes, but every visit to
  a new entry would read the CMS until a refresh, and it couldn't outlive an
  outage.
- **A 404 for a moved entry's old route.** Simpler, but WordPress itself
  redirects a renamed post's old slug, and a redirect keeps links working.
- **Design presets in a shared row.** It would change the homepage row's
  format; a whole-Site refresh already brings every entry's presets up to date.

## Consequences

- A request for a made-up URL reads the CMS once. A flood of them is load on
  the CMS, not on the store.
- A whole-Site refresh makes at least one CMS request per entry from one Worker
  invocation, so a site with many entries can reach Workers' per-invocation
  subrequest limit (50 on the Free plan); refresh such sites by `--uri`.
- Without an event, a new publication is available through the cold lookup;
  an update to a stored entry, a removal or a move is visible after a refresh.
  Publication and withdrawal events
  ([ADR 0005](0005-refresh-publications-through-signed-cms-events.md),
  [ADR 0006](0006-withdraw-publications-through-signed-cms-events.md)) and
  reconciliation ([ADR 0009](0009-reconcile-missed-changes-on-the-cms-scheduler.md))
  are those refreshes.

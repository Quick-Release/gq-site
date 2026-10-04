# ADR 0010: Declare a new content Site ready through one readiness gate

- Status: Accepted; amended by [ADR 0013](0013-serve-each-language-from-its-own-shared-rows.md)
  (a bilingual Site is ready only when every language exists in the CMS and
  its front page, chrome and homepage are served)
- Date: 2026-10-03

## Context

[ADR 0003](0003-serve-published-content-from-a-durable-store.md) to
[ADR 0009](0009-reconcile-missed-changes-on-the-cms-scheduler.md) built
spec [#38](https://github.com/Quick-Release/gq-site/issues/38)'s guarantee
piece by piece: a publication store, entries with a cold lookup, signed
publication, withdrawal and settings events, retries on the CMS's cron,
reconciliation every minute, and independent media (`gq media check`). Each
slice proved its own part on a disposable generated Site.

[#48](https://github.com/Quick-Release/gq-site/issues/48), the last slice,
asks for the whole path: a Site creator follows the Blueprint's flow and gets
a production-ready website, and "ready" must not be mistaken for something
weaker. Several weaker signals were within reach and each is wrong:

- **The Worker answering.** A deployed Frontend whose store was never filled
  answers every page with a 503 (ADR 0003). An HTTP 200 on `/robots.txt`, or
  even the signed check event, says nothing about the store.
- **DDEV or the CMS running.** A started CMS can be uninstalled, have
  WPGraphQL inactive, or lack the fields the GETQUICK plugins and theme add.
  `gq cms status` only reports DDEV's startup.
- **A matching title.** The phase 2 smoke gate compared the CMS's title with
  the Frontend's. Since ADR 0003 the Frontend can serve last-known-good
  content whatever the CMS says, so a match no longer proves the parts are
  wired, and a mismatch isn't a fault.
- **Configuration present.** A key in Sigillo isn't a key bound to the
  Worker; a crontab line isn't a cron that runs; a media bucket isn't an
  upload path (`gq media check` already separates "configured" from "ready").

Two provisioning gaps also blocked the flow:

- The Frontend's deploy token ("Staging Alchemy") had no D1 permission, so a
  deploy couldn't create the publication store or apply its migrations.
- `FRONTEND_REFRESH_TOKEN` and `PUBLICATION_EVENT_SECRET` had to be made by
  hand (`openssl rand`), and `gq new`'s sequence ran `ci:deploy` before them,
  so CI releases deployed the Frontend without them.

## Decision

- **`gq site check` is the gate.** It runs through `gq sigillo run staging`
  (`pnpm site:check`), exits 1 until every check passes, and reports per
  check what holds and what to run next. It composes the existing proofs,
  each observed where it can be:
  - **CMS:** WordPress answers GraphQL at `https://<domains.admin>/wp/graphql`
    (a redirect to `install.php` is "not installed"; a non-GraphQL answer is
    "WPGraphQL inactive"). Then every field the Frontend skeleton's queries
    read is sent in one query, each field with `@skip(if: true)`: GraphQL
    validates skipped fields against the schema without resolving them, so
    the CMS's own validator proves the fields exist and nothing is read.
    Missing fields are attributed to gq-design, wpgraphql-blocks or
    getquick-theme. A package test keeps the query in step with the
    skeleton's queries.
  - **Frontend:** the signed `check` event (ADR 0005) proves the event key and
    the store are bound. Its answer now also reports the store: the front
    page's, the chrome's and the design presets' states, entries by state,
    withdrawals in force and failed events; states and counts only, never
    content. The front page and the chrome must be stored in a servable
    format. The refresh token is proven by asking for a refresh of an empty
    list of routes, which the Frontend refuses with 400 only after accepting
    the token, so nothing is refreshed. The homepage must answer 200 with
    `Cache-Control: no-cache` and no edge cache hit (ADR 0006).
  - **Event delivery:** the Frontend's last reconciliation matched WordPress
    within ten minutes. Only the CMS's cron (ADR 0008, 0009) sends the signed
    `reconcile` event, so this one observation proves the cron runs
    `retry-due`, the CMS holds the right key and Frontend URL, and the store
    matches WordPress's published list. Failed events are reported as delays
    (a warning: visitors keep the last good content). Ploi must show the
    CMS's `.env` with this Site's key and the every-minute crontab.
  - **Independent media:** `gq media check --upload`, always. A URL on the
    media host is never taken as evidence without an upload read back.
- **Preparation stays explicit.** The gate never refreshes. A Site is
  prepared by `gq frontend refresh` (a whole-Site refresh, repeatable), and
  the gate reports an unprepared store as not ready with that command.
- **Local readiness is separate.** `gq site check --local` runs the CMS
  checks against this machine's DDEV CMS (after DDEV is running and
  `apps/cms/.env` names it) and the local media check. It says nothing about
  production.
- **Provisioning closes its gaps.** The deploy token gains `D1 Read` and
  `D1 Write`; `gq cloudflare deploy-token` adds missing permissions to an
  existing token in place, keeping its value. `gq frontend secrets` generates
  the two Frontend secrets into Sigillo staging when missing or too short.
  `gq new` prints the order that works: `frontend:secrets` before
  `ci:deploy`, `ploi:events` with the other provisioning, then releases,
  `frontend:refresh`, `media:check:upload` and `site:check`.
- **Two acceptance gates.** The deterministic one runs without accounts or
  secrets: the package's tests, the generated Frontend's tests and checks,
  the workerd runtime proof, and the real-WordPress proof, which now also
  walks the readiness transitions with the public WPGraphQL plugin
  (`scripts/smoke/acceptance.sh`). CI runs the generated Frontend's checks and
  the workerd runtime proof on every push. The live one is the gq-smoke
  wizard's stages 18 to 22: the gate, then a publication, a shared setting, a
  lost event, a prolonged CMS outage (the Ploi site suspended), a withdrawal
  and a redeploy, against the real CMS and Worker
  (`scripts/smoke/live-acceptance.mjs`).

## Considered options

- **A status endpoint on the Frontend, authenticated by the refresh token.**
  It would avoid the empty-refresh probe, but it adds a route and gives the
  refresh token a second meaning. The check event already carries the
  reconciliation, and its key is the one whose binding matters most.
- **Introspection (`__schema`) instead of skipped fields.** It works too, but
  matching nested types and enum values by hand re-implements GraphQL's
  validation; WPGraphQL can also disable public introspection.
- **Parsing the site's own queries out of `wordpress.ts`.** It would follow a
  site that changed its queries, but the CLI would depend on a site-owned
  file's text. The skeleton's fields, kept in step by a test, are the
  supported surface (spec #38's scope is new content Sites).
- **Refreshing as part of the check.** One command fewer, but a gate that
  changes what it checks can't tell "prepared" from "prepared just now", and
  a refresh is CMS load the operator should choose.
- **Requiring a Cloudflare Cron Trigger or Frontend-side scheduler evidence.**
  ADR 0009 chose the CMS's cron; the reconciliation record is the evidence it
  leaves on the Frontend.

## Consequences

- A Site is "ready" only with the CMS check user's application password in
  Sigillo, since the media upload is part of the gate.
- The first `site:check` after a release can fail for a minute: the first
  reconciliation comes with the cron's next run.
- A Frontend from before this slice answers the check without `store` and is
  reported as not ready ("predates gq site check"). Existing Sites aren't
  migrated; they adopt by copying `src/lib/events.ts` and
  `src/lib/publications.ts`.
- The ten-minute freshness window is the same as ADR 0009's Site Health
  warning, wider than the five-minute target: the gate is about the
  mechanism running, not a timing measurement.
- Unverified live until the wizard's stages run: Cloudflare's names for the
  D1 permission groups, the deploy with a D1 store on the pinned Alchemy,
  the GETQUICK schema against the `@skip` validation, Ploi's suspend and
  resume as an outage, and the timings on a real cron.

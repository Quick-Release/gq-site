# ADR 0009: Reconcile missed changes on the CMS's scheduler

- Status: Accepted; amended by [ADR 0013](0013-serve-each-language-from-its-own-shared-rows.md)
  (the shared reads are the design and each language's front page and
  chrome; the entries of every language are listed)
- Date: 2026-10-03

## Context

[ADR 0005](0005-refresh-publications-through-signed-cms-events.md),
[ADR 0006](0006-withdraw-publications-through-signed-cms-events.md) and
[ADR 0007](0007-refresh-shared-settings-through-settings-events.md) push each
publication, withdrawal and shared-setting change to the Frontend as a signed
event. [ADR 0008](0008-retry-event-delivery-from-the-cms-on-a-server-cron.md)
retries an event the CMS recorded but the Frontend didn't confirm.

Some changes are never recorded at all, so nothing retries them:

- a hook didn't fire;
- a plugin or a script changed the database without WordPress's save path;
- a request died before recording its event;
- a setting changed through a path the settings hooks don't cover.

[#47](https://github.com/Quick-Release/gq-site/issues/47) asks for the Frontend
to converge to the CMS within a five-minute target while the CMS and refresh
are healthy. It must not depend on visitors or on WP-Cron. During outages it
must keep the last good content and must not invent withdrawals. After
recovery it must follow the same promotion, ordering and withdrawal rules as
events. Change detection must not rely only on modification times.

What the stack allows (checked on the pinned build):

- **No scheduled handler on the Frontend Worker.** The Alchemy Astro build
  (`@alchemy.run/frontend-frameworks` 2.0.0-beta.79) pins the Worker's `main`
  to its vendored `@astrojs/cloudflare` entry, which exports only `fetch`. A
  Cloudflare Cron Trigger would need a second Worker that calls the Frontend.
- **Few Cron Triggers on the Free plan.** It allows five per account, which a
  fleet of Sites would exhaust.
- **A verified scheduler already exists.** It is the CMS's server cron (ADR
  0008): every minute, as the site's user, verified with a real cron daemon in
  `scripts/smoke/cms-events.sh`, reported in Site Health when it stops.
- **50 subrequests per invocation on the Free plan.** A whole-Site refresh is
  one CMS read per entry (ADR 0004), so it can't run every minute on a large
  Site.
- **WPGraphQL lists published entries cheaply.** `contentNodes` gives each one's
  `id`, `uri` and `modifiedGmt`, 100 per request. Shared settings have no
  modification time.

## Decision

- **The CMS's scheduler triggers it; the Frontend reconciles.**
  - Each `wp gq-events retry-due` run (ADR 0008's crontab) sends
    the Frontend a signed `reconcile` event after its retries. It uses the
    same envelope, key and endpoint as every event, with a 60-second timeout.
  - The event names nothing. It can only make the Frontend read published
    content and promote what it reads by the usual rules, so the CMS's key
    gains no new authority over content.
  - `wp gq-events reconcile` asks for a run at once.
  - The `gq_events_reconcile` filter turns it off.
- **What a run compares.**
  - **Shared rows.** The front page (with the title and tagline), the chrome
    and the design presets are read every run. Each read is compared with the
    stored row, as canonical JSON. Only a difference is promoted. This compares
    what visitors would see, so a shared-setting change is caught however it
    was saved.
  - **Entries.** WordPress's list of published pages and posts (`id`, `uri`,
    `modifiedGmt`) is compared with the stored entries. Each row also
    keeps the `modified_at` its read saw (migration `0005_reconciliation.sql`).
    The run refreshes:
    - an entry listed but not stored (**new**);
    - an entry stored at another route (**moved**: the old route is refreshed
      too, and redirects);
    - an entry stored with another id or modification time (**changed**);
    - a stored, published entry that isn't listed (**removed**). Only a read
      that confirms it missing makes it a 404;
    - a withdrawn entry that WordPress modified after its withdrawal
      (**republished**).
  - **Re-reads.** Two stored entries are re-read each run, least recently
    refreshed first, when the budget allows. A change that didn't move the
    modification time is caught eventually, though not within the target on a
    large Site.
- **Same rules as events.**
  - A changed, new, moved or republished entry becomes a publication event
    and goes through the same code (`applyPublication`):
    - its `occurredAt` is WordPress's modification time;
    - its id is derived from the entry, URI and time (`reconcile-<hash>`), so
      a repeated or interrupted run retries the same record;
    - a duplicate, an older event and a withdrawal are judged as for an event
      the CMS sent.
  - A removal or a re-read is a refresh of the route.
  - So:
    - an older scan can't lift a withdrawal: only a modification after it can;
    - work in flight can't undo a withdrawal: `promote` refuses a withdrawn
      entry in the same statement as the write;
    - a failed read keeps what is stored;
    - an incomplete or failed list removes nothing.
- **Budget, lease and record.**
  - A run makes at most 40 CMS requests. That covers three shared reads, the
    list's pages, and two per entry read, since WordPress failing on blocks is
    asked again.
  - What doesn't fit waits for the next run, least recently refreshed first.
    The run reports `behind`.
  - A one-row lease in D1 (`reconciliation`, two minutes) keeps runs from
    overlapping. An interrupted run's lease expires.
  - The row also keeps the last outcome (`reconciled`, `behind` or `failed`),
    its counts and its first failure, and when the store last matched
    WordPress.
- **Diagnostics.**
  - **Frontend.** It answers 200 for `reconciled`, `behind` or `busy`, and
    503 with the first failure for `failed`. The signed `check` event's answer
    includes the last reconciliation, which `gq frontend events check`
    prints.
  - **CMS.** It records each run in `gq_reconciliation`. `wp gq-events
delays` shows it. Site Health turns "recommended" when the Frontend hasn't
    matched WordPress for ten minutes.
  - Neither shows content or a secret.

## Considered options

- **A Cloudflare Cron Trigger on a second, scheduler Worker.** This is
  independent of the CMS's server, and the Frontend never depends on the CMS
  for timing. But it means a new resource per Site, a secret to bind to it, and
  one of five Free-plan triggers per account. A missed change also needs a
  readable CMS, whose server is the one running the cron.
- **CMS-side detection** (fingerprints of what was last delivered, sent as
  ordinary events). It needs no new Frontend logic. But the CMS can't see what
  the Frontend holds, so it can't repair a store that diverged for another
  reason, and the fingerprints would duplicate the Frontend's reads.
- **A whole-Site refresh every minute.** It is simple and catches everything.
  But it costs one CMS read per entry per minute, exceeds the subrequest
  limit past about 40 entries, and adds that load to the CMS.
- **Modification times for shared settings.** WordPress keeps none for
  options, menus' locations or global styles. Comparing what is read is exact.
- **A fingerprint field on WPGraphQL's entries.** It would catch changes that
  leave `modifiedGmt` alone, but it adds a schema dependency on the CMS
  skeleton. The re-reads cover that more slowly.

## Consequences

- **Timing.** With the cron healthy, a change no event delivered is public at
  the next minute's run, or later when more than about 18 entries changed at
  once. Measured: one run in the rendered tests; 96 seconds from the change
  to a stored page with a real cron daemon and a real WordPress
  (`scripts/smoke/cms-events.sh`, which polls every five seconds). This is a target
  under controlled conditions, not a promise. A stopped cron (reported by ADR
  0008's Site Health test), an unreachable Frontend or an overloaded CMS delays
  it.
- **CMS load.** Every minute there are four CMS requests (three shared reads
  and the list) plus two entry re-reads, and D1 writes only for what changed
  or was re-read. Each request is an anonymous GraphQL read the CMS already
  serves.
- **Limitations.**
  - A change that leaves `modifiedGmt` and the shared reads alone (such as a
    replaced media file at the same URL, or a reusable block) is caught only
    by the rotating re-reads. A Site with N entries takes about N/2 minutes.
  - A withdrawal whose event was lost becomes a `missing` 404 once WordPress
    confirms it, not a recorded withdrawal. A cached CMS answer that still
    returns the entry delays it.
  - The list alone takes one request per 100 entries. A Site with more than
    about 3,700 published entries spends the whole budget on it and never
    catches up, so it would need a larger budget (a paid plan) or a cheaper
    list.
  - Workers' 10 ms CPU limit on the Free plan is not proven for a run's
    rendering of many entries, as for any refresh.
- **Records.** Each change found adds one row to `publication_events`, like an
  event. A run interrupted after promoting leaves its record `received`; the
  store is already right, so nothing retries it.
- **Existing Sites.** They adopt this by copying the migration, the Frontend
  modules and the updated `delivery-retries.php` and `publication-events.php`.
  Their stored entries have no `modified_at` until a refresh reads them again,
  so their first runs re-read every entry, 18 per run.
- **Unverified live.** Cloudflare's enforcement of the subrequest and CPU
  limits on a deployed Worker, and the real WPGraphQL `modifiedGmt` on
  GETQUICK's schema. The proofs use a stub GraphQL that follows WPGraphQL's
  documented fields.

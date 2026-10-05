# ADR 0006: Withdraw publications through signed CMS events

- Status: Accepted; amended by [ADR 0009](0009-reconcile-missed-changes-on-the-cms-scheduler.md)
  (reconciliation lifts a withdrawal only for a modification WordPress made
  after it)
- Date: 2026-10-02

## Context

[ADR 0005](0005-refresh-publications-through-signed-cms-events.md) refreshes a
content site's publication store when an editor publishes a page or post. The
store keeps last-known-good content without an age limit
([ADR 0003](0003-serve-published-content-from-a-durable-store.md)), so it would
also keep serving a page the editor unpublished or deleted.
[#44](https://github.com/Quick-Release/gq-site/issues/44) asks for a received
unpublish or delete to stop serving that content at once, even while the CMS
is offline. Duplicate, delayed and racing work must not bring it back, and a
newer, authorised republication must be able to.

Two facts shaped the decision:

- A refresh can't be the authority for a withdrawal. It needs the CMS, and an
  answer from a CMS that still returns the entry (from a cache in front of
  it, or because it was read just before the withdrawal) would restore it.
- The store's ordering rule, `read_started_at`, orders reads by the
  Frontend's clock. It can't by itself tell an older read from a newer one
  once a withdrawal has been made without any read.

## Decision

- **A withdrawal is its own signed event.** The CMS plugin sends `withdraw`
  when a published page or post stops being public:
  - unpublished to another status (draft, pending, private, scheduled or
    trash);
  - given a password (on every save while it has one);
  - deleted outright while published (`before_delete_post`).

  The event has the same envelope, signature, Site check and recording as a
  publication. Its `entry` is `{ id, uri }`, where `uri` is the path the
  entry had while it was published. A deleted entry's record lives in the
  option `gq_publication_events_deleted` until it is delivered, since its
  post meta is deleted with it.

- **The Frontend withdraws without reading the CMS.** The authority is the
  event's signature and the entry's durable identity (WPGraphQL's global id).
  In one D1 transaction (`batch`), the Frontend:
  - records the withdrawal in `withdrawals` (migration `0004_withdrawals.sql`),
    one row per entry;
  - marks every row holding the entry `withdrawn`, whether it serves the entry
    or redirects for it;
  - marks the event's URI `withdrawn` too, even when the store never held it
    there, so a cold lookup can't fetch it, unless another entry is stored
    there.

  A `withdrawn` row is a 404. Every other publication is untouched.

- **A withdrawal in force is checked on every promotion.** `promote` refuses,
  in the same SQL statement as the write, any row for an entry whose
  withdrawal is in force. This covers a publication event's refresh, an
  operator's whole-Site or targeted refresh, a cold lookup and a front page
  read (the home query asks for the page's `id`). The refusal is
  reported as `{ "outcome": "withdrawn" }`. So nothing can bring the entry
  back while the withdrawal is in force:
  - a stale CMS answer;
  - an in-flight read that started before the withdrawal;
  - a duplicate delivery;
  - a Worker restart.

  A withdrawn row also takes the acceptance time as its `read_started_at`,
  so an older read can't replace it even after a republication.

- **Order is the CMS's.** Withdrawals and publications of one entry are
  ordered by their `occurredAt`.
  - A publication older than an applied withdrawal is superseded, never
    processed: ADR 0005's rule, since an applied withdrawal is recorded
    `refreshed`.
  - A withdrawal older than any recorded publication of the entry (whatever
    that publication's status) is superseded and changes nothing.
  - A withdrawal older than the one in force changes nothing.
  - A publication newer than the withdrawal lifts it (`republished_by`,
    `republished_at`) before its refresh. The entry then refreshes normally.
    If that refresh fails, the routes stay 404 until the retry succeeds.
  - A later withdrawal applies again.
- **No cache in front of the store.** The homepage and entry pages answer
  with `Cache-Control: no-cache`. A browser or proxy may keep a copy, but it
  must ask the Worker again before reusing it. The Worker's own reads go to
  D1 without the Sessions API, so they go to the primary database and see
  each committed withdrawal. The guarantee is therefore: once the Frontend
  has answered 200 to a withdraw event, every later visit is a 404. It is not
  "eventually, once an invalidation has propagated".

## Considered options

- **Withdraw by refreshing the route.** Needs the CMS, so it fails during an
  outage. A stale answer would restore the entry.
- **Delete the rows.** Then the route has no row, so a visit makes a cold
  lookup and a refresh promotes again. Nothing would remember the withdrawal.
- **A tombstone only on the rows (`state` with `read_started_at`).** Orders
  by the Frontend's clock, so a read that starts after the withdrawal, from
  a CMS that still returns the entry, would win. The entry-level record
  orders by the CMS's own time and survives the rows being re-read.
- **Treating a password as an ordinary publication**, which the refresh reads
  as missing. A stale answer could still restore the content, so a password
  is a withdrawal.
- **An edge cache with purge-on-withdrawal.** Purges propagate eventually, and
  a failed purge would keep serving withdrawn content.

## Consequences

- A withdrawal takes effect within the event's round trip. If the event
  never reaches the Frontend and the CMS is down too, the Frontend keeps
  serving the entry. This is the limitation spec #38 accepts. Once the CMS is
  back, reconciliation
  ([ADR 0009](0009-reconcile-missed-changes-on-the-cms-scheduler.md)) makes
  the entry a 404 when WordPress confirms it missing.
- If a republication's event is lost, the entry stays a 404, the safe
  direction. Updating or republishing it again, or `wp gq-events retry
<post>`, sends a newer event. Reconciliation can lift a withdrawal only
  through the same ordering rules.
- Rolling the Worker back to a version before `0004` loses the promotion
  check. That version serves `withdrawn` rows as a 503, never as content, but
  its refreshes could replace them. Roll back only together with a
  whole-Site refresh after the CMS is consistent.
- `withdrawals` holds one row per entry ever withdrawn. Nothing prunes it,
  like `publication_events`.
- When a withdrawal and a publication of one entry happened in the same
  millisecond, the withdrawal wins.

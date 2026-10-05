# ADR 0008: Retry event delivery from the CMS on a server cron

- Status: Accepted; amended by [ADR 0009](0009-reconcile-missed-changes-on-the-cms-scheduler.md)
  (each `retry-due` run also asks the Frontend to reconcile)
- Date: 2026-10-02

## Context

[ADR 0005](0005-refresh-publications-through-signed-cms-events.md) and
[ADR 0007](0007-refresh-shared-settings-through-settings-events.md) send a
signed event to the Frontend when an editor publishes an entry or changes a
shared setting. Publishing never waits on it. When the event can't be sent, or
the Frontend can't read WordPress back, the previous version stays served and
the CMS records the failure: per entry in post meta (`_gq_publication_event`),
per setting in an option (`gq_settings_event_<setting>`). Without a scheduler,
only an operator's `wp gq-events retry` sends it again.

[#46](https://github.com/Quick-Release/gq-site/issues/46) asks for:

- retries that run without visitor traffic, on a scheduler that really runs;
- recovery from sender, receiver and CMS-read failures without republishing;
- reporting that tells an editor public delivery is delayed, without a new
  dashboard;
- one mechanism for publications, settings and
  [#44](https://github.com/Quick-Release/gq-site/issues/44)'s withdrawals.

What the stack provides:

- **WP-Cron is not a scheduler here.** Production's `.env` sets
  `DISABLE_WP_CRON='true'`, and a Ploi server has no crontab that runs
  WordPress's scheduled events. WP-Cron would only run on visits anyway.
- **Ploi** manages per-server crontabs through its API
  (`POST /servers/{server}/crontabs`: user, command, frequency). Its servers
  have WP-CLI in `/usr/local/bin`, and a site lives in
  `/home/<system user>/<domain>`.
- **A Cloudflare Cron Trigger** on the Frontend would run without visits too.
  But it is unverified on the pinned Alchemy Astro build (the Worker's entry
  is Astro's). And it couldn't recover a dispatch failure: an event that
  never reaches the Frontend leaves nothing there to retry.

## Decision

- **The CMS retries, by resending the recorded event.** A site-owned
  must-use plugin, `web/app/mu-plugins/delivery-retries.php`, reads every
  delivery on record as one list, whatever the event's action:
  - entries from publication-events.php's records, publications and
    [ADR 0006](0006-withdraw-publications-through-signed-cms-events.md)'s
    withdrawals alike: post meta, or `gq_publication_events_deleted` for an
    entry deleted outright;
  - settings from settings-events.php's options;
  - another kind of event through the `gq_events_deliveries` filter.

  A retry sends the same event, with the same id and `occurredAt` and a fresh
  signature, through the same `deliver()`. So the Frontend's
  duplicate, supersede and `read_started_at` rules (ADR 0005) order it:
  a retry can't overwrite a newer publication or undo a newer withdrawal. The
  same retry recovers a dispatch failure (`network`, `rejected`,
  `not-configured`) and a receiver-side one (`refresh`, including a CMS
  read that failed), so the Frontend needs no scheduler of its own.

- **When a delivery is due.**
  - A failed one: after 1, 2, 5, 10 and 30 minutes, then hourly, up to 12
    attempts (about seven hours).
  - Then it is **failed**: reported, not retried. An operator's
    `wp gq-events retry`, a newer event for the same subject, or
    reconciliation ([ADR 0009](0009-reconcile-missed-changes-on-the-cms-scheduler.md))
    delivers it.
  - A **pending** one whose own request ended before sending it (a killed PHP
    worker): two minutes after it was queued.
  - Each attempt is counted on the record. The served version is never
    touched by a failure.
- **The scheduler is the server's cron.**
  - `wp gq-events retry-due` sends what is due, oldest first. It spends at
    most 45 seconds starting sends, leaving the rest for the next run.
  - A lock row (`gq_events_retry_lock`, taken with `INSERT IGNORE`, expiring
    after five minutes) keeps overlapping runs from sending the same events.
  - Each run records itself in `gq_events_scheduler`. Without a run in five
    minutes, the scheduler counts as not running, and the reports say so.
  - `gq ploi events` adds the Ploi crontab beside the key: every minute, as
    the site's system user,
    `cd /home/<user>/<domain>/apps/cms && PATH="/usr/local/bin:$PATH" wp gq-events retry-due --quiet`.
    It is idempotent, `--dry-run` shows it, and it warns about an existing
    crontab that runs less often.
  - WP-Cron is not used.
- **Editors see delivery apart from publication.** Without a new screen:
  - **The block editor** shows a notice when an entry opens, and again after
    each save, while the save's event is delivered (a small REST route,
    `gq-events/v1/entries/<id>`, for users who can edit the entry). The states
    are: being delivered; saved but not yet public, with the reason in plain
    words and the next retry; failed after its attempts; and recovered, with
    the time.
  - **The classic editor** shows the same as an admin notice.
  - **The page and post lists** mark entries "Public update pending",
    "delayed" or "failed".
  - **The Dashboard, the lists, Menus, Themes and General Settings**
    summarise delayed entries and settings.
  - When the scheduler isn't running, editors are told to ask the operator
    rather than promised a retry.
- **Operators get diagnostics without secrets.**
  - Site Health has a "Public website delivery" test. It is critical for a
    failed delivery, or in production when events are configured but the
    scheduler hasn't run.
  - `wp gq-events delays` lists each undelivered, or recently recovered,
    delivery: subject, action, event id, state, reason, attempts, next attempt
    and message. It also shows the scheduler's last run.
  - Neither shows the key, the event's body or content.
  - A refresh failure records the Frontend's own reason (such as
    `network: WordPress couldn't be reached`), not only "HTTP 503".
    Those messages come from the Frontend's anonymous reads.

## Considered options

- **WP-Cron driven by `wp cron event run --due-now` from a system cron.** It
  is the usual WordPress pattern. But it would also start every other
  plugin's scheduled events, which don't run in production, as a side
  effect. A command of our own does one thing.
- **A Cloudflare Cron Trigger retrying the Frontend's failed events.** It
  can't recover an event the Frontend never received. It needs runtime
  support unverified on the pinned build, and a second retry path beside the
  CMS's.
- **Action Scheduler or a queue table in the CMS.** It needs a runner too, and
  the records ADR 0005 and 0007 keep already hold the one event per subject
  that matters.
- **Retrying forever.** It is simpler, but a misconfigured Site would retry
  hourly without anyone noticing. Bounded attempts make the failure an
  explicit, reported state, and the last good version stays served anyway.
- **Editor notices only on page load.** It is less code. But in the block
  editor, which doesn't reload after publishing, an editor wouldn't learn of a
  delay until they left the page.

## Consequences

- A delivery that fails while publishing is retried within about a minute of
  its delay, without visits or republishing. The Frontend keeps the last good
  version until a retry succeeds.
- A Site without the crontab gets no automatic retries. Site Health, `delays`
  and the editor notices say so. `gq ploi events` installs it; existing Sites
  run it once after copying the plugin.
- A failure lasting more than about seven hours stops being retried. It stays
  reported until an operator, a newer event or reconciliation delivers it.
- The cron's `wp` runs every minute. A run with nothing due reads the records
  and writes `gq_events_scheduler`.
- Withdrawals (ADR 0006) are retried like publications, including a deleted
  entry's from its option. Another kind of event recorded elsewhere joins
  through `gq_events_deliveries`.
- Unverified live: the Ploi crontab API and its command on a real server,
  `wp` on cron's PATH there, and the block editor notices against the real
  GETQUICK admin.

# ADR 0022: Run WordPress's scheduled events from a server cron

- Status: Accepted; amends [ADR 0008](0008-retry-event-delivery-from-the-cms-on-a-server-cron.md)
  (its "WP-Cron is not used")
- Date: 2026-11-12

## Context

Production CMSs render `DISABLE_WP_CRON='true'`, so a visit never spawns
WP-Cron. [ADR 0008](0008-retry-event-delivery-from-the-cms-on-a-server-cron.md)
gave delivery retries their own crontab (`wp gq-events retry-due`) and
rejected `wp cron event run --due-now`, because it would also start every
other scheduled event, which didn't run in production. Nothing else runs
them, so on every Site:

- a scheduled post or page never publishes;
- core's own events never fire: emptying the trash, deleting expired
  transients, `wp_version_check` and the other update checks, Site Health's
  scheduled tests;
- plugins' events never fire: GQ Design's font updates, and on a commerce
  Site WooCommerce's Action Scheduler (its queue runs on WP-Cron), so
  emails, webhooks and scheduled sales wait forever.

Those events not running is a defect, not a guarantee to keep.

WP-Cron's own trigger is a loopback request to `wp-cron.php`. Sites put the
CMS behind Cloudflare Access (Quick-Release/southside-bnq puts the whole CMS
hostname behind it), so a self-request would get Access's login page. And it
would still need traffic to start it.

## Decision

- **The server's cron runs WordPress's due events through WP-CLI.** Every
  Site's CMS on Ploi has a second crontab beside the retry one: every minute,
  as the site's system user,
  `cd /home/<user>/<domain>/apps/cms && PATH="/usr/local/bin:$PATH" flock -n /home/<user>/.gq-wp-cron-<domain>.lock wp cron event run --due-now --quiet`.
  It runs WordPress in-process, so Access and the loopback don't matter.
  `DISABLE_WP_CRON` stays `true`: visits still never start WP-Cron.
- **Every minute.** WordPress's events are due at a time, not on a fixed
  cadence, so the cron's interval is how late one runs: a post scheduled for
  09:00 goes public by 09:01. WooCommerce's Action Scheduler registers an
  every-minute event; a five-minute cron would make its queue five times
  slower. A run with nothing due boots WordPress, reads the `cron` option and
  exits, which the retry crontab already does every minute.
- **`flock -n` keeps runs from overlapping.** WP-CLI runs due events without
  WP-Cron's `doing_cron` lock, so a slow event (an Action Scheduler batch, a
  remote update check) still running a minute later would start again in the
  next run. `flock -n` on a per-site lock file skips that minute instead; the
  next free run picks up whatever is due. The lock lives in the system user's
  home, outside the site and its releases. `flock` is util-linux's, on cron's
  default `PATH` on Ploi's Ubuntu servers.
- **Its own crontab, not the retry one.** The retry crontab is a content
  Site's and spends up to 45 seconds sending; chaining WP-Cron after it would
  delay both and let a slow event block delivery. A commerce Site has no
  retry crontab but needs WP-Cron most.
- **`gq ploi provision` adds it,** for every variant, idempotently: it plans
  `+ WP-Cron crontab` when the server has no crontab with that user and
  command, keeps one that exists, and warns about one that runs less often
  than every minute. `gq ploi events` keeps only the retry crontab.
- **`gq site check` reports it** as `cms-cron` (area `cms`) on content and
  commerce Sites alike: not ready without it, or when it runs less often than
  every minute, saying to run `pnpm ploi:provision`.
- **`gq offboard` cuts and restores it** beside the retry crontab: the cut
  deletes it and records it in `offboarded.cut.wpCronCrontab`, and
  `--restore` re-adds it.

## Considered options

- **A loopback request to `wp-cron.php` (WordPress's default, or a cron
  `curl`).** Access answers it with its login page, and an Access service
  token for it would be another per-Site secret to rotate.
- **One crontab running both commands.** It saves a WordPress boot a minute,
  but couples delivery to every other plugin's events, and a commerce Site
  has no retry command.
- **Every five minutes.** Cheaper, but scheduled posts are up to five
  minutes late and Action Scheduler's queue slows down, for a saving the
  every-minute retry crontab already spends.
- **A lock in WordPress instead of `flock`.** WP-CLI's `cron event run`
  takes none, and a lock option outlives a killed run; `flock` is released
  when the process ends.

## Consequences

- Scheduled posts, core's cleanups and update checks, and plugins' events
  (GQ Design's font updates, Action Scheduler) run on every Site within a
  minute of being due, with or without visits.
- The delivery retries stay on their own command and lock (ADR 0008):
  nothing in their scheduling changes.
- Events that never ran in production now do, on the first run after a Site
  adopts this, including any backlog that has been due since the Site went
  live. A plugin's event is now part of its production behaviour.
- An existing Site adopts it by upgrading `@getquick/site` and running
  `pnpm ploi:provision` (`--dry-run` first shows only the new crontab on a
  Site with no drift).
- Unverified live until the first adopter: Ploi creating a crontab whose
  command uses `flock`, and `wp cron event run` from cron on a Site behind
  Access.

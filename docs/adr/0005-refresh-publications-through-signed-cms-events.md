# ADR 0005: Refresh publications through signed CMS events

- Status: Accepted; amended by [ADR 0006](0006-withdraw-publications-through-signed-cms-events.md)
  (withdraw events; a password-protected entry is withdrawn, not refreshed)
  and [ADR 0009](0009-reconcile-missed-changes-on-the-cms-scheduler.md) (a
  signed `reconcile` event asks the Frontend to compare the whole store with
  WordPress) and [ADR 0010](0010-declare-a-new-content-site-ready-through-one-readiness-gate.md)
  (the `check` event's answer also reports the store's states and counts)
  and [ADR 0013](0013-serve-each-language-from-its-own-shared-rows.md) (an entry's event names its language; a language's front
  page is at its home, `/en/`)
- Date: 2026-10-02

## Context

[ADR 0003](0003-serve-published-content-from-a-durable-store.md) and
[ADR 0004](0004-serve-entries-from-the-store-with-a-cold-lookup.md) serve a
content site's published content from its publication store. Without events,
only an operator's `gq frontend refresh` updates it.
[#43](https://github.com/Quick-Release/gq-site/issues/43) asks for an editor's
publication of a page or post to refresh the Frontend without a deploy. The
event path has to be authenticated and Site-scoped. It has to establish event
identity, ordering and a recoverable record that the later slices build on:
withdrawals ([#44](https://github.com/Quick-Release/gq-site/issues/44)), shared
settings ([#45](https://github.com/Quick-Release/gq-site/issues/45)), and
retries and delay reporting ([#46](https://github.com/Quick-Release/gq-site/issues/46)).
Publishing must succeed even when the event or the refresh fails.

The owned CMS packages were inspected first:

- `gq-config` purges Cloudflare's cache on demand.
- `getquick-design` fires `getquick_design_cache_invalidated` (layout tags)
  and `getquick_design_published` (templates only). Nothing listens to either.
- `gq-support` signs requests to its own support service (Ed25519).
- `getquick-theme` has no relevant hooks.

None of them sends a publication of a page or post anywhere, and none has an
outbox or a retry. The content runtime's shared home is `gq-content`
([ADR 0015](0015-hold-only-the-blueprint-in-this-repository.md)), which isn't
extracted yet.

## Decision

- **The CMS skeleton owns the hook.** A must-use plugin,
  `web/app/mu-plugins/publication-events.php`, is created once with the CMS,
  so it is site-owned like `content-api.php`. It handles WordPress's
  `wp_after_insert_post` for a published `page` or `post`, ignoring revisions
  and autosaves. A draft or a private entry sends nothing. The plugin is to
  move to `gq-content` with the rest of the content runtime (ADR 0015).
- **An event is a reason to refresh, not content.** It carries:
  - `site`: the project;
  - `id`: a UUID;
  - `action`: `publish`;
  - `occurredAt`: milliseconds on the CMS's clock;
  - `entry`: `{ id, uri, previousUri? }`, where `id` is WPGraphQL's global id,
    `uri` is the entry's path (`/` for the front page), and `previousUri` is the
    path it had while published before.

  The Frontend refreshes those routes with the anonymous reads of ADR 0004, or
  the front page alone when the event is for `/`. So it promotes only content
  WordPress currently publishes. A draft or a password-protected entry reads
  as missing.

- **Authentication is an HMAC with its own key.**
  - The CMS posts to the Frontend's `/gq/events` with `GQ-Event-Timestamp`
    (seconds) and `GQ-Event-Signature: v1=<hex HMAC-SHA256 of "<timestamp>.<body>">`.
  - The key is `PUBLICATION_EVENT_SECRET`, a per-Site secret of at least 32
    characters in Sigillo `staging`.
  - The Frontend verifies the signature (`crypto.subtle.verify`), refuses a
    timestamp more than five minutes from its clock, an event for another
    `site`, an unsupported action (422) and a malformed or oversized body
    (400, 413). It reads nothing and writes nothing before those checks pass.
  - The key is not `FRONTEND_REFRESH_TOKEN`: a CMS holding it can only ask for
    the routes it names to be re-read, not refresh the whole Site, and neither
    credential authorises the other's endpoint. Deploy tokens and CORS play no
    part.
  - A signed `check` action proves the key works on both sides and changes
    nothing. `gq frontend events check` sends it from Sigillo, and
    `wp gq-events check` sends it from the CMS.
- **The Frontend records every accepted event before processing it.**
  Migration `0003_publication_events.sql` adds `publication_events`: one row
  per event `id`, holding its entry, its URIs, `occurred_at`, a `status`
  (`received`, `refreshed`, `failed`, `superseded`), the number of attempts
  and the failure reason.
  - A delivery of a recorded id that was refreshed or superseded is a
    duplicate, answered 200 without a CMS read. One that was received or
    failed is a retry and is processed again.
  - An event older than one already refreshed for the same entry is
    superseded and never processed.
  - A refreshed event supersedes the entry's older received or failed ones.
  - The store's own `read_started_at` rule also orders the promotions. So a
    delayed or duplicate publication can't overwrite a newer accepted one, and
    withdrawals take precedence through the same record
    ([ADR 0006](0006-withdraw-publications-through-signed-cms-events.md)).
- **The answer states the outcome.**
  - 200: refreshed, superseded or duplicate.
  - 503: the refresh kept the stored version. The event stays recorded as
    `failed`, for a retry.
  - 4xx: refused, and nothing changed.
  - Each action has a handler with its own schema: `check`, `withdraw` (ADR 0006),
    `settings` ([ADR 0007](0007-refresh-shared-settings-through-settings-events.md))
    and `reconcile` (ADR 0009) sit beside `publish`.
- **Publishing never waits on delivery.**
  - Each entry's latest event and its delivery state are recorded in post
    meta (`_gq_publication_event`) as `pending` before sending.
  - The event is sent at `shutdown`, after `fastcgi_finish_request()` where
    PHP-FPM provides it, with a 15-second timeout (`gq_publication_events_timeout`).
  - The outcome is recorded: `refreshed`, or `failed` with a reason
    (`network`, `refresh`, `rejected`, `not-configured`), the HTTP status and a
    message that never holds the key.
  - Outside production, a CMS without the key or a Frontend URL records
    nothing. In production that is a `not-configured` failure.
  - `wp gq-events status` lists pending and failed entries, and
    `wp gq-events retry <post>` sends the same event again. Automated retry
    and editor-facing reporting are
    [ADR 0008](0008-retry-event-delivery-from-the-cms-on-a-server-cron.md)'s.
- **The credentials follow explicit paths, and their values are never
  printed.**
  - **Frontend:** `infra/frontend.run.ts` binds `PUBLICATION_EVENT_SECRET`
    and `FRONTEND_REFRESH_TOKEN` as Worker secrets. `deploy-frontend.mjs`
    refuses either if it is shorter than 32 characters and warns when one is
    missing.
  - **CI releases:** `gq ci deploy` adds both to the CI Worker when Sigillo
    has them. The release step passes them to the Frontend deploy only when
    the Worker has them, because a step naming a secret the Worker lacks fails.
    So a CI release binds the refresh token too.
  - **CMS:** `gq ploi events` writes the key into the Ploi site's `.env`, and
    `config/application.php` defines it.

## Considered options

- **Reusing `FRONTEND_REFRESH_TOKEN` as a bearer token.** It is one secret
  fewer, but it would give the CMS, the larger attack surface, authority to
  refresh the whole Site. A bearer token is also replayable and doesn't
  protect the body.
- **Ed25519 like gq-support.** The Frontend would hold only a public key. But
  that means a key pair to generate and rotate per Site. HMAC matches the CI
  webhook's precedent, and both ends are the Site's own.
- **Content in the event.** It would save a CMS read, but the Frontend would
  have to trust a push. An event mis-sent for a draft could then leak it.
- **Processing in `waitUntil` or a Queue after answering 202.** That would
  shorten the CMS's wait, but it needs runtime support not verified on the
  pinned Alchemy Astro build, or a new Queue resource. Processing within the
  request reads at most two routes (8 seconds each) and reports the real
  outcome. Retries (ADR 0008) build on the same record.
- **An outbox table or Action Scheduler in the CMS.** Post meta holds the one
  event per entry that matters, because a newer one supersedes it. It needs no
  schema and is visible per post for the delivery report (ADR 0008).
  Production disables WP-Cron, so a scheduled retry needs a real scheduler
  anyway.
- **Extending an existing private package** (`getquick-design`, `gq-config`).
  It would have meant choosing the shared package home, which was #32's to
  decide; ADR 0015 gives the content runtime its own home in `gq-content`.

## Consequences

- An editor's publication reaches visitors within the event's round trip. If
  that trip fails, the publication waits for a retry: by `wp gq-events retry`,
  an operator's refresh, or the automated retry (ADR 0008). The previous good version
  stays served throughout.
- The CMS and the Frontend's clocks must agree within five minutes, or every
  event is refused as stale.
- With PHP-FPM, the CMS worker stays busy for up to the timeout after the
  editor's response. Without FPM, the request's end waits for it.
- `publication_events` grows by one row per publication. Nothing prunes it.
- Withdrawals and shared settings send their own events (ADR 0006, ADR 0007).
  A front-page change made through Settings sends none; reconciliation catches
  it ([ADR 0009](0009-reconcile-missed-changes-on-the-cms-scheduler.md)).
  WordPress's permalink must be a pretty path, as WPGraphQL's URIs are.
- Existing sites adopt the plugin and the endpoint by copying them. Syncing
  doesn't add them.

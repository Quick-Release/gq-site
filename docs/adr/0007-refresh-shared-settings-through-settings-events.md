# ADR 0007: Refresh shared settings through settings events

- Status: Accepted; amended by [ADR 0013](0013-serve-each-language-from-its-own-shared-rows.md)
  (a language's own menus, title and tagline send events naming it, which
  refresh only its rows; the rest refresh every language's)
- Date: 2026-10-02

## Context

[ADR 0005](0005-refresh-publications-through-signed-cms-events.md) refreshes a
page or post on the Frontend when an editor publishes it.
[#45](https://github.com/Quick-Release/gq-site/issues/45) asks the same for the
shared settings: the menus, the logo, the site's identity and the design
presets. A change to one has to reach the homepage and every affected entry
without a deploy or republishing each entry. A failed or delayed refresh has to
keep the previous settings served. And it has to use the same authenticated
event path and recovery record as publications, so the retries of
[#46](https://github.com/Quick-Release/gq-site/issues/46) need nothing
setting-specific.

The owned CMS packages were inspected for where the settings live and which
hooks fire when they change (getquick-design 0.2.18, getquick-theme 0.4.0,
gq-config):

- **Menus:** getquick-theme registers the `primary` location
  (`functions.php`), and the Frontend reads that location's menu items.
  Editing them fires WordPress's `wp_update_nav_menu`,
  `wp_update_nav_menu_item`, `wp_delete_nav_menu` and `deleted_post`. The
  locations are kept in the `theme_mods_<stylesheet>` option.
- **Logo:** getquick-design registers `generalSettings.siteLogo` from the
  `site_logo` option. Its Branding screen saves it through `/wp/v2/settings`,
  and the Customizer's `custom_logo` syncs to it.
- **Identity:** the title and tagline are the plain `blogname` and
  `blogdescription` options, and the icon is the `site_icon` option. GQ
  Design's Branding screen saves them too. No package overrides them.
- **Design presets:** getquick-design's `designTokens` reads
  `wp_get_global_settings()`, the theme's theme.json with the user's
  `wp_global_styles` post on top. GQ Design's Design screen saves the palette
  as that post (`/wp/v2/global-styles/<id>`).
- **Package hooks:** none of these changes reaches a frontend.
  `getquick_design_cache_invalidated` doesn't fire for global styles,
  `site_logo`, `site_icon`, `blogname` or `blogdescription`, and nothing
  listens to it.

On the Frontend, the chrome row holds the menu, logo and icon, and every page
is served with it. The front page's row holds the title and tagline (only the
homepage renders them). Each entry's row holds the design presets it was read
with (ADR 0004).

## Decision

- **A `settings` event per setting.** The event is
  `{ site, id, action: "settings", occurredAt, setting }`, where `setting` is
  `menus`, `logo`, `identity` or `design`. It carries no content. It is signed
  and sent exactly like a publication event, to the same `/gq/events` with the
  same key, and refused the same way.
- **The Frontend refreshes the shared rows, not the entries.** Each setting
  maps to the rows every affected page is served with:
  - `menus` and `logo`: the chrome;
  - `identity`: the front page (title, tagline) and the chrome (icon);
  - `design`: a new shared `design` row.

  Each row is promoted only from a complete, valid read, under the
  `read_started_at` rule, so a failed read keeps the stored menus, branding
  and design. A partly failed event (such as identity's front page promoted
  and its chrome kept) is recorded as failed and retried whole.

- **Shared design presets.** The `design` row holds the presets read on their
  own (a `DesignPresets` query). Once a refresh has stored it, the homepage
  and every entry are served with it instead of the presets in their own rows.
  A whole-Site refresh stores it too.
  - A Site whose store has no `design` row, or holds one in a format this
    Frontend can't read, serves each page with the presets in its own row.
  - No migration and no format change.
  - This amends ADR 0004's "design presets stay in each entry's row": a change
    to them is one read, applied to every page at once, not one read per entry.
- **Change identity and order.** The event's `id` is its identity. A setting is
  recorded in `publication_events` as the subject `setting:<name>` (the
  `node_id` column, `uri` `/`), so the duplicate, supersede and failed-retry
  rules of ADR 0005 apply per setting:
  - a delivery of a refreshed id is a duplicate;
  - an event older than one already refreshed for the same setting is
    superseded and never read;
  - a refreshed one supersedes that setting's older failed ones.

  Settings are ordered apart from each other and from entries. A retry
  ([ADR 0008](0008-retry-event-delivery-from-the-cms-on-a-server-cron.md))
  resends any recorded event by its action and subject.

- **The CMS hooks live in the site-owned skeleton.** A must-use plugin,
  `settings-events.php`, sits beside `publication-events.php` and reuses its
  endpoint, key and signed `send()`.
  - It listens to:
    - `updated_option`, `added_option` and `deleted_option` for `blogname`,
      `blogdescription`, `site_icon` and `site_logo`;
    - the current theme's `theme_mods_` for `nav_menu_locations` and
      `custom_logo`;
    - the nav menu hooks, for a menu assigned to a location;
    - `save_post_wp_global_styles`;
    - `switch_theme`.
  - It sends one event per setting per request, at `shutdown`, after the
    editor's response where PHP-FPM allows. A second change in the same
    request moves that event's time on.
  - Each setting records its last event and its delivery in the option
    `gq_settings_event_<setting>`.
  - `wp gq-events settings status` and `wp gq-events settings retry <setting>`
    list and resend them.

## Considered options

- **Re-reading every entry for a design change.** It keeps ADR 0004's rows
  unchanged. But it costs one CMS read per entry within the event's 15-second
  wait and Workers' subrequest limit. A partial failure would also leave the
  Site with a mix of old and new presets.
- **One event naming several settings.** Fewer requests when a screen saves
  several settings at once. But the record has one subject per event, and a
  combined event couldn't be ordered or superseded per setting.
- **Listening to `getquick_design_cache_invalidated`.** It doesn't fire for
  global styles, the logo, the icon or the title, and it fires for layout
  changes the Frontend doesn't render.
- **Putting the plugin in `getquick-design`.** Choosing a shared package home
  was [#32](https://github.com/Quick-Release/gq-site/issues/32)'s decision;
  ADR 0015 gives the content runtime its own home in `gq-content`.
- **The site title on entry pages.** Entries are titled with the project's
  name, not WordPress's title. The issue asks to refresh the existing
  representation, so an identity change shows on the homepage (title,
  tagline) and on every page (icon), and the entry layout is unchanged.

## Consequences

- A menu, logo, identity or design change reaches every page within the
  event's round trip, through later outages. If the trip fails, the previous
  settings stay served until a retry: `wp gq-events settings retry`, an
  operator's `gq frontend refresh`, or the automated retry (ADR 0008).
- Pages are served with the stored `design` row even when an entry's own read
  is newer. A lost design event is caught by the next design event, a
  whole-Site refresh, or reconciliation
  ([ADR 0009](0009-reconcile-missed-changes-on-the-cms-scheduler.md)).
- `wp_navigation` posts (block-theme navigation), fonts, the logo variation
  and a front-page change in Settings → Reading send no settings event. The
  Frontend doesn't render the first three; the last is a publication matter.
- Existing sites adopt the plugin and the Frontend changes by copying them.
  Syncing doesn't add them.

# GETQUICK site blueprint

`gq-site` holds the blueprint every GETQUICK site follows: the `gq`
CLI, published as `@getquick/site`, and the design and rollout plan behind
it ([ADR 0001](docs/adr/0001-the-getquick-site-blueprint.md)).

Terms shared across GETQUICK repositories (Site, CMS, Frontend, Blueprint,
Runtime, GETQUICK plugin, GETQUICK package, Platform release, Fleet) are
defined in
[gq-platform's glossary](https://github.com/Quick-Release/gq-platform/blob/main/GLOSSARY.md);
this one uses them without redefining them.

## Language

### Blueprint

**Managed file**:
A file, or a section or set of keys in one, that the blueprint generates.
_Avoid_: generated file (when a section or key set is meant)

**Site-owned file**:
A file the blueprint never overwrites, such as a site's ADRs, research,
plugins, theme and apps.

**App skeleton**:
The files a new site's CMS or Frontend starts from, written once and only
while that app doesn't exist yet; site-owned from then on.
_Avoid_: app template (a template is the blueprint's source for a file)

**Adoption**:
Bringing an existing site onto the blueprint: its first sync takes over the
managed files, its own deploy steps move into deploy extensions, and anything
the generated sections repeat is removed from the site's own content.
_Avoid_: onboarding (that is adding a site to the fleet)

**Deploy extension**:
A site-owned step that the generated CMS deploy runs after activating the
site's plugins, such as activating its theme.
_Avoid_: deploy hook (hooks are the Git hooks)

**Variant**:
The kind of site the blueprint supports: content or commerce. Lombardi is a
content site; Ekis is a commerce site.

### Published content

**Missing content**:
Content the CMS confirms isn't published: it answered, with valid data, and
has nothing at that URI. The Frontend answers 404.
_Avoid_: not found (for a CMS failure)

**Unavailable content**:
Content the Frontend couldn't read: the CMS timed out, couldn't be reached,
answered with an HTTP or GraphQL error, or answered without the fields the
Frontend requires. It says nothing about whether the content exists; the
Frontend answers 503, never 404.
_Avoid_: missing content, empty (for a failed read)

**Entry**:
A published WordPress page or post, served at its own route (its URI). The
front page is the homepage, not an entry. An entry WordPress keeps at another
route now is moved: its old route redirects there.
_Avoid_: post (for pages too), article

**Publication store**:
A content site's durable copy of its published content (the front page and
the entries) and shared chrome, in the Frontend's own D1 database, which
visitors are served from
([ADR 0003](docs/adr/0003-serve-published-content-from-a-durable-store.md),
[ADR 0004](docs/adr/0004-serve-entries-from-the-store-with-a-cold-lookup.md)).
A multilingual Site keeps each language's front page and chrome in its own
rows ([ADR 0013](docs/adr/0013-serve-each-language-from-its-own-shared-rows.md)).
It outlives CMS outages, Worker restarts and redeploys.
_Avoid_: cache (it isn't evicted), KV

**Last-known-good content**:
What the publication store holds: the most recent complete, valid read of a
publication. It has no age limit; only a newer read or a withdrawal replaces
it.
_Avoid_: stale content (as a fault)

**Refresh**:
Reading published content from the CMS and promoting each complete, valid
read into the publication store; a failed read keeps what is stored. Only a
trusted caller may refresh: `gq frontend refresh` with the Site's refresh
token, for the whole Site (its preparation) or for chosen entries, and the
Site's CMS, for the entry a publication event names. A Site no
refresh has filled is not ready, and its pages are a 503.
_Avoid_: rebuild, revalidate, purge

**Publication event**:
The Site's CMS telling its Frontend that a page or post was published or
updated: signed with the Site's event secret, with its own identity and the
time it happened, it makes the Frontend refresh that entry
([ADR 0005](docs/adr/0005-refresh-publications-through-signed-cms-events.md)).
It carries no content. An event older than one already refreshed for the
same entry is superseded; one whose refresh failed stays recorded for a retry.
Publishing never waits on it.
_Avoid_: webhook (for the domain event), purge

**Withdrawal**:
The Site's CMS telling its Frontend that a published page or post stopped
being public: unpublished, made private or password-protected, trashed or
deleted. It is a signed event like a publication event
([ADR 0006](docs/adr/0006-withdraw-publications-through-signed-cms-events.md)).
The Frontend makes every route of that entry a 404 at once, without reading
the CMS. While the withdrawal is in force, no read promotes the entry again.
Only a publication that happened after it lifts it.
_Avoid_: purge, invalidation, delete (for an unpublish)

**Shared setting**:
Site-wide data every page is served with: the menus, the logo, the site's
identity (title, tagline, icon) and the design presets. A change to one sends
a settings event, a publication event naming the setting instead of an entry,
which refreshes only the shared rows it is part of, so it reaches every page
without republishing them
([ADR 0007](docs/adr/0007-refresh-shared-settings-through-settings-events.md)).
On a multilingual Site the menus, title and tagline are each language's own:
a change to them names its language and refreshes only that language's rows
([ADR 0013](docs/adr/0013-serve-each-language-from-its-own-shared-rows.md)).
_Avoid_: options, theme settings (for the WordPress mechanisms behind them)

**Public delivery**:
The Frontend confirming that it acted on an event (refreshed or withdrew what
it names), apart from the change itself: a change can be saved in WordPress while its public
delivery is pending, delayed (failed, and retried by the CMS's delivery
scheduler, a server cron) or failed (no attempts left). Visitors keep the
last-known-good content until it succeeds; editors and Site Health are told
([ADR 0008](docs/adr/0008-retry-event-delivery-from-the-cms-on-a-server-cron.md)).
_Avoid_: sync, publish (for the Frontend's side)

**Reconciliation**:
The Frontend comparing its publication store with what WordPress publishes and
refreshing what differs, so a change whose event was never sent still reaches
visitors. The CMS's scheduler asks for it every minute
([ADR 0009](docs/adr/0009-reconcile-missed-changes-on-the-cms-scheduler.md)).
It follows the same promotion, ordering and withdrawal rules as events. A failed
read keeps what is stored, and only WordPress confirming an entry missing makes
it a 404.
_Avoid_: sync, polling, full refresh (a whole-Site refresh reads every entry)

**Site readiness**:
Whether a new content Site's resilience guarantee holds, as `gq site check`
establishes it ([ADR 0010](docs/adr/0010-declare-a-new-content-site-ready-through-one-readiness-gate.md)):
WordPress installed with every WPGraphQL field the Frontend reads, the
Frontend's secrets and store bound, its store prepared by a whole-Site
refresh, the CMS's scheduler having it reconcile, and an upload proving
independent media. A multilingual Site's holds in every language: each
exists in the CMS, and its front page, chrome and homepage are served. A
running Worker, a running DDEV, an HTTP 200 or a matching title is not
readiness.
_Avoid_: up, healthy, deployed (for a ready Site)

**Cold lookup**:
A visit's read of an entry the publication store has never held, the only CMS
read a visit makes: a published entry is stored and served, a confirmed
missing one is a 404, and a failed read is a 503.
_Avoid_: cache miss (it isn't a fallback for stored entries)

### Hosting

**Staging domain**:
`bnq.pt`, the domain GETQUICK owns for temporarily hosting sites'
development and staging copies. A site's staging hosts are always
`<project>-cms.bnq.pt` for the CMS and `<project>-fe.bnq.pt` for the
Frontend, where `<project>` is the client's name (the site's `project` in
`gq.ops.json`).

**Artifacts-only Site**:
A Site whose `gq.ops.json` names no `github.repository`
([ADR 0012](docs/adr/0012-keep-a-sites-code-in-artifacts-when-it-has-no-github-repository.md)):
its code lives in its Cloudflare Artifacts repository, which is its `origin`,
and pushes there start CI with no GitHub webhook, mirror or commit status.
_Avoid_: GitHub-less site, mirror-less site

**Offboarding**:
Taking a leaving client's Site down without losing its content or code
([ADR 0011](docs/adr/0011-offboard-a-site-by-cutting-access-before-archiving.md)):
first cutting every public URL and every credential gq made for it
(`gq offboard`, reversible with `--restore`), then archiving its content to one
place and deleting its live infrastructure (`gq offboard --archive`,
irreversible).
_Avoid_: withdrawal (an editor unpublishing content), teardown, decommission

**Site Archive**:
Everything kept of an Offboarded Site's content once its live infrastructure
is gone: its media, its CMS database and backups, its published content and
its manifest, gathered in one place shared by every former client, with a
manifest of what each file is and where it came from. It is checked against
that manifest before anything is deleted. Its code is kept apart, in its
archived GitHub repository; an Artifacts-only Site's is in the archive, as a
git bundle of every ref.
_Avoid_: backup (a copy the live Site restores from), export

**Offboarded Site**:
A Site whose gq.ops.json records `offboarded`: its access is cut (phase
`cut`) or it is archived (phase `archived`). Every command that would expose
it again refuses, and so do its deploy scripts and CI release step; read-only
commands keep working.
_Avoid_: withdrawn site, disabled site

**Independent media**:
A site's WordPress uploads stored on R2 and served from the media bucket's
own public domain, not from the CMS, so they stay available while the CMS is
down. The production prerequisite `gq media check` verifies; keeping uploads
on disk is only for local development.
_Avoid_: offloaded media, CDN media

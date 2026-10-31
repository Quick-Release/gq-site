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

**Content Runtime**:
The Runtime a content Site delivers published content with: gq-content's
`getquick/gq-content` CMS plugin and `@getquick/content` Frontend package,
pinned together at one version. A Site whose `gq.ops.json` has
`contentRuntime: "package"` (every Site `gq new` generates) runs it; a Site
generated before keeps its copy of the runtime, site-owned
([ADR 0020](docs/adr/0020-wire-new-content-sites-to-the-gq-content-package-pair.md)).
_Avoid_: content skeleton (the skeleton is the Site's starting files)

**Deploy extension**:
A site-owned step that the generated CMS deploy runs after activating the
site's plugins, such as activating its theme.
_Avoid_: deploy hook (hooks are the Git hooks)

**Variant**:
The kind of site the blueprint supports: content or commerce. A Site's
variant is chosen when it is created and never changes; it decides the
Site's app skeletons, managed files and defaults, with `framework` choosing
only between content Frontends. A commerce Site's Frontend is its
storefront, and WooCommerce is its only commerce authority. Ekis,
FPA Shop and Bruaa are commerce sites.
_Avoid_: frontend variant, flavour

**Reference Site**:
The live content Site the blueprint is tested against: Cooldown Gaming. A
playground, where downtime and resets are expected
([reference](docs/reference/reference-site.md)).

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
readiness. A commerce Site's, through the same command
([ADR 0021](docs/adr/0021-declare-a-commerce-site-ready-through-the-same-gate.md)):
the CMS serving WooCommerce's Store API, the GETQUICK plugins and theme and
holding the storefront's proxy secret, a cart round-tripped through the
storefront's Worker, its rate limiters bound, the legal pages assigned and
independent media. Payments, shipping, tax and checkout aren't part of it.
Formatting and manifest validation are readiness on neither variant.
_Avoid_: up, healthy, deployed (for a ready Site)

**Cold lookup**:
A visit's read of an entry the publication store has never held, the only CMS
read a visit makes: a published entry is stored and served, a confirmed
missing one is a 404, and a failed read is a 503.
_Avoid_: cache miss (it isn't a fallback for stored entries)

**Consent database**:
A Site's record of its visitors' consent decisions, one D1 database per
stage, created in the EU and apart from the publication store: the only
store a visitor's request writes, and only through the consent Runtime's
record endpoint
([ADR 0019](docs/adr/0019-record-visitors-consent-in-a-separate-eu-database.md)).
It exists only for a Frontend with the consent Runtime, and its retention
purge runs in a Worker of its own.
_Avoid_: consent cache, cookie store

### Releases

**Release**:
A tagged version of a Site, deployed CMS first, then Frontend
([ADR 0016](docs/adr/0016-activate-cms-releases-from-kept-builds-and-roll-back-code-only.md)). Each release
must work beside the one before it: its CMS with the previous Frontend, and
the previous CMS code with its database. A release that can't says so, and
is not rollback-safe.

**Kept release**:
A complete, built CMS release held on the CMS server beside the live one,
ready to be made live again without building or downloading anything. The
live release and the two before it are kept; older ones are reached by
deploying their tag again.
_Avoid_: backup (for a kept release)

**Partial release**:
A release whose CMS went live and whose Frontend didn't. It is recorded as
such, never as success, and is ended by deploying that release's Frontend
again or by a rollback.
_Avoid_: failed release (the CMS part is live)

**Rollback**:
Making an earlier release of a Site live again, run by an operator through
`gq`: the Frontend first, then the CMS by a code rollback, skipping an app
already at that release. A deploy whose CMS fails after its switch rolls the
CMS back by itself.
_Avoid_: revert, undo

**Code rollback**:
Making a kept release the live CMS code again, activated exactly as a deploy
activates it. It switches code only: the database keeps every change made
since, which is why every release must run beside the one before it.
Restoring a database is a separate, deliberate act that loses editors' work
since its snapshot.
_Avoid_: restore (for a code switch)

**Deployment policy**:
A protected Site's `gq.ops.json` `deployment` block, read before anything
is uploaded, synced or deployed. Its **deployment state** is `authorized`,
`paused` or `reserved`.
_Avoid_: admission state (that is the request admission's)

**Deployment hold**:
A deployment state other than `authorized`: no release may start. Only a
reviewed Site change to `deployment.state` lifts it; nothing on the server
can.
_Avoid_: hold (unqualified, where the request admission's could be meant)

**Guarded package**:
A Composer package named in the deployment policy's `guardedPackages`: it
is deployed only as an approved version, verified file by file on the
server.

**Request admission**:
What answers a guarded Site's PHP requests 503, before any other PHP code,
while a deploy changes its packages: a gate the PHP-FPM pool prepends, and
the **admission state** it reads (`.gq/state`). The Site is served only
while the admission state reads exactly `open` and a newline; anything else,
`held <nonce>` among it, is an **admission hold**. `admission.sh lift` ends
an admission hold at the end of a deploy that verified and finished; it
can't authorize a release or lift a deployment hold.
_Avoid_: maintenance mode (WordPress's own, which unguarded Sites use)

### Hosting

**Staging domain**:
`bnq.pt`, the domain GETQUICK owns for temporarily hosting sites'
development and staging copies. A site's staging hosts are always
`<project>-cms.bnq.pt` for the CMS and `<project>-fe.bnq.pt` for the
Frontend, where `<project>` is the client's name (the site's `project` in
`gq.ops.json`).

**Custom hostname**:
A Site's public Frontend hostname in the client's own DNS, outside the
Cloudflare zone on our account, served through Cloudflare for SaaS on that
zone (`domains.frontend` with `domains.frontendTarget`). The client CNAMEs it
to the Frontend's hostname in the zone, and a Worker route sends its requests
to the production Frontend.
_Avoid_: external domain, vanity domain

**External proxy**:
A reverse proxy we run outside Cloudflare that serves a Site's public
Frontend hostname with a certificate of its own and forwards every request
to the Frontend's hostname in the Cloudflare zone (`domains.frontendProxy`
with `domains.frontendTarget`). It is used when the client requires a
certificate authority Cloudflare can't serve. The Worker has no route for
the public hostname, and no Custom hostname exists for it.
_Avoid_: origin proxy, front proxy

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

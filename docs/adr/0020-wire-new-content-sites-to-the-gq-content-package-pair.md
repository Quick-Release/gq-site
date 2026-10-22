# ADR 0020: Wire new content Sites to the gq-content package pair

- Status: Accepted
- Date: 2026-10-22

## Context

Until now `gq new` copied the content runtime into each Site, created once and
then Site-owned: the Frontend's delivery, store, events, reconciliation,
WPGraphQL client, HTML helpers and their tests, its five SQL migrations, and
the CMS's publication, settings and delivery-retry mu-plugins. The decisions
behind that runtime are ADRs [0003](0003-serve-published-content-from-a-durable-store.md)
to [0010](0010-declare-a-new-content-site-ready-through-one-readiness-gate.md)
and [0013](0013-serve-each-language-from-its-own-shared-rows.md).

Under [ADR 0015](0015-hold-only-the-blueprint-in-this-repository.md) and
[gq-platform ADR 0001](https://github.com/Quick-Release/gq-platform/blob/main/docs/adr/0001-ownership-of-work-across-getquick-repositories.md),
the runtime belongs to Quick-Release/gq-content. It now ships there as a
configured pair released together at one version
([gq-content ADR 0001](https://github.com/Quick-Release/gq-content/blob/v0.1.0/docs/adr/0001-release-the-content-runtime-as-a-configured-package-pair.md)):
the Composer `wordpress-muplugin` `getquick/gq-content`, served from
composer.getquick.io, and the npm package `@getquick/content`. 0.1.0 was
published from tag `v0.1.0`
([gq-content#13](https://github.com/Quick-Release/gq-content/issues/13#issuecomment-6336904617)),
and 0.2.0, which new Sites pin, from `v0.2.0`. 0.2.0 adds the content
extension, through which a Site carries its own fields with its
publications
([gq-content ADR 0004](https://github.com/Quick-Release/gq-content/blob/v0.2.0/docs/adr/0004-carry-a-sites-own-content-as-a-typed-extension.md)).
[gq-content ADR 0002](https://github.com/Quick-Release/gq-content/blob/v0.1.0/docs/adr/0002-preserve-publication-delivery-and-withdrawal-through-extraction.md)
carries this repository's runtime decisions forward.

Sites already generated hold their copies and may have changed them. gq-content
leaves their migration out of scope: only newly generated Sites adopt the
pair.

## Decision

- **A Site names its runtime.** `gq.ops.json` gains an optional
  `contentRuntime`. `"package"` means the pinned pair; `gq new` writes it.
  Without it, a Site keeps the runtime an earlier blueprint copied into it.
- **Ownership entries can depend on it.** An entry in
  `blueprint/ownership.json` marked `"contentRuntime": "package"` applies only
  to a Site whose manifest says so. On any other Site, `gq sync` neither
  writes nor records it, so it never adds the pair to an older Site, nor
  rewrites or deletes what that Site copied. Dropping the runtime's create-once
  entries changes nothing in those Sites either: a create-once file is never
  deleted.
- **The pins are managed keys.** `apps/cms/composer.json`
  `require.getquick/gq-content` and `apps/frontend/package.json`
  `dependencies.@getquick/content` are each pinned exactly by a managed key.
  The two fragments (`templates/fragments/cms-composer.keys.json`,
  `frontend-package.keys.json`) must name one version; gq refuses to load
  otherwise. `gq sync --check` fails while a Site's halves disagree, naming
  both. A key set in a file gq creates once is written with that file.
- **The route adapters are managed.** `apps/frontend/src/pages/gq/events.ts`
  and `refresh.ts` are fully generated. Each hands the request to the
  package's `handleEvent` or `handleRefresh`.
- **The Site configures the runtime and composes its pages.**
  `apps/frontend/src/lib/content.ts` is created once. It builds
  `createContentRuntime` from the manifest (identity, languages, CMS origin),
  the build environment and the Worker's bindings. The pages, layout, copy,
  styles and their rendered-route test stay Site-owned skeleton files, now
  importing the package's helpers. The CMS's `config/application.php` defines
  `GQ_CONTENT_SITE_ID` as the manifest's `project`, the identity the
  Frontend's runtime accepts.
- **Installing the package switches durable delivery on.**
  `infra/frontend.run.ts` takes the publication migrations from
  `apps/frontend/migrations` when a Site has its own copy (an older Site).
  Otherwise, on a Site whose manifest names the package runtime, it takes
  them from the installed `@getquick/content`'s `./migrations` export, and
  `infra/scripts/deploy-frontend.mjs` applies the same rule. An older Site
  that installs the package only for consent gets no store from it. A
  Frontend with neither has no store, as before.
- **The Blueprint keeps what isn't runtime.** Provisioning (secrets, the
  `wp gq-events retry-due` crontab, the stores), readiness orchestration,
  media checks, the CMS skeleton and the version pins stay here. The CMS
  plugin installs no cron, and the crontab's command is unchanged.

## Considered options

- **Detect adoption from the files.** Treating a Site as adopted when its
  Frontend depends on `@getquick/content` breaks Sites that install it only
  for consent ([ADR 0019](0019-record-visitors-consent-in-a-separate-eu-database.md))
  while keeping their copied runtime: `gq sync` would overwrite their event
  routes and add the CMS plugin beside their copied mu-plugins. Rejected for
  an explicit, recorded choice.
- **Manage the adapters and pins on every Site.** An older Site's routes
  would count as local edits and stop `gq sync`, and its CMS would load the
  plugin beside its own copies. Rejected.
- **Migrate existing Sites now.** Out of scope for gq-content's first
  release. A Site may opt in later by setting `contentRuntime` and replacing
  its copies; [Move an existing Site onto the content package pair](../guides/content-pair-migration.md)
  is that migration's guide.

## Consequences

- ADRs 0003–0010 and 0013 keep their provisioning and Blueprint parts. Their
  runtime parts are superseded by gq-content's ADRs; each says which.
- The runtime's behaviour is proved in gq-content. Here,
  `scripts/smoke/content-pair.sh` proves that a generated Site wires the
  pinned pair: its pins, the crontab's command, the migrations the deploy
  resolves and the `/gq` routes. The generated Frontend keeps its
  rendered-route test of what the Site composes. The real-CMS events proof
  (`cms-events.sh`) and the workerd runtime proofs left with the runtime.
- Every new Site now has `@getquick/content` installed, and it exports
  `./consent/migrations`, so by [ADR 0019](0019-record-visitors-consent-in-a-separate-eu-database.md)'s
  rule (`infra/consent.ts`) every new Site's deploy also creates its EU
  consent database, purge Worker and rate limiter, whether or not the Site
  composes consent. ADR 0019's opt-in signal may need revisiting now that
  the package is also the Content Runtime.
- Moving the pin is a Blueprint release that changes both fragments and both
  skeleton templates at once. A test holds them equal.

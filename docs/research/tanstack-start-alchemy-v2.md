# TanStack Start on the blueprint's Alchemy v2

Verified 2026-10-26 against published npm artifacts, rather than Alchemy v1
examples. This note concerns blueprint deployment and package consumption.

## Deployment integration

The [official Alchemy Cloudflare Start guide](https://alchemy.run/cloudflare/frontend/tanstack-start/)
selects `Cloudflare.Website.Vite` with the ordinary `tanstackStart()` and React
plugins. It removes `@cloudflare/vite-plugin`: Alchemy adds its own plugin.
The current guide uses a newer import layout; the blueprint's beta.79 artifact
exports `alchemy/Cloudflare`, verified from its package exports.

[alchemy@2.0.0-beta.79](https://www.npmjs.com/package/alchemy/v/2.0.0-beta.79)
ships `lib/Cloudflare/Website/Vite.{js,d.ts}`. Its `ViteProps` extends Worker
props, so D1, Redacted secrets, domains, workersDev, cron, compatibility and
observability are supported. `Vite` delegates to the same Worker resource as
Astro; preserving logical IDs preserves the deployment identity.
`lib/Cloudflare/Workers/Sources/Vite.js` loads the app's Vite and calls
`createBuilder` with `@alchemy.run/cloudflare-runtime/vite`, followed by
`builder.buildApp()`. The proof executes that published plugin with the
same custom Worker entry (`main: "src/worker.ts"`) without deploying.

The custom entry wraps Start's published `@tanstack/react-start/server-entry`
fetch handler and exports `scheduled`, which delegates to Runtime consent
purging. Bindings are read on requests via `cloudflare:workers`; a type-only
`Cloudflare.InferEnv<typeof Website>` import prevents infrastructure code from
entering the Worker. Outside workerd the bindings callback returns no bindings.

## Compatible pins

Start 1.169.4 declares Vite >=8 and depends on Router 1.170.46; the skeleton
pins that exact Router. React/React DOM are 19.3.1. React plugin 6.0.2 satisfies
the frontend-frameworks beta.79 peer. Vite Plus 1.0.0 uses its own Vite 8 core
and Vitest 5.0.1. Its executable is `vp`; a `vite build` script fails because
this package has no `vite` executable. Start gets its own create-once workspace
catalog; Astro's 0.3.0 catalog stays byte-identical. Alchemy, frontend-frameworks
and Effect remain beta.79 / rc.115 as before.

The proof's Miniflare 5.20261023.0-beta supports the current compatibility date.
Stable Miniflare 4.20260730.0 rejects 2026-10-26 (its binary only supports
2026-08-06). The beta is a proof dependency only, never a generated app dependency.
Its v5 module manifest is assembled from the emitted Worker and its chunks.

## Runtime contract and handoff

[@getquick/content@0.4.0](https://www.npmjs.com/package/@getquick/content/v/0.4.0)
already supplies the required server Runtime:

- `@getquick/content/server`: `createContentRuntime({site, cmsOrigin,
graphqlEndpoint, wordpress, isServer, bindings, development, consent})`;
  `publishedHome`, `publishedEntry`, `routeLanguage`, `isLanguageHome`,
  `handleEvent(Request, {siteOrigin})`, `handleRefresh(Request, {siteOrigin})`,
  `renderDesignPattern`, `consentConfiguration`. A found result uses
  `content`, not `value`; moved results expose `uri`. `responseStatus` remains
  the shared 200/404/503 mapping.
- `@getquick/content/migrations`: Node-only `migrationsDirectory`.
  Historical SQL filenames and contents exactly match the blueprint's 0001–0005.
- `@getquick/content/consent/server`: `createConsentServer({siteId, bindings})`
  with `handleRecord`, `handleRead`, and scheduled `purge`. Bindings are
  `CONSENT_DB`, `CONSENT_READ_TOKEN`, `CONSENT_RATE_LIMITER`.
- `@getquick/content/consent/migrations`: `consentMigrationsDirectory`, separate
  from the publication database.
- `@getquick/content/consent/client`: idempotent `startConsent()`, which refreshes
  after React navigation. Consent UI HTML comes from `consentPage` on the
  existing `/consent/astro` export. Inspection of its released JS confirms
  pure HTML functions with no Astro dependency.

The Start CMS skeleton pins `getquick/gq-content` 0.4.0 alongside the npm
package and sets `GQ_CONTENT_SITE_ID` from `project`; the old copied
`publication-events.php`, `settings-events.php` and `delivery-retries.php` are
excluded. Its gq-config 0.5.0 pin provides `getquickLegal` for consent CMS settings
(the 0.4.0 baseline lacks that field). Existing Astro CMS files and pins stay
unchanged. See the owner's [CMS instructions](https://github.com/Quick-Release/gq-content/blob/v0.4.0/cms/README.md)
and [paired release notes](https://github.com/Quick-Release/gq-content/blob/v0.4.0/docs/releases/0.4.0.md).

**Release dependency:** npm 0.4.0 installed successfully in the proof. The private
Composer artifacts `getquick/gq-content` 0.4.0 and `getquick/gq-config` 0.5.0
were verified at their upstream tags, but their registry availability and paired
CMS integration have not been tested here. The upstream v0.4.0 release describes
availability verification as pending. Do not treat this draft as a completed
paired rollout. The owner must confirm those exact artifacts are installable
and pass its CMS/Frontend pair gate. No runtime implementation is edited here.

No invented Runtime method or unpublished JavaScript support is required.
A precise nonblocking gq-content improvement is to expose those same
`ConsentPageInput`, `ConsentPage`, `consentPage`, `legalFooter` and
`CONSENT_STYLES` through a neutral `@getquick/content/consent/html` export and
cover SSR plus React navigation in its package consumer tests. The concrete
owner files are `frontend/src/consent/astro.ts` (existing pure HTML functions),
a new `frontend/src/consent/html.ts` entry, `frontend/package.json` exports and
the package build entry list. Keep the current `/consent/astro` export compatible. Until released,
the skeleton explicitly imports the real `/consent/astro` export.

CESAM (local clone `/data/code/getquick/clients/cesam-bnq`) needs its own
session in a worktree. Its manifest project is `cesam`, with no GitHub
repository recorded; its origin is the Cloudflare Artifacts `cesam` repository.
Do not derive resource names from the clone directory name.
That session must replace its Site-owned app and preserve its exact
publication and consent D1 resource IDs, existing secrets, bindings, language
configuration, extensions, forms, chrome and authored routes. Configure any
CESAM-specific Runtime extension in `src/site.server.ts`; do not copy shared
Runtime internals into the app. Carry forward its existing consent token and
services. Check Alchemy's resource plan, release/rollback compatibility,
refresh/event/readiness behavior and consent writes/reads/retention against
its store before deployment. A destructive app reset does not authorize
resetting data or creating replacement databases. Nomia is explicitly exempt.

## Limits

The account-free proof establishes generation, package compatibility, the
Cloudflare Worker build, unavailable-content status and endpoint guards.
It does not establish a live deployment, CMS integration, consent readiness,
withdrawal through an outage, or CESAM's feature parity. Existing runtime
acceptance tests remain the Runtime owner's responsibility, and Site readiness
remains the live gate. No production deploy or npm publish was performed.

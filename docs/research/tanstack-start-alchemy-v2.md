# TanStack Start on Alchemy v2

Verified against published packages on 2026-10-26/27 and integrated with gq-site
main `e033403` (0.24.1), including ADRs 0019 and 0020. This concerns blueprint
deployment and package consumption, not a Site's redesign.

## Deployment evidence

The [official Cloudflare Start guide](https://alchemy.run/cloudflare/frontend/tanstack-start/)
uses `Cloudflare.Website.Vite`, `tanstackStart()` and the React Vite plugin.
It removes `@cloudflare/vite-plugin` because Alchemy supplies its own plugin.
The current guide's import layout has moved; the pinned
[alchemy@2.0.0-beta.79](https://www.npmjs.com/package/alchemy/v/2.0.0-beta.79)
artifact exports `alchemy/Cloudflare`.

The published `lib/Cloudflare/Website/Vite.{js,d.ts}` declares `ViteProps` from
Worker props: native bindings, Redacted secrets, domains, workersDev and assets
are retained. `Vite` delegates to the same Worker resource as Astro. Preserving
the logical IDs therefore preserves the deployment identity.
`lib/Cloudflare/Workers/Sources/Vite.js` loads the app's own Vite, calls
`createBuilder` with `@alchemy.run/cloudflare-runtime/vite`, then `buildApp()`.
The proof executes this actual published plugin against the generated app,
without the Alchemy engine or a Cloudflare account.

The Start infra is the current shared Frontend declaration with only its
framework-specific driver/options changed. It retains package migration lookup,
publication database, consent database/purge imports, GraphQL credentials,
consent retention, forms/Turnstile bindings, preview bindings, domains, stages
and Offboarded Site guards. Consent's scheduled handler remains in the existing
separate purge Worker, matching ADR 0019 and CESAM's deployed resource model.
There is no v1 adapter, Wrangler configuration or production deployment.

## Pins and repeatable proof

Start 1.169.4 requires Vite >=8 and depends on Router 1.170.46, which is pinned
explicitly. React/React DOM are 19.3.1. React plugin 6.0.2 satisfies the
frontend-frameworks beta.79 peer. Vite Plus 1.0.0 uses its Vite 8 core and
Vitest 5.0.1. Its executable is `vp`; `vite build` fails because it provides no
`vite` executable. Start has a separate create-once workspace catalog; Astro's
catalog is unchanged. Alchemy/frontend-frameworks beta.79 and Effect rc.115 stay
as pinned on main.

`node scripts/smoke/tanstack-check.mjs` generates a Site from this checkout,
installs the CLI from this checkout's file package, and runs app and infra type
checks. It verifies all five original migration SQL hashes against the installed
Runtime, builds the Worker with Alchemy's Cloudflare plugin, then runs it in
local workerd: unprepared home/entry responses are 503; event/refresh method and
authorization guards and consent method dispatch are the real Runtime's.
The proof uses Miniflare 5.20261023.0-beta solely as a test dependency. Stable
Miniflare 4.20260730.0 rejects the current compatibility date; v5 supports it.
The v5 module manifest contains the emitted server entry and every JS chunk.

Tests compare omitted/explicit Astro generation including the lock, assert
Start has no Astro or copied Runtime internals, prove sync idempotence and
managed-route edit refusal, and format both skeletons at short/long names.
Existing release/offboarding/consent/form tests remain in the full suite.

## Package contracts and remaining work

[@getquick/content@0.4.0](https://www.npmjs.com/package/@getquick/content/v/0.4.0)
already exposes everything used here. `createContentRuntime` from `/server`
accepts Site identity, CMS/GraphQL URLs, language configuration and a server-only
bindings callback. Its delivery methods return `found.content`, `missing`,
`moved.uri` or unavailable results. `responseStatus` supplies 200/404/503.
`handleEvent` and `handleRefresh` receive the original Request and Site origin.
`renderDesignPattern`, theme/presentation CSS and `consentConfiguration` remain
Runtime helpers. The app uses the existing thin `src/lib/content.ts` contract,
including forms opt-in; no runtime internals are copied.

The managed Start consent adapters call `/consent/server`'s
`createConsentServer({siteId, bindings, retentionDays}).handle(Request)`, reading
`CONSENT_RETENTION_DAYS` just as Astro does. Form adapters call `/forms/server`'s
`createFormsServer` with `content().publishedForm`, CMS origin, language, bindings
and the manifest spam choices. Package migration exports remain Node-only in
infra. The pair still uses shared managed pins, not new hard-coded CMS pins.
Main already records the paired 0.4.0 adoption in
[the content-pair migration guide](../guides/content-pair-migration.md).

No gq-content implementation change blocks this skeleton's compilation or
Worker guards. One precise nonblocking improvement is a neutral
`@getquick/content/consent/html` export for the existing `ConsentPageInput`,
`ConsentPage`, `consentPage`, `legalFooter`, `CONSENT_STYLES`. Its owner files
are `frontend/src/consent/astro.ts`, a new `frontend/src/consent/html.ts`,
`frontend/package.json` exports and the build entry list. Keep `/consent/astro`
compatible and cover SSR plus React navigation in consumer tests. Until that
release, this skeleton imports the real `/consent/astro` export: its published
JS is pure HTML generation and has no Astro dependency. Client mounting calls
the existing idempotent `startConsent()` after navigation.

## CESAM handoff

Start a separate session in a worktree of the Site clone
`/data/code/getquick/clients/cesam-bnq`. Its manifest project is `cesam`, with no
GitHub repository recorded; origin is Cloudflare Artifacts' `cesam` repository.
No Site is edited by this blueprint task; Nomia is explicitly exempt.

CESAM must replace its Site-owned `apps/frontend`, set `framework: "tanstack"`
while keeping `contentRuntime: "package"`, and update its create-once
`pnpm-workspace.yaml` and lockfile. Preserve `src/lib/content.ts` configuration:
languages, extensions/collections, consent services, first-party hosts, forms,
CMS access and content presentation. Its block rendering/client interactions
need their own Site acceptance; this thin starter is not a redesign of CESAM.

Keep `CesamFrontend`, Worker `cesam-fe`, `CesamPublications` /
`cesam-fe-publications`, `CesamConsent` / `cesam-fe-consent`, and
`CesamConsentPurge` / `cesam-consent-purge`. Sync `infra/frontend.run.ts`, retain
`infra/consent.ts`, and keep existing secrets and database state. Review the
Alchemy plan for replacement/deletion before deploying. Verify existing
publication rows, refresh/events, consent writes/reads/retention, forms,
readiness, withdrawal through an outage and release/rollback compatibility.
The new default alone does not migrate any existing Site.

The local proof establishes generation, package compatibility, real Cloudflare
build and endpoint guards. It establishes neither live CMS integration nor
CESAM feature parity. Those remain acceptance work in their owning repositories.
No production deploy or npm publish was performed.

## CI follow-up: framework-specific fixtures

Run 40425418996 at `f698281` failed `content-pair` and `consent`: both
shell scripts called `gq new` without a framework, creating the new Start
app, while their shared `frontend-runtime-lib.mjs` invoked Alchemy's Astro
builder. Both failures reproduced locally as `ERR_MODULE_NOT_FOUND` for
`astro`; installing Astro into a Start Site would hide the fixture mismatch.
The other five jobs in that completed run passed.

The Astro-specific content-pair, consent and presentation proofs now request
`--framework astro`, matching their build helper and, for presentation, their
Astro layout fixture. They continue to cover the existing Astro consumer.
`tanstack-check.mjs` deliberately omits the option and covers the new default,
with its own Vite build and workerd probe. The full consent browser acceptance
suite remains Astro coverage; the Start proof currently checks endpoint guards,
not that full browser suite. Existing manifests that omit `framework` still
select Astro. This fix changes only disposable proof fixtures; Nomia and CESAM
remain untouched.

Follow-up validation: both original failing smoke commands pass; consent runs
32 monolingual and 56 bilingual browser acceptance checks plus record/read and
readiness checks. The presentation and Hero proofs pass. The default Start
consumer proof passes app/infra type checks, Cloudflare build, migration hashes
and workerd guards. `pnpm exec vp run check` passes all 800 tests, and shell
syntax, documentation formatting and diff whitespace checks pass.

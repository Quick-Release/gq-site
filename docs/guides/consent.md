# Consent records and legal pages

[Documentation](../README.md)

What the Blueprint provides for gq-platform's consent and legal-pages
foundations (CONSENT-1 and LEGAL-1, under
[Platform ADR 0008](https://github.com/Quick-Release/gq-platform/blob/claude/cookie-consent-foundation/docs/adr/0008-consent-and-legal-pages.md),
**Proposed**), and how a Site wires them. The decision behind the
provisioning is [ADR 0019](../adr/0019-record-visitors-consent-in-a-separate-eu-database.md).

The consent Runtime is gq-content's (`@getquick/content/consent*`, see its
[consent documentation](https://github.com/Quick-Release/gq-content/blob/main/docs/consent.md)):
the banner, the categories and service catalog, embed rewriting, the record
and read endpoints, the record schema and the purge. A commerce Frontend uses
gq-storefront's React adapter over it (`@quick-release/storefront/consent`).
GQ Config holds the legal pages, the data controller and the GA4 toggle, and
reads records in its Consent tab. The Blueprint provisions, wires and checks;
it copies none of their logic into a Site.

## What the Blueprint provisions

When `apps/frontend` has a consent Runtime installed (`@getquick/content`
exporting `./consent/migrations`), the Frontend's deploy
(`infra/frontend.run.ts` with the managed `infra/consent.ts`) adds:

| Resource or binding                 | What it is                                                                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<project>-fe-consent[-<stage>]`    | A D1 database created with `jurisdiction: "eu"`, migrated from the Runtime's `consentMigrationsDirectory`, bound as `CONSENT_DB`. Retained in production. Separate from the publication store. |
| `CONSENT_READ_TOKEN`                | A Worker secret from Sigillo staging: the bearer the CMS reads records with. Without it, reads are refused and decisions are still recorded.                                                   |
| `CONSENT_RATE_LIMITER`              | A Workers Rate Limiting binding for the record endpoint: 30 a minute per client IP, counted per Site and stage. The IP isn't stored.                                                           |
| `<project>-consent-purge[-<stage>]` | A Worker with no public URL, run daily at 03:17 UTC, binding the same database. Its entry, the managed `apps/frontend/workers/consent-purge.ts`, calls the Runtime's `purge()`.                |
| `CONSENT_RETENTION_DAYS`            | A plain variable on the Frontend and the purge Worker, when `gq.ops.json` sets `consent.retentionDays` ([below](#the-sites-retention)). Without it, the Runtime's default applies.             |

A Frontend without a consent Runtime deploys exactly as before.

Offboarding a Site ([offboarding guide](offboarding.md#archive-a-site))
exports each consent database into the Site's archive (`consent.sql`,
`consent-<stage>.sql`), then deletes each purge Worker and each consent
database. **The archive then holds visitors' consent records**, the
controller's proof of consent and personal data: CONSENT-1's retention
(CN-R10) governs how long the archive keeps them, not the archive's own.

Secrets follow the Frontend's others:

```sh
pnpm frontend:secrets   # generates CONSENT_READ_TOKEN in Sigillo staging when missing
pnpm ci:deploy          # CI releases bind it to the Frontend
pnpm ploi:events        # the CMS's .env: GETQUICK_CONSENT_READ_TOKEN, GETQUICK_FRONTEND_URL
pnpm push fix           # the CMS release that copies the .env
```

GQ Config sends the token only to the HTTPS origin of `GETQUICK_FRONTEND_URL`
(which `gq ploi provision` and `gq ploi events` set to `https://<domains.frontend>`),
never to a URL saved in its admin. The CMS skeleton requires
`getquick/gq-config 0.4.3`, the first release with the Legal Contract and the
Consent tab.

### The Site's retention

Records are deleted once their decision has been out of force (superseded or
expired) for the retention period: by default the Runtime's maximum, 1826
days (5 years, CN-R10). A controller that sets a shorter period states it in
`gq.ops.json`:

```json
{ "consent": { "retentionDays": 365 } }
```

It is a whole number of days from 1 to 1826; `gq doctor` and every other
command refuse anything else. The next Frontend deploy (`pnpm ci:deploy`, or
a release) binds it as `CONSENT_RETENTION_DAYS` to both Workers from that one
value: the purge entry deletes by it, and the `/gq/consent` routes pass it to
`createConsentServer`, so the readiness `check()` reports what the purge
applies. Nothing needs `gq sync`: the deploy reads `gq.ops.json` itself.
Removing the key returns both to the Runtime's default on the next deploy.

A Site whose `/gq/consent` routes are its own (one not on the content pair,
or one that composed them by hand) passes the same value where it creates the
server, reading `CONSENT_RETENTION_DAYS` from the Worker's bindings:

```ts
retentionDays: env.CONSENT_RETENTION_DAYS ? Number(env.CONSENT_RETENTION_DAYS) : undefined,
```

## What the Blueprint checks

- **`gq doctor`** lists the Site's consent databases (with
  `CLOUDFLARE_API_TOKEN` from the environment or Sigillo staging) and fails
  on any not in `eu`. Cloudflare can't change a D1 database's jurisdiction,
  so one created elsewhere must be replaced (below).
- **`gq site check`** adds a _Consent and legal pages_ part:
  - `legal-pages`: GQ Config's Legal Contract, read anonymously per language
    as a Frontend reads it. Not ready on `missing_required` (a required role
    with no public page, as GQ Config computes it), `controller_incomplete`
    (no controller name or privacy email), or a GQ Config without the
    Contract. `missing_translation` (a language falling back to the default
    language's page) only warns. An optional role whose page went private
    isn't visible anonymously: GQ Config's Legal tab shows it
    (`page_unavailable`).
  - `consent-runtime`: not ready when GQ Config's GA4 toggle is on with a
    measurement ID and a homepage has no consent Runtime
    (`#gq-consent-config`, the Runtime's configuration, part of its
    replacement-UI Contract). When the Runtime is there it names the active
    services.
  - `third-party-hosts`: each language's homepage, as fetched without
    JavaScript, must load nothing from a host other than the Frontend's, the
    CMS's or the media domain: no live `script`, `iframe`, `img`, `source`,
    `video`, `audio`, `embed`, `object`, `track` or loading `link`, and no
    embed the Runtime blocked (`data-gq-consent-blocked`: an unknown host, or a catalog service the Site hasn't activated). The
    scan is gq-content's own `scanConsentHtml`, from the `@getquick/content`
    the CLI pins. Other routes are each Site's acceptance (CONSENT-1
    acceptance evidence, item 5).
  - `cms-events` also requires the CMS's `GETQUICK_CONSENT_READ_TOKEN` to
    match Sigillo's, when Sigillo has one.

  `gq site check` covers content Sites; it refuses commerce until #26.

## Wiring a Frontend

The Runtime's documentation is authoritative. A Site composes it at its
documented seams and copies none of its logic.

### Content (Astro)

A content Site from `gq new` (0.20.1 and later) composes the consent UI
already:

- **Routes, managed by `gq sync`** (as `gq/events.ts` and `gq/refresh.ts`
  are, on a Site with `"contentRuntime": "package"`):
  `apps/frontend/src/pages/gq/consent.ts` hands the request to the Runtime's
  `createConsentServer({ siteId, bindings }).handle()`, and answers 404 when
  it returns null; `gq/consent/[...rest].ts` re-exports it for the reads.
  `siteId` is `gq.ops.json`'s `project`, the identity the content runtime and
  the purge Worker use. The bindings are the Worker's (`CONSENT_DB`,
  `CONSENT_READ_TOKEN`, `CONSENT_RATE_LIMITER`, from `cloudflare:workers`),
  and so is the retention, `CONSENT_RETENTION_DAYS`
  ([The Site's retention](#the-sites-retention)).
  The protocol stays the package's: `POST /gq/consent` records,
  `/gq/consent/records/<id>`, `/export` and `/stats` read with the bearer.
- **The runtime option, in `src/lib/content.ts`** (created once, the Site's):
  `createContentRuntime({ …, consent: { services: [], cmsSettings: true, firstPartyHosts } })`.
  Every published body's third-party embeds become placeholders at delivery,
  and each language's chrome carries GQ Config's Legal Contract and GA4
  toggle. `firstPartyHosts` are the Site's Frontend and media domains
  (`domains.frontend`, `media.domain`); the CMS's is included by default.
- **The UI, in `src/layouts/Layout.astro`** (created once, the Site's):
  `consentPage({ configuration: runtime.consentConfiguration(chrome), language, legal, cookie })`
  from `@getquick/content/consent/astro`, its `head` in `<head>`, its `body`
  first in `<body>`, its `footer` (the legal links and **Cookie settings**)
  in a `<footer>`, and `startConsent()` from
  `@getquick/content/consent/client` in a `<script>`. Restyle it through the
  `--gq-consent-*` custom properties.
- No cron on the Site's Worker: the purge Worker above runs it.

**Services.** A new Site declares no catalog service (`services: []`). With
GA4 off there is no optional service, so no banner and nothing is recorded,
but **Cookie settings** and the legal links stay on every page (CN-C1). GQ
Config's GA4 toggle (with a measurement ID) adds GA4 and the banner. An
embed of a service the Site hasn't declared, such as a YouTube video in a
post, is served as a blocked placeholder: nothing loads, and
`gq site check`'s `third-party-hosts` names it on a homepage. To let
visitors load it after consent, declare the service in `src/lib/content.ts`
(`services: ["youtube"]`; the catalog has `youtube`, `vimeo` and
`google_maps`). A declared service is an optional category, so the banner
asks for it.

**Proofs.** The generated Frontend's own tests (`src/routes.test.ts`, run by
`scripts/smoke/frontend-check.sh`) render pages through Astro's Container
API with the stub CMS. `scripts/smoke/consent.sh` serves the built Frontend
in workerd with local D1 stores and runs gq-content's
`runConsentAcceptance` in Chromium, monolingual and bilingual (CI's
`consent` job).

### Commerce (TanStack Start)

- The root route's loader calls a server function that builds
  `storefrontConsent({ settings, language, services, cookie })` from
  `@quick-release/storefront/consent`, with `shouldReload: true`;
  `<ConsentUi>` first in `<body>`, `<ConsentLegalLinks>` in the footer.
- One splat route, `src/routes/gq.consent.$.ts`, with `GET` and `POST`
  handlers calling the Runtime's `handle()`.
- Turn off TanStack Router's `scrollRestoration`: it writes session storage on
  every visit.
- No cron on the Site's Worker: the purge Worker above runs it.

There is no commerce skeleton yet (`gq new --variant commerce`, #89), and the
commerce Frontend's deploy file is to come with it; it imports the same
`infra/consent.ts`.

## Adopting it on an existing Site

`gq sync` adds the managed parts. The layout and `lib/content.ts` are the
Site's, so it never touches them: compose the UI there by hand.

### A Site on the content pair (`"contentRuntime": "package"`, 0.20.0)

1. Upgrade `@getquick/site` and run `gq sync`. It adds
   `apps/frontend/src/pages/gq/consent.ts` and `gq/consent/[...rest].ts`.
   If the Site already composed its own `/gq/consent` routes, `gq sync`
   names them and writes nothing: delete them, then sync again.
2. In `apps/frontend/src/lib/content.ts`, widen the manifest's type and pass
   the `consent` option to `createContentRuntime`:

   ```ts
   const manifest = ops as {
     project: string;
     domains?: { admin: string; frontend: string };
     media?: { domain: string };
     wordpress?: { locale?: string; languages?: Array<{ locale: string; slug: string }> };
   };
   ```

   ```ts
       bindings,
       consent: {
         services: [], // the catalog services the Site embeds, e.g. ["youtube"]
         cmsSettings: true,
         firstPartyHosts: [manifest.domains?.frontend, manifest.media?.domain].filter(
           (host): host is string => Boolean(host),
         ),
       },
     });
   ```

3. In `apps/frontend/src/layouts/Layout.astro`, import the UI, build it
   after the chrome is known, and place its parts:

   ```astro
   ---
   import { consentPage } from "@getquick/content/consent/astro";
   // … after `chrome`, `language` and `runtime` are set:
   const configuration = runtime.consentConfiguration(chrome);
   const consent = configuration
     ? consentPage({
         configuration,
         language: language.lang,
         legal: chrome?.legal,
         cookie: Astro.request.headers.get("cookie"),
       })
     : null;
   ---
   <head>
     …
     {consent && <Fragment set:html={consent.head} />}
   </head>
   <body>
     {consent && <Fragment set:html={consent.body} />}
     <header>…</header>
     <slot />
     {consent && (
       <footer class="site-footer">
         <Fragment set:html={consent.footer} />
       </footer>
     )}
     <script>
       import { startConsent } from "@getquick/content/consent/client";
       startConsent();
     </script>
   </body>
   ```

   A layout with its own footer puts `consent.footer` in it instead. The
   banner must stay first in `<body>`.

4. If the Frontend's tests stub WordPress by query name (the skeleton's
   `src/test/wordpress-stub.ts`), answer `ConsentSettings` too: with
   `cmsSettings` on, every chrome read also asks GQ Config for the Legal
   Contract and GA4. A new Site's stub and tests (`src/routes.test.ts`, "the
   consent UI") show it; `gq sync --recreate` writes them over the Site's
   own.
5. `pnpm frontend:secrets` (it generates `CONSENT_READ_TOKEN` when missing),
   `pnpm ci:deploy`, `pnpm ploi:events`, then a release. Then
   `pnpm frontend:refresh`, so the stored chrome carries the Legal Contract
   (GQ Config's `legal` and `analytics` settings events refresh it from then
   on).
6. `pnpm doctor` (the jurisdiction) and `pnpm site:check` (legal pages, the
   Runtime, third-party hosts).

### A Site generated before 0.20.0

Move it onto the content pair first
([Move an existing Site onto the content package pair](content-pair-migration.md)),
then follow the steps above. Until then it can compose the same parts by
hand around its copied runtime with `@getquick/content` 0.2.0 installed for
consent: `consentConfiguration({ services, analytics, controller })` from
`@getquick/content/consent` takes the place of `runtime.consentConfiguration`,
and `rewriteEmbeds` the `consent` option's rewriting. Require
`getquick/gq-config` `^0.4.3` in `apps/cms/composer.json` for the Legal
Contract and the Consent tab, and don't require `getquick/gq-content` while
the CMS still has the skeleton's own event mu-plugins
(`publication-events.php`, `settings-events.php`, `delivery-retries.php`):
they declare the same PHP namespace, and WordPress stops on the
redeclaration.

A Site that loaded a third-party script or embed itself replaces it with a
catalog service through the Runtime, a placeholder, or a self-hosted copy;
readiness names each host.

### A consent database outside the EU

Only a database created by hand, or by a deploy before this wiring, can be
elsewhere. Cloudflare can't move it:

1. `wrangler d1 export <name> --remote --table consent_records --no-schema --output consent.sql`:
   the records only (they are personal data: keep the file out of the
   repository, and delete it afterwards).
2. Delete the database (`wrangler d1 delete <name>`), and redeploy the
   Frontend: Alchemy creates it in `eu` and applies the migrations.
3. Import them (`wrangler d1 execute <name> --remote --file consent.sql`),
   then `pnpm doctor`.

Visitors' decisions made during the swap stay applied in their browsers; the
Runtime retries a record it couldn't deliver.

## Tested Platform release combination

Recorded for `@getquick/site` 0.20.1 on 2026-10-22.

| Component                                    | Pin           | Artifact                                                                                                                                        |
| -------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `@getquick/site`                             | 0.20.1        | npm; depends on `@getquick/content` 0.2.0 exactly, for readiness's scan                                                                         |
| `getquick/gq-config`                         | 0.4.3         | GETQUICK Composer registry; pinned in the CMS skeleton                                                                                          |
| `@getquick/content`                          | 0.2.0         | npm, tag `v0.2.0` at `3806642`, `sha512-zywnQvGpSmiOpuKqCJbt/mHokXQbe/gfvC80ZGtg0TEs7oJKAMjba9tSXZcsHiIogS+b7ez+fBb1OmkFHK6PaA==`               |
| `getquick/gq-content`                        | 0.2.0         | GETQUICK Composer registry (`wordpress-muplugin`), the same tag; ZIP SHA-256 `9a80fbd57cab1716ed8030b16180115ee992062b3248525a65782ad8dde76850` |
| `@quick-release/storefront`                  | 0.2.1         | GitHub Packages; checked with 0.19.1 beside `@getquick/content` 0.1.0, not again since                                                          |
| Alchemy / `@alchemy.run/frontend-frameworks` | 2.0.0-beta.79 | the Blueprint's catalog pin                                                                                                                     |

The content skeleton pins `getquick/gq-content` and `@getquick/content`
(managed keys) and composes the consent UI and routes, as above. There is no
commerce skeleton yet (#89).

Checked together, without deploying anything or creating a Cloudflare
resource, on a Site generated by this release with its Frontend installed
from npm (CI's `generated-frontend`, `content-pair` and `consent` jobs): the
Frontend's tests, `astro check`, lint and format pass; Alchemy's Astro build
served in workerd with a local D1 publication store and consent database passes
gq-content's `runConsentAcceptance` in Chromium on representative routes
(CN-R1, CN-R4, CN-R6, CN-R13), records a decision through `POST /gq/consent`
and answers it at `GET /gq/consent/records/<id>` with the bearer only, and
`gq site check`'s `legal-pages`, `consent-runtime` and `third-party-hosts`
are ready with GA4 on, monolingual and bilingual (`legal-pages` warns of the
bilingual fixture's untranslated privacy policy, as it should). The 0.19.1 checks of
`infra/` and the purge entry stand.

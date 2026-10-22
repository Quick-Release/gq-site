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

A Frontend without a consent Runtime deploys exactly as before.

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
    rules are gq-content's `scanConsentHtml`'s. Other routes are each Site's
    acceptance (CONSENT-1 acceptance evidence, item 5).
  - `cms-events` also requires the CMS's `GETQUICK_CONSENT_READ_TOKEN` to
    match Sigillo's, when Sigillo has one.

  `gq site check` covers content Sites; it refuses commerce until #26.

## Wiring a Frontend

The consent UI is composed in a Site's own files, which `gq sync` never
writes: the layout, the routes and the components are site-owned (create-once
skeleton files), so a Site's custom layout is never overwritten. The Runtime's
documentation is authoritative; in short:

### Content (Astro)

- `src/pages/gq/consent.ts` and `src/pages/gq/consent/[...rest].ts`: hand
  the request to the Runtime's `createConsentServer({ siteId, bindings })`
  `handle()` (bindings from `cloudflare:workers`: `CONSENT_DB`,
  `CONSENT_READ_TOKEN`, `CONSENT_RATE_LIMITER`), and answer 404 when it
  returns null.
- The layout: `consentPage({ configuration, language, legal, cookie })` from
  `@getquick/content/consent/astro`, its `head` in `<head>`, its `body` first
  in `<body>`, its `footer` in the footer, and
  `startConsent()` from `@getquick/content/consent/client` in a script.
- Embeds and GQ Config's settings: `createContentRuntime({ consent: { services, cmsSettings: true } })`
  rewrites every published body's embeds at delivery and reads the Legal
  Contract and GA4 into each language's chrome. Site components use
  `embedPlaceholder()`.
- No cron on the Site's Worker: the purge Worker above runs it.

The content app skeleton still carries its own copy of the content runtime
rather than `@getquick/content` (#77), so a new content Site gets the
provisioning and checks but composes the consent UI by hand, as above, until
the skeleton moves to the package.

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

1. Upgrade `@getquick/site` and run `gq sync`: it adds `infra/consent.ts`, the
   purge entry and the consent wiring in `infra/frontend.run.ts`, the CI
   secret, and nothing site-owned.
2. Require `getquick/gq-config` `^0.4.3` in `apps/cms/composer.json`, update
   the lock and release the CMS. Assign the legal pages and the controller in
   GETQUICK → Legal.
3. Add the exact `@getquick/content` (and, on commerce,
   `@quick-release/storefront`) pins from the tested combination below to
   `apps/frontend/package.json`, and compose the UI and routes as above.
4. `pnpm frontend:secrets`, `pnpm ci:deploy`, `pnpm ploi:events`, then a
   release: the first deploy creates the consent database in `eu`.
5. `pnpm doctor` (the jurisdiction) and `pnpm site:check` (legal pages, the
   Runtime, third-party hosts).

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

| Component                                    | Version                                                        | State                                |
| -------------------------------------------- | -------------------------------------------------------------- | ------------------------------------ |
| `@getquick/site`                             | this branch (#106)                                             | unreleased                           |
| `getquick/gq-config`                         | 0.4.3                                                          | released; pinned in the CMS skeleton |
| `@getquick/content` / `getquick/gq-content`  | 0.1.0 from `main` at `504d154` (gq-content#29), packed locally | merged, **not published**            |
| `@quick-release/storefront`                  | 0.2.1 candidate (gq-storefront#17)                             | unmerged, **not published**          |
| Alchemy / `@alchemy.run/frontend-frameworks` | 2.0.0-beta.79                                                  | the Blueprint's catalog pin          |

Checked together: the generated `infra/` type-checks against Alchemy
beta.79; with the packed `@getquick/content` 0.1.0 installed in a generated
Site, `infra/consent.ts` finds its consent migrations, the purge entry
type-checks, and its `scheduled()` run against the real migration deleted a
record past retention and kept a current one; `astro check`, lint and format
pass in the generated Frontend. Nothing was deployed: no Cloudflare resource
was created. The combination is recorded again with exact published versions
when `@getquick/content` and the storefront are released.

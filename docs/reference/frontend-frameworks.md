# Frontend frameworks

`gq.ops.json` selects `framework: "astro" | "tanstack"` separately from
`variant: "content" | "commerce"`. Omission means Astro, including manifests
migrated from v0. `gq new` defaults to `tanstack`; `--framework astro` explicitly
creates the supported Astro skeleton. Commerce creation remains unsupported.

The TanStack skeleton uses React, Start and Router. `gq sync` manages its
`src/routes/gq.*` endpoints and `src/worker.ts`; the app, page presentation and
`src/site.server.ts` are Site-owned. The installed `@getquick/content` owns
publication delivery, migrations, event verification, refresh, consent and
retention. The skeleton copies none of that logic. The Start CMS installs the matching
`getquick/gq-content` 0.4.0 MU plugin and gq-config 0.5.0 for legal fields; it
sets `GQ_CONTENT_SITE_ID` to the manifest project and omits the copied CMS event
modules. Private Composer availability and paired integration remain a release
dependency, detailed in the integration note.

Fill `domains` before deploying. Local `pnpm frontend:dev` runs at port 4321,
reads the existing public GraphQL env variable and explicitly allows Runtime
live delivery in development. Production stays store-only, with 503 before
preparation. `pnpm check` builds the route tree and type-checks the app.
`infra:check` checks the deployment declaration. `gq doctor` requires Start's
Vite config and router instead of an Astro config.

## Adoption

Changing `framework` is an explicit deployment choice, never an app conversion.
`sync` preserves every Site-owned app file and refuses edits to managed files.
A Site changing frameworks must replace its own app, adapt its own Runtime
configuration, run `sync`, update its create-once workspace catalog and lockfile,
and prove readiness before releasing. Review the resulting Alchemy plan against
the existing state before any deploy; this change performs no deployments.

The publication Stack, Website, D1 logical IDs, database and Worker names stay
unchanged across frameworks. Package migrations 0001–0005 are byte-identical to
the Astro skeleton's. Production D1 removal policy stays retain. Deployment and
release guards still refuse an Offboarded Site.

Start creates a separate EU consent D1 store (`<project>-fe-consent`, logical ID
`<Project>Consent`) with `CONSENT_DB`, a write rate limiter, and optional
`CONSENT_READ_TOKEN`. `gq frontend secrets` prepares that token for Start;
`gq ci deploy` forwards it and CI releases bind it. A daily Worker scheduled
handler delegates retention to the Runtime. Offboarding archives consent SQL
alongside publication SQL before deleting its store; resumption refuses to
remove a consent store absent from the recorded archive.

For a Site with an existing consent store, match its resource identity and
existing Alchemy state in that Site's migration. The default name is for new
Sites; do not create a second store and mistake it for migration.

Nomia (`nomia-bnq`) remains Astro: leave its manifest and app alone. CESAM's
Frontend replacement belongs in its own repository and worktree. Neither Site
is modified by this blueprint change.

## Verification

Run `node scripts/smoke/tanstack-check.mjs` for a disposable generated consumer.
It installs the pinned published packages, checks app and infrastructure,
compares historical publication SQL byte for byte, builds with Alchemy v2's
actual Cloudflare Vite plugin, and executes the resulting Worker in workerd.
No account, secrets, Alchemy plan or deploy is used. `KEEP=1` keeps the proof.
Existing Astro smoke commands explicitly select Astro and retain their tests.

The deployment evidence and cross-repository contracts are in
[the integration note](../research/tanstack-start-alchemy-v2.md).

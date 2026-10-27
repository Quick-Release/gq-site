# Frontend frameworks

`gq.ops.json` selects `framework: "astro" | "tanstack"` separately from
`variant: "content" | "commerce"`. Omission means Astro, including migrated
manifests and Sites on `contentRuntime: "package"`. `gq new` defaults to
`tanstack`; `--framework astro` explicitly creates the supported Astro skeleton.
Commerce creation remains unsupported. TanStack content Frontends require
`contentRuntime: "package"`; new Sites already select that paired Runtime.

The TanStack skeleton uses React, Start and Router. `gq sync` manages its
`src/routes/gq.*` endpoints. The router, pages and `src/lib/content.ts` Runtime
configuration are Site-owned. The installed `@getquick/content` owns delivery,
event verification, refresh, consent, forms and migrations. The skeleton copies
none of that logic. The shared package-pair managed keys pin both Runtime halves
as before; no second framework-specific CMS or package upgrade mechanism is added.

`pnpm frontend:dev` runs at port 4321 and uses the public GraphQL env variable.
Only development explicitly allows live delivery without a store. Production
answers 503 before preparation. `pnpm check` builds the route tree and checks
types. `infra:check` checks deployment. Doctor requires Vite and Router instead
of Astro config, and checks the TanStack form route when forms are configured.

## Adoption

Changing `framework` is a deployment choice, never an app conversion. Sync
preserves Site-owned app files and refuses edits to managed files. An existing
Site must replace its own app, adapt `src/lib/content.ts`, sync managed files,
update its create-once workspace catalog and lockfile, and prove readiness.
Review the Alchemy plan against existing state before deploying.

Start uses Alchemy v2 `Cloudflare.Website.Vite`. Stack, Website, publication D1,
consent D1 and purge Worker identities stay the same. The shared `infra/consent.ts`,
retention configuration, per-stage rate limits, secrets, CI/release forwarding,
offboarding and rollback orchestration are unchanged. Consent retention remains
in its separate managed purge Worker (ADR 0019), rather than moving to the
Frontend. Start adds no new database or secret name.

Nomia (`nomia-bnq`) remains Astro: leave its manifest and app alone. CESAM's
Frontend replacement belongs in its own repository and worktree. Neither Site
is modified here. CESAM's manifest project is `cesam`, regardless of its clone's
`cesam-bnq` directory name; keep that identity.

## Verification

`node scripts/smoke/tanstack-check.mjs` creates a disposable consumer using this
checkout. It installs dependencies, checks app and infra, verifies the historical
publication SQL hashes, builds with Alchemy beta.79's actual Cloudflare Vite
plugin, and executes the emitted Worker in workerd. No account, secret, Alchemy
plan or deploy is used. `KEEP=1` retains the proof. Existing Astro smoke commands
explicitly select Astro and retain their coverage.

See [the integration note](../research/tanstack-start-alchemy-v2.md) for upstream
sources, evidence limits and the CESAM/gq-content handoff.

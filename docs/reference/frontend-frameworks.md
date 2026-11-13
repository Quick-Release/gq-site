# Frontend frameworks

`gq.ops.json` selects `framework: "astro" | "tanstack"` separately from
`variant: "content" | "commerce"`. Omission means Astro, including migrated
manifests and Sites on `contentRuntime: "package"`.

A new content Site chooses its Frontend framework: Astro or TanStack Start.
Both are first-class, supported choices; neither is a compatibility path
([gq-platform ADR 0015](https://github.com/Quick-Release/gq-platform/blob/main/docs/adr/0015-astro-or-tanstack-for-new-content-site-frontends.md),
amending ADR 0010). Astro suits content-heavy Sites that render CMS HTML and
keep little client-side state; TanStack Start suits application-like Sites. In
a terminal, `gq new` asks a content Site for the framework unless
`--framework astro|tanstack` gives it. Outside a terminal `--framework`
selects it, and without the flag the Site is TanStack, so existing scripts
keep their behaviour.

A commerce Site's Frontend is TanStack Start whatever `framework` says
([ADR 0017](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0017-generate-commerce-sites-from-the-variant-alone.md)):
`gq new --variant commerce` records `tanstack` and refuses `--framework astro`. TanStack content Frontends require
`contentRuntime: "package"`; new Sites already select that paired Runtime.

The Astro skeleton uses Astro with Tailwind CSS. `gq sync` manages its
`src/pages/gq/*` endpoints and, when forms are configured, its form route. Its
pages, layouts and runtime configuration are Site-owned. `pnpm check` runs
`astro check`; doctor requires `astro.config.mjs`. The installed
`@getquick/content` owns the same delivery, events, refresh, consent, forms and
migrations as for TanStack.

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

## Versions

Each skeleton pins the newest stable upstream releases that pass the
Blueprint's checks, and the two share the toolchain pins (gq-platform ADR 0015
decision 4). A version that fails a check is recorded here with the version
pinned instead; no check is weakened for it. Pinned on 2026-11-12:

| Package                                                                      | Astro skeleton | TanStack skeleton |
| ---------------------------------------------------------------------------- | -------------- | ----------------- |
| `astro`                                                                      | ^7.4.11        | —                 |
| `@astrojs/check`                                                             | ^0.9.12        | —                 |
| `tailwindcss`, `@tailwindcss/vite`                                           | 4.3.5          | —                 |
| `@tanstack/react-start`                                                      | —              | 1.169.5           |
| `@tanstack/react-router`                                                     | —              | 1.170.46          |
| `react`, `react-dom`                                                         | —              | 19.3.1            |
| `@types/react`, `@types/react-dom`                                           | —              | 19.3.0            |
| `@vitejs/plugin-react`                                                       | —              | 6.3.0             |
| `@cloudflare/workers-types`                                                  | —              | 5.20261110.1      |
| `typescript` (Frontend)                                                      | ^6.0.3         | 7.0.2             |
| `typescript` (`infra`, `infra/ci`, managed)                                  | ^7.0.2         | ^7.0.2            |
| `vite-plus` (`vite` is its core)                                             | 1.6.0          | 1.6.0             |
| `vitest`                                                                     | 5.1.0          | 5.1.0             |
| `alchemy`, `@alchemy.run/cloudflare`, `@alchemy.run/frontend-frameworks`     | 2.0.0-beta.86  | 2.0.0-beta.86     |
| `effect`, `@effect/platform-node`, `@effect/platform-node-shared` (override) | 4.1.4          | 4.1.4             |

Gaps from the latest release:

- **TypeScript 7 in the Astro Frontend.** `astro check` (`@astrojs/check`
  0.9.12, whose `typescript` peer is `^5 || ^6`) refuses TypeScript 7: "astro
  check does not currently support TypeScript 7.0". Astro's experimental
  replacement, `@astrojs/ts-content-mapper`, needs TypeScript 7.1, which is
  still a beta. The Astro Frontend stays on TypeScript 6.0.3, the latest 6.x.
  The TanStack Frontend and the managed `infra` packages use TypeScript 7.0.2.
- **Alchemy beta.86, not the latest.** From 2.0.0-beta.84 the Cloudflare
  provider is its own package, `@alchemy.run/cloudflare`: the managed
  `infra/*.ts` import it, and `infra/package.json` depends on it from the
  catalog. The Alchemy and Effect catalog entries, the
  `@effect/platform-node-shared` override and the `effect` peer rule are
  managed keys of each Site's `pnpm-workspace.yaml`, so `gq sync` moves them
  with the templates
  ([migration plan](../research/alchemy-cloudflare-package-migration.md)).
  beta.85 and later speak the Cloudflare state store's v8 protocol and upgrade
  the account's shared store on their first `--yes` run. After that, no
  project in the account on beta.84 or older can plan or deploy. That move is
  hop 2, made for the whole account at once. beta.86 adds
  `RemovalPolicy.protect()`, which the production publication and Consent
  databases (and the storefront Runtime's) now carry. beta.87 (2026-11-12)
  changes nothing the managed infra uses: its Cloudflare changes are to Durable
  Object class deletion and containers, and it was still inside pnpm's 24-hour
  `minimumReleaseAge` when 0.44.0 was cut.
- **Effect 4.1.** Alchemy beta.79 to beta.84 import `effect/Crypto`, which
  Effect 4.1 removed, and beta.85 and later need Effect `^4.1.0` (beta.86:
  `^4.1.4`). So Effect moved with Alchemy twice: 4.0.7 for beta.84 (0.43.1)
  and 4.1.4 for beta.86. `@effect/sql-d1` 4.1.4, which
  `@alchemy.run/cloudflare` depends on, matches it again.
  `scripts/smoke/sync-upgrade.sh` plans the stack as far as Cloudflare to catch
  a pair that can't load.
- **Astro 7.4 for frontend-frameworks.** From beta.85,
  `@alchemy.run/frontend-frameworks` peers on `astro ^7.4.0`. A Site's own
  `apps/frontend` range (`^7.2.9` on Cooldown Gaming, Nomia and Southside)
  allows the Astro 7.3 its lock may hold, and pnpm only warns, so `gq doctor`
  fails when the installed Astro is outside that peer range. The fix is
  `pnpm --dir apps/frontend update astro@^7.4.0`.
- **`capnp-es` and TypeScript 7.** `@alchemy.run/cloudflare-runtime` beta.84 to beta.86
  depends on `capnp-es` 0.0.16, whose optional `typescript` peer is `^5 || ^6`.
  pnpm warns; builds, checks and the workerd probe pass.
- **`@cloudflare/workers-types`.** 5.20261112.1 was published on 2026-11-12,
  inside pnpm's 24-hour `minimumReleaseAge`; the skeletons pin 5.20261110.1.

An existing Site's catalog (Alchemy beta.79, beta.83 or beta.84, Effect
4.0.0-rc.115, 4.0.7 or 4.1.4) moves to these pins on its next `gq sync`:
`scripts/smoke/sync-upgrade.sh` syncs a 0.40.0 Site (`GQ_SYNC_FROM` picks
another release; CI also runs 0.43.0 and 0.43.1), installs it, type-checks its `infra` under TypeScript 7
and plans its Frontend stack as far as Cloudflare. The
Astro workspace keeps its `@napi-rs/wasm-runtime>@emnapi/runtime` override at
1.11.3, the latest 1.x: without it pnpm still resolves an `@emnapi/runtime`
2.0 beta for `astro2tsx`'s wasm runtime, the ABI mismatch the override
prevents.

## Verification

`node scripts/smoke/tanstack-check.mjs` creates a disposable consumer using this
checkout. It installs dependencies, checks app and infra, verifies the historical
publication SQL hashes, builds with the pinned Alchemy's actual Cloudflare Vite
plugin, and executes the emitted Worker in workerd. No account, secret, Alchemy
plan or deploy is used. `KEEP=1` retains the proof. The Astro smokes
(`scripts/smoke/frontend-check.sh`, `consent.sh`, `presentation.sh` and
`content-pair.sh`) select `--framework astro` and remain required; neither
framework's coverage is weakened to make the other pass.

See [the integration note](../research/tanstack-start-alchemy-v2.md) for upstream
sources, evidence limits and the CESAM/gq-content handoff.

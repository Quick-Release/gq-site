# Alchemy beta.84+ and `@alchemy.run/cloudflare`: fleet migration plan

Planning only, written 2026-11-12 against gq-site `main` 790b1b6 (0.41.1).
Nothing here is implemented. Tracking issue: [#185](https://github.com/Quick-Release/gq-site/issues/185).

## Problem

The Blueprint pins `alchemy` and `@alchemy.run/frontend-frameworks`
2.0.0-beta.83 ([Frontend frameworks](../reference/frontend-frameworks.md#versions)).
From beta.84 Alchemy's Cloudflare provider is no longer `alchemy/Cloudflare`
but its own package, `@alchemy.run/cloudflare`.

The two halves of a Site's Alchemy setup have different owners
(`blueprint/ownership.json`):

| File                                                                        | Ownership                                            | Holds                                                                         |
| --------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| `infra/frontend.run.ts`, `infra/consent.ts`, `infra/storefront-bindings.ts` | fully generated                                      | `import * as Cloudflare from "alchemy/Cloudflare"`                            |
| `infra/package.json`                                                        | fully generated                                      | `alchemy`, `@alchemy.run/frontend-frameworks`, `effect`: `"catalog:"`         |
| `apps/frontend/package.json`                                                | create-once (+ managed keys for `@getquick/content`) | `@alchemy.run/frontend-frameworks`: `"catalog:"` (Astro and TanStack content) |
| `pnpm-workspace.yaml`                                                       | create-once                                          | the `catalog:` versions                                                       |

`gq sync` rewrites the first two in every Site; nothing rewrites the catalog.
Shipping split-package templates alone would leave a Site with
`@alchemy.run/cloudflare: "catalog:"` and no catalog entry (pnpm install
fails) or, with a literal pin, two Alchemy cores (beta.79 from the catalog and
beta.8x from the Cloudflare package's peer). Either breaks `infra:check` and
the deploy on the Site's next sync.

## Upstream changes, beta.83 → latest

Read on 2026-11-12 from the npm registry, the GitHub releases
([v2.0.0-beta.84](https://github.com/alchemy-run/alchemy/releases/tag/v2.0.0-beta.84),
[beta.85](https://github.com/alchemy-run/alchemy/releases/tag/v2.0.0-beta.85),
[beta.86](https://github.com/alchemy-run/alchemy/releases/tag/v2.0.0-beta.86)),
PRs #2288, #2316, #2327, #2945, #3002, #3074 and #3201, and a diff of the published
`src/` of alchemy 83/84/86, `@alchemy.run/cloudflare` 84/85/86 and
`@alchemy.run/frontend-frameworks` 83/86. Nothing was run against a live
state store: points marked _inferred_ come from reading the code.

### Versions

- The latest is **2.0.0-beta.86** for `alchemy`, `@alchemy.run/cloudflare`
  and `@alchemy.run/frontend-frameworks`, published 2026-11-12 (inside pnpm's
  24-hour `minimumReleaseAge` today). beta.84 was published 2026-10-24 and
  beta.85 on 2026-11-02. `@alchemy.run/cloudflare` starts at beta.84.
- **The three move in lockstep.** `@alchemy.run/cloudflare` peers on
  `alchemy` and (optionally) `@alchemy.run/frontend-frameworks` at its own exact
  version, and frontend-frameworks pins its `cloudflare-runtime` at its own.
  Its `effect` peer is ^4.0.5 (84), ^4.1.0 (85) and ^4.1.4 (86). The
  Blueprint's Effect 4.1.4 satisfies all three. The existing Sites' 4.0.0-rc.115
  satisfies none of them, so Effect moves with Alchemy.
- At beta.85 frontend-frameworks' framework peers moved (Astro ^7.4.0 among
  them) and it took `@alchemy.run/redis` as a dependency.

### Imports

- `alchemy/Cloudflare` and every `alchemy/Cloudflare/*` path are gone from
  beta.84, with no shim (#2316). The swap is
  `import * as Cloudflare from "@alchemy.run/cloudflare"`; sub-paths keep
  their shape (`@alchemy.run/cloudflare/D1`, `/Website`, …).
- `alchemy`, `alchemy/Stack` and `RemovalPolicy` stay in core.
- **`@alchemy.run/cloudflare` must be a direct dependency of `infra/package.json`.**
  From beta.84 (#2288), the CLI finds Cloudflare auth, the Cloudflare state
  store and `alchemy cloudflare` through the package's `alchemy.contributes`
  field, and it looks for them only in the project's `package.json`
  dependencies and in installed `@alchemy.run/*` packages. Without the
  dependency, a deploy fails with "install the package".

### Resource, provider and CLI API

For what the managed infra uses (Worker, `Website.Astro`, `Website.Vite`,
D1, RateLimit, Routes, custom domains, `Cloudflare.providers()`,
`Cloudflare.state()`, `Alchemy.Stack`), the props are unchanged apart from
these additions:

- Worker: optional `codeUpdateStrategy` (85), optional `domain.dns` for
  non-Cloudflare DNS. Domains without `dns` attach as before.
- `Website.Astro`: `output` resolves from the prop, then `astro.config.*`,
  then `"server"`. We pass `"server"`. Optional `main`.
- D1: `lookup` (86). No new replacement triggers, and the migrations table is
  unchanged.
- `Cloudflare.state()` options became `{ accountId?, domain?, workerName? }` (#2945).
  We call it with no arguments.
- The CLI flags `deploy-frontend.mjs` passes (`deploy --stage --config --yes
--no-input --dry-run --detailed --adopt`) all still exist at beta.86. Core
  dropped `--account-id`, `--worker-name`, `--region` and `--watch`; the
  Cloudflare provider now contributes its own flags.
- Auth reads the same variables (`CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID`, …). From beta.85 credentials resolve from the
  caller's config, not the last deploy's.

**Behaviour change: secrets (beta.85, #2327).** A full deploy now deletes
`secret_text` bindings that an earlier Alchemy deploy uploaded and this one
doesn't declare. State written by beta.83 or earlier has no `secretNames`, so
the provider falls back to the previous deploy's `env`. That means the first
beta.85+ deploy can already unbind a secret. `frontend.run.ts` declares
`FRONTEND_REFRESH_TOKEN`, `PUBLICATION_EVENT_SECRET`, `CONSENT_READ_TOKEN`,
the Turnstile secret and the preview credentials only when their variable is
set. On beta.83 a deploy run without one left the old secret bound. From
beta.85 it removes it (_inferred_).

### State compatibility

- **Resource type identifiers are unchanged** (`Cloudflare.Worker`,
  `Cloudflare.D1Database`, `Cloudflare.RateLimit`, `Cloudflare.Workers.Route`,
  …). Of 414 `Cloudflare.*` identifiers in beta.83, the only ones missing at
  beta.86 are internal. Nothing in the package move itself replaces or
  deletes a resource (_inferred_ from the unchanged identifiers and logical
  IDs).
- **The Cloudflare state store's protocol goes from v7 to v8 at beta.85.**
  beta.84 still speaks v7. A beta.85+ deploy run with `--yes` (as ours always
  is) upgrades the store in place. A v8 store answers 409 to the legacy
  protocol that beta.83 and earlier use, and beta.85+ refuses a store newer
  than itself.
- **The store is one per Cloudflare account.** `Cloudflare.state()` with no
  arguments uses the `alchemy-state-store` Worker. Every Blueprint Site below
  deploys to the same account (`8f38791a…`). So the first Site to deploy on
  beta.85+ upgrades the store for all of them, and from then on every Site, or
  any other Alchemy project in that account, that is still on beta.84 or older
  can no longer deploy (_inferred_ from code; not observed).
- Previewing: `alchemy deploy --dry-run --detailed` (our `plan:frontend`)
  exists throughout. From beta.85 Worker and D1 reads keep their persisted
  shape, so unchanged resources no longer show as drift. beta.86 adds
  `RemovalPolicy.protect()` (#3074), which makes any plan that would replace or
  delete the resource fail.

### Breaking changes that don't touch the managed infra

These are listed so the review can confirm them against the templates:
`foundationDns` → `nameservers.type` (#2501),
`Test.make` → `@alchemy.run/test` (#2621),
`Access.getIdentityProvider` → `IdentityProvider.lookup` (#3002),
nested Durable Object transactions (#3110),
`CertificatePack` issuance status (#3108),
a Redacted Logpush `destinationConf` (#2840), and
spec regeneration for a few account-level resources (#3201).

## Fleet inventory

Read on 2026-11-12 from each Site's default branch on GitHub (`gh api`,
read-only) and, for the Artifacts-hosted Site, its local clone. Every
Blueprint Site has the same infra imports
(`alchemy`, `alchemy/Stack`, `alchemy/Cloudflare`).

| Site                              | Repository                                                                  | Variant / Frontend                              | `@getquick/site` | Catalog `alchemy` / `frontend-frameworks` | `effect`     | In scope                                                                            |
| --------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------- | ---------------- | ----------------------------------------- | ------------ | ----------------------------------------------------------------------------------- |
| Cooldown Gaming (reference)       | Quick-Release/cooldowngaming                                                | content, Astro, package runtime                 | 0.35.0           | 2.0.0-beta.79 / beta.79                   | 4.0.0-rc.115 | yes, first                                                                          |
| Southside                         | Quick-Release/southside-bnq (`/data/code/vh/clients`)                       | content, Astro, package runtime                 | 0.40.0           | beta.79 / beta.79                         | 4.0.0-rc.115 | yes                                                                                 |
| Nomia (bioeconomia.apambiente.pt) | Quick-Release/nomia-bnq                                                     | content, Astro, package runtime                 | 0.38.0           | beta.79 / beta.79                         | 4.0.0-rc.115 | yes                                                                                 |
| CESAM                             | Cloudflare Artifacts `cesam` (local clone `cesam-bnq`, ff6ab35, 2026-10-24) | content, Astro, package runtime                 | 0.23.2           | beta.79 / beta.79                         | 4.0.0-rc.115 | yes; its TanStack rebuild (gq-platform site-frontend-framework plan) may land first |
| Bruaa                             | Quick-Release/bruaa                                                         | commerce, TanStack                              | 0.35.0           | beta.79 / beta.79                         | 4.0.0-rc.115 | yes                                                                                 |
| FPA Shop                          | Quick-Release/fpa-shop                                                      | commerce foundation, no `infra/` or catalog yet | 0.18.1           | —                                         | —            | no infra yet; gets the new pins when it is generated forward                        |
| Lombardi                          | Quick-Release/lombardi (archived)                                           | content                                         | 0.15.1           | beta.79                                   | —            | no: offboarded (`phase: archived`)                                                  |

Alchemy consumers that are not Blueprint Sites (no `gq.ops.json`, no
`gq sync`), out of this plan's scope and listed so they aren't forgotten:
Ekis (`Quick-Release/ekis`, `infra/package.json` pins beta.78 directly),
bioeconomia.pt (beta.77, superseded by nomia-bnq) and cesam-astro (beta.76).

The local clones under `/data/code/getquick/clients` lag their remotes for
some Sites (for example Bruaa's clone says 0.32.0, GitHub 0.35.0); the table
uses the remotes. Re-read each Site at the start of its migration.

## Recommended approach

The migration has two independent risks: the package split (a code and
dependency change in every Site) and the state store's v8 protocol (one
account-wide switch). They move in two hops so that the first can roll out
Site by Site.

### Hop 1: beta.84, the package split (state store stays v7)

1. **Make the catalog's Alchemy and Effect entries managed keys.** Extend
   managed keys (`blueprint/ownership.json` `managedKeys`, today JSON files
   only) to `pnpm-workspace.yaml`. Each key is a path: `catalog.alchemy`,
   `catalog["@alchemy.run/cloudflare"]`,
   `catalog["@alchemy.run/frontend-frameworks"]`, `catalog.effect`,
   `catalog["@effect/platform-node"]`, `overrides["@effect/platform-node-shared"]`
   and `peerDependencyRules.allowedVersions.effect`. The rest of the file stays
   the Site's own. Its comments and key order are kept, as managed keys already
   do for `package.json`. With that, the gq-site release that writes the
   split-package templates writes the versions they need in the same
   `gq sync`, so neither half ever ships without the other. This is the
   central change. A version-aware sync, rendering old or new imports from
   whichever catalog it finds, would keep two template sets alive and still
   leave the catalog to hand edits, so it isn't recommended.
2. **The same gq-site release** (a minor bump, with a CHANGELOG entry
   naming the migration) also:
   - swaps `alchemy/Cloudflare` → `@alchemy.run/cloudflare` in every managed
     `infra/*.ts` template (content Astro, TanStack, commerce, `consent.ts`);
   - adds `"@alchemy.run/cloudflare": "catalog:"` to the fully generated
     `infra/package.json`;
   - updates the create-once skeleton catalogs to the same pins;
   - updates `docs/reference/frontend-frameworks.md#versions`.
3. **Doctor and sync guards.** `gq sync --check` already fails on drifted
   managed keys. In addition:
   - `gq doctor` fails when the installed `alchemy`,
     `@alchemy.run/cloudflare` and `@alchemy.run/frontend-frameworks` (in
     `infra/node_modules`) are not one version, or don't match the catalog.
     That catches a sync committed without `pnpm install`.
   - `deploy-frontend.mjs` refuses to run when `@alchemy.run/cloudflare`
     can't be resolved from `infra`, before Alchemy's own "install the
     package" error.
4. **Effect 4.1.4 goes with it.** `@alchemy.run/cloudflare` beta.84 needs
   `effect` ^4.0.5, and the Sites are on 4.0.0-rc.115.

beta.84 is the target of this hop only because it still speaks the v7 store
protocol. That lets Sites on beta.79 and beta.84 deploy side by side in the one
account while the fleet catches up.

### Hop 2: beta.86 (or the latest), the store upgrade

1. **Guard secrets first.** `deploy-frontend.mjs` refuses a full deploy that
   would drop a secret the Worker currently has bound. It lists the bound names
   through the Cloudflare API and compares them with what `frontend.run.ts` will
   declare from the environment. Only an explicit `--drop-secret <NAME>` lets
   the deploy unbind one. Without this guard, the first beta.85+ deploy can
   silently remove `CONSENT_READ_TOKEN` and the other optional secrets.
2. **Protect the data.** Mark the production publication D1 and Consent D1
   `RemovalPolicy.protect()`, and keep the protection on every later deploy.
   From then on, a plan that would replace or delete either one fails.
3. **One gq-site release** moves the managed catalog keys and every pin
   to beta.86 together. Because the keys are managed, this is a version bump
   plus `pnpm install` in each Site.
4. **Cut over as one account-wide window** (see the per-Site order). Every
   Alchemy project that deploys to account `8f38791a…`, Blueprint or not,
   must be ready on beta.85+ before the first deploy, because that deploy
   upgrades the shared store.

Hop 1 and hop 2 may land a few days apart. Sites that are already on hop 1
can be held at it as long as needed.

## Per-Site steps and order

Before either hop, bring each Site to the current gq-site release on its own
(a normal update PR), so the Alchemy hop's diff contains nothing else. CESAM
(0.23.2) and Cooldown Gaming (0.35.0) have the largest gaps.

For each Site, in that Site's own repository and a new session:

1. Update `@getquick/site` to the hop's release, then run `gq sync` and
   `pnpm install`. Commit the sync diff and `pnpm-lock.yaml` together.
2. Run `gq sync --check`, `gq doctor`, `pnpm infra:check`, `pnpm ci:check`
   and `gq verify`.
3. Run `pnpm plan:frontend` against production state. Review it: no
   resource may be replaced or deleted, and no binding may be removed (see
   Verification).
4. Release the Site (`pnpm push`). Its Cloudflare CI deploys the tag. Then
   run `pnpm site:check`, `pnpm frontend:events:check` and the smoke for its
   variant.

Order, both hops:

| #   | Site                              | Why here                                                                                                                                                    |
| --- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Cooldown Gaming                   | The reference Site; downtime is expected.                                                                                                                   |
| 2   | Southside                         | Already on 0.40.0: the smallest diff. Astro, consent.                                                                                                       |
| 3   | Nomia                             | Astro, package runtime, production client.                                                                                                                  |
| 4   | CESAM                             | Astro today. If its TanStack rebuild lands first, it migrates on the TanStack templates instead. It lives on Cloudflare Artifacts, not GitHub.              |
| 5   | Bruaa                             | Commerce. The private `@quick-release` packages must install with the new pins (`scripts/smoke/commerce-check.sh`).                                         |
| —   | FPA Shop                          | No `infra/` yet. It gets the pins when it is generated forward.                                                                                             |
| —   | Ekis, bioeconomia.pt, cesam-astro | Not Blueprint Sites (no `gq sync`). Hop 1 doesn't affect them. Before hop 2 they must be moved by hand, retired, or confirmed to deploy to another account. |

In hop 2, prepare and review every Site's PR, plan included, before any of
them deploys. Then freeze deploys in the account and deploy in the order above
in one sitting. Cooldown Gaming's deploy performs the store upgrade.

## Verification

- **In gq-site, before each release**: the existing smokes
  (`frontend-check.sh`, `content-pair.sh`, `consent.sh`, `tanstack-check.mjs`,
  `commerce-check.sh`, `ci-composer.sh`) on the new pins.
- **A new sync smoke**: a fixture Site generated by the previous release, on
  beta.79 and rc.115. `gq sync` from this checkout must move both the
  templates and the catalog, then `pnpm install --frozen-lockfile` must
  pass after the install that regenerates the lock, followed by
  `infra:check`. This proves the old-to-new path, not only new Sites.
- **The plan against real state**: `pnpm plan:frontend` for each Site, read
  in full. A machine check on the `--detailed` output refuses any `replace`
  or `delete` and any removed binding. Whether Alchemy can emit the plan as
  JSON is an open question; if it can't, parse the text output. A
  `RemovalPolicy.protect()` resource makes such a plan fail on its own.
- **Bindings and secrets**: record the Worker's bound secret names and
  bindings before the deploy, and compare them with the same list after it.
- **After the deploy**: `pnpm site:check`, `pnpm frontend:events:check`, a
  publish/refresh round trip, and a consent record write and read.

## Rollback

- **Hop 1**: the store stays v7, so rollback is code only. Revert the
  Site's sync commit, or redeploy its previous tag through CI. Resources are
  unchanged because their identifiers are.
- **Hop 2**: there is no way back below beta.85 once the store is v8.
  Rolling back means a newer beta.85+ release, or redeploying the
  previous Worker version through Cloudflare's Worker versions, not Alchemy.
  Before the first hop-2 deploy, export the store's state
  (`alchemy state … --backend cloudflare`) for every stack, together with D1
  exports of the publication and Consent databases (`gq db backup` and the D1
  export). If the upgrade fails mid-window, Sites not yet deployed keep
  serving: only their deploys are blocked.

## Open questions

1. Is a v8 store really unreadable from beta.84? If beta.84 can also read
   it, the cutover window is not needed. That should be tested on a
   disposable account (a scratch store, not the fleet's) before hop 2.
2. Do Ekis, bioeconomia.pt or cesam-astro deploy with Alchemy to account
   `8f38791a…`, and who moves them?
3. Can `alchemy deploy --dry-run` emit a structured plan to gate on, or do we
   parse text?
4. gq-site has no YAML dependency today (`package.json`). Managed keys in
   `pnpm-workspace.yaml` need a comment-preserving YAML editor (for example
   `yaml`'s document API) or a narrow line-based writer for `catalog:` entries.
   Which?
5. Should hop 1 skip straight to beta.86 if questions 1 and 2 are settled
   before it ships, giving one hop?
6. Where does CESAM's TanStack rebuild stand, and does it change CESAM's
   position in the order?
7. Is beta.86 (or a later beta) still the latest, and past
   `minimumReleaseAge`, when hop 2 is cut?

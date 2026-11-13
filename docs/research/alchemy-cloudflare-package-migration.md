# Alchemy beta.84+ and `@alchemy.run/cloudflare`: fleet migration plan

Written 2026-11-12 against gq-site `main` 790b1b6 (0.41.1). Tracking issue:
[#185](https://github.com/Quick-Release/gq-site/issues/185).

Status: **hop 1 is done** (gq-site 0.43.1, see
[Hop 1 in the Blueprint](#hop-1-in-the-blueprint)): all five Blueprint Sites
deployed it by 2026-11-13. **Hop 2's Blueprint part is implemented** (gq-site
0.44.0, see [Hop 2 in the Blueprint](#hop-2-in-the-blueprint)). Every Site's
own hop 2, and the cutover window ([decided](#cutover-window-owner-decisions-2026-11-13)), are still to do.

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
  Its `effect` peer is ^4.0.5 (84), ^4.1.0 (85) and ^4.1.4 (86). The existing
  Sites' 4.0.0-rc.115 satisfies none of them, so Effect moves with Alchemy.
  But Alchemy beta.79 to beta.84 import `effect/Crypto`, which Effect 4.1
  removed: beta.84 needs Effect 4.0.x (4.0.7), and beta.85 and later need
  4.1.x. Effect moves again in hop 2.
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
4. **Effect 4.0.7 goes with it.** `@alchemy.run/cloudflare` beta.84 needs
   `effect` ^4.0.5, the Sites are on 4.0.0-rc.115, and Alchemy up to beta.84
   can't load on Effect 4.1 (it imports the removed `effect/Crypto`).

beta.84 is the target of this hop only because it still speaks the v7 store
protocol. That lets Sites on beta.79 and beta.84 deploy side by side in the one
account while the fleet catches up.

### Hop 1 in the Blueprint

Done on 2026-11-12, released in gq-site 0.43.0 with Effect 4.1.4, which
broke `alchemy deploy`; 0.43.1 pins Effect 4.0.7. What shipped:

- The seven managed keys above, from
  `blueprint/templates/fragments/pnpm-workspace.keys.yaml`. In the lock and in
  gq's messages a segment holding a dot is bracketed, so
  `catalog["@alchemy.run/cloudflare"]`, but `catalog.@effect/platform-node`
  (JSON managed keys keep their existing names).
- A key the lock has no hash for yet is taken over only when its value is one
  an earlier blueprint created (`pnpm-workspace.earlier.json`: Alchemy
  beta.79 and beta.83, Effect rc.115 and 4.1.4). Any other value is the Site's
  own pick: `gq sync` stops with a diff, as for a hand edit.
- The templates import `@alchemy.run/cloudflare`, `infra/package.json`
  depends on it, and the pins are exactly 2.0.0-beta.84 for the three Alchemy
  packages and 4.0.7 for Effect (0.43.1; 0.43.0 had 4.1.4).
- `gq doctor`'s Alchemy install check, and the deploy wrapper's refusal
  without `@alchemy.run/cloudflare`.
- `scripts/smoke/sync-upgrade.sh` (CI job `sync-upgrade`): a 0.40.0 Site,
  Astro and TanStack, synced, installed, frozen-installed, type-checked and
  doctor-clean.

Open question 4 is settled: the `yaml` package (2.9.1, which Alchemy itself
depends on) parses the file to find each key and its exact byte range, and gq
edits only those ranges, as the JSON managed keys do. That is the safer of the
two. A line-based writer would have to re-implement YAML's quoting, flow
collections and comments to find a key, and could misread a file it doesn't
expect. `yaml`'s document API re-serializes the whole file, which can change
quoting, indentation and blank lines the Site owns. What gq can't edit without
rewriting (invalid YAML, a top level that isn't a mapping, a flow mapping in
the way) is refused, and nothing is written.

### Hop 2 in the Blueprint

Done on 2026-11-13, in gq-site 0.44.0. Read against the published `src/` of
alchemy and `@alchemy.run/cloudflare` 76, 78, 81, 83, 84, 85, 86 and 87, and
the live account read-only (`alchemy state list` with beta.84, and Cloudflare
API `GET`s of Worker settings).

**Target: 2.0.0-beta.86**, with Effect 4.1.4. Its state store is byte-for-byte
beta.87's (`StateStore/` unchanged 86→87). It has `RemovalPolicy.protect()`
(beta.85 doesn't), and its Worker compatibility defaults are beta.84's.
beta.87 changes, among what the managed infra uses, only Durable Object class
deletion (no managed Worker has a Durable Object). It was also about 4 hours
old when hop 2 was cut, against beta.86's 17. Every beta.86 package clears
pnpm's 24-hour `minimumReleaseAge` at 2026-11-13T09:40Z
(`@alchemy.run/node-utils`, the last published). Before then pnpm installs it
but appends `minimumReleaseAgeExclude` entries to the Site's
`pnpm-workspace.yaml`, which the sync smoke now refuses.

What shipped:

- The pins: the managed keys and both skeletons at beta.86 / Effect 4.1.4;
  beta.84 and Effect 4.0.7 added to `pnpm-workspace.earlier.json`.
- `src/frontend/deploy-guards.mjs` (`@getquick/site/deploy-guards`), which
  both managed `deploy-frontend.mjs` run Alchemy through:
  - the store guard (`--upgrade-state-store`, and no `--yes` on a plan);
  - the secret guard (`--drop-secret <NAME>`);
  - the plan check on the `--detailed` text: replace, delete, orphaned,
    `unbind`, a removed `env` key, and compatibility flags reported;
  - the before/after comparison of the Worker's bindings, flags and date.
- `RemovalPolicy.protect(production)` inside `retain(production)` (the
  innermost policy wins) on the publication, Consent and storefront Runtime
  databases.
- `gq doctor`: the Frontend's Astro against frontend-frameworks' peer range.
- `sync-upgrade.sh` from 0.43.1 too, with the wrapper run and the
  `pnpm-workspace.yaml` rewrite check.

**`--yes` upgrades the store, even on a plan.** `alchemy deploy` sets
`updateStateStore: options.yes` whatever `--dry-run` says
(`Cli/commands/deploy.ts`, beta.84 to beta.87). Until 0.44.0,
`deploy-frontend.mjs` passed `--yes` to plans too. So the first `pnpm
plan:frontend` on beta.85+ would have upgraded the account's store. Without
`--yes`, a beta.85+ plan against a v7 store fails ("out of date … pass
--yes"). **So no Site can read a beta.86 plan against production state before
the store is upgraded.** Hop 2's reviewed plans therefore happen in the window,
right after Cooldown Gaming's `pnpm plan:frontend --upgrade-state-store`. The
upgrade only redeploys the store's Worker and changes no Site resource.

**Live baseline, 2026-11-13 02:05Z** (Cloudflare API, names only): the store
Worker has no `ALCHEMY_STATE_STORE_VERSION` binding, so it is the v7 an older
Alchemy deployed. Every Frontend Worker already has `new_module_registry`.
Bruaa's flags are `nodejs_compat` and `new_module_registry`, dated 2026-07-18;
the others are dated 2026-08-31. beta.86's flag defaults are beta.84's
(`Workers/Worker.ts`), so hop 2 should change no flag.

| Worker              | Secrets bound                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `cooldowngaming-fe` | CONSENT_READ_TOKEN, FRONTEND_REFRESH_TOKEN, GQ_AUTH_GRAPHQL_CLIENT_ID, GQ_AUTH_GRAPHQL_CLIENT_SECRET, PUBLICATION_EVENT_SECRET           |
| `southside-fe`      | CONSENT_READ_TOKEN, FRONTEND_REFRESH_TOKEN, GQ_AUTH_GRAPHQL_CLIENT_ID/SECRET, GQ_FORMS_ACCESS_CLIENT_ID/SECRET, PUBLICATION_EVENT_SECRET |
| `nomia-bnq-fe`      | CONSENT_READ_TOKEN, FRONTEND_REFRESH_TOKEN, PUBLICATION_EVENT_SECRET                                                                     |
| `cesam-fe`          | CONSENT_READ_TOKEN, FRONTEND_REFRESH_TOKEN, PUBLICATION_EVENT_SECRET                                                                     |
| `bruaa-fe`          | GETQUICK_AUTH_COOKIE_SECRET, GETQUICK_CART_SESSION_SECRET, GETQUICK_STOREFRONT_PROXY_SECRET                                              |

#### Store inventory (account `8f38791a…`)

`alchemy state list -r --backend cloudflare` (beta.84, read-only, 2026-11-13)
lists 19 stacks. Besides the five Blueprint Sites' Frontend stacks and the
store's own `CloudflareStateStore`:

| Stack (stages)                                        | Repository (Alchemy, Effect)                             | Resources in state                                                  | Needs before the window                                                                                                                      |
| ----------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `legaciti-dashboard-infra` (production)               | Quick-Release/legaciti (beta.76 + a local patch, rc.112) | Dashboard Worker, 7 publication D1s, 4 queues, 3 R2, PubCache       | Move to beta.86 (`@alchemy.run/cloudflare`, Effect 4.1.4; re-check its `alchemy@2.0.0-beta.76.patch`), or accept a deploy freeze until moved |
| `GQSupportWorker` (prod, staging)                     | Quick-Release/gq-support `worker/` (beta.83, 4.0.5)      | Worker, SupportDB, SupportLedger, GitHubAppSecret                   | Move to beta.86, or freeze                                                                                                                   |
| `gq-games-api` (production)                           | Quick-Release/gq-games-api (beta.81, 4.0.1)              | Api Worker, Database (D1)                                           | Move to beta.86 (with `@effect/sql-d1` 4.1.4), or freeze                                                                                     |
| `EkisStorefront`, `EkisDocs` (prod)                   | Quick-Release/ekis (beta.78, rc.115)                     | storefront Worker, EkisCartSessions, EkisHeadlessState; docs Worker | Move to beta.86, or freeze                                                                                                                   |
| `NomiaWeb`, `NomiaDocs`, `NomiaInfrastructure` (prod) | Quick-Release/bioeconomia.pt (beta.77, rc.112)           | web and docs Workers; NomiaMedia and NomiaDatabaseBackups (R2)      | Superseded by nomia-bnq: freeze (its tag release deploys `NomiaWeb`), or retire; check whether nomia-bnq still uses those two buckets        |
| `CesamAstro` (prod, dev_valerio)                      | Quick-Release/cesam-astro (beta.76, rc.112)              | Website, its Access app                                             | Superseded by CESAM's Blueprint Site: freeze or retire                                                                                       |
| `LombardiFrontend` (prod, dev_valerio)                | Quick-Release/lombardi (archived; beta.79)               | Frontend Worker, LombardiPublications                               | Nothing: offboarded and archived, it never deploys again                                                                                     |
| `GqSmokeFrontend` (no stages)                         | this repository's `gq-smoke-up.sh`                       | none                                                                | Nothing; don't run the live smoke during the window                                                                                          |

The upgrade breaks none of them at runtime: Workers, D1, R2 and queues keep
serving. What stops is every plan and deploy from beta.84 or older. Such a
run sees v8 where it expects v7 and tries to redeploy the store through its
`CloudflareStateStore` bootstrap stack (with `--yes`, or after a prompt). The
v8 Worker answers 409 to every request for that stack, so the run fails while
reading its state, before it touches a secret. In CI without `--yes`, it
fails with "out of date". (Read in beta.76's and beta.84's
`StateStore/State.ts` and beta.85's `Api.ts` `refuseLegacyBootstrap`.) None
of them deploys on a schedule: legaciti, gq-support and bioeconomia.pt's
infrastructure workflow are `workflow_dispatch`, and bioeconomia.pt's
`release.yml` deploys `NomiaWeb` on a tag. Old Alchemy can't move a project
to a separate store either: before beta.85 `Cloudflare.state()` hardcodes the
`alchemy-state-store` Worker.

#### Cutover window (owner decisions, 2026-11-13)

- **Timing.** The window opens right after gq-site 0.44.0 is released, the
  same day, and runs in one sitting. From the store upgrade until the last
  Site's post-checks, nothing else deploys in the account.
- **The store gate.** Cooldown Gaming first runs
  `pnpm plan:frontend --upgrade-state-store`. That upgrades the store to v8
  and changes no Site resource, and no other run passes the flag. Then all
  five Sites plan against the v8 store, and each plan is reviewed before any
  Site deploys. This replaces the earlier condition that every hop-2 PR has a
  reviewed plan before the window, which a beta.85+ plan can't meet against a
  v7 store.
- **Order.** Before the store gate: the state exports (beta.84) and the D1
  exports of each Site's publication and Consent databases. Then deploy
  Cooldown Gaming → Southside → Nomia → CESAM → Bruaa, each followed by its
  post-checks.
- **Frozen stacks.** Every non-Blueprint stack in the
  [store inventory](#store-inventory-account-8f38791a) is frozen and left
  untouched: `legaciti-dashboard-infra`, `GQSupportWorker`, `gq-games-api`,
  `EkisStorefront`, `EkisDocs`, `NomiaWeb`, `NomiaDocs`,
  `NomiaInfrastructure`, `CesamAstro` and `LombardiFrontend`. Each moves to
  beta.85+ in its own repository when it next needs a deploy. nomia-bnq
  doesn't use bioeconomia.pt's `nomia-media` and `nomia-db-backups` buckets (0
  references on live pages). The inventory's "Needs before the window" column
  lists the options considered; freezing was chosen for every row.

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
| —   | Ekis, bioeconomia.pt, cesam-astro | Not Blueprint Sites (no `gq sync`). Hop 1 doesn't affect them. For hop 2 they, and the other non-Blueprint stacks, are frozen (owner decision, 2026-11-13). |

In hop 2, prepare every Site's PR before the window, without planning it
against production. In the window, freeze deploys in the account. Cooldown
Gaming's `pnpm plan:frontend --upgrade-state-store` performs the store
upgrade. Then all five Sites plan, each plan is reviewed, and the Sites deploy
in the order above, in one sitting
([decisions](#cutover-window-owner-decisions-2026-11-13)). The non-Blueprint
stacks stay frozen.

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

1. ~~Is a v8 store really unreadable from beta.84?~~ Settled from source
   ([Hop 2 in the Blueprint](#hop-2-in-the-blueprint)): yes. beta.84 and
   older see a version mismatch. They try to redeploy the store through the
   legacy bootstrap stack, which the v8 Worker refuses with 409, or in CI they
   fail with "out of date". Not tried on a scratch account (none is
   available). The cutover window stays.
2. ~~Do Ekis, bioeconomia.pt or cesam-astro deploy to account `8f38791a…`?~~
   Yes, and so do legaciti, gq-support and gq-games-api (the
   [store inventory](#store-inventory-account-8f38791a)). The owner froze them
   all ([decisions](#cutover-window-owner-decisions-2026-11-13)).
3. ~~Can `alchemy deploy --dry-run` emit a structured plan?~~ No. Under
   `--log-format json` the renderer prints no plan (`Cli/Present.ts`), and the
   plan events carry phases, not changes. The plan check reads the plain text
   (`formatPlanLines`).
4. ~~YAML editing.~~ Settled in hop 1.
5. ~~Should hop 1 skip straight to beta.86?~~ Moot: hop 1 shipped on beta.84.
6. ~~Where does CESAM's TanStack rebuild stand?~~ Unreleased; CESAM is still
   Astro and migrates on the Astro templates (#185).
7. ~~Is beta.86 still the latest?~~ No: beta.87 came out on 2026-11-12, and
   0.44.0 stays on beta.86 (see above). beta.86 clears `minimumReleaseAge` at
   2026-11-13T09:40Z.
8. ~~Plans before the window.~~ A beta.86 plan can't read a v7 store
   without upgrading it, so the owner moved the reviewed plans into the window,
   after Cooldown Gaming's store gate
   ([decisions](#cutover-window-owner-decisions-2026-11-13)). Planning against
   an exported snapshot (`Alchemy.localState()`) isn't built: whether
   `alchemy state read` output round-trips into local state, Redacted values
   included, is untested.

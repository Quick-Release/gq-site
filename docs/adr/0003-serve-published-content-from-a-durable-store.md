# ADR 0003: Serve published content from a durable store

- Status: Accepted; amended by [ADR 0004](0004-serve-entries-from-the-store-with-a-cold-lookup.md)
  (entries, and the cold lookup of an entry the store has never held) and
  [ADR 0005](0005-refresh-publications-through-signed-cms-events.md) (CMS
  publication events; CI releases bind the refresh token) and
  [ADR 0010](0010-declare-a-new-content-site-ready-through-one-readiness-gate.md)
  (the deploy token's D1 permission; readiness requires a prepared store) and
  [ADR 0013](0013-serve-each-language-from-its-own-shared-rows.md) (each language's front page and chrome have their own rows)
- Date: 2026-10-02

## Context

[Spec #38](https://github.com/Quick-Release/gq-site/issues/38) asks new content
sites' Frontends to keep serving their last successful published content
through CMS outages, without an age limit, and to survive Worker restarts and
redeploys. Its first slice ([#41](https://github.com/Quick-Release/gq-site/issues/41))
serves the homepage and its shared chrome that way. Later slices add entries
([#42](https://github.com/Quick-Release/gq-site/issues/42)), WordPress events
([#43](https://github.com/Quick-Release/gq-site/issues/43)), withdrawals that
must win over delayed publications ([#44](https://github.com/Quick-Release/gq-site/issues/44)),
retries and reconciliation. So the store has to support ordering and
precedence from the start; an edge cache with eventual invalidation does not.

Facts checked against the pinned stack (Alchemy 2.0.0-beta.79,
`@alchemy.run/frontend-frameworks` 2.0.0-beta.79, Astro 7, workerd):

- `Cloudflare.Website.Astro` accepts Worker bindings in `env`: a
  `Cloudflare.D1.Database` resource becomes a D1 binding, a `Redacted` string
  a `secret_text`. Astro code reads them with `import("cloudflare:workers")`.
  The deploy build is `buildInChild` from
  `@alchemy.run/frontend-frameworks/astro/source`; its output, served in
  workerd with a local D1 binding, reads and writes the store and keeps it
  across a Worker restart (`scripts/smoke/frontend-runtime.sh`).
- A D1 database's `migrations` directory is applied by Alchemy on deploy, in
  order, recorded in `__alchemy_migrations`; the Worker that binds it is
  updated after it.
- `RemovalPolicy.retain()` keeps a resource's cloud object when the
  declaration is removed, renamed or replaced.

## Decision

- **D1 is the publication store.** Each Site and stage gets its own database
  (`<project>-fe-publications[-<stage>]`), declared in `infra/frontend.run.ts`,
  bound as `PUBLICATION_DB`, separate from the Worker so a redeploy or restart
  never touches it. Production's is retained. A visitor's request reads only
  the store; it never reads the CMS and never writes.
- **Promotion is explicit and ordered.** Only a trusted refresh reads the CMS
  (anonymously, so only published content), and it promotes a row only from a
  complete, valid read: a timeout, unreachable CMS, HTTP or GraphQL error,
  missing required field, or a front page WordPress could only return without
  its blocks keeps the stored row. Each row records when its CMS read started
  (`read_started_at`); an upsert replaces a row only if its read started
  later, so a slow or delayed refresh can't overwrite a newer one. A
  withdrawal (#44) is a row state promoted with the same rule, so it can't be
  undone by an older read. Rows are per key (`home`, `chrome`, later entries),
  so a failed chrome read leaves the stored front page alone and the reverse.
- **No age limit, honest cold state.** A stored row is served until a refresh
  replaces it. With no row, or one this Worker can't read, the homepage is a
  503 (not ready), never a 404 or a placeholder; a confirmed missing front
  page is a stored `missing` state and a 404.
- **Persisted-state evolution.** The schema evolves only through new numbered
  migrations in the Frontend's `migrations/`, applied by Alchemy before the
  Worker changes; a migration must keep the Worker it replaces working (add,
  never rewrite). Each row carries the `format` of its body; a Worker serves
  only formats it knows and treats any other, or a body that doesn't parse, as
  unusable (503, logged), never as content.
- **Trusted refresh authority.** `POST /gq/refresh` on the Frontend, with
  `Authorization: Bearer <FRONTEND_REFRESH_TOKEN>`: a per-Site secret of at
  least 32 characters in Sigillo `staging`, bound to the Worker as a secret at
  deploy, compared in constant time. Without it bound, refresh is refused.
  `gq frontend refresh` sends it. It is not the deploy token, and CORS plays no
  part.
- **Opt-in by the Frontend.** `infra/frontend.run.ts` is fully generated, so
  it creates the store only when `apps/frontend/migrations` exists: new
  content sites have it; an existing site's site-owned Frontend doesn't, and
  its deploy is unchanged until it adopts the files.

## Considered options

- **Workers KV**: eventually consistent across locations (a write can take a
  minute to be visible) and last-write-wins without conditional writes, so it
  can't make a withdrawal immediate or reject an older publication.
- **Durable Objects (SQLite)**: strongly consistent and ordered too, but the
  Alchemy Astro Website has no way to export a Durable Object class from the
  Astro Worker, so it would need a second Worker; D1 is a plain binding.
- **R2**: strongly consistent with conditional puts per object, but ordering
  and precedence across keys, and diagnostics, are queries D1 already offers.
- **Cache API or HTTP caching in front of the Worker**: per-location,
  evictable and best-effort, so it can't be the last-known-good copy, and edge
  invalidation can't guarantee an immediate withdrawal. Not layered on top.
- **A refresh run by `gq` writing D1 over Cloudflare's API**: it would need
  the Site's renderer in the CLI and a Cloudflare token as refresh authority.

## Consequences

- D1 has one primary location: a visitor far from it pays a round trip per
  request. Read replication or a cache in front stays possible, provided it
  never outlives a withdrawal.
- Stored content changes only through a trusted refresh: an operator's
  `pnpm frontend:refresh`, or the CMS's signed events
  ([ADR 0005](0005-refresh-publications-through-signed-cms-events.md)).
- A deploy without `FRONTEND_REFRESH_TOKEN` bound leaves refresh refused
  until a deploy with it, while stored content keeps being served.

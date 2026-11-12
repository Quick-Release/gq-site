# ADR 0023: Move a Site's Alchemy pins with the managed infra

- Status: Accepted
- Date: 2026-11-12

Implemented by [#190](https://github.com/Quick-Release/gq-site/pull/190) and
[#195](https://github.com/Quick-Release/gq-site/pull/195), released in 0.43.0
and 0.43.1.

## Context

From `alchemy` 2.0.0-beta.84, Alchemy's Cloudflare provider is no longer
`alchemy/Cloudflare` but its own package, `@alchemy.run/cloudflare`. That
package peers on `alchemy` at its own exact version and on Effect ^4.0.5
([#183](https://github.com/Quick-Release/gq-site/issues/183),
[the migration plan](../research/alchemy-cloudflare-package-migration.md)).

The two halves of a Site's Alchemy setup used to have different owners:

- `gq sync` rewrites the fully generated `infra/frontend.run.ts`,
  `infra/consent.ts` and `infra/package.json` (`blueprint/ownership.json`).
  They import the provider and take `alchemy` from `catalog:`.
- The catalog that pins Alchemy and Effect is in the Site's
  `pnpm-workspace.yaml`. That file is created once, so no sync rewrote it.

Every existing Site's catalog pins beta.79 and Effect 4.0.0-rc.115. If the
templates switched to the new package alone, every Site would break its
`infra:check` and deploy on its next sync. It would have either a
`catalog:` dependency with no catalog entry, or two Alchemy cores.

Two further facts bound the choice. First, every Site deploys to one
Cloudflare account and shares its Alchemy state store. From beta.85, the
first deploy upgrades that store to a protocol that beta.84 and older
releases can't use. Second, pnpm 12 applies its 24-hour `minimumReleaseAge`
by default without failing. It writes an exclude entry for each younger pin
into the Site's `pnpm-workspace.yaml`.

## Decision

1. **The catalog's Alchemy and Effect pins are managed keys of
   `pnpm-workspace.yaml`.** They are `catalog.alchemy`,
   `catalog["@alchemy.run/cloudflare"]`,
   `catalog["@alchemy.run/frontend-frameworks"]`, `catalog.effect`,
   `catalog["@effect/platform-node"]`,
   `overrides["@effect/platform-node-shared"]` and
   `peerDependencyRules.allowedVersions.effect`. The rest of the file stays
   the Site's own. The `gq sync` that rewrites the infra to import
   `@alchemy.run/cloudflare` writes the versions it needs in the same change.
   The first sync takes over a pin only when its value is one an earlier
   Blueprint wrote there. Any other value is the Site's edit and stops the
   sync with a diff, as an edited managed key does.
   The Site's step is `gq sync`, then `pnpm install`, then a commit that
   includes the lockfile. The CHANGELOG names it.
2. **`gq sync` has no Alchemy version guard.** It never writes the new imports
   without the matching pins, so it has no mismatched Site to refuse. Two
   later checks catch what a sync can't: `gq doctor` fails while the
   installed Alchemy packages disagree with each other or with the catalog,
   and the Frontend deploy refuses to run while `@alchemy.run/cloudflare`
   isn't installed in `infra`.
3. **`infra/package.json` lists `"@alchemy.run/cloudflare": "catalog:"`.**
   The Alchemy CLI finds Cloudflare's auth, its state store and
   `alchemy cloudflare` only through a declared dependency. The
   provider's optional `@alchemy.run/domain` peer is left out: the managed
   infra doesn't import it, and listing it would add a third lockstep pin for
   nothing.
4. **This hop targets beta.84, not the latest release.** beta.84 is the first
   release with the split, and the last that uses the state store's v7
   protocol, as beta.79 does. So Sites can move one at a time. Adopting beta.85
   or later is a separate, account-wide cutover ([#185](https://github.com/Quick-Release/gq-site/issues/185)).
   Until that cutover, the gap is recorded in
   [Frontend frameworks](../reference/frontend-frameworks.md#versions), as an
   exception to gq-platform ADR 0015 decision 4.
5. **A pin is never younger than pnpm's `minimumReleaseAge`.** The Blueprint
   pins the newest release that is at least 24 hours old, so installing a
   Site never adds an exclude entry to its workspace.

## Considered options

- **A documented upgrade step only.** Each Site edits its catalog by hand
  before or after the sync. Any Site that misses the step breaks on its next
  sync. Every later Alchemy bump would need another hand edit.
- **A `gq sync` guard that reads the catalog and refuses while Alchemy is
  older than beta.84, with the instruction.** It stops a broken sync, but the
  Site still edits YAML by hand. The guard's version knowledge would duplicate
  the templates' and has to be kept current with each bump.
- **Both.** This has the costs of both and still leaves the catalog to hand
  edits.
- **A version-aware sync** that renders the old or the new imports from
  whichever catalog it finds. It keeps two template sets alive and still
  leaves the catalog to hand edits.
- **beta.85 or beta.86 now.** Either would force the store cutover on the
  first Site that deploys, before the fleet is ready for it.

## Consequences

- From now on, an Alchemy or Effect bump in the Blueprint reaches a Site
  as a version bump, `gq sync` and `pnpm install`, with no edit to the Site's
  own files. That includes the beta.85+ hop.
- `pnpm-workspace.yaml` is the first YAML file with managed keys. gq edits
  only those keys' lines, keeps the comments and refuses what it can't place.
- A Site can't hold its own Alchemy or Effect version: changing one is a
  managed-key edit, and sync refuses it.
- A Site that deploys on beta.84 still uses the v7 store, so a Site that
  hasn't migrated yet keeps deploying beside one that has.

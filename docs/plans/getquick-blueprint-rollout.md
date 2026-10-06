# GETQUICK blueprint rollout

The accepted requirements, phases, and gates for
[ADR 0001](../adr/0001-the-getquick-site-blueprint.md). They describe
tooling that does not exist yet; accepting them is not a claim that the fleet
tooling or rollout machinery is built. The
[update-mechanics and fleet review](../research/getquick-blueprint-update-mechanics.md)
records the evidence behind them.

Start with fleet inventory and durable rollout automation, not a large
management UI. Release, health-check, and recovery guarantees come before
convenience. Third-party agent skills are installed by `gq skills`
([Agent skills](../guides/skills.md)) and do not block this work.

## Managed-file ownership and manifest evolution

- The blueprint publishes a file-ownership manifest: fully generated files,
  generated sections, create-once scaffolding, and site-owned files.
  Synchronization never replaces existing ADRs/research or site-owned code.
  The `AGENTS.md` base has a defined seam for site-owned guidance.
- `gq sync` is deterministic and idempotent for the installed blueprint and
  validated manifest. A check/diff mode reports changes without writing;
  unexpected edits to managed output fail with an actionable diff rather
  than being silently discarded. Generation does not require deploy secrets.
- `gq.ops.json` has a schema version and explicit upgrade migrations. Supported
  variants/capabilities are validated, not inferred from arbitrary flags.
  Plugin activation is declarative; site-specific retirement steps and data
  migrations live in site-owned extensions with defined ordering and failure
  behavior. Conformance checks validate these seams instead of treating all
  differences as drift.
- Generated environment templates contain public configuration/placeholders,
  not Sigillo secret payloads. Secrets remain per-command/per-deploy injections
  through the existing wrapper; setup does not persist a whole environment.

## Compatible platform releases

A platform release identifies a tested combination of blueprint CLI/templates,
shared npm renderer and block contracts, Composer plugins/theme, WordPress,
and required runtimes. It records compatibility by site variant, supported
upgrade paths, and support expiry. Sites retain their lockfiles with exact
resolved versions; Composer plugins retain caret constraints and WordPress
core remains deliberately pinned.

Common runtime behavior belongs in shared packages so one fix can reach all
sites; changing scaffolding alone cannot update copied frontend implementations.
The CMS and Frontend must remain compatible through their deployment
sequence, including an interrupted upgrade and supported code rollback.
Breaking or destructive changes require an explicit migration/approval policy
rather than routine auto-promotion. Separate tooling-only updates from runtime
changes so skills or hook updates do not redeploy public websites
unnecessarily.

## Fleet release and rollout contract

Renovate proposes dependency changes together with the `gq sync` output, and
CI checks the resulting commit; opening or merging that PR is not rollout
completion. `getquick-fleet` owns the durable rollout state and drives the
existing site release tooling. The operator approves an eligible platform
release once; individual sites do not require repetitive manual release steps.

1. Select eligible sites by variant, supported source version, update channel,
   and maintenance policy. Temporary holds have an owner and expiry; define
   an expedited security-patch policy rather than allowing indefinite drift.
2. Prepare dependency/lockfile updates and generated output in site PRs. Run
   checks against the final generated commit before merge.
3. For the current pilot group or promoted batch only, merge eligible changes
   and create each required site release/tag through the existing version
   tooling. Do not tag later batches before their promotion gate passes.
   Today's `v*` tag triggers production deploy; a successful `main` build or
   merged PR is not evidence of deployment.
4. Deploy representative pilot sites for each affected variant, including
   content and commerce when both are in scope. Verify the actual CMS and
   Frontend versions, GraphQL/content behavior, and frontend smoke checks;
   an HTTP 200 or matching archive SHA alone is insufficient.
5. Observe the pilots, then promote in bounded batches. Health regressions
   pause promotion automatically. Policy specifies the observation period,
   success/failure thresholds, and operator pause/resume/abort controls before
   a rollout can start.
6. Record the outcome per site and reconcile interrupted or ambiguous jobs
   with actual deployed state before retrying. Permit one active deployment
   per site and limit concurrency per shared server/account. Migrations and
   other side effects must not be duplicated by retries.

### Where generation runs

The execution model for generation is an implementation gate: configured
self-hosted/eligible hosted Renovate may run allowlisted `postUpgradeTasks`,
or a trusted isolated CI job may generate and write back the output. Free
Mend-hosted Renovate cannot run arbitrary `gq sync` commands. Reuse Cloudflare
CI where appropriate; GitHub Actions is not a prerequisite. Verify the bot,
repository, dependency change, and exact revision; a branch name is not
sufficient authorization. Give generation no production credentials, restrict
write-back paths, and rerun checks after it changes a PR.

## Deployment and data recovery guarantees

Before fleet rollout, replace the current in-place CMS update with atomic
code activation and retained previous releases. Build each site's release
artifact once where practical and promote the same verified artifact; do not
resolve new dependency versions during promotion. A successful CMS deploy
followed by a failed Frontend deploy is an explicit partial-release state, not
success.

Verify backup freshness and restorability before data/schema changes, record
migration state, and exercise recovery procedures. Existing `pnpm db:backup`
is a starting point, not proof of an integrated recovery gate. Prefer
backward-compatible expand/contract migrations and roll-forward recovery.
Code rollback does not imply database rollback: never automatically restore
an old database over content or orders written since the backup. Define and
test the code rollback and data recovery procedures separately.

## Fleet inventory, isolation, and capacity

- Keep desired and observed versions separately for CMS and Frontend,
  alongside health, rollout state, migration state, backup freshness, and
  update holds. Record auditable release actions. The fleet controller must
  not be needed to serve ordinary website traffic.
- Retain site/environment data and secret isolation. Scope deployment authority
  separately from generation and maintenance authority. Document onboarding,
  offboarding, emergency patching, and restore ownership/procedures.
- Plan account/server placement, resource quotas, concurrency, and cost ceilings
  before copying infrastructure across the fleet. The current per-site frontend
  plus CI Worker layout consumes multiple Workers per site before staging;
  verify provider limits at implementation time. Choose shared versus per-site
  CI and evaluate account partitioning or Workers for Platforms when justified,
  rather than assuming today's layout scales unchanged.

## Phases and gates

| Phase          | What happens                                                                                                                                                                                          | Gate                                                                                                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Extract     | Inventory sites' scripts as shared CLI code, site-owned code/tests, or obsolete. Move shared tools into `@getquick/site`; keep site-owned migration extensions.                                       | A content site uses published packages without vendored shared tools; retained site code/tests still pass and a release deploys.                                                         |
| 2. Generate    | Build `gq new`/`gq sync`, the ownership manifest, and versioned `gq.ops.json` schema from the extracted layout. Reconcile the content and commerce sites' manifest shapes without persisting secrets. | A generated content site passes `pnpm verify` and deploys to throwaway staging; check/diff, idempotency, schema upgrades, and preservation of owned files are tested.                    |
| 3. Prove       | Regenerate an existing content site's managed surfaces.                                                                                                                                               | Managed output matches the site's existing files; a second sync has no diff and site-owned files are unchanged.                                                                          |
| 4. Adopt       | Bring Ekis onto the blueprint and test representative content/commerce upgrades, including compatible platform versions and recovery.                                                                 | Both variants pass upgrade, runtime-health, and code/data-recovery checks; define rollout policy values, generation execution, and capacity placement.                                   |
| 5. Fleet proof | Exercise one approved platform release through pilot sites and bounded batches in disposable staging.                                                                                                 | A deliberately failed health gate prevents promotion; interruption resumes without duplicate migrations; one site can be recovered without reverting healthy sites or losing newer data. |

**Phase 1 passed** on 2026-10-01: a content site on `@getquick/site` 0.8.0, with no vendored shared tooling, deployed its CMS and Frontend from Cloudflare CI.

**Phase 2 passed** on 2026-10-02: `gq-smoke`, generated by `gq new` from `@getquick/site` 0.12.0, passed `pnpm verify`, and its v0.1.1 tag deployed the CMS (Ploi, the tagged commit) and the Frontend through its Cloudflare CI Worker, confirmed on `gq-smoke-cms.bnq.pt/wp/graphql` and `gq-smoke-fe.bnq.pt`; its infrastructure was then torn down ([#7](https://github.com/Quick-Release/gq-site/issues/7)).

**Phase 3 passed** on 2026-10-02: a content site adopted on `@getquick/site` 0.13.0 was deployed by the generated CMS deploy script, which ran its deploy extension `deploy/ploi/admin.d/10-theme.sh`; its theme stayed active, the CMS and Frontend served the new version with GraphQL content, and `gq sync --check` reported nothing pending afterwards. Blueprint changes therefore originate here, and a site takes them by bumping its pin and running `gq sync` until the fleet layer opens update PRs ([ADR 0001](../adr/0001-the-getquick-site-blueprint.md)).

**Phase 2** is specified in [#1](https://github.com/Quick-Release/gq-site/issues/1);
its design decisions are [ADR 0002](../adr/0002-generate-sites-from-a-versioned-manifest.md).
Its gate runs on the throwaway site `gq-smoke`
([#7](https://github.com/Quick-Release/gq-site/issues/7)):
[`scripts/smoke/gq-smoke-up.sh`](../../scripts/smoke/gq-smoke-up.sh) walks
through generating, verifying, provisioning and releasing it, and
[`scripts/smoke/gq-smoke-down.sh`](../../scripts/smoke/gq-smoke-down.sh)
tears its infrastructure down, keeping the repository and Sigillo project
for repeat runs.

A site's root commands are thin wrappers over `@getquick/site` where
appropriate; site-owned commands and their dependencies stay the site's.

### Adoption checklist

The procedure an existing site follows to adopt the blueprint (Ekis, in
phase 4):

1. Bump `@getquick/site` and run `gq sync --check` to see what adoption changes.
2. Move the site's own deploy steps out of `deploy/ploi/admin.sh` into deploy
   extensions under `deploy/ploi/admin.d/` (such as a theme activation in
   `10-theme.sh`). Drop one-off clean-ups that have already run on the server,
   after checking it read-only.
3. Delete the conflicting `admin.sh` and run `gq sync`; commit `gq.lock.json`.
4. Remove the site's own content that the generated `AGENTS.md` and
   `.gitignore` sections repeat, keeping site-specific text outside the
   sections.
5. If the site has a `CONTEXT.md`, `git mv CONTEXT.md GLOSSARY.md`, and point
   the site's vendored agent skills that name `CONTEXT.md` at `GLOSSARY.md`.
6. A second `gq sync --check` reports nothing pending, `pnpm verify` passes,
   and a release deploys.

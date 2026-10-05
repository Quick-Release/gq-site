# ADR 0001: The GETQUICK site blueprint

- Status: Accepted
- Date: 2026-09-30

## Context

GETQUICK runs more sites than it can keep up to date one repository at a
time. Its sites share a monorepo layout, Sigillo secrets through
`gq.ops.json`, and tooling vendored into each site under `packages/tools/`,
but every copy drifts and a fix reaches only the site it was made in.

## Decision

Every GETQUICK site follows the blueprint, which splits a site into three
layers:

1. **Versioned packages** on npm: `@getquick/site` (the `gq` CLI), a DDEV
   add-on, the block contracts and renderer, and the agent skills.
2. **Managed files** that `gq new` and `gq sync` generate from `gq.ops.json`:
   the hook layout, toolchain pins, `setup`/`doctor`/`verify`, the CI config,
   the `docs/{adr,plans,research,agents}` skeleton, the `AGENTS.md` base, and
   the `gq.ops.json` schema.
3. **A fleet layer** (Renovate, `gq doctor --conformance`, `getquick-fleet`)
   that moves platform releases through the sites.

- **The blueprint is a CLI, not a base project.** It lives in this
  repository, released with `v*` tags and a changelog. Sites share no Git
  history with it: `gq sync` regenerates managed files from the installed
  `@getquick/site` version and never merges site forks. Reusable per-site
  differences are validated `gq.ops.json` options (such as the variant);
  site-specific behavior stays in site-owned extension points.
- **Blueprint changes originate here.** Conventions and managed files are
  changed and released in this repository, and reach sites as update PRs. A
  convention a site develops becomes a blueprint rule only by being made
  here.
- **Sites record their adoption with a link, not a copy.** The design and the
  [rollout plan](../plans/getquick-blueprint-rollout.md) live here; a site's
  own ADR records only that it follows the blueprint and any site-specific
  terms of that adoption.
- **The fleet goal is one approved platform release, rolled out
  automatically and safely across eligible sites**, not hundreds of manually
  managed update PRs. Sites keep independent repositories, deployments, and
  data.
- **No production fleet rollout precedes the safety gates** in the
  [rollout plan](../plans/getquick-blueprint-rollout.md): generation,
  cross-variant upgrades, code and data recovery, and a failed health gate
  that stops promotion. Extraction alone is not fleet readiness.
- **Two conventions are blueprint rules**, and Ekis moves onto them in
  phase 4:
  - **Staged-only pre-commit, full checks pre-push.** The pre-commit hook
    only formats and lints staged files; the full check list (`verify`) runs
    pre-push. Ekis runs everything, including the DDEV checks, on every
    commit.
  - **Toolchain pins checked by `doctor`.** Node is pinned in `.mise.toml`
    and pnpm in `packageManager`, and `doctor` reports a running toolchain
    that doesn't match them. Ekis pins neither.
- Until a site adopts the blueprint, its own scripts, tools, and
  `gq.ops.json` stay in place.

The [rollout plan](../plans/getquick-blueprint-rollout.md) holds the accepted
requirements, phases, and gates; the
[update-mechanics and fleet review](../research/getquick-blueprint-update-mechanics.md)
holds the supporting evidence. Phase 2's design (one manifest, its schema and
migrations, the lock file, ownership categories, declarative plugins) is
[ADR 0002](0002-generate-sites-from-a-versioned-manifest.md). Third-party
agent skills are installed and updated by `gq skills`
([Agent skills](../guides/skills.md)), separately from this decision.

## Considered options

- **A template repository that sites fork and merge from.** Every site
  becomes a long-lived fork, and each upgrade is a merge against whatever
  that site changed, so conflicts grow with every site and release.
  Generating managed files from a validated manifest makes an upgrade a
  regeneration of files nobody edits by hand.
- **One shared platform** (WordPress Multisite, a shared runtime, or a shared
  tenant database). It couples every client's uptime, data, and deploys: a
  bad release or a restore hits every site at once. Independent sites driven
  by a central rollout give the same one-release updates without that
  coupling.
- **Keep vendoring shared tools in each site** (a `packages/tools/`
  directory per site). A fix must be copied into every site by hand, and the
  copies drift. Versioned packages let Renovate propose the update
  everywhere.

## Consequences

- Managed-file changes originate here and reach sites through checked
  update PRs. Unexpected local edits to managed files stop
  synchronization instead of being silently discarded; site-owned files stay
  under the site's control.
- Standardization does not remove per-site builds, lockfiles, migrations, or
  health checks; it makes running them automatic and observable.
- Progressive rollout is slower than deploying everywhere at once but bounds
  the impact of a bad release. The fleet can be partially upgraded while
  compatibility guarantees hold; exceptions cannot outlast the declared
  support policy.

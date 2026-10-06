# GETQUICK site blueprint: update mechanics and fleet gaps

The evidence behind the [rollout plan](../plans/getquick-blueprint-rollout.md)
and [ADR 0001](../adr/0001-the-getquick-site-blueprint.md): how a blueprint
update becomes a verified production rollout across independently deployed
sites, and where the deploy path falls short of that. Deploy-path findings are
checked against the files the blueprint generates (`blueprint/templates/`).
External documentation was retrieved on 2026-09-30.

This research is supporting rationale, not evidence that the requirements it
leads to are implemented. The rollout plan holds those requirements and their
gates.

## Assessment

Versioned packages, generated configuration, and a fleet layer are a sound
foundation. The missing specification is how a package update becomes a
verified production rollout across independently deployed sites. Creating
consistent repositories and operating a fleet are different capabilities.

## Installing third-party agent skills

These findings bear on installing upstream agent skills into a site's
`.agents/skills/`, which [`gq skills`](../guides/skills.md) does.

### 1. Git can't re-include a child of an excluded directory

`.agents/skills/` followed by `!.agents/skills/browser-testing/` does not make
new files in the site-owned skill visible to Git. Already-tracked files remain
tracked; the problem affects the intended whitelist and new files.

Use this instead:

```gitignore
.agents/skills/*
!.agents/skills/browser-testing/
.pi/skills/
```

Verified against the [official Git documentation](https://git-scm.com/docs/gitignore)
and reproduced with `git check-ignore --no-index` in a disposable repository:
the directory pattern ignores `browser-testing/SKILL.md`; the `/*` pattern
does not.

### 2. The `skills` CLI takes a space-separated skill list

At the inspected `vercel-labs/skills` source revision `c5ad3a85`,
[`parseAddOptions`](https://github.com/vercel-labs/skills/blob/c5ad3a85/src/add.ts#L1904)
collects successive space-separated arguments after `--skill`; it does not
split commas. A comma-joined list is treated as one skill name. If nothing
matches, `runAdd` reports the failure and exits with status 1.

Example of the intended argument shape:

```text
skills add mattpocock/skills -y --skill ask-matt code-review codebase-design
```

Pin the CLI version as well as the installed content; an unversioned
`npx -y skills` permits installer behavior to change between machines.
The inspected source revision is evidence of behavior, not verification of
which published npm version every machine will execute.

### 3. The `skills` lock is not a frozen-content installation guarantee

At the same revision,
[`runInstallFromLock`](https://github.com/vercel-labs/skills/blob/c5ad3a85/src/install.ts)
groups entries by `source` plus optional `ref`, then calls `runAdd`. It does not
verify fetched content against the recorded `computedHash`. The
[project-lock write path](https://github.com/vercel-labs/skills/blob/c5ad3a85/src/add.ts#L1660)
records a newly computed hash after installation.

A missing ref uses the upstream default; a branch ref can move. A tag can also
be moved unless immutability is enforced. Therefore, refreshing a hash after
upstream changes is update detection, not reproducible pinning.

For reproducibility, use an installer-supported immutable source/artifact and
integrity verification, with separate install and update operations. Do not
assume raw commit-SHA installation works without testing the selected CLI's
fetch behavior. Presence-only `doctor` checks also cannot detect stale content.

The inspected
[`cli.ts`](https://github.com/vercel-labs/skills/blob/c5ad3a85/src/cli.ts#L940)
routes `experimental_install` to lock restoration, while `install` and `i`
route to `add`. Retain the documented experimental command until the chosen,
pinned release demonstrably supports another interface.

## Renovate cannot universally run `gq sync` out of the box

The [Mend-hosted FAQ](https://docs.renovatebot.com/mend-hosted/faq/) specifies:

- Free users cannot configure or request arbitrary `postUpgradeTasks` commands.
- Trusted Community/OSS projects can request an exception; acceptance is
  discretionary, not automatic.
- Paying Mend customers can configure `RENOVATE_ALLOWED_COMMANDS`.

Self-hosted Renovate likewise requires an administrator-controlled
[`allowedCommands`](https://docs.renovatebot.com/self-hosted-configuration/#allowedcommands)
allowlist. Its
[`postUpgradeTasks`](https://docs.renovatebot.com/configuration-options/#postupgradetasks)
can run generation and include the resulting files in the update branch.

So the fleet needs an execution model: appropriately configured Renovate, or a
separate trusted generation job that writes back to the PR. Sites deploy
through Cloudflare CI, so GitHub Actions is not a prerequisite and should not
be introduced implicitly.

A separate job must verify the bot identity, repository, expected dependency
change, and exact revision; a `renovate/` branch prefix alone is not authority.
Run generation without deployment credentials, restrict write-back paths,
and rerun required checks on the resulting commit. Avoid checking out and
executing untrusted PR code in a privileged `pull_request_target` job.
An allowlisted command still executes its dependencies: isolation and narrowly
scoped credentials remain necessary.

## Fleet design recommendations

### Close the PR-to-production gap

Merging an update isn't enough: a site's CI release step
([`infra/ci/release.ts`](../../blueprint/templates/infra/ci/release.ts))
deploys only `v*` tags. Merging an update does not deploy it. Define which
trusted automation merges, creates the site release through the existing
version tooling, waits for the tag deployment, verifies runtime health, and
records the result.

Separate tooling-only changes from runtime changes so a skills or hook update
does not unnecessarily redeploy every public site.

### Coordinate the platform, not just the blueprint CLI

Describe compatible combinations of the CLI/templates, shared npm renderer
and contracts, Composer plugins/theme, WordPress, and required runtimes.
Preserve site lockfiles and the existing caret-constraint policy while
recording the exact tested resolutions in each release.

Prioritize shared runtime packages for behavior that should update everywhere;
updating scaffolding cannot fix independently copied frontend implementations.
Define supported version windows and compatibility during partial upgrades.

### Make rollout progressive, observable, and resumable

Use representative pilots for each site variant, then bounded batches, with
health gates and an observation period before promotion. Specify automatic
pause criteria, one active deployment per site, shared-server/account
concurrency limits, idempotency, and recovery after an interrupted job.
A single approved platform release should not require hundreds of manual
approvals. Breaking or destructive changes need a separate policy.

Record desired and observed versions separately for CMS and frontend, plus
release state, health, migration state, backup freshness, and temporary holds
with expiry. A green source-commit check is not proof of a healthy deployment.
The fleet controller should not be required to serve ordinary website traffic.

### Harden deployment and data recovery before multiplying it

The generated CMS deploy script
([`deploy/ploi/admin.sh`](../../blueprint/templates/deploy/ploi/admin.sh))
replaces live files with `rsync`, installs Composer dependencies on the
server, and invokes `wp core update-db`. There is no atomic code switch or
integrated pre-migration backup/restore gate in this deploy path. A live
database export facility exists through `pnpm db:backup`; this is not a claim
that sites have no backups.

The generated release step
([`scripts/ci-release.mjs`](../../blueprint/templates/scripts/ci-release.mjs))
deploys the CMS first and the frontend second. A frontend failure can leave a
mixed-version site. `gq ploi release` ([source](../../src/ploi/release.mjs))
checks the deployed commit, but this does not replace a GraphQL/content health
probe or frontend smoke checks.

Build each site's release artifact once where practical and promote the same
verified artifact. Define atomic code activation, previous-artifact retention,
backward-compatible migrations, migration tracking, and restore drills. Code
rollback and database rollback are different operations: an automatic database
restore can erase content or orders written since the backup. Prefer compatible
expand/contract changes and roll-forward recovery where appropriate.

### Make managed-file ownership explicit

List fully generated, generated-section, create-once, and site-owned files.
Do not overwrite existing ADRs/research or turn the manifest into an unlimited
collection of site-specific switches. Keep plugin activation declarative, but
provide an explicit site-owned extension point for imperative migrations.

Specify manifest schema versions/migrations, deterministic and idempotent
`gq sync`, a check/diff mode, and refusal to silently discard unexpected edits.
An empty-diff gate should apply to generated surfaces while preserving
site-owned code. Demonstrate upgrades on representative content and commerce
sites before claiming fleet readiness.

### Budget infrastructure and isolate authority

Each site has a frontend Worker and a dedicated CI Worker
([`infra/frontend.run.ts`](../../blueprint/templates/infra/frontend.run.ts),
[`infra/ci/wrangler.jsonc`](../../blueprint/templates/infra/ci/wrangler.jsonc)).
At 300 sites, copying this layout into one account means at least 600 Workers
before staging environments. The retrieved
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/#number-of-workers)
list 500 Workers per paid account. This is a planning example, not a claim about
GETQUICK's negotiated account limits or future placement.

Decide shared versus per-site CI, account/server placement, quotas, rollout
concurrency, and cost ceilings before scaling the templates. Evaluate Workers
for Platforms or account partitioning where justified; neither is automatically
required just because a fleet exists.

Retain per-site/environment secret and data isolation, separate generation and
deployment privileges, audit release actions, and document onboarding,
offboarding, restore, and emergency-patch procedures.

## Suggested acceptance test

After proving generation, add a fleet proof: one approved shared update reaches
representative content and commerce pilot sites; a deliberately failed health
gate prevents promotion; an interrupted rollout resumes without duplicate
migrations; and the operator can recover one site without reverting healthy
sites or losing newer data.

Start with fleet inventory and a durable rollout job, not a large management UI.
A centrally operated fleet of isolated sites can provide SaaS-like updates
without requiring WordPress Multisite or a shared tenant database.

## Supporting architecture references

- [Microsoft: updating multitenant solutions](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/considerations/updates)
  discusses deployment rings, version support, maintenance policies, and
  before/after health monitoring.
- [Microsoft: multitenant control planes](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/considerations/control-planes)
  distinguishes fleet management from serving tenant workloads and recommends
  scaling management automation to actual needs.

Skills-source claims are scoped to the linked revision; validate the selected
published version before implementation.

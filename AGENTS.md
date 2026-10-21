# AGENTS.md

## Scope

This repository is the blueprint: the `gq` CLI, managed files, the manifest and its schema, app skeletons, provisioning, CI and deploy, version pins and fleet rollout. Runtime behaviour (content events and delivery, the storefront, GETQUICK plugins) and Site features belong to their own repositories. Which repository owns what: [gq-platform ADR 0001](https://github.com/Quick-Release/gq-platform/blob/main/docs/adr/0001-ownership-of-work-across-getquick-repositories.md).

Until 2026-10-30, change any GETQUICK repository the task needs, each in a worktree of that repository. After that date, restore the ownership rule from git history.

## Reference Site

Tests that need a live content Site use Cooldown Gaming (cooldowngaming.com), a playground where downtime is expected. See `docs/reference/reference-site.md`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on Quick-Release/gq-site (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root; terms shared across repositories are in gq-platform's `GLOSSARY.md`. See `docs/agents/domain.md`.

# AGENTS.md

## Scope

This repository is the blueprint: the `gq` CLI, managed files, the manifest and its schema, app skeletons, provisioning, CI and deploy, version pins and fleet rollout. Runtime behaviour (content events and delivery, the storefront, GETQUICK plugins) and Site features belong to their own repositories. Which repository owns what: [gq-platform ADR 0001](https://github.com/Quick-Release/gq-platform/blob/main/docs/adr/0001-ownership-of-work-across-getquick-repositories.md).

Before acting on a request, ask "whose release would ship this?". Read any repository for evidence, but change only this one: its code, proofs, research, issues and PRs. When a request belongs to another repository, change nothing anywhere. Reply with that repository (`Quick-Release/<name>` and its local clone) and tell the user to start a new session there, in a worktree of that repository. When the owner is unclear, point to Quick-Release/gq-platform the same way. This applies even when the change looks small, or when this session already has the other repository's context.

## Reference Site

Tests that need a live content Site use Cooldown Gaming (cooldowngaming.com), a playground where downtime is expected. See `docs/reference/reference-site.md`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on Quick-Release/gq-site (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root; terms shared across repositories are in gq-platform's `GLOSSARY.md`. See `docs/agents/domain.md`.

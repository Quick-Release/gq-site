# AGENTS.md

## Scope

This repository is the blueprint: the `gq` CLI, managed files, the manifest and its schema, app skeletons, provisioning, CI and deploy, version pins and fleet rollout. Runtime behaviour (content events and delivery, the storefront, GETQUICK plugins) and Site features belong to their own repositories. Which repository owns what: [gq-platform ADR 0001](https://github.com/Quick-Release/gq-platform/blob/main/docs/adr/0001-ownership-of-work-across-getquick-repositories.md).

Read any repository for evidence. Write code, proofs, research and issues only in the repository that owns them. File the rest in the owning repository, or in Quick-Release/gq-platform when the owner is unclear, and stop.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on Quick-Release/gq-site (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root; terms shared across repositories are in gq-platform's `GLOSSARY.md`. See `docs/agents/domain.md`.

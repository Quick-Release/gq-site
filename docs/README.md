# Documentation

[Package overview and quick start](../README.md)

## Site guides

| Document                                              | Use it for                                                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Generate and sync a site](guides/sites.md)           | New content sites, managed-file ownership, locks, sync conflicts and create-once files.                                                                             |
| [Local site development](guides/local-development.md) | Setup, doctor, verify, DDEV, Composer and a local design-plugin checkout.                                                                                           |
| [Sigillo secrets](guides/secrets.md)                  | Per-command secret injection and checkout login without downloading environments.                                                                                   |
| [Provisioning and deployment](guides/provisioning.md) | The new content Site flow and readiness, Ploi provisioning/releases/media, database backup and live-to-local sync, Cloudflare tokens/buckets, CI and GitHub wiring. |
| [Offboarding a Site](guides/offboarding.md)           | Cutting a leaving client's public URLs and credentials, the guards while it is offboarded, restoring it, and archiving it before deleting its infrastructure.       |
| [Agent skills](guides/skills.md)                      | Register, update, lock and safely check upstream agent skills under `.agents/skills`.                                                                               |
| [Agent scope](guides/agent-scope.md)                  | The hooks that keep an agent session in its own repository: the router and the write fence.                                                                         |

## Reference

| Document                                               | Use it for                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| [Site manifest and environment](reference/manifest.md) | Site discovery, schema v1, manifest migrations and provider token/ID precedence.                 |
| [Commands](reference/commands.md)                      | Command syntax, output and mutation confirmation.                                                |
| [Release and version commands](reference/release.md)   | Variant defaults, release/verify/doctor additions and release-config migration.                  |
| [Programmatic use](reference/programmatic-use.md)      | The existing `run()` interface and injected adapters.                                            |
| [Reference Site](reference/reference-site.md)          | Cooldown Gaming, the live content Site the blueprint is tested against: its repository and URLs. |

## Contributors

[Develop and publish gq-site](development.md) covers the toolchain, checks,
test naming and fixture-site seam, schema generation, and npm publishing.

## Design and records

The glossary, ADRs, plans, research and agent guidance live in the
repository, not the npm package. These links point to the repository so they
also work from the installed package; decisions are linked, not copied into
guides.

- [Glossary](https://github.com/Quick-Release/gq-site/blob/main/GLOSSARY.md): domain terminology.
- [ADR 0001: The GETQUICK site blueprint](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0001-the-getquick-site-blueprint.md): the blueprint decision.
- [ADR 0002: Generate sites from one versioned manifest](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0002-generate-sites-from-a-versioned-manifest.md): manifest and ownership decisions.
- [ADR 0003: Serve published content from a durable store](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0003-serve-published-content-from-a-durable-store.md): the Frontend's publication store.
- [ADR 0004: Serve entries from the store, with a cold lookup](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0004-serve-entries-from-the-store-with-a-cold-lookup.md): stored pages and posts.
- [ADR 0005: Refresh publications through signed CMS events](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0005-refresh-publications-through-signed-cms-events.md): publication events.
- [ADR 0006: Withdraw publications through signed CMS events](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0006-withdraw-publications-through-signed-cms-events.md): withdrawals.
- [ADR 0007: Refresh shared settings through settings events](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0007-refresh-shared-settings-through-settings-events.md): settings events.
- [ADR 0008: Retry event delivery from the CMS on a server cron](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0008-retry-event-delivery-from-the-cms-on-a-server-cron.md): delivery retries and delay reporting.
- [ADR 0009: Reconcile missed changes on the CMS's scheduler](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0009-reconcile-missed-changes-on-the-cms-scheduler.md): reconciliation every minute.
- [ADR 0010: Declare a new content Site ready through one readiness gate](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0010-declare-a-new-content-site-ready-through-one-readiness-gate.md): `gq site check`, the new-Site flow and its acceptance gates.
- [ADR 0011: Offboard a Site by cutting its access before archiving it](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0011-offboard-a-site-by-cutting-access-before-archiving.md): `gq offboard`, its guards, `--restore` and `--archive`.
- [ADR 0012: Keep a Site's code in Artifacts when it has no GitHub repository](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0012-keep-a-sites-code-in-artifacts-when-it-has-no-github-repository.md): Artifacts-only Sites.
- [ADR 0013: Serve each language from its own shared rows](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0013-serve-each-language-from-its-own-shared-rows.md): bilingual Sites' rows, events, reconciliation and readiness.
- [ADR 0014: Keep a Site's code in the EU unless it opts out](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0014-keep-a-sites-code-in-the-eu-unless-it-opts-out.md): Artifacts namespace jurisdictions.
- [Rollout plan and evidence](https://github.com/Quick-Release/gq-site/blob/main/docs/plans/getquick-blueprint-rollout.md): accepted gates, passed phases and adoption checklist.
- [Research](https://github.com/Quick-Release/gq-site/tree/main/docs/research): dated inventories and implementation research.
- [Agent guidance](https://github.com/Quick-Release/gq-site/tree/main/docs/agents): issue tracking, triage and domain-document use.

The [Ploi API endpoint inventory](research/ploi-api.md), researched on
2026-09-18, is included in the package. Its logical CLI names are descriptive,
not commands; the [command reference](reference/commands.md) is the CLI
contract.

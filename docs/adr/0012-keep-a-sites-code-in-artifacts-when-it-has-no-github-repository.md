# ADR 0012: Keep a Site's code in Artifacts when it has no GitHub repository

- Status: Accepted
- Date: 2026-10-03

## Context

A Site's CI runs on Cloudflare: pushes to its Artifacts repository start the
CI Workflow (`cf.artifacts.repo.pushed`). Until now every Site's code lived on
GitHub too. Clones pushed to GitHub only, and the CI Worker's webhook and
Mirror Workflow copied each push into Artifacts. CI then reported a commit
status back to GitHub. `gq ci deploy` refused without `GITHUB_CI_TOKEN` and
`GITHUB_WEBHOOK_SECRET`, and `gq git artifacts` handed out read-only tokens,
so a Site could not run without a GitHub repository.

Some Sites don't need GitHub: no pull requests, no issues, one operator. For
those, a GitHub repository is only one more account, token and webhook to
provision, and later to offboard. CESAM is the first.

## Decision

- **`github.repository` decides.** A Site whose `gq.ops.json` names
  `github.repository` is on GitHub and works as before. A Site without it is
  **Artifacts-only**: its code lives in its Artifacts repository, and that is
  its `origin`.
- **Pushes go straight to Artifacts.** `gq git artifacts setup` makes the
  Artifacts repository `origin` when there is none. It leaves another origin
  alone and exits 1, saying so, because pushes there would start no CI. As
  the credential helper, `gq git artifacts get` mints an Artifacts-only Site
  one-hour **write** tokens (read-only ones for a Site on GitHub, as before).
- **The CI Worker works without GitHub.** `gq sync` renders an empty
  `GITHUB_REPOSITORY` rather than a placeholder. The Worker then answers the
  GitHub webhook with a 404 and skips commit statuses. `gq ci deploy` needs
  the `GITHUB_*` secrets only for a Site on GitHub. `gq github setup` says
  there is nothing to connect and exits 0.
- **`gq doctor`** checks that an Artifacts-only Site's `origin` pushes to
  Artifacts through gq's credential helper.

## Considered options

- **Stand-in GitHub secrets.** Store an inert token and webhook secret so
  `gq ci deploy` runs. Rejected: each CI run would retry failed GitHub status
  posts, and the Site would carry secrets that mean nothing.
- **A site-owned credential helper and CI patch.** Rejected: managed files
  would drift from the blueprint, and every such Site would repeat the work.

## Consequences

- Moving a Site onto GitHub later means naming `github.repository`, running
  `gq sync`, `gq github setup`, `gq ci deploy` and `gq git artifacts setup`,
  and pointing `origin` at GitHub.
- `gq offboard` works on an Artifacts-only Site
  ([ADR 0011](0011-offboard-a-site-by-cutting-access-before-archiving.md)).
  Its cut disables the Artifacts token and revokes the repository's git
  tokens instead of deactivating a webhook. Its archive keeps the code as
  `code.bundle`, a git bundle of every ref, checked against the repository
  before the repository is deleted.
- An Artifacts-only Site has no pull requests or commit statuses; the
  pre-push hook (`pnpm verify`) and CI are its checks.

# Deployment policy

[Documentation](../README.md)

A Site's `gq.ops.json` may declare it a **protected deployment target** with a
`deployment` block. A Site without the block deploys exactly as before.

```json
"deployment": {
  "protected": true,
  "state": "paused",
  "reason": "Nightly updates paused for a controlled Support release"
}
```

| Key               | Meaning                                                                                                                                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protected`       | Required, and only `true`: the block exists only for a Site someone deliberately protected.                                                                                                                                                         |
| `state`           | Required: `authorized` deploys; `paused` and `reserved` refuse every deploy.                                                                                                                                                                        |
| `reason`          | Required while `paused` or `reserved`: why the Site holds. It is printed with every refusal.                                                                                                                                                        |
| `holder`          | Required while `reserved`, and only then: who holds the Site (for example `nightly pipeline`).                                                                                                                                                      |
| `guardedPackages` | Optional Composer packages a deploy verifies before uploading and again on the server; see [Package expectations](package-expectations.md). A protected Site guarding a package can't deploy until an authenticated approval service is configured. |

Schema validation refuses a protected Site without a `state`, a `paused` or
`reserved` one without a `reason`, a `reserved` one without a `holder`, and
any other `state` (there is no `open`: an unprotected Site has no block).

## What refuses

While `state` is `paused` or `reserved`, these refuse before anything is
uploaded to R2, before the Ploi deploy script is synced and before a deploy
is started:

- `gq ploi release` (and so `pnpm ploi:release`);
- `gq release package` unless it runs with `--no-deploy`, which only
  prepares a commit and calls no provider; the refusal comes before
  Composer runs or anything is committed;
- the generated CI release step (`scripts/ci-release.mjs`, run by Cloudflare
  CI for a `v*` tag), before the CMS or the Frontend deploys;
- the generated Frontend deploy (`infra/scripts/deploy-frontend.mjs`, behind
  `pnpm deploy:frontend`), before Alchemy runs.

The refusal reads, for example:

```
acme is reserved by nightly pipeline (gq.ops.json deployment.state: reserved): Nightly update running. Nothing was uploaded, synced or deployed. A reviewed Site change that sets deployment.state to "authorized" lifts the hold.
```

No flag or environment variable lifts a hold. A policy change is a reviewed
Site change to `gq.ops.json`: merged to the default branch, and for CI part
of the tagged commit. Removing the block makes the Site an ordinary one
again, which is just as much a reviewed change.

An offboarded Site (`gq.ops.json` `offboarded`) is refused first, by its own
check, whatever its deployment policy says.

## Not covered

- **A stale tag can release a held Site.** CI reads the policy from the
  tagged commit's `gq.ops.json` (a local release from the working tree's). A
  `v*` tag on a commit that predates the hold doesn't carry it, so CI would
  release that commit. Until CI also reads the reviewed default branch's
  policy, don't push release tags for a held Site, and pause any automation
  that pushes them.
- The policy is the Site's own source of truth. A pipeline outside gq (such as
  a nightly updater) has to read it, or hold the Site through it, to be
  bound by it.

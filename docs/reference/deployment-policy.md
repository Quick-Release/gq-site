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
- the CI Worker's release step for a `v*` tag (below), before the CMS or the
  Frontend deploys;
- the generated Frontend deploy (`infra/scripts/deploy-frontend.mjs`, behind
  `pnpm deploy:frontend`), before Alchemy runs.

The refusal reads, for example:

```
acme is reserved by nightly pipeline (the default branch's gq.ops.json deployment.state: reserved): Nightly update running. Nothing was uploaded, synced or deployed. A reviewed Site change that sets deployment.state to "authorized" lifts the hold.
```

No flag or environment variable lifts a hold. A policy change is a reviewed
Site change to `gq.ops.json`, merged to the default branch. Removing the
block makes the Site an ordinary one again, which is just as much a reviewed
change.

An offboarded Site (`gq.ops.json` `offboarded`) is refused first, by its own
check, whatever its deployment policy says.

## The current policy holds old commits

A hold added today isn't in a commit made yesterday. So a release checks
every policy that applies to it, and refuses when any of them is offboarded
or holds, before anything else:

- **`gq ploi release`** (and `gq release package`'s deploy): the working
  tree's `gq.ops.json`, the release commit's, and the **default branch's
  current one**. It reads the last from `origin` (`git ls-remote --symref
origin HEAD`, then `git fetch origin refs/heads/<branch>`, which changes
  only `FETCH_HEAD` and objects, never the working tree or a branch). A
  release commit or default branch whose `gq.ops.json` is missing, invalid or
  unreadable refuses, for every Site: an old unprotected commit can't release
  a Site whose current branch protects it. Guarded packages named by any of
  them are guarded.
- **The CI Worker** (`infra/ci/cloudflare.ci.ts`, deployed by `gq ci
deploy`): a tag runs its own `scripts/ci-release.mjs` and its own gq, which
  may predate the hold, so the Worker admits the release first with its own
  code (`infra/ci/release.ts`), in the release step's container, using only
  its `git` and `node`. It reads the default branch's `gq.ops.json` from
  Artifacts and the tagged commit's from the workspace, and refuses when
  either is offboarded or holds, when the default branch's can't be read, or
  when the default branch protects the Site or guards packages and the tagged
  commit doesn't (its gq wouldn't enforce that). The tagged scripts never run
  after a refusal. The release step's `ci-release.mjs` passes the Artifacts
  token to `gq ploi release` in the environment, never argv, so it can read
  the default branch too.

## Not covered

- **A CI Worker deployed before this release has no admission.** It runs a
  tag's own scripts, so an old tag would release a held Site. The admission
  protects a Site once it has synced this release and redeployed its CI
  Worker (`gq sync`, then `gq ci deploy`). Until then, keep the Site's
  release tags from being pushed: don't run `pnpm push`, and pause any
  automation that pushes tags.
- The policy is the Site's own source of truth. A pipeline outside gq (such as
  a nightly updater) has to read it, or hold the Site through it, to be
  bound by it.

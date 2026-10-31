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
acme is reserved by nightly pipeline (the default branch's gq.ops.json deployment.state: reserved): Nightly update running. Nothing was uploaded, synced or deployed. A reviewed Site change that sets deployment.state to "authorized" lifts the deployment hold.
```

No flag or environment variable lifts a deployment hold (the
[glossary](../../GLOSSARY.md)'s term for `paused` or `reserved`; a guarded
Site's request admission has its own, unrelated **admission hold**, and
`admission.sh lift`, which ends that one at the end of a deploy, can't
authorize a release or lift a deployment hold). A policy change is a reviewed
Site change to `gq.ops.json`, merged to the default branch. Removing the
block makes the Site an ordinary one again, which is just as much a reviewed
change.

An offboarded Site (`gq.ops.json` `offboarded`) is refused first, by its own
check, whatever its deployment policy says.

## The current policy holds old commits

A hold added today isn't in a commit made yesterday. So a release checks
every policy that applies to it, and refuses when any of them is offboarded
or holds, before anything else:

- **`gq ploi release`** (and `gq release package`, which reads the working
  tree's and the default branch's before anything else): the working tree's
  `gq.ops.json`, the release commit's, and the **default branch's current
  one**, all read with a system git (`/usr/bin/git`, `/usr/local/bin/git`,
  `/opt/homebrew/bin/git` or Homebrew on Linux's), never one a Site's
  `node_modules/.bin` or Sigillo values put first on `PATH`, and an
  environment gq builds: none of the caller's `GIT_*` variables, no system
  or global git configuration (`/etc/gitconfig`, `~/.gitconfig` and
  `~/.config/git/config` are ignored, so no `url.insteadOf`, alias or
  credential helper from them applies), no replacement objects, hooks or
  fsmonitor. Where the default branch comes from is the trust root, and it
  differs:
  - **In CI** (`ARTIFACTS_REMOTE` set, as the CI Worker's own configuration
    sets it for the release step): only from that URL. The release
    repository's origin must name exactly it (its raw `remote.origin.url`,
    includes not followed), or the release refuses before any request. The
    read itself (`git ls-remote --symref <ARTIFACTS_REMOTE> HEAD`, then a
    fetch of `refs/heads/<branch>`) runs in a temporary bare repository gq
    creates and removes: every git call names it with `--git-dir` and runs
    in it, `GIT_CEILING_DIRECTORIES` stops discovery at its parent, and
    `safe.bareRepository=explicit`, so git never adopts a repository found
    from the release repository, the working directory or any directory above
    the scratch one. None of the release repository's config (its origin,
    `url.insteadOf`, includes, credential settings) applies; no global or
    system config applies; redirects aren't followed; only the remote's own
    protocol is allowed; and `ARTIFACTS_TOKEN` reaches git as
    `http.<ARTIFACTS_REMOTE>.extraHeader` in the environment of those two
    calls alone. So a step before the release (the tag's install) that
    rewrites the release repository's config or a runner's global config can
    neither redirect the read to a forged, authorized policy nor receive the
    token. `ARTIFACTS_TOKEN` without `ARTIFACTS_REMOTE`, `ARTIFACTS_REMOTE`
    without `ARTIFACTS_TOKEN`, or an `ARTIFACTS_REMOTE` that isn't an
    accepted URL, refuses. An accepted URL is `https://` to a DNS name (no
    bare IP address, no port, no credentials, no `..`- or dot-prefixed path
    segment, no query or fragment), or, for the tests only, plain `http://`
    to `127.0.0.1` (any port). `localhost` is not accepted.
  - **On an operator's machine** (neither set): from the checkout's own
    `origin`, as its `.git/config` says (`git ls-remote --symref origin
HEAD`, then `git fetch origin refs/heads/<branch>`, which changes only
    `FETCH_HEAD` and objects). The operator's checkout is the trust root
    there; its repository config applies (gq pins only its hooks and
    fsmonitor settings). `origin` authenticates over SSH (your
    `SSH_AUTH_SOCK`); an HTTPS `origin` that needs a credential helper from
    your global git configuration can't be read, so the release refuses.

  The CI Worker's own admission reads both policies the same way (a temporary
  bare repository of its own, every call bound to it with `--git-dir` and
  `GIT_CEILING_DIRECTORIES` so the tag's workspace can't be discovered as a
  repository from the step's working directory, no system or global config,
  the token scoped to `ARTIFACTS_REMOTE`, no redirects, only that remote's
  protocol, the same accepted URLs). A
  release commit or default branch whose `gq.ops.json` is missing, invalid or
  unreadable refuses, **for every Site**, protected or not: an old
  unprotected commit can't release a Site whose current branch protects it.
  This changes ordinary Sites too. A release now needs `origin` reachable
  (offline, it refuses), a default branch it names, and a `gq.ops.json` on
  that branch and in the release commit that this gq validates (an old tag
  whose manifest predates a schema change refuses; release a current
  commit). An online Site with a valid manifest and no `deployment` block
  releases as before. Guarded packages named by any of
  them are guarded.

- **The CI Worker** (`infra/ci/cloudflare.ci.ts`, deployed by `gq ci
deploy`): a tag carries its own `scripts/ci-release.mjs`, gq, package
  scripts and checks, which may predate the hold. So for a `v*` tag the
  Worker's first step (`infra/ci/release.ts` `ciSteps`) is the admission,
  alone in a fresh runner with the Worker's own code and only the CI image's
  `git` and `node`, before anything the tag controls is installed, run or
  given a secret: no `pnpm install`, Composer install or lifecycle script, no
  `pnpm verify`, no release. It fetches the release tag and the default
  branch from Artifacts into a scratch repository of its own and reads
  `gq.ops.json` from both commits with `git show` (never the restored
  workspace, which it never lets git discover as a repository). It refuses
  when either is offboarded or holds, when either can't be read, when the tag
  doesn't point at the release's commit, or when the default branch protects
  the Site or guards packages and the tagged commit doesn't (its gq wouldn't
  enforce that). The release step admits again first, the same way. The
  Artifacts token reaches each network git call in its environment only:
  never argv, an exported variable, a file or a global git setting, and the
  Frontend deploy runs without it. `scripts/ci-release.mjs` fetches the
  release source the same way — a repository it makes whose origin names
  `ARTIFACTS_REMOTE`, every call bound to it, the token only on the fetch —
  and `gq ploi release` (which it then runs) puts the token only in its own
  two git reads of the default branch.

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

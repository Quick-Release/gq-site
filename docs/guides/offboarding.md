# Offboarding a Site

[Documentation](../README.md)

When a client leaves, offboarding takes their Site down without losing any of
it ([ADR 0011](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0011-offboard-a-site-by-cutting-access-before-archiving.md)).
It has two phases:

1. **Cut** (`gq offboard`, reversible): every public URL and every credential
   gq made for the Site is cut. Nothing is deleted: the CMS's files and
   database, the Frontend Worker and its store, the buckets and the code all
   stay.
2. **Archive** (`gq offboard --archive`, irreversible): all content goes to
   one archive, which is verified, and only then is the live infrastructure
   deleted. It needs the cut recorded first.

## Before you start

- **Work from the deploy branch, up to date.** Check out the branch CI
  deploys (usually `main`), pull it, and make sure the working tree is clean.
  The `offboarded` record the cut writes is what stops CI and your teammates'
  checkouts from deploying the Site again, but only once it is committed and
  pushed to that branch: written on a feature branch or a stale checkout, it
  guards nothing but your own copy.
- **gh 2.48 or later**, logged in with admin on the repository (`gh --version`;
  the webhooks are listed with `gh api --paginate --slurp`). An older gh fails
  while the plan is read, before anything changes. An Artifacts-only Site
  needs no gh (see [An Artifacts-only Site](#an-artifacts-only-site)).
- Ask the team not to push while the cut runs; the cut silences CI first, but
  a push already under way can still deploy.

## Cut a Site's access

```sh
pnpm offboard --dry-run       # the plan, nothing changed
pnpm offboard                 # the plan, then a prompt
git add gq.ops.json && git commit -m "chore: offboard the Site" && git push
pnpm offboard --dry-run       # every line ✓ (or !): nothing came back
```

Commit and push `gq.ops.json` straight away, then run `--dry-run` again and
expect every line to be `✓` (or `!`, by hand). A `-` line means something was
exposed again while the cut ran (a CI release already under way, say): run
`pnpm offboard` again to cut it.

`pnpm offboard` runs `gq offboard` through `gq sigillo run operations`, for
the account's token-manager token. Ploi's token and the releases bucket's R2
key are read from Sigillo staging, and the GitHub webhook goes through your
`gh` login (it needs admin on the repository). Outside a terminal, pass
`--yes`.

These checks come first, and stop the run before anything changes:

- **The deploy files are current.** `infra/frontend.run.ts`,
  `infra/scripts/deploy-frontend.mjs` and `scripts/ci-release.mjs` must be as
  `gq sync` writes them: older or edited copies lack the guards that keep a
  deploy from exposing the Site again. Run `gq sync` (`gq sync --check` shows
  what it changes) and commit, then offboard.
- **`ploi.siteId` is the Site's CMS.** The Ploi site it names must be
  `domains.admin`, running as `ploi.systemUser`; a stale or copied ID would
  suspend another client's site.
- **`ploi.database` is the Site's database.** The site's `.env` (read, never
  written) must have `DB_NAME` equal to `ploi.database`: Ploi doesn't link
  databases to sites, so a copied name would back up, archive and delete
  another client's database.

The plan marks each item `✓` (already done), `-` (to cut) or `!` (by hand),
and is applied in this order:

| Part     | What happens                                                                                                                                                                                                                                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Record   | `offboarded: { "at": …, "phase": "cut" }` is written to `gq.ops.json` first, so the guards hold even if a later step fails. Commit and push it once the cut is done (an Artifacts-only Site's can only be committed).                                                                                                                   |
| Backup   | `gq db backup` of the live database into the backups bucket, before anything is cut.                                                                                                                                                                                                                                                    |
| CI       | The GitHub push webhook is deactivated (on an Artifacts-only Site, every push credential is taken away instead) and the CI Worker's workers.dev switched off, first, so a push from then on can't deploy the Frontend again. A CI Worker not named `<project>-ci` may serve other repositories: it is listed for you (`!`) and left on. |
| CMS      | The retry crontab is deleted and the Ploi site suspended ("offboarded"); its files, `.env` and database stay.                                                                                                                                                                                                                           |
| Frontend | The Worker's custom domains are detached and its workers.dev and preview URLs switched off, and its other stages' too. The Workers and their D1 stores stay.                                                                                                                                                                            |
| Media    | The media bucket's custom domain is disabled. The bucket and its uploads stay. A media bucket not named `<project>-media` may serve other clients: it is listed for you (`!`) and its domain left on.                                                                                                                                   |
| Tokens   | Every `GETQUICK <PROJECT> …` Cloudflare token is disabled, last, since the steps before need them. The token-manager token is never touched.                                                                                                                                                                                            |

As it goes, the cut notes in `offboarded.cut` each thing it has changed (the
crontab, the suspension, each detached domain, each Worker's workers.dev
setting as it was, the media domain, the webhook and each token it disabled):
restore brings back those and nothing else. A change that failed isn't
noted, so restore never undoes something the cut didn't do. Commit and push
`gq.ops.json`: it is what keeps gq, the deploy scripts and CI from exposing
the Site again.

Two things are yours to do by hand, and the plan says so:

- **The CMS's deploy webhook.** Ploi's API can't disable it; the suspension
  is what stops it.
- **The CMS's DNS record** (`domains.admin`), added by hand when the Site was
  provisioned. Remove it if it should go.

The Frontend's secrets stay in Sigillo; with every URL gone, they reach
nothing.

Running `pnpm offboard` again cuts only what is still exposed, so a run that
failed halfway is finished by running it again. A failure before the tokens
step leaves every token active, and the record already guards the Site.
A Frontend stage is a Worker named `<project>-fe-<stage>` whose
`PUBLICATION_DB` binding is the D1 store `<project>-fe-publications-<stage>`:
that binding is what ties it to the project. Any other Worker named like one
(`<project>-fe-fe`, project `<project>-fe`'s production Worker; a
hand-deployed `<project>-fe-redirects`; `<project>-fe-shop-fe`) may not be
the Site's: the plan lists it for you to check, and leaves it alone. Once the Ploi site is suspended the backup
counts as done: a suspended CMS can't change its database, so the backup
taken before it is the final one.

## An Artifacts-only Site

A Site with no `github.repository` in `gq.ops.json` keeps its code only in its
Artifacts repository
([ADR 0012](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0012-keep-a-sites-code-in-artifacts-when-it-has-no-github-repository.md)).
Pushes there start CI directly, and nothing goes through GitHub, so `gh`
isn't needed. Offboarding it needs `artifacts.namespace` and `artifacts.repo`
in `gq.ops.json`, and differs in these ways:

- **The cut.** Straight after the backup, where a Site on GitHub has its
  webhook deactivated, the cut disables the `GETQUICK <PROJECT> Artifacts`
  token, so no git token can be minted. It then revokes every git token
  still active for the repository. Nobody can push from then on, you
  included: commit `gq.ops.json`, and push it once the Site is restored.
- **Restore** re-enables the Artifacts token with the other tokens; the
  credential helper mints new git tokens from it.
- **The archive** clones the repository into a temporary directory and
  stores every ref in `code.bundle`, which `manifest.json` lists with its
  refs. When the archive is verified, the repository's refs are read again
  and must match the bundle's, so a push made after the bundle stops the run
  before anything is deleted; a resumed run checks them against the recorded
  `manifest.json` again before the repository goes. The repository is then deleted with the rest.
  There is no webhook to delete and nowhere to push the record: commit
  `gq.ops.json` in your checkout. The run prints `code.bundle`'s location
  where a Site on GitHub has its archived repository.

## While a Site is offboarded

Every command that would expose the Site again refuses, and names
`gq offboard --restore`:

- `gq cloudflare media`, `deploy-token`, `ci`, `releases`
- `gq github setup`, `gq ci deploy`
- `gq ploi provision`, `events`, `media`, `release`, and any `gq ploi api`
  operation that writes (`--dry-run` still prints the request)
- `gq release push`, `gq release tag`
- `gq frontend refresh`, `gq frontend secrets`
- `pnpm deploy:frontend` (`infra/scripts/deploy-frontend.mjs`) and CI's release
  step (`scripts/ci-release.mjs`); `infra/frontend.run.ts` drops the domain and
  every workers.dev and preview URL, so even a direct Alchemy deploy
  re-attaches nothing.

Checks, `gq db backup` and `gq ploi api` GETs keep working.

## Restore a Site

```sh
pnpm offboard:restore --dry-run
pnpm offboard:restore
git add gq.ops.json && git commit -m "chore: restore the Site"
```

`gq offboard --restore` reverses what the cut recorded in `offboarded.cut`,
in the reverse order, tokens first: it re-enables the tokens the cut disabled
(never creating new ones; a token that was disabled before stays so, and the
plan says it), re-enables the media domain, re-attaches every domain the cut
detached and puts each Frontend Worker's workers.dev and preview URLs back as
they were, resumes the Ploi site, re-adds the retry crontab if the cut
deleted one, puts the CI Worker's workers.dev back and reactivates the
webhook, and removes `offboarded`. Add back by hand a DNS record
you removed. Then release and deploy as usual, and run `pnpm site:check`.

Restore refuses once the Site's archive is recorded.

## Archive a Site

Once the cut is recorded (and committed), and nobody expects the Site back,
run it from an up-to-date checkout of the repository's default branch with
nothing changed but `gq.ops.json`:

```sh
git switch main && git pull --ff-only
pnpm offboard:archive --dry-run   # the plan, nothing changed
pnpm offboard:archive             # the plan, then type the project's name
```

`pnpm offboard:archive` runs `gq offboard --archive` through
`gq sigillo run operations`, like the cut. In a terminal it goes on only once
you type the project's name back; elsewhere it needs `--yes`. **This can't be
undone**: everything but the archive, the GitHub repository and the Sigillo
project is deleted. It ends by committing `gq.ops.json` and pushing it, then
archiving the repository: there is nothing to commit afterwards.

### What is archived

Everything goes to the private R2 bucket `offboarded-clients`, shared by every
former client (created if missing, with no public domain), under
`<project>/<UTC date>/`:

| File               | What it is                                                                                                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uploads.zip`      | Every object of the media bucket, keys kept as paths. Streamed from the bucket to the archive, never held in memory or on disk. Only a media bucket named `<project>-media` is archived: another may hold other clients' uploads, and is listed for you. |
| `database.sql.gz`  | A fresh dump of the CMS database (still there, on the suspended site).                                                                                                                                                                                   |
| `publications.sql` | The Frontend's D1 publication store, exported (and `publications-<stage>.sql` for each other stage's). A Site without one (no durable delivery) can't be archived yet.                                                                                   |
| `backups/`         | Copies of the Site's own database backups (`<backups.prefix><database>/`), the cut's final backup among them. When the backups bucket is deleted whole (it is the project's releases bucket, as is usual), everything under `backups.prefix` instead.    |
| `code.bundle`      | An Artifacts-only Site's code: a git bundle of every ref of its Artifacts repository. A Site on GitHub has none: its repository is archived instead.                                                                                                     |
| `gq.ops.json`      | The Site's manifest as it was.                                                                                                                                                                                                                           |
| `manifest.json`    | Each file's size and sha256, and where everything came from: buckets, Ploi IDs, Workers, the D1 store, the GitHub repository's HEAD (an Artifacts-only Site's refs instead).                                                                             |

Each media object and backup must hold as many bytes as its bucket lists.
Then every file is read back and checked against `manifest.json`, and
`uploads.zip`'s entries are counted against the media bucket's objects. An
Artifacts-only Site's repository refs are read again and must match
`code.bundle`'s. **If
anything differs, the run stops before deleting anything.** Only a verified
archive is recorded in `gq.ops.json` (`offboarded.archive`: its bucket, prefix
and `manifest.json`'s sha256).

A new archive refuses to start, before writing anything, when:

- the Ploi site isn't `domains.admin` running as `ploi.systemUser`, or its
  `.env` names another database than `ploi.database` (as for the cut);
- something under `<project>/<UTC date>/` is there already: gq never archives
  over it. Move unverified files aside; if they are a verified archive whose
  record was lost, put `offboarded.archive` back in `gq.ops.json` instead;
- a source is gone (the Ploi site or database, the Frontend Worker, its D1
  store, the project's media bucket) while no archive is recorded: a new archive would
  miss it, so the record of the one that was made must come back;
- the final backup the cut took isn't in the backups bucket.

### What is deleted

In this order, only after the archive is recorded:

| Part      | What happens                                                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ploi      | The site (and `ploi.siteId` in `gq.ops.json`), its database and its system user, unless another site on the server runs as it. Ploi deletes the site in the background, so gq waits for it to go first.       |
| Frontend  | The Worker and its D1 publication store, and every other stage's.                                                                                                                                             |
| CI        | The CI Worker, its Workflows and its container application.                                                                                                                                                   |
| Media, R2 | The media bucket's custom domain; then the media, releases and CI backup buckets, each emptied with a key scoped to it, and deleted. The backups bucket stays: only the Site's own backups in it are deleted. |
| Artifacts | The Artifacts repository. The empty namespace stays (the plan says so).                                                                                                                                       |
| DNS       | The `A`, `AAAA` and `CNAME` records named exactly as the Site's hosts: `domains.admin`, `domains.frontend` and `media.domain`. Each is listed in the plan.                                                    |
| Tokens    | Every `GETQUICK <PROJECT> …` token, deleted last on Cloudflare.                                                                                                                                               |
| GitHub    | The push webhook is deleted (not on an Artifacts-only Site).                                                                                                                                                  |
| Record    | `offboarded.phase` becomes `"archived"`, and gq commits `gq.ops.json` and pushes it to the default branch (an Artifacts-only Site's you commit yourself).                                                     |
| GitHub    | Last, once the record is pushed, the repository is archived: read-only, its code and history kept (not on an Artifacts-only Site).                                                                            |

The zone is shared with other Sites (`bnq.pt` holds every client's staging
hosts): it is never deleted, and neither is any record that isn't one of the
Site's own hosts, a subdomain of them included. Other record types at those
hosts (MX, TXT, CAA: perhaps the client's mail or verification) and every
record at the zone's apex are listed for you instead.

Some of what `gq.ops.json` names may be shared, or copied from another Site,
so the archive deletes only what is named exactly as gq names the project's
own:

| Resource              | gq's name                                                       |
| --------------------- | --------------------------------------------------------------- |
| Buckets               | `<project>-media`, `<project>-releases`, `<project>-ci-backups` |
| Workers               | `<project>-fe`, `<project>-ci`                                  |
| Workflows             | `<project>-ci`, `<project>-mirror`                              |
| Container application | `<project>-ci-cisandbox`                                        |
| D1 store              | `<project>-fe-publications`                                     |
| Artifacts repository  | `<project>`                                                     |

Other stages' Workers and D1 stores go only when the `PUBLICATION_DB` binding
ties them together (see the cut). Anything else, a sibling project's
`<project>-shop-media` included, is listed for you (`!`) and left alone; so
are the custom domain and DNS records of a media bucket that isn't the
project's own. A resource is reported deleted (`✓`) only once an exact lookup
finds it gone, never because a listing left it out.

The run ends by printing where everything is: the archive's prefix and
`manifest.json`'s sha256, the archived repository, and the Sigillo project,
which is kept with the Site's secrets.

An archived repository takes no push, so gq pushes the record first, and
only when that can't surprise you: the checkout is on the default branch,
nothing but `gq.ops.json` is changed, its remote is the repository being
archived, and the push is a fast-forward. Otherwise the plan shows a `! Git`
line saying why, and the run deletes everything else but leaves the
repository as it is. Commit and push `gq.ops.json` yourself, then run
`pnpm offboard:archive` again: with the record pushed, it only archives the
repository (it needs neither Cloudflare nor Ploi).

### If it fails halfway

Run it again. A recorded archive is never written again (its `manifest.json`
must still match the recorded sha256, or nothing more is deleted), and only
what is still there is deleted. Until the run finishes, `gq offboard` and
every guarded command point you back at `pnpm offboard:archive`, and
`--restore` refuses. A push refused at the end (the remote moved on while the
run deleted) leaves the repository unarchived: pull, push `gq.ops.json`, and
run it again.

Ploi may take a while to delete the site, and refuses to delete its system
user until it has. gq waits up to 5 minutes for the site to go, then retries
the system user's deletion for up to 5 minutes more; past that the run stops
with Ploi's reasons, and a rerun later picks up from there.

A run that failed before its archive was verified (a source read short, or
the verification itself) has deleted nothing, but leaves its files under
`r2://offboarded-clients/<project>/<UTC date>/`, and the next run that day
won't write over them. To clear them:

1. List them: in the Cloudflare dashboard (R2 → `offboarded-clients`), or
   with any S3 client and a key for that bucket.
2. Move every object under `<project>/<UTC date>/` to another prefix, such as
   `<project>/<UTC date>-unverified/`, or delete them: the Site's content is
   all still in place, so the next run archives it anew.
3. Run `pnpm offboard:archive` again.

The next UTC day's prefix starts empty, so a run then needs nothing moved
(the leftovers stay, unverified, until you delete them).

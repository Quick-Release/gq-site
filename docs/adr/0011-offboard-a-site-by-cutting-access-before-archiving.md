# ADR 0011: Offboard a Site by cutting its access before archiving it

- Status: Accepted
- Date: 2026-10-03

## Context

When a client leaves, the first thing they want is that nothing of theirs is
reachable, and their content (the database, the uploads, the publication
store) and code must survive. The gq-smoke wizard's teardown
(`scripts/smoke/gq-smoke-down.sh`) deletes a throwaway Site outright, so a
client's Site can't go that way.

A Site is exposed in many places, each made by a different command: the CMS
on Ploi (its site, its retry crontab, its deploy webhook, a DNS record added
by hand), the Frontend Worker (its custom domain, workers.dev and preview
URLs), the media bucket's public domain, the CI Worker and the GitHub push
webhook that reaches it, and the project's Cloudflare tokens. Any provisioning
or deploy command run afterwards (by a person or by CI on the next tag) would
attach the domain or mint the token again.

"Withdrawal" already means an editor unpublishing content
([ADR 0006](0006-withdraw-publications-through-signed-cms-events.md)), so this
is **offboarding** (see the glossary).

## Decision

- **Two phases.** `gq offboard` cuts every public URL and every credential gq
  made, deleting nothing, and is reversible (`gq offboard --restore`). A
  second phase, `gq offboard --archive`, archives all content to one place
  and deletes the live infrastructure; it refuses unless the first is
  recorded (see "The archive" below).
- **One plan, applied in order.** The command reads everything first, prints
  a plan (`✓` already done, `-` to cut, `!` by hand), and applies only what is
  still to do after confirmation (a prompt in a terminal, `--yes` elsewhere,
  as `gq ploi provision`). Running it again cuts only what is still exposed,
  so a failed run is finished by running it again. Before calling any
  provider it refuses unless the managed deploy files
  (`infra/frontend.run.ts`, `infra/scripts/deploy-frontend.mjs`,
  `scripts/ci-release.mjs`) are as `gq sync` writes them, since an older or
  edited copy lacks the guards below. Once it has read the Ploi site, it
  refuses when the site `ploi.siteId` names isn't `domains.admin` running as
  `ploi.systemUser`, since a stale or copied ID would suspend another
  client's site (`--restore` and the archive check the same). The cut and
  the archive also refuse unless the site's `.env` (read, never written) has
  `DB_NAME` equal to `ploi.database`: Ploi's databases aren't linked to
  sites, so a copied name would back up, dump and delete another client's.
  The order:
  1. `offboarded: { "at", "phase": "cut", "cut": {} }` written to
     gq.ops.json **first**, for the operator to commit, so the guards hold
     while the cut is half done (a teammate's release or deploy refuses even
     if a later step fails);
  2. a final `gq db backup` into the backups bucket, before anything is cut;
  3. the GitHub push webhook deactivated and the CI Worker's workers.dev
     switched off, **straight after the backup**: the record isn't committed
     yet, so CI wouldn't refuse a push made mid-cut, and a release could
     re-attach what the next steps detach. A CI Worker not named
     `<project>-ci` may serve other repositories: it is reported as manual
     and left on;
  4. the CMS's retry crontab (matched as `gq ploi events` matches it), then
     the Ploi site suspended with the reason "offboarded", which keeps its
     files, `.env` and database. Ploi's API can't disable the site's deploy
     webhook (suspension is the only lever) and the CMS's DNS record was made
     by hand, so both are reported as manual;
  5. the Frontend Worker's custom domains detached, its workers.dev and
     preview URLs switched off, and the same for each of its other stages:
     a Worker named `<project>-fe-<stage>` (one word, never `fe`) whose
     `PUBLICATION_DB` binding is the D1 store
     `<project>-fe-publications-<stage>`, which is what ties it to the
     project. Any other Worker named like one (`<project>-fe-fe` is project
     `<project>-fe`'s production Worker; a hand-deployed Worker has no such
     binding) is reported as manual. The Workers and their D1 stores stay;
  6. the media bucket's custom domain disabled; the bucket stays. A media
     bucket not named `<project>-media` may serve other clients: it is
     reported as manual and its domain left on;
  7. every "GETQUICK <PROJECT> …" Cloudflare token disabled, **last**, since
     the earlier steps (and a rerun after a failure) need what they grant. A
     failure before this step leaves every token active. Tokens, GitHub hooks
     and Ploi crontabs are read across every page of their listings.

  Each step notes in `offboarded.cut` what it changed, once the change is
  made: the final backup, the retry crontab, the suspension, each detached
  Worker domain, the media domain, the webhook's ID and each disabled
  token's ID. A change that failed isn't noted, so restore never undoes what
  the cut didn't do (a token someone disabled on purpose after a failed cut
  stays disabled). Only each Worker's workers.dev setting as it was is noted
  before the change, and kept from the first run (`??=`), so the original
  survives a change that half happened; restore compares it with the live
  setting anyway.

- **The record turns on the guards.** While gq.ops.json has `offboarded`,
  every gq command that would expose the Site again refuses before reading a
  secret or calling a provider, and says to run `gq offboard --restore`:
  `cloudflare media|deploy-token|ci|releases`, `github setup`, `ci deploy`,
  `ploi provision|events|media|release`, `release push|tag`,
  `frontend refresh|secrets`, and any `ploi api` operation that writes
  (unless `--dry-run`). The generated `infra/scripts/deploy-frontend.mjs` and
  `scripts/ci-release.mjs` refuse on their own (they don't run through gq),
  and `infra/frontend.run.ts` drops the domain and every workers.dev and
  preview URL, so even a direct Alchemy deploy re-attaches nothing.
  Read-only commands (checks, `gq db backup`, `ploi api` GETs) keep working.
- **Restore reverses it, and only it.** `gq offboard --restore` brings back
  what `offboarded.cut` records and nothing else, in the reverse order: it
  re-enables those tokens (never creates them: `planToken` would "create" a
  disabled token, which would duplicate it; a token disabled before the cut
  stays disabled, shown as manual), re-enables the media domain, re-attaches
  every detached Worker domain and puts each Frontend Worker's workers.dev
  and preview URLs back as they were, resumes the Ploi site, re-adds the
  crontab only if the cut deleted one, puts the CI Worker's workers.dev back
  and reactivates the webhook, and removes `offboarded`. It refuses once the
  archive has run (`phase: "archived"`).
- **Credentials, per command.** It runs through `gq sigillo run operations`
  (`pnpm offboard`, `pnpm offboard:restore`) for the token-manager token.
  Tokens are managed with it; every other Cloudflare call goes through a
  1-hour token it mints for the run ("GETQUICK <PROJECT> offboarding
  (temporary)") and deletes afterwards. Ploi's token and the releases R2 key
  are read into memory from Sigillo staging; GitHub goes through the
  operator's `gh` login. No value is printed, and what a provider echoes back
  on failure (R2's error bodies, `gh`'s stderr) goes through
  `src/cli/redact.mjs` first; of an R2 error only its code and message are
  kept. A secret Sigillo doesn't list is reported missing; one it can't hand
  over is reported as a failed read.
- **A reusable plan.** The provider operations (`src/offboard/providers.mjs`),
  the reading of the Site and its plans (`steps.mjs`) and the plan runner
  (`plan.mjs`) are separate from the command, so the archive plans and
  applies the same way.

Choices made where the spec left room:

- The final backup counts as done once the Ploi site is suspended: a
  suspended CMS can't change its database, so the backup taken before is the
  last state. A rerun after a failure doesn't take another.
- The manager token is never disabled, even if it were named after the
  project: its ID comes from `tokens/verify` and is left out. Temporary
  tokens (names ending in "(temporary)") are left out too.
- `frontend.run.ts` omits `domain` while offboarded rather than setting it to
  `null`, which Alchemy's Website type may not accept; a removed property is
  what detaches the domain.
- A recorded media domain or webhook that is gone by the restore is reported
  as manual (`pnpm cf:media`, `pnpm github:setup`), since restoring isn't
  provisioning.
- One Sigillo environment per command, not per provider. The spec asked for
  `staging` for Ploi, GitHub and the Frontend and `operations` for tokens and
  buckets. A command runs under one `gq sigillo run`, so offboarding runs
  under `operations` (for the token-manager token) and reads the few staging
  secrets it needs (`PLOI_API_TOKEN`, the releases R2 key) into memory
  through Sigillo's CLI, never into the environment of a child process.
  GitHub needs no secret (`gh`), and the Frontend's are never read.
- The deploy-file precondition checks only the three files that carry the
  guards, not all of `gq sync --check`: other drift can't expose the Site,
  and a client's edits elsewhere shouldn't block cutting its access.
- `--dry-run` reads only, but it mints and deletes the run's temporary token,
  since the manager token can't read Workers or R2.
- Offboarding requires the whole configuration (domains, Ploi, backups,
  media, CI, Cloudflare zone, and the GitHub repository or, for an
  Artifacts-only Site, the Artifacts repository), named when missing, rather
  than skipping a part: every Blueprint Site has them.
- `phase` is `"cut"` or `"archived"` in the schema, so restore can refuse an
  archived Site.

### The archive (phase 2)

- **Archive, verify, then delete.** `gq offboard --archive` refuses a Site
  without the `offboarded` record. Its plan lists everything it will archive
  and delete (each DNS record by name). In a terminal it goes on only once
  the project's name is typed back; elsewhere it needs `--yes`. The archive
  goes to the private R2 bucket `offboarded-clients`, shared by every client
  and created if missing (no custom domain), under `<project>/<UTC date>/`:
  - `uploads.zip`: every object of the media bucket, keys kept, streamed
    from the bucket into a multipart upload, so neither the bucket nor the
    archive is ever held in memory or on disk. Only the project's own media
    bucket (`<project>-media`) is archived: another may hold other clients'
    uploads, so it is reported as manual, and its custom domain and DNS
    records stay;
  - `database.sql.gz`: a fresh dump, which the server uploads straight to
    the archive through a presigned URL (as `gq db backup` does);
  - `publications.sql`: the D1 store's export, and
    `publications-<stage>.sql` for each other stage's store;
  - `backups/`: copies of the Site's own database backups
    (`<backups.prefix><database>/`, where `gq db backup` writes them), or of
    everything under `backups.prefix` when the backups bucket is deleted
    whole (it is also the project's releases bucket, as usual), so nothing
    the deletion takes goes unarchived;
  - `gq.ops.json`, and `manifest.json`: each file's size and sha256 (and
    `uploads.zip`'s entry count), the source resources (buckets, the Ploi
    server, site, database and system user, the Workers, Workflows and
    container application, the D1 store's name and ID, the Artifacts
    repository, the GitHub repository and its HEAD commit, the zone, the
    Sigillo project), gq's version and the date.

  Every media object and backup copied must hold as many bytes as its
  bucket's listing says, so a body cut short without an error isn't archived
  as whole. Every file is then read back and its size and sha256 compared
  with the manifest; `uploads.zip`'s entry count must equal the media
  bucket's object count, read again. Any difference stops the run **before
  anything is deleted**. Only a verified archive is recorded, as
  `offboarded.archive: { bucket, prefix, manifestSha256 }`.

- **The deletions follow gq-smoke-down's order**: the Ploi site (and
  `ploi.siteId` forgotten in gq.ops.json, as gq-smoke-down does), its
  database and system user; the Frontend Worker and its D1 store (Alchemy
  retains a production store, so it is deleted explicitly), and each other
  stage's Worker and store; the CI Worker, its Workflows and its container
  application; the media bucket's custom domain; the media, releases and CI
  backup buckets, each emptied with a key scoped to it, then deleted; the
  Site's own backups, when the backups bucket isn't one of those; the
  Artifacts repository; the Site's own DNS records; then the project's
  tokens, deleted (phase 1 only disabled them).
- **Only what is the Site's own.** Several things the archive deletes may be
  shared, so it checks before it deletes:
  - The backups bucket is never deleted: its `prefix` exists so that it can
    be shared (Ekis's `backups-sites` holds every client's). Only the
    Site's own backups under `<backups.prefix><database>/` are deleted,
    once archived, unless the bucket is also the media, releases or CI
    backup bucket and goes whole.
  - A bucket, Worker, Workflow, container application, D1 store or
    Artifacts repository is deleted only when its name is exactly the one gq
    gives it for the project: the buckets `<project>-media`,
    `<project>-releases` and `<project>-ci-backups`, the Workers
    `<project>-fe` and `<project>-ci`, the Workflows `<project>-ci` and
    `<project>-mirror`, the container application `<project>-ci-cisandbox`,
    the D1 store `<project>-fe-publications` and the Artifacts repository
    `<project>`. Other stages' Workers and D1 stores go only when the
    `PUBLICATION_DB` binding ties them together, as in the cut; a D1 store
    named like a stage's that no stage Worker binds is manual. Anything else
    gq.ops.json points at, a sibling project's `<project>-shop-media`
    included, is listed as manual.
  - A resource is reported deleted (`✓`) only when an exact lookup finds it
    gone (a bucket, Worker or Workflow by its name), never because a listing
    left it out. Listings (Workers, container applications, D1 stores,
    tokens, Ploi's sites) are read across every page; one
    without page totals is read until an empty page, one that ignores paging
    until it repeats a page, and a Ploi listing past 50 pages stops the run
    rather than look complete.
  - The Ploi system user stays (manual) while another site on the server
    runs as it; Ploi would take that site's home with it, or refuse halfway.
  - The Ploi site is deleted only when `ploi.siteId` names `domains.admin`
    running as `ploi.systemUser`, and the database only when the site's
    `.env` names it.
  - Ploi deletes a site in the background and refuses (422) to delete its
    system user meanwhile. After deleting the site, the run waits until Ploi
    neither returns nor lists it, before the database and the system user;
    a system user deletion Ploi still refuses with 422 is retried. Each
    waits 2 s, doubling up to 10 s, for 5 minutes at most on the run's clock,
    then fails: the system user with Ploi's validation errors (its 422
    body's `message` and `errors`, redacted like every Ploi error gq shows).
    Then GitHub's push webhook is deleted, `offboarded.phase` becomes
    `"archived"` (`at` the archive's date), and the record is committed and
    pushed before the repository is archived (below). The run prints the
    archive's prefix, the archived repository and the Sigillo project, which
    is kept.
- **The record reaches git before the repository is read-only.** An archived
  repository takes no push, so the run itself commits gq.ops.json (that file
  alone) and pushes it to the default branch, and archives the repository
  (`gh repo archive`, so the code stays readable) only once the push
  succeeded, last of all. It pushes only when that can't surprise the
  operator, checked when it plans: the checkout is on the repository's
  default branch, nothing but gq.ops.json is changed or untracked in it, the
  branch's remote is the repository being archived, and the remote branch
  (fetched first) has nothing the checkout lacks, so the push is a
  fast-forward. Otherwise the plan says why in a manual line, to commit and
  push gq.ops.json by hand, then run the archive again; that run deletes
  everything else but leaves the repository unarchived. A push the remote
  still refuses (it moved on mid-run) fails the run before the repository
  is archived, saying the same. Once `phase` is `"archived"`, a rerun reads
  only the repository and the checkout (no Sigillo, Cloudflare or Ploi): the
  record pushed (gq.ops.json unchanged since its commit, and nothing left to
  push) is `✓`, otherwise it is pushed as above; an archived repository is
  `✓`, otherwise it is archived. A record never pushed to a repository
  archived meanwhile by hand is manual: unarchive, push, archive again.
- **The zone is shared.** It is the team's preview and staging domain for
  every client (`bnq.pt`), so only records named exactly as one of this
  Site's hosts (`domains.admin`, `domains.frontend`, `media.domain`) are
  deleted, and only those that serve it: `A`, `AAAA` and `CNAME`. Any other
  type at those hosts (MX, TXT, CAA) may be the client's own mail or
  verification and is listed as manual, and no record at the zone's apex is
  deleted at all. The zone and every other record stay, a subdomain of a
  Site's host included.
- **Resumable, never archived twice.** A rerun reads what is left and
  deletes only that. A recorded archive is never written again: its
  `manifest.json` must still match the recorded sha256, or the run stops
  before deleting anything else. A new archive starts only when every source
  it reads is still there (the Ploi site and database, the Frontend Worker,
  its D1 store, the media bucket), when nothing is under its prefix yet, and
  when the final backup phase 1 took is there; otherwise the run stops
  before writing anything. Either of the first two means an archive whose
  record was lost (an uncommitted gq.ops.json, another clone), which a new
  one would overwrite or miss content from. A run that fails before
  verification records nothing; its unverified files must be moved aside
  before the next run archives anew (the size-check failure says so). While the archive is
  recorded but the run unfinished, `gq offboard` and `--restore` refuse, and
  the guards point at `gq offboard --archive`. Once archived, a rerun calls
  only `git` and `gh`, and has nothing to do once the record is pushed and
  the repository archived.
- **Credentials.** `pnpm offboard:archive` runs it through
  `gq sigillo run operations`, like phase 1. Its temporary token can also
  delete Workers, Workflows, container applications, D1 stores, buckets and
  Artifacts repositories, and export a D1 store. R2 objects are read, written
  and deleted with keys scoped to one bucket each, minted for the run as
  1-hour tokens ("GETQUICK <PROJECT> offboarding <bucket> (temporary)") and
  deleted with it. The record is pushed with the checkout's own git remote
  and credentials.

Choices made where the spec left room:

- The scoped keys are minted for the run rather than the project's own R2
  keys from Sigillo: phase 1 disabled those, and enabling them again would
  hand out credentials the cut took away. A scoped key still can't reach
  another client's bucket, which is what the gq-smoke cleanup relies on.
- `uploads.zip` stores its entries uncompressed (media is compressed
  already), with ZIP64 records past 4 GiB or 65,535 entries.
- The archive's resume point is gq.ops.json's record, written right after
  verification, rather than a marker in the bucket: it is what the guards and
  restore read already. A run that fails before verification leaves its
  unverified files under that day's prefix, which the next run refuses to
  write over; the operator moves them aside (or, if they are a verified
  archive whose record was lost, records it).
- The media custom domain is removed before the buckets are deleted, as
  gq-smoke-down does, so no bucket is deleted with a domain still on it.
- The Frontend Worker is deleted through Cloudflare's API, not
  `alchemy destroy`: gq doesn't run Alchemy, and a direct deploy of an
  offboarded Site refuses anyway.
- The container application is the one Wrangler names after the CI Worker
  and its sandbox class (`<ci.worker>-cisandbox`); nothing else is matched.
- Deleting something already gone (taken along by another deletion, or by a
  rerun) counts as done.
- The empty Artifacts namespace stays (gq-smoke-down can't delete one
  either), reported as manual.
- `--yes` confirms in a terminal too, as in the other offboarding commands.
- `--dry-run` reads only, but mints and deletes the run's tokens, including
  the scoped keys it lists the media and backups buckets with.

### An Artifacts-only Site

An Artifacts-only Site (no `github.repository`,
[ADR 0012](0012-keep-a-sites-code-in-artifacts-when-it-has-no-github-repository.md))
is offboarded the same way, with its Artifacts repository where GitHub was.
It needs `artifacts.namespace` and `artifacts.repo` instead, and gq never
calls `gh` for it.

- **The cut takes every push credential away.** A push to its Artifacts
  repository starts CI directly, so there is no webhook to deactivate.
  Straight after the backup, where a Site on GitHub has its webhook
  deactivated, the cut disables the "GETQUICK <PROJECT> Artifacts" token (the
  one the credential helper mints git tokens with), noted with the other
  tokens, then revokes every git token still active for the repository,
  listed again once the token is disabled so that none minted since the plan
  was read survives (a repository already gone has nothing to revoke). The
  CI Worker's workers.dev is switched off as for any Site. Restore
  re-enables the token with the others; no git token comes back, since the
  credential helper mints new ones. The run's temporary token can read
  and revoke Artifacts git tokens for such a Site.
- **The record can't be pushed until restore.** With no credential left to
  push with, nobody can start CI, so the committed record guards only the
  operator's checkout, and nothing else needs it.
- **The code is archived with the content.** The archive's files include
  `code.bundle`: a git bundle (`git bundle create --all`) of a mirror clone
  of the Artifacts repository, made in a temporary directory removed
  afterwards. `git bundle verify` checks it, and `manifest.json` records its
  refs (`sources.artifacts.refs`) and `sources.github: null`. The clone and
  the reads of the repository's refs go through read-only git tokens the
  run's temporary token mints for each and revokes after it, passed to git
  in its environment (an `http.extraHeader`, every other credential helper
  off, no prompt), never in its arguments or on disk. The repository is a source a new
  archive requires. A repository without refs has nothing to bundle, which
  the plan says.
- **Verified before the repository goes.** The verification reads the
  repository's refs again and compares them with the bundle's: a push since
  the bundle was made stops the run before anything is deleted. A resumed
  run (the archive recorded, the repository still there) compares them with
  the refs the recorded `manifest.json` has for `code.bundle`, and stops the
  same way when they differ.
- **Nothing to push.** The Artifacts repository is deleted with the rest, so
  there is no webhook to delete, no record to push and no repository to
  archive. The plan says to commit the record in the checkout, and a rerun
  once archived reaches nothing.

## Considered options

- **Delete at once, as gq-smoke-down does.** Rejected: irreversible before
  the content is safely archived and verified, and a client may come back.
- **An archive per client bucket.** Rejected: one shared, private bucket is
  one place to look for any former client, with one access policy.
- **Re-enable the project's bucket keys for the archive.** Rejected: see the
  scoped keys above.
- **Archive to a local file, then upload it.** Rejected: a large media
  bucket would need as much free disk; streaming needs one part in memory.
- **Disable the tokens first.** Rejected: the steps after would lose the
  credentials they need, and a failed run couldn't be finished.
- **Guard in each command.** Rejected for the gq commands: one check in the
  dispatcher, after the manifest is read and before any command runs, can't
  be forgotten by a new command's author. The deploy scripts check for
  themselves because they run outside gq.
- **Restore as the Blueprint configures it**, without remembering what was
  cut. Rejected: it would re-enable tokens disabled on purpose before the
  cut, re-attach only `domains.frontend`, and re-add a crontab the Site never
  had.
- **Match ownership by a `<project>-` prefix.** Rejected: it couldn't tell
  `acme` from a sibling project `acme-shop` (whose `acme-shop-media` a copied
  gq.ops.json might name) or `acme-fe` (whose production Worker `acme-fe-fe`
  looks like one of `acme`'s stages).
- **Note each change before making it.** Rejected: a change that failed would
  still be noted, so restore could re-enable a token the cut never disabled
  and someone had disabled since.
- **Write the record last**, once everything is cut. Rejected: a failure
  halfway would leave the Site half cut and unguarded until a rerun.
- **Delete every bucket gq.ops.json names.** Rejected: a backups bucket can
  hold every client's backups, and nothing in gq.ops.json says a bucket is
  this Site's alone but its name.
- **Archive the repository, then write the record.** Rejected: an archived
  repository takes no push, so the record would be left unpushable, and the
  operator would have to unarchive the repository, push, and archive it
  again.
- **Write the record through GitHub's contents API** rather than the
  checkout's git. Rejected: it would commit to the default branch whatever
  the checkout holds, overwrite a gq.ops.json changed on the remote since,
  and leave the checkout with the same change uncommitted and a branch
  behind its remote.
- **Push from whatever the checkout is.** Rejected: a push from another
  branch doesn't reach the default branch the record must be on, one with
  other changes or commits publishes what the operator hasn't decided to,
  and a forced push could drop a teammate's commits.
- **Make an Artifacts-only Site's repository read-only** for the cut.
  Rejected: Artifacts' API sets `read_only` only when a repository is
  created, forked or imported.
- **Push the record to the Artifacts repository** before the archive deletes
  it. Rejected: the repository is deleted in the same run, and `code.bundle`
  is read before the record changes.
- **Bundle an Artifacts-only Site's code from the operator's checkout.**
  Rejected: a checkout may lack branches, tags or commits the repository
  has; the repository itself is what gets deleted.
- **Give up on Ploi's 422 at once**, for a rerun to finish. Rejected: Ploi
  accepts the deletion once its background site deletion finishes, minutes
  later, so the run waits that long itself.

## Consequences

- The archive pushes from the operator's checkout: an up-to-date checkout
  of the default branch with nothing else changed archives the repository
  in one run; any other needs the record pushed by hand and a second run.
- An offboarded Site's gq.ops.json must be committed and pushed with its
  record, from the branch CI deploys: an uncommitted record guards only this
  checkout, and CI's release step reads the committed one. The guide says to
  cut from an up-to-date deploy branch, push straight away, then run
  `--dry-run` again and expect every line `✓`.
- A Site without a D1 publication store (no durable delivery) can't be
  archived: the store is one of the sources a new archive requires.
- Listing GitHub's hooks needs gh 2.48 or later (`gh api --slurp`).
- The Frontend's secrets stay in Sigillo: with every URL gone they reach
  nothing, and the archive keeps the Sigillo project.
- An archived Site is gone but for its archive, its archived repository and
  its Sigillo project; bringing it back is a new provisioning from those.
- The `offboarded-clients` bucket holds every former client's content; who
  can read it is decided there, once.
- `gq offboard` reaches Cloudflare, Ploi and GitHub, so its tests run at the
  `run()` seam against one in-memory account (`test/support/offboarding.mjs`),
  R2's S3 API included.

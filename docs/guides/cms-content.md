# Agent access to production CMS content

[Documentation](../README.md)

How an agent reads and changes a page's (or post's) raw block markup,
`post_content`, on a Site's production CMS once Cloudflare Access gates the
CMS ([gq-platform ADR 0011](https://github.com/Quick-Release/gq-platform/blob/main/docs/adr/0011-agent-access-to-production-cms-content.md)).
The sanctioned route is **REST with the Site's agent application password**,
behind Access. WP-CLI is [break-glass](#break-glass-wp-cli), through `gq` only.

The old route, logging in to `wp-login.php` with an admin's credentials and
calling REST with the cookie and a `wp_rest` nonce, is **retired**: Access
redirects `wp-login.php` and `/wp-json/*` before WordPress sees them, and
WordPress only accepts application passwords over REST. Don't use it or
record it in agent notes. (A person's own review in an authenticated
wp-admin browser, such as GQ Design's preview review in the
[manifest reference](../reference/manifest.md), is not an agent route and is
unchanged.)

## What a Site provides

Each Site sets these up for itself; this package provisions none of them.

- **An agent WordPress user**, used by agents only, with the Editor role,
  never Administrator. One per Site.
- **Its application password**, created with
  `wp user application-password create <user> <name> --porcelain` and piped
  straight into Sigillo, never echoed or passed as an argument.
- **For unattended work**, an Access application scoped to the content
  routes (`/wp-json/wp/v2/pages`, and `posts` if needed) with a **Service
  Auth** policy naming one single-purpose service token. Never `Any valid
service token`, Bypass or Everyone. Access can't filter by method, so a
  WAF rule (or the origin) limits those routes to GET and POST.
- **For interactive work**, a person whose Access policy covers those routes.

## Credentials

Sigillo holds them in the Site's **production** environment:

| Name                                | What it is                                                         |
| ----------------------------------- | ------------------------------------------------------------------ |
| `GQ_CMS_AGENT_USERNAME`             | The agent WordPress user's login                                   |
| `GQ_CMS_AGENT_APPLICATION_PASSWORD` | Its application password                                           |
| `GQ_CMS_AGENT_ACCESS_CLIENT_ID`     | The agent's Access service token: `CF-Access-Client-Id` (optional) |
| `GQ_CMS_AGENT_ACCESS_CLIENT_SECRET` | Its secret: `CF-Access-Client-Secret` (optional)                   |

They follow the same rules as the [other CMS pairs](cms-access.md): `gq` sends
them only to the exact HTTPS origin `domains.admin` names, and only to
`/wp-json/wp/v2/pages/<id>`, `/wp-json/wp/v2/posts/<id>`, their
`/revisions` and `/revisions/<id>`. Credentialed calls never follow a
redirect, and no error shows a value. Half a service-token pair fails, naming
only the names. The username can't contain `:`; neither value may contain a
line break or surrounding spaces, and the password is never trimmed (its
inner spaces are its own). These are distinct from the preview, GraphQL,
automation, form and `gq-design` MCP credentials: never reuse them for
another client, or another client's for this one.

Inject them per command with `gq sigillo run production -- …`. Never
`sigillo secrets download --force`, `--mount` or a bulk copy, and never put a
value in an argument, URL, file in the repository, issue or log.

### The edge credential

`gq content` picks one, in this order:

1. **The agent's service token**, when Sigillo injects the
   `GQ_CMS_AGENT_ACCESS_CLIENT_*` pair: unattended work.
2. **A person's `cloudflared` session**: after
   `cloudflared access login https://<domains.admin>`, `gq` reads
   `cloudflared access token -app=https://<domains.admin>` and sends it as
   `cf-access-token`. The token is never printed.
3. **None**, for a Site without Access. A redirect (to Access) then fails
   with what to run.

WordPress identity is always the application password in
`Authorization: Basic`, beside the edge headers. Keep the service token in
Access's two-header mode: single-header service auth would take the
`Authorization` header.

## The workflow

```sh
gq sigillo run production -- gq content get 12 --out home.json
# edit home.json: move, add or change blocks in the tree
gq sigillo run production -- gq content diff 12 --file home.json
gq db sync --yes                       # the local CMS has the live page
gq content validate 12 --file home.json
gq sigillo run production -- gq content put 12 --file home.json --yes
gq sigillo run staging -- gq frontend refresh --uri /
```

`--type post` works on a post instead of a page.

- **`get`** reads `GET /wp-json/wp/v2/<type>/<id>?context=edit` and writes
  `content.raw` as stored, byte for byte. To a `.json` file it writes the
  parsed block tree instead (the shape of PHP's `parse_blocks`:
  `blockName`, `attrs`, `innerBlocks`, `innerHTML`, `innerContent`), and
  refuses if that tree wouldn't serialize back to the same bytes. It
  remembers a hash of what it read. `--revision <id>` reads a revision
  instead (for a rollback).
- **Edit the tree, not the text.** Change `attrs`, move or remove entries of
  `innerBlocks`, and keep `innerContent` in step: it holds the HTML around
  inner blocks, with a `null` where each inner block goes, so a moved block
  takes its `null` (and the `"\n\n"` between blocks) with it. Never splice
  the markup as a string. Static blocks (`core/button`, `core/buttons`) are
  unsafe until validated; a block's inner HTML has to be what its `save()`
  writes.
- **`diff`** compares the file with what the CMS holds now: the block
  outline (names and attributes by depth), then the markup.
- **`validate`** writes the file to the same post in the Site's DDEV CMS
  (fed by `gq db sync`, on the same `composer.lock`), as a local Editor named
  `gq-content-check`, and opens it in the block editor in a headless Chrome.
  It fails if WordPress stored other bytes than given (KSES or a content
  filter changed them), if the editor marks any block invalid, or if a block
  type isn't registered. Blocks the editor accepts only through a
  deprecation pass, with a warning: the editor rewrites them on their next
  save. A pass is recorded for those exact bytes. It needs DDEV running,
  `apps/cms/.env` pointing at it, and Chrome or Chromium (`CHROMIUM` names
  one).
- **`put`** writes the file with one `POST /wp-json/wp/v2/<type>/<id>`. It
  refuses bytes without a passing `validate` (or after `composer.lock`
  changed), a post changed in the CMS since `get`, and, without a terminal,
  a write without `--yes`. Afterwards it checks that WordPress stored the
  bytes as given and that a new revision holds them, and names the revision
  to roll back to. `--without-validation` skips the validation check, loudly;
  use it only when validation can't run and a person has reviewed the diff.

A `.json` file is serialized before anything compares or sends it; the bytes
are what `validate` and `put` check.

### Rollback

The revision the previous write left is the rollback: REST has no revision
restore, so read it and write it back the same way.

```sh
gq sigillo run production -- gq content get 12 --revision 40 --out rollback.html
gq content validate 12 --file rollback.html
gq sigillo run production -- gq content put 12 --file rollback.html --yes
```

WordPress records no revision for a change of whitespace only, and `put`
then reports that no revision was recorded.

### Publication

Writing to the CMS doesn't publish to the Frontend. Refresh it with
`gq frontend refresh` (`--uri <path>` for the page; `put` prints it), and
check the live page in a browser, not by an HTTP 200.

## REST by hand

Until a Site pins a release with `gq content`, the same calls work with
`curl`. Headers go through stdin (`-H @-`) so no value lands in an argument
or the process list. A person's session:

```sh
cloudflared access login https://cms.example.com
gq sigillo run production -- sh -c '
  {
    printf "cf-access-token: %s\n" "$(cloudflared access token -app=https://cms.example.com)"
    printf "Authorization: Basic %s\n" "$(printf "%s:%s" "$GQ_CMS_AGENT_USERNAME" "$GQ_CMS_AGENT_APPLICATION_PASSWORD" | base64 | tr -d "\n")"
  } | curl -fsS --proto =https -H @- \
    "https://cms.example.com/wp-json/wp/v2/pages/12?context=edit&_fields=id,modified_gmt,content"
' | jq -r .content.raw > home.html
```

With the service token instead, replace the `cf-access-token` line with
`CF-Access-Client-Id` and `CF-Access-Client-Secret` lines from
`$GQ_CMS_AGENT_ACCESS_CLIENT_ID` and `$GQ_CMS_AGENT_ACCESS_CLIENT_SECRET`.

- **Read**: `GET /wp-json/wp/v2/pages/<id>?context=edit`; `content.raw` is the
  markup as stored (`content.rendered` is not).
- **Write**: `POST /wp-json/wp/v2/pages/<id>` with
  `Content-Type: application/json` and `{"content": "<markup>"}`, built with
  `jq -Rs '{content: .}' home.html` and sent with `--data-binary @-`.
- **Verify**: `GET /wp-json/wp/v2/pages/<id>/revisions?_fields=id,date_gmt`
  lists a new revision, newest first, and
  `GET …/revisions/<revision>?context=edit` holds the bytes written.

Never follow redirects (`curl` doesn't without `-L`): a redirect means the
edge didn't admit the request.

## Break-glass WP-CLI

Only when the REST route is unavailable, and only through `gq`:

```sh
gq sigillo run production -- gq wp -- post get 12 --field=post_content
gq sigillo run production -- gq wp --yes -- post update 12 home.html
```

`gq wp` never uses a hand-written SSH alias. The host is the Site's own:
`ploi.serverId`, `ploi.systemUser`, `ploi.projectRoot` and `domains.admin`
from `gq.ops.json`, or, without a system user there, the Ploi site serving
`domains.admin`. The command runs in `apps/cms` as a Ploi one-off script, as
that system user, like `gq db backup`'s export, so it needs `PLOI_API_TOKEN`
(and, for writes, the R2 credentials).

- **Allowed reads**: `core version`, `post get`, `post list`, `post meta get`,
  `post meta list`, `plugin list`, `theme list`.
- **Allowed writes**: `post update <id> <file>`, `post meta update`,
  `post meta delete`, `transient delete`, `cache flush`, `rewrite flush`. One
  object at a time, never `--all`.
- **Refused**: raw SQL and PHP (`db …`, `eval`, `eval-file`, `shell`), bulk
  or destructive commands (`search-replace`, `site empty`, `post delete` and
  other deletes), global options that change the target or run code
  (`--ssh`, `--http`, `--path`, `--url`, `--exec`, `--require`), and
  everything not listed.

A write is confirmed (`--yes` without a terminal), runs a `gq db backup`
first, and acts as a WordPress user: `--user=<login>`, else
`GQ_CMS_AGENT_USERNAME`, so WordPress authorizes and attributes it and KSES
treats it as that user. `post update <id> <file>` sends the local file
through a short-lived presigned R2 URL (a Ploi script holds at most 7,500
characters), then checks that WordPress stored the bytes as given and
recorded a new revision. It skips the block editor: validate the file with
`gq content validate` first.

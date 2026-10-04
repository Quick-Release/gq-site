# Commands

[Documentation](../README.md)

Commands below use the site's installed `gq` binary (for example, via
`pnpm exec gq`). An optional root `package.json` script makes `pnpm ops`
run it:

```json
{
  "scripts": {
    "ops": "gq"
  }
}
```

```sh
gq --version
gq context show [--json]
gq new <dir> --project <name> --variant content [--locale <locale>]
gq sync [--manifest] [--check] [--variant <content|commerce>] [--recreate <path>]...
gq skills update [--check]

gq setup [--no-ddev]
gq doctor
gq verify [--ci]

gq ploi servers list
gq ploi server show [--server <id>]
gq ploi sites list [--server <id>]
gq ploi site show [--server <id>] [--site <id>]
gq ploi api list [--group <group>] [--search <text>]
gq ploi api describe <operation-id>
gq ploi api <operation-id> [--path name=value] [--query name=value]
    [--page <n>] [--per-page <n>] [--data <json> | --data-file <file>]
    [--all] [--max-pages <n>] [--dry-run | --yes]
gq ploi provision [--dry-run | --yes]
gq ploi release [--ref <ref>] [--git-dir <dir>]
gq ploi media [--dry-run]
gq ploi events [--dry-run]

gq db sync [--yes]
gq db backup

gq cms start [--foreground] [ddev start arguments...]
gq cms status
gq cms stop | describe [ddev arguments...]
gq cms composer install | update | reinstall | test | lint | lint:fix [arguments...]
gq cms design [refresh]

gq cloudflare accounts list
gq cloudflare zones list [--account <id>]
gq cloudflare zone show [--zone <id>]
gq cloudflare dns list [--zone <id>] [--name <hostname>] [--type <type>]
gq cloudflare deploy-token [--dry-run]
gq cloudflare releases [--dry-run]
gq cloudflare media [--dry-run]
gq cloudflare ci [--dry-run]

gq media check [--upload | --local] [--json]
gq frontend secrets [--dry-run]
gq frontend refresh [--uri <path>]... [--url <frontend origin>] [--json]
gq frontend events check [--url <frontend origin>] [--json]
gq site check [--url <frontend origin>] [--json]
gq site check --local [--json]

gq offboard [--dry-run] [--yes]
gq offboard --restore [--dry-run] [--yes]
gq offboard --archive [--dry-run] [--yes]

gq ci deploy
gq ci runs
gq github setup [--dry-run]
gq git artifacts setup
gq git artifacts get | store | erase

gq sigillo run <environment> -- <command> [arguments...]
gq sigillo login
gq sigillo setup <environment>
gq sigillo secrets <environment> [arguments...]

gq version check [version]
gq version sync [version]
gq release prepare [version]
gq release tag [version]
gq release push <major|minor|fix>
```

`--json` prints machine-readable output; `ploi api` always prints the
provider's JSON. In a terminal, `gq` with no arguments opens a command picker.

`ploi api` covers all 225 operations in the Ploi API reference
([inventory](../research/ploi-api.md)); operation IDs follow the docs' routes,
such as `sites.log-site`. Every non-GET operation needs `--yes` (or a prompt in
a terminal); `--dry-run` prints the resolved request without sending it.
Everything `ploi api` prints (responses, `--dry-run` requests and the
confirmation prompt) has its credentials replaced with `"[redacted]"`, keeping
the JSON's shape: the strings and numbers under any field whose name has the
word token, password, secret, key or private (`api_key`, `privateKey`), and the
value of any URL query parameter whose name has the word token, key, secret or
signature, such as the `token` in a site's `deploy_webhook_url`. Booleans and
nulls stay. The other `ploi` and `cloudflare` commands print only selected,
non-secret fields.
The `cloudflare accounts|zones|zone|dns` commands are read-only.

`gq offboard` records `offboarded` in `gq.ops.json`, then cuts a Site's public
URLs and credentials, deleting nothing; it needs the managed deploy files as
`gq sync` writes them, the Ploi site running as `ploi.systemUser`, its `.env`
naming `ploi.database`, and gh 2.48 or later. `--restore` reverses what the cut recorded. Both print the
plan (`✓` done, `-` to cut or `+` to restore, `!` by hand) and need `--yes`
outside a terminal. While `offboarded` is set, every command that would expose
the Site again refuses: `cloudflare media|deploy-token|ci|releases`,
`github setup`, `ci deploy`, `ploi provision|events|media|release`, a
`ploi api` operation that writes (unless `--dry-run`), `release push|tag` and
`frontend refresh|secrets`. `--archive` (irreversible, only once `offboarded`
is recorded) archives the Site's content to
`r2://offboarded-clients/<project>/<UTC date>/`, reads it all back, and only
then deletes its Ploi site, Workers, D1 stores, buckets, its own backups,
Artifacts repository, its own DNS records and its tokens (only what is named
exactly as gq names the project's own), archives its GitHub repository, and
records `offboarded.phase: "archived"`; in a terminal it asks for the
project's name, elsewhere `--yes`. An Artifacts-only Site (no
`github.repository`) needs no gh: its cut disables its Artifacts token and
revokes the repository's git tokens instead of the webhook, and its archive
keeps its code as `code.bundle`, a git bundle of every ref. See
[Offboarding a Site](../guides/offboarding.md).
`gq skills update` works from any Git repository and is documented in the
[agent skills guide](../guides/skills.md).

See [release and version behavior](release.md), [local development](../guides/local-development.md),
[provisioning](../guides/provisioning.md), [offboarding](../guides/offboarding.md), and [secret injection](../guides/secrets.md)
for detailed command behavior.

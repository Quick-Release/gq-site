# Site manifest and environment

[Documentation](../README.md)

`gq` walks up from the current directory to the nearest `gq.ops.json`,
stopping at the enclosing Git repository, and treats that directory as the
site root. Every site-relative path resolves from there. `--project <dir>` or
`--config <file>` selects a site explicitly.

```json
{
  "$schema": "./node_modules/@getquick/site/schema/gq.ops.schema.json",
  "schemaVersion": 1,
  "project": "example-site",
  "variant": "content",
  "domains": { "admin": "example-site-cms.bnq.pt", "frontend": "example-site-fe.bnq.pt" },
  "ploi": { "serverId": "12345", "siteId": "67890" },
  "cloudflare": {
    "accountId": "0123456789abcdef0123456789abcdef",
    "zoneId": "abcdef0123456789abcdef0123456789",
    "zoneName": "example.com"
  },
  "github": { "repository": "Quick-Release/example-site" }
}
```

`gq.ops.json` is validated against schema v1 before any command runs
([ADR 0002](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0002-generate-sites-from-a-versioned-manifest.md)):
`schemaVersion`, `project` and `variant` (`content` or `commerce`) are
required, `domains` has the roles `admin` and `frontend` and an optional
`docs`, and an unknown or misspelt key fails by its path. The blocks each
command reads (`ploi`, `cloudflare`, `releases`, `media`, `backups`, `local`,
`artifacts`, `ci`, `github`, `sigillo`, `wordpress.plugins`,
`wordpress.locale`, `wordpress.languages`) are optional; a command names
the keys it needs. `artifacts.jurisdiction` is where `gq cloudflare ci`
creates the Artifacts namespace: `eu` (the default when it's left out),
`us`, or `unrestricted` to opt out; see
[Cloudflare provisioning and CI](../guides/provisioning.md#cloudflare-provisioning-and-ci). `wordpress.locale` is the site's main language as a
WordPress locale (`en_US`, `pt_PT`, `pt_PT_ao90`); see
[The site's language](../guides/sites.md#the-sites-language).
`wordpress.languages` lists a bilingual site's other languages, each a
`locale` and the `slug` of its URL directory; see
[More languages](../guides/sites.md#more-languages). `offboarded` (`at`, `phase`, and `cut`,
what the cut changed, which `--restore` brings back) is written by
`gq offboard` and turns on the guards of an
[offboarded Site](../guides/offboarding.md); `gq offboard --archive` adds
`offboarded.archive` (`bucket`, `prefix`, `manifestSha256`) once the archive
is verified. `$schema` points editors at the JSON
Schema generated from it ([schema/gq.ops.schema.json](../../schema/gq.ops.schema.json)).

A manifest without `schemaVersion` is v0, the shape before versioning. Every
command refuses it, and one newer than the installed `gq` reads, with the
step to take. `gq sync` migrates it:

```sh
gq sync --manifest --variant content   # v0 → v1, written back
gq sync --manifest --check             # report pending migrations, exit 1, write nothing
```

v0 never recorded the variant, so the v0 → v1 migration takes it from
`--variant` rather than guessing. It drops the keys of flows `gq` no longer
has (`credentials`, `github.environment`, `github.secrets`,
`github.variables`) and names each one. `gq sync` needs no network access
and no secrets.

Provider IDs are safe to commit; tokens are not. `gq` reads `PLOI_API_TOKEN`,
`CLOUDFLARE_API_TOKEN` and optional ID overrides (`PLOI_SERVER_ID`,
`PLOI_SITE_ID`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`,
`CLOUDFLARE_ZONE_NAME`) from, in increasing precedence:

1. `${XDG_CONFIG_HOME:-$HOME/.config}/gq/ops.env`
2. the site's `.env`
3. the process environment, which is where a secret manager such as Sigillo
   injects them per command
4. flags (`--server`, `--site`, `--account`, `--zone`)

## Related references

The [release and version reference](release.md) describes variant defaults
and the `release`, `verify` and `doctor` additions. Provider-specific settings
are documented with [provisioning](../guides/provisioning.md), and Sigillo
settings with [secrets](../guides/secrets.md). For managed-file ownership and
adoption, see [Generate and sync a site](../guides/sites.md).

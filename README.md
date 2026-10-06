# gq-site

Shared tooling for GETQUICK sites, published to public npm as
[`@getquick/site`](https://www.npmjs.com/package/@getquick/site): one `gq`
CLI, configured by each site's own `gq.ops.json`.

The blueprint generates and synchronizes managed files, provisions Ploi and
Cloudflare, runs local CMS and workspace checks, and handles releases,
database backups and live-to-local sync. Secrets are injected per command
through Sigillo; generation and sync need no network access or secrets.

## Quick start

For site setup, use the blueprint's Node pin (currently 24.21.0) and the pnpm
version in the site's `packageManager`. The CLI alone supports Node 22.12.0+;
that minimum is not enough for the site's full development toolchain. This
repository's contributor requirements are in [Development](docs/development.md).

### Generate a content site

```sh
pnpm dlx @getquick/site new acme --project acme --variant content
cd acme
# Activate the Node pin in .mise.toml or .nvmrc before installing.
pnpm install
pnpm exec gq sync --check
```

The target directory must be empty. `gq new` creates the CMS and Frontend
app skeletons and prints the provisioning steps without running them.
See [Generate and sync a site](docs/guides/sites.md) for ownership, adoption,
and handling sync conflicts, then [Local development](docs/guides/local-development.md)
or [Provisioning and deployment](docs/guides/provisioning.md).

### Use an existing site

Pin an exact version in the site's root `devDependencies`; no registry login
is needed:

```sh
pnpm add --save-dev --save-exact @getquick/site
pnpm exec gq --help
```

[Configure `gq.ops.json`](docs/reference/manifest.md) before running site
commands. A manifest without `schemaVersion`, or release settings in a
`shop-devtools.config.mjs`, is migrated by `gq sync --manifest`: see the
[manifest reference](docs/reference/manifest.md) and the
[release reference](docs/reference/release.md).

## Documentation

- **Site guides:** [Generate and sync](docs/guides/sites.md) ·
  [Local development](docs/guides/local-development.md) ·
  [Secrets](docs/guides/secrets.md) ·
  [Provisioning and deployment](docs/guides/provisioning.md) ·
  [Offboarding](docs/guides/offboarding.md) ·
  [Agent skills](docs/guides/skills.md)
- **Reference:** [Manifest and environment](docs/reference/manifest.md) ·
  [Commands](docs/reference/commands.md) ·
  [Release and version behavior](docs/reference/release.md) ·
  [Programmatic `run()` interface](docs/reference/programmatic-use.md)
- **Contributors:** [Development and publishing](docs/development.md)
- **Design and records:** [Documentation map](docs/README.md)

These guides and references ship with the npm package. The
[Ploi API inventory](docs/research/ploi-api.md) is a dated research snapshot,
not the current command reference.

## Current status

Phases 1–3 of the rollout (extraction, content-site generation, and adoption
by an existing content site) have passed. Managed-file changes originate here;
a site takes them by bumping its pin and running `gq sync`. Commerce-site generation is not supported;
commerce adoption and fleet rollout are gated work.
See the [rollout record](https://github.com/Quick-Release/gq-site/blob/main/docs/plans/getquick-blueprint-rollout.md#phases-and-gates)
for evidence and remaining gates, and
[ADR 0001](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0001-the-getquick-site-blueprint.md)
for the blueprint decision.

## License

[MIT](LICENSE)

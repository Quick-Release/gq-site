# Blueprint source map

This directory ships with `@getquick/site`. `gq new` and `gq sync` read its
sources; they do not copy the directory wholesale into a site. This map is
contributor documentation, not a generated site file.

[`ownership.json`](ownership.json) is authoritative: each entry maps a site
`path` to a blueprint `template` (relative to this directory), or a symlink
target. Source names are navigation aids, not ownership rules. Paths not listed
are site-owned and never touched.

[`packages.json`](packages.json) is the package catalogue for
`gq packages`: the GETQUICK Composer packages the blueprint knows, where each
is discovered and installed from, and its upgrade policy. It holds no version
constraints; those stay in `templates/apps/cms/composer.json`. See
[Blueprint packages](../docs/reference/packages.md).

## Whole-file sources and fragments

Most of `templates/` follows the site's directory layout. Keep `apps/`, `infra/`,
`deploy/`, `scripts/`, and `docs/` target-shaped so a site's file has a predictable
source home. Whole-file sources include both fully generated files and
create-once scaffolding; consult `ownership.json` to tell them apart.

Partial sources live in `templates/fragments/`:

| Source                        | Site target         | Role                                               |
| ----------------------------- | ------------------- | -------------------------------------------------- |
| `fragments/AGENTS.section.md` | `AGENTS.md`         | Generated section, including its begin/end markers |
| `fragments/gitignore.section` | `.gitignore`        | Generated section, including its begin/end markers |
| `fragments/package.keys.json` | Root `package.json` | Managed JSON leaf keys, not a complete package     |

These paths are relative to `templates/`. Fragments are used as shipped, without
`{{name}}` substitution. Fully generated and create-once whole-file sources are
rendered with site values.

`templates/package.initial.json` is separate: its rendered values seed a missing
root `package.json` before managed keys are applied. Those initial values are
site-owned thereafter; they are not reapplied to an existing package. Whole
app and infrastructure `package.json` sources retain their target-shaped names.

## Ownership categories

- **Fully generated:** the whole file or symlink is blueprint-owned and kept in
  sync, such as toolchain pins, Git hooks, and `infra/` files.
- **Generated sections:** only the text between the begin/end markers is managed;
  site content around it is preserved.
- **Managed keys:** only the JSON leaf keys supplied by the fragment are managed;
  other keys and their formatting are preserved.
- **Create-once:** scaffolding is written when absent, then site-owned. Deleting it
  does not restore it on the next sync unless `--recreate <path>` requests it.
  App skeleton files are created only while their app directory is absent;
  an existing app does not gain missing skeleton files unless explicitly recreated.

`gq.ops.json` is listed without a template: the CLI creates or migrates the
manifest, and the ownership machinery records its existence. The lock records
site paths and content hashes, not blueprint source paths, so renaming a source
does not require a site migration.

## Deliberate dotless names

Some sources omit a leading dot: `mise.toml`, `nvmrc`, `vite-hooks/`, app `ddev/`,
`env.example`, `gitignore`, and `gitkeep` map to dot-prefixed site paths.
They remain visible as blueprint assets rather than acting as this repository's
local configuration. The mapping in `ownership.json`, not a naming convention,
determines the generated path. `fragments/gitignore.section` follows the same
principle while making its partial role explicit.

For site workflows, see [Generate and sync a site](../docs/guides/sites.md).
The ownership decision remains in
[ADR 0002](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0002-generate-sites-from-a-versioned-manifest.md).

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
constraints; those stay in both CMS skeletons' `composer.json`
(`templates/apps/cms/` and `templates/commerce/apps/cms/`).
[`package-requirements.json`](package-requirements.json) records what each
pinned version requires of the other GETQUICK packages, from the registry, so
a test can check offline that the pins install together. See
[Blueprint packages](../docs/reference/packages.md).

An entry with `variants` applies only to sites of those variants (ADR 0017);
one without applies to both. Two entries may share a `path` when each names its
own variants, so a commerce site's file comes from its own template. Commerce
sources live under `templates/commerce/`, mirroring the site's layout as the
rest of `templates/` does.

## Whole-file sources and fragments

Most of `templates/` follows the site's directory layout. Keep `apps/`, `infra/`,
`deploy/`, `scripts/`, and `docs/` target-shaped so a site's file has a predictable
source home. Whole-file sources include both fully generated files and
create-once scaffolding; consult `ownership.json` to tell them apart.

Partial sources live in `templates/fragments/`:

| Source                                 | Site target                  | Role                                               |
| -------------------------------------- | ---------------------------- | -------------------------------------------------- |
| `fragments/AGENTS.section.md`          | `AGENTS.md`                  | Generated section, including its begin/end markers |
| `fragments/gitignore.section`          | `.gitignore`                 | Generated section, including its begin/end markers |
| `fragments/package.keys.json`          | Root `package.json`          | Managed JSON leaf keys, not a complete package     |
| `fragments/cms-composer.keys.json`     | `apps/cms/composer.json`     | The content pair's CMS pin (managed key)           |
| `fragments/frontend-package.keys.json` | `apps/frontend/package.json` | The content pair's Frontend pin (managed key)      |

These paths are relative to `templates/`. Fragments are used as shipped, without
`{{name}}` substitution. Fully generated and create-once whole-file sources are
rendered with site values.

`templates/package.initial.json` is separate: its rendered values seed a missing
root `package.json` before managed keys are applied. Those initial values are
site-owned thereafter; they are not reapplied to an existing package, except
that `gq sync --recreate package.json` adds the ones it lacks.

[`rate-limit-namespaces.json`](rate-limit-namespaces.json) is the fleet's
register of commerce Sites' rate-limit namespace IDs, by Cloudflare account,
and the IDs reserved for documentation; `gq doctor` checks a Site's against
it. See [Rate-limit namespaces](../docs/reference/rate-limit-namespaces.md). Whole
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

An entry marked `"contentRuntime": "package"` applies only to a Site whose
`gq.ops.json` says so: the content pair's pins and its `/gq` route adapters.
Elsewhere `gq sync` neither writes nor records it, so a Site generated before
keeps its copied runtime
([ADR 0020](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0020-wire-new-content-sites-to-the-gq-content-package-pair.md)).
The two pin fragments must name one version, which the skeletons'
`composer.json` and `package.json` start with too; a test holds them equal.
A managed key in a file created in the same run is written with that file.

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

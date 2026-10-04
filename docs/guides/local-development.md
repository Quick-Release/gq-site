# Local site development

[Documentation](../README.md)

## Workspace: setup, doctor and verify

The runners are shared; what they check is the site's.

- `setup` installs the workspace (`pnpm install --frozen-lockfile`), creates
  `apps/frontend/.env` and `apps/cms/.env` from their `.env.example` when
  missing, then starts DDEV and installs Composer through the site's
  `cms:dev:raw --foreground` and `cms:composer` scripts. `--no-ddev` stops
  after the `.env` files; without DDEV installed it stops there with a warning.
- `verify` runs the site's checks (the variant's defaults, then
  `verify.checks`; the list `release push` runs) in order, in the site root, on the terminal, stopping at the first failure
  with its exit code. A check is `{ cmd, args, cwd, env, requires }`;
  `requires` lists what it needs, `php` (Composer and
  `apps/cms/vendor`) or `ddev` (the project running), and defaults to `php`
  for a `composer` check. Locally a check whose requirement is missing is
  skipped and reported; `--ci` runs every check.
- `doctor` reports the running `@getquick/site` against the site's pin, Node
  against `package.json` `engines.node` and the `.mise.toml` (or `.nvmrc`)
  pin, pnpm against `packageManager`, git, the files each app must have
  (the variant's defaults plus `doctor.requiredFiles`,
  `{ "<app path>": ["<file>", …] }`),
  installed dependencies, a leftover Artifacts push URL (with
  `gq.ops.json` `artifacts`), the apps' `.env` files, Sigillo's project and
  login (with `sigillo`), the Artifacts namespace's jurisdiction against
  `artifacts.jurisdiction` (read with `ARTIFACTS_API_TOKEN` from the
  environment or Sigillo `staging`, and skipped without it), local media (`gq media check --local`) and the DDEV
  project named in `apps/cms/.ddev/config.yaml`. A missing tool, required
  file or `node_modules`, a Node below the minimum, R2 credentials in
  `apps/cms/.env`, or a namespace outside its jurisdiction fails it
  (exit 1); drift from a pin only warns.

## Local CMS (DDEV)

The `cms` commands run the site's Bedrock app in `apps/cms` with DDEV. Like
`gq sigillo run`, they parse their own arguments: what `gq` doesn't use goes
to DDEV or Composer as is.

- `cms start` returns at once: a detached `gq` worker starts DDEV, then points
  `apps/cms/.env` at it (database, URL, and the defaults `db sync` uses). The
  worker records its phase in `apps/cms/.local-plugins/ddev-start.json` and
  its output in `ddev-start.log`; a second `start` while one runs reuses it.
  `--foreground` does the same work and waits, failing with DDEV's exit code.
- `cms status` reports the last background startup (ready, failed with its
  message, cancelled, or still starting) and the log's path, and exits 1 when
  it failed or its worker died. `cms stop` cancels a pending startup before
  stopping DDEV. A started DDEV isn't a ready CMS: `gq site check --local`
  (`pnpm site:check:local`) also requires WordPress installed, WPGraphQL
  active with every field the Frontend reads (the GETQUICK plugins and theme
  add some), and uploads kept on disk, and says what to do for each
  ([provisioning](provisioning.md#a-new-content-site-end-to-end)).
- `cms composer` runs Composer in a running DDEV project (its PHP matches the
  server), else with the host Composer, else in DDEV started for it. `install`,
  `update` and `reinstall` always use the host Composer with
  `COMPOSER_AUTH` from `gq sigillo run`, since the registry login doesn't
  reach DDEV's container.
- A developer can point `gq-design` (`getquick/gq-design` in Composer) at a
  local checkout with an ignored `apps/cms/.local-plugins/config.json`
  (`{ "gqDesign": "/absolute/path" }`). The old `getquickDesign` key and
  `getquick-design.php` checkout still work; conflicting keys are refused.
  The checkout's entrypoint selects the plugin slug (`gq-design.php` selects
  `gq-design`). `cms start` symlinks it over the registry copy and writes local
  DDEV files that read-only bind-mount it and run `gq cms design` (relink) and
  `gq cms design refresh` (autoload) as hooks through the site's
  `node_modules/.bin/gq`.

  After renaming a checkout from `getquick-design` to its sibling `gq-design`,
  update either config key's path and run `gq cms design` or `gq cms start`.
  An exact dangling old link with a safe registry backup is migrated; live or
  unrelated links are refused. The old backup stays at
  `.local-plugins/getquick-design-release`, separate from `gq-design-release`:
  never rename a registry backup to the other package's slug. Generated old
  DDEV mount/hook files are replaced; custom files are refused. This also
  supports rolling the checkout back to the old name and entrypoint.

  Composer dependency changes restore ordinary registry directories for both
  slugs, retain fallback backups if Composer removes a package or fails, then
  relink and rebuild autoload under the same lock. CI never consults the
  override; with no active opt-in, source symlinks under either slug prevent
  dependency changes. This does not edit a site's Composer requirements,
  lockfile, or plugin activation list; migrate those separately.

  Hook files generated by an older tool are rewritten by the next
  `gq cms start`; until then a plain `ddev start` runs the old hooks.

For the variant defaults and manifest additions these runners use, see
[Release and version commands](../reference/release.md).

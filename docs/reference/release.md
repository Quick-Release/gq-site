# Release and version commands

[Documentation](../README.md)

The release commands, `verify` and `doctor` read their settings from
`gq.ops.json`: the blueprint's defaults for the site's `variant`, plus the
additions the site declares. Additions are appended to the defaults; a site
can't remove one. Every path is relative to the site root.

The `content` defaults:

- version file `VERSION` and changelog `CHANGELOG.md`, for every site;
- JSON files whose `version` follows `VERSION`: `package.json` and
  `apps/frontend/package.json`;
- release paths: `VERSION`, `CHANGELOG.md`, `README.md`, `package.json`,
  `pnpm-workspace.yaml`, `gq.ops.json`, `infra`, `deploy/ploi/admin.sh`,
  `AGENTS.md`, `apps/cms/.gitignore`, `apps/cms/composer.json`,
  `apps/cms/composer.lock` and `apps/frontend/package.json`;
- checks: `pnpm run check`, `lint`, `test`, `test:scripts`, `infra:check` and
  `ci:check`, then `composer --working-dir=apps/cms validate`, `run lint` and
  `run test` (each requiring `php`);
- required files: `apps/cms` `composer.json` and `.ddev/config.yaml`,
  `apps/frontend` `package.json` and `astro.config.mjs`.

`commerce` has no defaults, so a commerce site declares everything as
additions.

```json
{
  "release": {
    "jsonFiles": ["apps/docs/package.json"],
    "textFiles": [
      {
        "path": "apps/cms/web/app/themes/example-theme/style.css",
        "patterns": [
          { "regexp": "^Version: .+$", "flags": "m", "replacement": "Version: {version}" }
        ]
      }
    ],
    "paths": ["apps/cms/web/app/themes/example-theme/style.css"]
  },
  "verify": {
    "checks": [
      { "cmd": "pnpm", "args": ["run", "e2e"], "cwd": "apps/frontend", "requires": ["ddev"] }
    ]
  },
  "doctor": { "requiredFiles": { "apps/frontend": ["tsconfig.json"] } }
}
```

A text file's pattern is a regular expression (`regexp`, optional `flags`)
whose match is replaced by `replacement`, where `{version}` stands for the
version.

- `version check` fails, listing each file, when any of them doesn't carry
  `VERSION` or the given version.
- `version sync` writes `VERSION` (or the given version) into every file.
- `release prepare` also writes the version to the version file first.
- `release tag` checks the version and a clean tree, then creates an
  annotated `v<version>` tag.
- `release push` first refuses to run unless HEAD is on the default branch
  (`origin/HEAD`, or `main` when the remote doesn't name one), naming the
  branch it found, before it bumps, commits or tags anything: a release pushed
  from a feature branch would leave its commit off the default branch while CI
  deploys its tag. Merge the branch, switch to the default branch, and run it
  there. It then bumps the version (`fix` and `patch` bump the third number),
  syncs it, adds the commits since the last `v*` tag to the changelog, runs
  the checks, commits the release paths, tags, and pushes the branch and the
  tag. Command output streams through as it runs. Nothing deploys from here:
  Cloudflare CI deploys the pushed `v*` tag.

A site that keeps these settings in a `shop-devtools.config.mjs` module
migrates them with `gq sync --manifest`, which folds the module into `gq.ops.json`, keeping only what
differs from the variant's defaults, and removes it. It names each default the
module left out (gq adds it) and each check it moves after the defaults,
and refuses settings `gq.ops.json` can't express: another version file or
changelog, `composer`, `deploys` and `docsChangelogPath`. While the module
exists, the release commands and `verify` refuse to run, and `doctor` fails.

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

`commerce` has content's defaults, with the Frontend's `pnpm run build`
after `test`, and requires `apps/frontend` `vite.config.ts` instead of
`astro.config.mjs` (ADR 0017).

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

- `release package <composer-package>` redeploys the CMS with one Composer
  package updated. From a clean tree it runs `composer update <package>` in
  `apps/cms` with the host Composer and the registry login (as
  `gq cms composer update` does), syncs and checks the current `VERSION`
  (as `release prepare` does, without a bump), commits the changed tracked
  files (`Update <package> to <version>`, naming the commit of a `dev-*`
  version), and deploys that commit with `gq ploi release --ref HEAD`. When
  the lock doesn't change it deploys HEAD as it is. It doesn't tag, push or
  run the checks: push the commit afterwards. The package must be in
  `apps/cms/composer.json`'s `require`. Run it under the `staging`
  environment, which holds `COMPOSER_AUTH`, the Ploi token and the releases
  R2 key: `pnpm release:package getquick/gq-design`. `staging` names the
  secrets, not the target: it deploys the one Ploi site `gq.ops.json` names,
  production included.

  Guarded preparation, with any of these options:

  | Option                      | Effect                                                                                                                                                                      |
  | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `--to <version>`            | Locks exactly `<version>`. `composer.json` stays as it is, so its requirement must already admit `<version>`; otherwise it refuses.                                         |
  | `--pin`                     | With `--to`: also sets the package's requirement to exactly `<version>`, the only change it makes to `composer.json`.                                                       |
  | `--expect-before <version>` | Refuses, before Composer runs, unless the lock holds `<version>` now.                                                                                                       |
  | `--release-id <id>`         | For a guarded package (required there): the approved release whose record the approval lookup returns.                                                                      |
  | `--reference <ref>`         | Refuses unless every reference the lock records for the package after the update is `<ref>`. Refused for a guarded package, whose reference comes from its approval record. |
  | `--no-deploy`               | Commits without deploying: nothing is uploaded and no provider is called.                                                                                                   |
  | `--composer-only`           | Deploys the commit Composer-only (see `gq ploi release --composer-only`).                                                                                                   |

  Guarded preparation runs `composer update <package> --no-interaction
--no-install`, with `--with <package>:<version>` for `--to`: Composer's
  temporary constraint, so the lock gets exactly that version even when the
  requirement (`^0.1.3`, `*`) admits newer ones. A range never lets Composer
  pick the registry's latest. It never runs `--with-dependencies`, so a
  version that needs other packages changed fails in Composer. It refuses
  when the update adds, removes or changes any other `packages` or
  `packages-dev` entry, changes any other top-level lock field (aliases,
  platform, stability flags, minimum-stability, plugin-api-version), changes
  `content-hash` (with `--pin`: to anything but the hash Composer computes for
  the pinned `composer.json`, which gq computes after reproducing the lock's
  current one), leaves the package at another version or reference, or
  changes any other file (`composer.json` included, unless `--pin`). It stages
  and commits exactly the files it may change, checking the index. Any
  failure up to the commit puts back `composer.json`, `composer.lock` (and a
  guarded package's expectations), undoes its own staging, and names anything
  else that changed without touching it. The host Composer must support
  `update --with` (Composer 2).
  A package in `gq.ops.json`
  `deployment.guardedPackages` is only prepared with `--to` and
  `--release-id`, from a fresh `prepare` approval record looked up before
  Composer runs, and only from the commit the record's published tag points
  to; its expectation in `deploy/ploi/package-expectations.json` is committed
  with the lock (see [Package expectations](package-expectations.md)).

`gq ploi release --composer-only` passes the deploy variable `composer_only`,
which the deploy script reads as `COMPOSER_ONLY=true`: after the guarded
package checks it can make before anything changes, and replacing the
shipped code, it runs `composer install`, restores shipped plugins and
themes, applies the dependency patch, verifies any
[package expectations](package-expectations.md) and reloads PHP-FPM, then
stops: no maintenance mode, no WP-CLI, no plugin activation and no database
update. Before this option, only the deploy script understood
`COMPOSER_ONLY`; no gq command could set it.

A site's `apps/cms/composer.json` and `composer.lock` are its own: no release
command rewrites a requirement, and none rejects a lock that pins a branch
commit. See [branch requirements](packages.md#a-site-on-a-branch).

A site that keeps these settings in a `shop-devtools.config.mjs` module
migrates them with `gq sync --manifest`, which folds the module into `gq.ops.json`, keeping only what
differs from the variant's defaults, and removes it. It names each default the
module left out (gq adds it) and each check it moves after the defaults,
and refuses settings `gq.ops.json` can't express: another version file or
changelog, `composer`, `deploys` and `docsChangelogPath`. While the module
exists, the release commands and `verify` refuse to run, and `doctor` fails.

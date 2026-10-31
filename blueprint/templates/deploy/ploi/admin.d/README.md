# CMS deploy extensions

The site's own steps in the CMS deploy. `deploy/ploi/admin.sh` is generated
by `gq` from `gq.ops.json` and rewritten by `gq sync`, so don't edit it: put a
step it lacks here instead, such as retiring an old plugin, activating the
site's theme or a one-off data migration. This directory is the site's;
`gq sync` never changes it.

- Every `*.sh` file here is an extension. Each runs with `bash` from
  `apps/cms`, in lexical (byte) order of file name (use a numeric prefix:
  `10-theme.sh`, `20-retire-contact.sh`), after the plugins in
  `wordpress.plugins` are activated and the database is updated
  (`wp core update-db`), before the rewrite rules are flushed, while the site
  is in maintenance mode. Start one with `set -euo pipefail`.
- `SITE_PATH` (the site root) and `APP_PATH` (`apps/cms`) are set, and `wp`
  is on `PATH`.
- An extension that exits non-zero fails the deploy with its exit code; the
  ones after it don't run.
- Extensions run only once WordPress is installed, and not on a
  Composer-only deploy.
- They ship with the release (`deploy/ploi`), so a change takes effect with
  the next `gq ploi release`.

Activating a plugin needs no extension: add it to `wordpress.plugins` in
`gq.ops.json` and run `gq sync`. Nor do pretty permalinks: after the
extensions, the deploy sets `/%postname%/` when the site has plain ones. An
extension that sets another structure keeps it.

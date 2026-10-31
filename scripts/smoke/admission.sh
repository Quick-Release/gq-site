#!/usr/bin/env bash
#
# A guarded Site's deploy, with its request admission, on a real stack: the
# generated deploy/ploi/admin.sh and admission.sh, run verbatim by a `ploi`
# user in a disposable Docker container (admission/Dockerfile) with real
# nginx over TLS (a throwaway CA), real PHP-FPM (opcache.validate_timestamps=0,
# two pools of one PHP version), real rsync, real Composer and real WP-CLI on
# the WordPress the CMS skeleton pins (SQLite). admission/stack.sh holds the
# checks; see docs/reference/package-expectations.md#checked-on-a-real-stack.
#
# Stand-ins, and only these:
#   - transport: the release archive is a local file (ARCHIVE_URL=file://…),
#     not R2, and the deploy runs as Ploi would run it, without Ploi;
#   - registry: the GETQUICK packages (gq-support, the theme, gq-config) are
#     small local Composer path packages with those names, not the private
#     registry's (COMPOSER_AUTH is a placeholder); WordPress and the Bedrock
#     packages come from Packagist;
#   - the release's apps/cms is the generated one with that composer.json, a
#     no-op scripts/patch-dependencies.php (the patched wpgraphql-blocks
#     isn't installed), the SQLite drop-in, a must-use marker and a slow
#     script (the checks' instruments);
#   - PACKAGE_EXPECTATIONS is rendered by gq's own renderServerExpectations
#     for the local gq-support, without an approval service.
# The server's nginx and PHP-FPM configuration is the smoke's own, written
# by stack.sh: it isn't Ploi's production template, which stays unverified.
#
# Needs docker and node (with this checkout's dependencies installed).
# Downloads (Ubuntu packages, Packagist packages, WP-CLI, the SQLite
# integration) use the network; nothing is provisioned or deployed anywhere.

set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
image="gq-admission-smoke"
version=$(sed -n 's/.*"roots\/wordpress": "\([0-9.]*\)".*/\1/p' "$repo/blueprint/templates/apps/cms/composer.json")

parent=$(mktemp -d "${TMPDIR:-/tmp}/gq-admission.XXXXXX")
container=""
cleanup() {
  if [ -n "$container" ]; then
    # The container wrote files as root into the shared directory.
    docker exec "$container" chown -R "$(id -u):$(id -g)" /work >/dev/null 2>&1 || true
    docker rm -f "$container" >/dev/null 2>&1 || true
  fi
  rm -rf "$parent"
}
trap cleanup EXIT

work="$parent/work"
mkdir -p "$work/packages" "$work/releases" "$work/archives"
chmod 0755 "$parent" "$work"

# The generated guarded Site.
cd "$parent"
node "$repo/bin/gq.mjs" new acme --project acme --variant content >/dev/null
node -e '
const { readFileSync, writeFileSync } = require("node:fs");
const path = process.argv[1];
const ops = JSON.parse(readFileSync(path, "utf8"));
ops.domains = { ...ops.domains, admin: "cms.acme.test", frontend: "www.acme.test" };
ops.wordpress = { ...ops.wordpress, plugins: ["gq-support"], locale: "en_US" };
ops.deployment = {
  protected: true,
  state: "authorized",
  guardedPackages: ["getquick/gq-support"],
  approval: { stage: "prod", slot: "acme/production" },
};
writeFileSync(path, JSON.stringify(ops, null, 2) + "\n");
' "$parent/acme/gq.ops.json"
(cd "$parent/acme" && node "$repo/bin/gq.mjs" sync >/dev/null)
grep -qx 'ADMIN_HOST="cms.acme.test"' "$parent/acme/deploy/ploi/admission.sh"
grep -qx 'GUARDED_PACKAGES="getquick/gq-support"' "$parent/acme/deploy/ploi/admin.sh"

# Local Composer path packages standing in for the private registry's.
package() {
  local dir="$work/packages/$1" json="$2"
  mkdir -p "$dir"
  printf '%s\n' "$json" >"$dir/composer.json"
}
package gq-support '{"name": "getquick/gq-support", "version": "0.1.11", "type": "wordpress-plugin"}'
cat >"$work/packages/gq-support/gq-support.php" <<'PHP'
<?php
/**
 * Plugin Name: GQ Support (smoke stand-in)
 */
if (!defined('ABSPATH')) {
    file_put_contents('/home/ploi/plugin-ran', sprintf("%.6f gq-support\n", microtime(true)), FILE_APPEND);
    echo "gq-support ran directly\n";
}
PHP
mkdir -p "$work/packages/gq-support/src"
echo '<?php // gq-support code' >"$work/packages/gq-support/src/support.php"
package getquick-theme '{"name": "getquick/getquick-theme", "version": "0.6.1", "type": "wordpress-theme"}'
printf '/*\nTheme Name: GETQUICK Theme (smoke stand-in)\n*/\n' >"$work/packages/getquick-theme/style.css"
echo '<?php // theme' >"$work/packages/getquick-theme/index.php"
echo '<?php // theme functions' >"$work/packages/getquick-theme/functions.php"
package gq-config '{"name": "getquick/gq-config", "version": "0.4.3", "type": "wordpress-muplugin"}'
printf '<?php\n/* Plugin Name: GQ Config (smoke stand-in) */\ndefine('"'"'GETQUICK_CONFIG_VERSION'"'"', '"'"'0.4.3'"'"');\n' \
  >"$work/packages/gq-config/gq-config.php"
# A package that ships a .user.ini emptying auto_prepend_file, installed by
# Composer during a held deploy.
package sneaky '{"name": "acme/sneaky", "version": "1.0.0", "type": "wordpress-plugin"}'
printf 'auto_prepend_file =\n' >"$work/packages/sneaky/.user.ini"
cat >"$work/packages/sneaky/sneaky.php" <<'PHP'
<?php
/**
 * Plugin Name: Sneaky (smoke)
 */
if (!defined('ABSPATH')) {
    file_put_contents('/home/ploi/plugin-ran', sprintf("%.6f sneaky\n", microtime(true)), FILE_APPEND);
    echo 'sneaky ran; prepend=', ini_get('auto_prepend_file'), "\n";
}
PHP

# A package that ships a .user.ini restricting open_basedir to the gate and
# the web root (the gate still loads; the admission state can't be read),
# and a directory whose .user.ini starves memory.
package basedir '{"name": "acme/basedir", "version": "1.0.0", "type": "wordpress-plugin"}'
printf 'open_basedir = "/home/ploi/cms.acme.test/.gq/admission.php:/home/ploi/cms.acme.test/apps/cms/web/"\n' \
  >"$work/packages/basedir/.user.ini"
cat >"$work/packages/basedir/basedir.php" <<'PHP'
<?php
/**
 * Plugin Name: Basedir (smoke)
 */
if (!defined('ABSPATH')) {
    @file_put_contents('/home/ploi/plugin-ran', sprintf("%.6f basedir\n", microtime(true)), FILE_APPEND);
    header('X-GQ-Smoke-Ran: basedir');
    echo "basedir ran\n";
}
PHP
mkdir -p "$work/packages/basedir/lowmem"
printf 'memory_limit = 1M\n' >"$work/packages/basedir/lowmem/.user.ini"
cat >"$work/packages/basedir/lowmem/lowmem.php" <<'PHP'
<?php
@file_put_contents('/home/ploi/plugin-ran', sprintf("%.6f lowmem\n", microtime(true)), FILE_APPEND);
header('X-GQ-Smoke-Ran: lowmem');
echo "lowmem ran\n";
PHP

# Releases: the generated apps/cms and deploy/ploi, with the stand-ins.
release() {
  local name="$1" extra="$2" dir="$work/releases/$1"
  mkdir -p "$dir/deploy"
  cp -R "$parent/acme/apps/cms" "$dir/apps-cms"
  mkdir -p "$dir/apps"
  mv "$dir/apps-cms" "$dir/apps/cms"
  cp -R "$parent/acme/deploy/ploi" "$dir/deploy/ploi"
  cat >"$dir/apps/cms/composer.json" <<JSON
{
  "name": "getquick/acme-cms",
  "type": "project",
  "repositories": [
    { "type": "path", "url": "/work/packages/gq-support", "options": { "symlink": false } },
    { "type": "path", "url": "/work/packages/getquick-theme", "options": { "symlink": false } },
    { "type": "path", "url": "/work/packages/gq-config", "options": { "symlink": false } },
    { "type": "path", "url": "/work/packages/sneaky", "options": { "symlink": false } },
    { "type": "path", "url": "/work/packages/basedir", "options": { "symlink": false } }
  ],
  "require": {
    "composer/installers": "^2.0",
    "getquick/gq-config": "0.4.3",
    "getquick/getquick-theme": "0.6.1",
    "getquick/gq-support": "0.1.11",
    "oscarotero/env": "^2.0",
    "roots/bedrock-autoloader": "1.1.0",
    "roots/wordpress": "$version",
    "roots/wp-config": "^1.0",
    "vlucas/phpdotenv": "^5.0"$extra
  },
  "config": {
    "allow-plugins": { "composer/installers": true, "roots/wordpress-core-installer": true },
    "sort-packages": true
  },
  "extra": {
    "installer-paths": {
      "web/app/mu-plugins/{\$name}/": ["type:wordpress-muplugin"],
      "web/app/plugins/{\$name}/": ["type:wordpress-plugin"],
      "web/app/themes/{\$name}/": ["type:wordpress-theme"]
    },
    "wordpress-install-dir": "web/wp"
  }
}
JSON
  printf '<?php\n// Smoke stand-in: the patched wpgraphql-blocks is not installed.\n' \
    >"$dir/apps/cms/scripts/patch-dependencies.php"
  # A must-use marker noting every web request WordPress runs.
  cat >"$dir/apps/cms/web/app/mu-plugins/gq-marker.php" <<'PHP'
<?php
if (PHP_SAPI !== 'cli') {
    file_put_contents('/home/ploi/wordpress-ran', sprintf("%.6f %s\n", microtime(true), $_SERVER['REQUEST_URI'] ?? ''), FILE_APPEND);
}
PHP
  # A slow script, for a request that starts before a hold.
  cat >"$dir/apps/cms/web/slow.php" <<'PHP'
<?php
usleep((int) ($_GET['ms'] ?? 6000) * 1000);
file_put_contents('/home/ploi/slow-' . preg_replace('/[^a-z0-9]/', '', $_GET['tag'] ?? 'x'), sprintf("%.6f\n", microtime(true)));
echo "slow done\n";
PHP
  printf 'version=1.0.%s\ncommit=%040d\nref=v1.0.%s\n' "${#name}" 0 "${#name}" >"$dir/RELEASE"
}
release r1 ""
release r2 ',
    "acme/basedir": "1.0.0",
    "acme/sneaky": "1.0.0"'
release r3 ',
    "acme/basedir": "1.0.0",
    "acme/sneaky": "1.0.0"'
printf '#!/usr/bin/env bash\necho "late extension fails"\nexit 4\n' \
  >"$work/releases/r3/deploy/ploi/admin.d/20-late-failure.sh"

docker build -q -t "$image" "$repo/scripts/smoke/admission" >/dev/null
container=$(docker run -d -e WORDPRESS_VERSION="$version" \
  -v "$work:/work" -v "$repo/scripts/smoke/admission/stack.sh:/stack.sh:ro" \
  "$image" sleep infinity)

# Locks (Composer resolving against Packagist and the path packages), then
# the expectations gq would write for the local gq-support.
docker exec "$container" bash /stack.sh fixtures
for name in r1 r2; do
  node --input-type=module - "$repo" "$work" "$name" <<'NODE'
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
const [repo, work, name] = process.argv.slice(2);
const { filesDigest, renderServerExpectations } = await import(
  join(repo, "src/ploi/package-expectations.mjs")
);
const root = join(work, "packages/gq-support");
const files = {};
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else files[relative(root, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
};
walk(root);
const release = join(work, "releases", name);
const lock = readFileSync(join(release, "apps/cms/composer.lock"), "utf8");
const support = {
  name: "getquick/gq-support",
  version: "0.1.11",
  installPath: "web/app/plugins/gq-support",
  files,
  filesDigest: filesDigest(files),
};
writeFileSync(join(release, "PACKAGE_EXPECTATIONS"), renderServerExpectations([support], lock));
NODE
done
cp "$work/releases/r2/apps/cms/composer.lock" "$work/releases/r3/apps/cms/composer.lock"
cp "$work/releases/r2/PACKAGE_EXPECTATIONS" "$work/releases/r3/PACKAGE_EXPECTATIONS"

docker exec "$container" bash /stack.sh run

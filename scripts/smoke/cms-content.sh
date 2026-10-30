#!/usr/bin/env bash
#
# The agent's content route on a real WordPress (gq-platform ADR 0011):
# generates a disposable content site from this checkout's blueprint, sets up
# a real WordPress (the version the CMS skeleton pins, on SQLite, with
# WP-CLI) with the site's own content-api.php as a must-use plugin and an
# Editor agent user with an application password, then runs cms-content.mjs:
# gq content get, diff and put over REST, the block editor's validation in a
# headless Chrome, and gq wp's break-glass `post update` script.
#
# Generation stays offline and secret-free; only the downloads (WordPress,
# its SQLite integration and WP-CLI, cached in GQ_SMOKE_CACHE) use the
# network. Nothing is provisioned or deployed. The site is deleted afterwards
# unless KEEP=1. Needs php, unzip, curl and Chrome or Chromium (CHROMIUM).

set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
cache="${GQ_SMOKE_CACHE:-${TMPDIR:-/tmp}/gq-smoke-cache}"
version=$(sed -n 's/.*"roots\/wordpress": "\([0-9.]*\)".*/\1/p' "$repo/blueprint/templates/apps/cms/composer.json")
mkdir -p "$cache"

fetch() {
  [[ -s "$cache/$1" ]] || curl -fsSL -o "$cache/$1" "$2"
}
fetch wp-cli.phar https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar
fetch "wordpress-$version.zip" "https://wordpress.org/wordpress-$version.zip"
fetch sqlite-database-integration.zip \
  https://downloads.wordpress.org/plugin/sqlite-database-integration.latest-stable.zip

parent=$(mktemp -d "${TMPDIR:-/tmp}/gq-cms-content.XXXXXX")
if [[ "${KEEP:-}" == 1 ]]; then
  echo "Keeping the site in $parent/acme"
else
  trap 'rm -rf "$parent"' EXIT
fi

cd "$parent"
node "$repo/bin/gq.mjs" new acme --project acme --variant content >/dev/null

WORDPRESS_VERSION="$version" node "$repo/scripts/smoke/cms-content.mjs" "$parent/acme" "$cache"

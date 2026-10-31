#!/usr/bin/env bash
#
# A guarded Site's deploy quarantine on a real WordPress: generates a
# disposable content site guarding a package from this checkout's blueprint,
# takes the .maintenance file its generated deploy script writes, and runs
# quarantine.mjs against a real WordPress (the version the CMS skeleton pins,
# on SQLite, with WP-CLI) served by PHP's built-in server: every web request
# answers 503, WordPress core's fatal-error scrape exception included, while
# WP-CLI keeps working; WordPress's own .maintenance, for contrast, lets that
# scrape request through.
#
# Generation stays offline and secret-free; only the downloads (WordPress,
# its SQLite integration and WP-CLI, cached in GQ_SMOKE_CACHE) use the
# network. Nothing is provisioned or deployed. Needs php and unzip.

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

parent=$(mktemp -d "${TMPDIR:-/tmp}/gq-quarantine.XXXXXX")
trap 'rm -rf "$parent"' EXIT

cd "$parent"
node "$repo/bin/gq.mjs" new acme --project acme --variant content >/dev/null
node -e '
const { readFileSync, writeFileSync } = require("node:fs");
const path = process.argv[1];
const ops = JSON.parse(readFileSync(path, "utf8"));
ops.deployment = {
  protected: true,
  state: "authorized",
  guardedPackages: ["getquick/gq-support"],
  approval: { stage: "prod", slot: "acme/production" },
};
writeFileSync(path, JSON.stringify(ops, null, 2) + "\n");
' "$parent/acme/gq.ops.json"
(cd "$parent/acme" && node "$repo/bin/gq.mjs" sync >/dev/null)

WORDPRESS_VERSION="$version" node "$repo/scripts/smoke/quarantine.mjs" "$parent/acme" "$cache"

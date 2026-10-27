#!/usr/bin/env bash
#
# The publication events' real-CMS proof: generates a disposable content site
# from this checkout's blueprint, installs its Frontend's and its CI Worker's
# npm dependencies (the latter for Wrangler's local workerd runtime), sets up a
# real WordPress (the version the CMS skeleton pins, on SQLite, with WP-CLI)
# carrying the site's own event and delivery-retry mu-plugins and the public
# WPGraphQL plugin (for gq site check's CMS readiness), then runs
# cms-events.mjs: WordPress publishes through its real hooks, and the Frontend
# built by Alchemy's Astro Cloudflare build, served in workerd with a local D1
# publication store, receives the signed events.
#
# The site installs @getquick/site from this checkout, not npm
# (this-checkout.sh). Generation stays offline and secret-free; only the
# downloads (npm packages, WordPress, its SQLite integration, WPGraphQL and
# WP-CLI, cached in GQ_SMOKE_CACHE) use the network. Nothing is provisioned or deployed: no Cloudflare account,
# token, remote resource or live CMS is used. The site is deleted afterwards
# unless KEEP=1. Needs php and unzip. The real-cron check runs only when
# Docker has the image GQ_SMOKE_CRON_IMAGE (default ddev/ddev-webserver:v1.25.4,
# which DDEV installs) locally; it is never pulled.

set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
source "$repo/scripts/smoke/this-checkout.sh"
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
fetch wp-graphql.zip https://downloads.wordpress.org/plugin/wp-graphql.latest-stable.zip

parent=$(mktemp -d "${TMPDIR:-/tmp}/gq-cms-events.XXXXXX")
if [[ "${KEEP:-}" == 1 ]]; then
  echo "Keeping the site in $parent/acme"
else
  trap 'rm -rf "$parent"' EXIT
fi

cd "$parent"
node "$repo/bin/gq.mjs" new acme --project acme --variant content --framework astro >/dev/null
use_this_checkout "$repo" "$parent/acme"
cd acme
CI=1 pnpm install --filter @acme/frontend... --filter @acme/ci... --filter . >/dev/null

WORDPRESS_VERSION="$version" node "$repo/scripts/smoke/cms-events.mjs" "$parent/acme" "$cache"

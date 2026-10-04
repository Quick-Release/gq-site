#!/usr/bin/env bash
#
# A bilingual Site's real-CMS proof: generates a disposable content site from
# this checkout's blueprint with wordpress.locale pt_PT_ao90 and
# wordpress.languages English under /en/, sets up a real WordPress (the
# version the CMS skeleton pins, on SQLite, with WP-CLI) with WPGraphQL,
# Polylang and GQ Polylang for WPGraphQL, then runs cms-polylang.mjs: the
# deploy's Polylang configuration (the generated deploy/ploi/polylang.sh,
# with the languages the generated admin.sh passes it) on an existing
# monolingual Site, then GraphQL over HTTP as the Frontend reads it, then
# the events the site's publication-events.php and settings-events.php send
# as each language is edited.
#
# Generation stays offline and secret-free; only the downloads (WordPress,
# its SQLite integration, WPGraphQL, Polylang, GQ Polylang for WPGraphQL and
# WP-CLI, cached in GQ_SMOKE_CACHE) use the network. Polylang Pro is private,
# so the proof runs on the free plugin, which GQ Polylang for WPGraphQL's own
# tests cover beside Pro. Nothing is provisioned or deployed. The site is
# deleted afterwards unless KEEP=1. Needs php and unzip.

set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
cache="${GQ_SMOKE_CACHE:-${TMPDIR:-/tmp}/gq-smoke-cache}"
version=$(sed -n 's/.*"roots\/wordpress": "\([0-9.]*\)".*/\1/p' "$repo/blueprint/templates/apps/cms/composer.json")
polylang_graphql=0.1.0
mkdir -p "$cache"

fetch() {
  [[ -s "$cache/$1" ]] || curl -fsSL -o "$cache/$1" "$2"
}
fetch wp-cli.phar https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar
fetch "wordpress-$version.zip" "https://wordpress.org/wordpress-$version.zip"
fetch sqlite-database-integration.zip \
  https://downloads.wordpress.org/plugin/sqlite-database-integration.latest-stable.zip
fetch wp-graphql.zip https://downloads.wordpress.org/plugin/wp-graphql.latest-stable.zip
fetch polylang.zip https://downloads.wordpress.org/plugin/polylang.latest-stable.zip
fetch "gq-polylang-graphql-$polylang_graphql.zip" \
  "https://github.com/Quick-Release/gq-polylang-graphql/releases/download/v$polylang_graphql/gq-polylang-graphql-$polylang_graphql.zip"

parent=$(mktemp -d "${TMPDIR:-/tmp}/gq-cms-polylang.XXXXXX")
if [[ "${KEEP:-}" == 1 ]]; then
  echo "Keeping the site in $parent/acme"
else
  trap 'rm -rf "$parent"' EXIT
fi

cd "$parent"
node "$repo/bin/gq.mjs" new acme --project acme --variant content --locale pt_PT_ao90 >/dev/null
cd acme
# shellcheck disable=SC2016 # JavaScript, not shell
node -e '
  const fs = require("node:fs");
  const ops = JSON.parse(fs.readFileSync("gq.ops.json", "utf8"));
  ops.wordpress.plugins.push("polylang", "gq-polylang-graphql");
  ops.wordpress.languages = [{ locale: "en_US", slug: "en" }];
  fs.writeFileSync("gq.ops.json", `${JSON.stringify(ops, null, 2)}\n`);
'
node "$repo/bin/gq.mjs" sync >/dev/null

WORDPRESS_VERSION="$version" POLYLANG_GRAPHQL_VERSION="$polylang_graphql" \
  node "$repo/scripts/smoke/cms-polylang.mjs" "$parent/acme" "$cache"

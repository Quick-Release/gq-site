#!/usr/bin/env bash
#
# Generates a disposable content site from this checkout's blueprint, installs
# its Frontend's dependencies and runs the Frontend's tests (including the
# rendered-route tests in src/routes.test.ts), `astro check`, lint and format,
# then lists a second language in its gq.ops.json (wordpress.languages) and
# runs the tests and `astro check` again, as a bilingual Site.
#
# The site isn't named Acme, the name the tests' stub CMS uses, so a test that
# expects the stub's name where the site renders its own fails here.
#
# The site installs @getquick/site from this checkout, not npm
# (this-checkout.sh). Generation stays offline and secret-free; only
# `pnpm install` uses the network, to fetch the Frontend's npm dependencies.
# Nothing is provisioned or deployed, and the site is deleted afterwards
# unless KEEP=1.

set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
source "$repo/scripts/smoke/this-checkout.sh"
parent=$(mktemp -d "${TMPDIR:-/tmp}/gq-frontend-check.XXXXXX")
project=orbit
if [[ "${KEEP:-}" == 1 ]]; then
  echo "Keeping the site in $parent/$project"
else
  trap 'rm -rf "$parent"' EXIT
fi

cd "$parent"
node "$repo/bin/gq.mjs" new "$project" --project "$project" --variant content >/dev/null
use_this_checkout "$repo" "$parent/$project"
cd "$project"
CI=1 pnpm install --filter "@$project/frontend..." --filter . >/dev/null

cd apps/frontend
pnpm test
pnpm check
pnpm lint
pnpm exec vp fmt --check .

# The same Frontend on a bilingual Site: English under /en/ beside the
# default Portuguese. The Frontend reads the languages when it is built.
node -e '
const fs = require("node:fs");
const path = "../../gq.ops.json";
const ops = JSON.parse(fs.readFileSync(path, "utf8"));
ops.wordpress.plugins.push("polylang-pro", "gq-polylang-graphql");
ops.wordpress.locale = "pt_PT_ao90";
ops.wordpress.languages = [{ locale: "en_US", slug: "en" }];
fs.writeFileSync(path, JSON.stringify(ops, null, 2) + "\n");
'
pnpm test
pnpm check

#!/usr/bin/env bash
#
# The durable homepage's runtime proof: generates a disposable content site
# from this checkout's blueprint, installs its Frontend's and its CI Worker's
# npm dependencies (the latter for Wrangler's local workerd runtime), then runs
# frontend-runtime.mjs: the Frontend built by Alchemy's Astro Cloudflare build,
# served in workerd with a local D1 publication store, through a stub CMS
# outage, a Worker restart and a rebuilt redeploy. Then the same site is made
# bilingual (gq.ops.json's wordpress.languages) and frontend-languages.mjs
# proves that each language is served from the store.
#
# The site installs @getquick/site from this checkout, not npm
# (this-checkout.sh). Generation stays offline and secret-free; only
# `pnpm install` uses the network. Nothing is provisioned or deployed: no
# Cloudflare account, token or remote resource is used. The site is deleted
# afterwards unless KEEP=1.

set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
source "$repo/scripts/smoke/this-checkout.sh"
parent=$(mktemp -d "${TMPDIR:-/tmp}/gq-frontend-runtime.XXXXXX")
if [[ "${KEEP:-}" == 1 ]]; then
  echo "Keeping the site in $parent/acme"
else
  trap 'rm -rf "$parent"' EXIT
fi

cd "$parent"
node "$repo/bin/gq.mjs" new acme --project acme --variant content >/dev/null
use_this_checkout "$repo" "$parent/acme"
cd acme
CI=1 pnpm install --filter @acme/frontend... --filter @acme/ci... --filter . >/dev/null

node "$repo/scripts/smoke/frontend-runtime.mjs" "$parent/acme"

# shellcheck disable=SC2016 # JavaScript, not shell
node -e '
  const fs = require("node:fs");
  const ops = JSON.parse(fs.readFileSync("gq.ops.json", "utf8"));
  ops.wordpress.plugins.push("polylang-pro", "gq-polylang-graphql");
  ops.wordpress.locale = "pt_PT_ao90";
  ops.wordpress.languages = [{ locale: "en_US", slug: "en" }];
  fs.writeFileSync("gq.ops.json", `${JSON.stringify(ops, null, 2)}\n`);
'
node "$repo/scripts/smoke/frontend-languages.mjs" "$parent/acme"

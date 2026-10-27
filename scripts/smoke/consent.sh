#!/usr/bin/env bash
#
# The consent proof (CONSENT-1, LEGAL-1): generates a disposable content site
# from this checkout's blueprint, installs its Frontend's npm dependencies (the
# pinned @getquick/content among them) and its CI Worker's (for Wrangler's
# local workerd runtime), then runs consent.mjs: the Frontend built by
# Alchemy's Astro Cloudflare build, served in workerd with a local D1
# publication store and Consent database, passes gq-content's shared
# acceptance suite in Chromium, records decisions there, and is ready by gq
# site check's consent part with GA4 on; monolingual, then bilingual.
#
# Needs Playwright's Chromium (`pnpm exec playwright install chromium`), or
# CHROMIUM naming one. The site installs @getquick/site from this checkout,
# not npm (this-checkout.sh). Generation stays offline and secret-free; only
# `pnpm install` uses the network. Nothing is provisioned or deployed: no
# Cloudflare account, token or remote resource is used. The site is deleted
# afterwards unless KEEP=1.

set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
source "$repo/scripts/smoke/this-checkout.sh"
parent=$(mktemp -d "${TMPDIR:-/tmp}/gq-consent.XXXXXX")
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

node "$repo/scripts/smoke/consent.mjs" "$parent/acme"

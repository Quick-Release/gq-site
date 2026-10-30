#!/usr/bin/env bash
#
# Generates a disposable commerce site from this checkout's blueprint
# (ADR 0017), installs it, installs it again with a frozen lockfile, and runs
# gq sync --check and gq verify: its Frontend's check, lint, test and build,
# the CI scripts' tests and the infra and CI type checks. The CMS's Composer
# checks skip without Composer or the private registry's login.
#
# A commerce Site has no readiness yet (#26): this proves generation and the
# skeleton's checks, nothing about a working shop.
#
# The site installs @getquick/site from this checkout, not npm
# (this-checkout.sh). Generation stays offline and secret-free; only
# `pnpm install` uses the network. Nothing is provisioned or deployed, and the
# site is deleted afterwards unless KEEP=1.

set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
source "$repo/scripts/smoke/this-checkout.sh"
parent=$(mktemp -d "${TMPDIR:-/tmp}/gq-commerce-check.XXXXXX")
project=shop
if [[ "${KEEP:-}" == 1 ]]; then
  echo "Keeping the site in $parent/$project"
else
  trap 'rm -rf "$parent"' EXIT
fi

cd "$parent"
node "$repo/bin/gq.mjs" new "$project" --project "$project" --variant commerce --locale pt_PT_ao90 >/dev/null
use_this_checkout "$repo" "$parent/$project"
cd "$project"
CI=1 pnpm install >/dev/null
CI=1 pnpm install --frozen-lockfile >/dev/null
pnpm exec gq sync --check
pnpm exec gq verify
# The build leaves no managed file changed.
pnpm exec gq sync --check

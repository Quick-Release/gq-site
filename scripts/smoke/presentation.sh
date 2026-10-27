#!/usr/bin/env bash
# Build a real generated content Site and serve saved presentation content through
# Astro/workerd. GQ_CONTENT_TARBALL optionally installs an immutable local preview;
# it never changes the blueprint's published dependency pins.
# Usage: scripts/smoke/presentation.sh [rendered Container document]
# Needs Playwright Chromium, or CHROMIUM naming an executable. No deployment.
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
document=$(realpath "${1:-$repo/test/fixtures/presentation/container-rendered.html}")
source "$repo/scripts/smoke/this-checkout.sh"
parent=$(mktemp -d "${TMPDIR:-/tmp}/gq-presentation.XXXXXX")
if [[ "${KEEP:-}" == 1 ]]; then
  echo "Keeping the site in $parent/acme"
else
  trap 'rm -rf "$parent"' EXIT
fi

cd "$parent"
# This proof uses Astro build/layout APIs; the default Start app has its own proof.
node "$repo/bin/gq.mjs" new acme --project acme --variant content --framework astro >/dev/null
use_this_checkout "$repo" "$parent/acme"
cd acme
CI=1 pnpm install --filter @acme/frontend... --filter @acme/ci... --filter . >/dev/null
node "$repo/scripts/smoke/presentation.mjs" "$parent/acme" "$document"
node "$repo/scripts/smoke/presentation-hero.mjs" "$parent/acme"

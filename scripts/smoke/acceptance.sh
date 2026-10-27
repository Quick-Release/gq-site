#!/usr/bin/env bash
#
# Spec #38's local acceptance gate (ADR 0010), on disposable sites generated
# from this checkout's blueprint, without a Cloudflare account, a live CMS or
# a secret: the package's own checks, then each proof in turn.
#
#   1. pnpm check: formatting, lint, and the package's tests (generation,
#      ownership, provisioning commands and gq site check at the run() seam).
#   2. frontend-check.sh: the generated Frontend's own tests (its pages
#      against a stubbed CMS), astro check, lint and format.
#   3. content-pair.sh: the generated Site wired to the pinned content
#      runtime (ADR 0020): its pins, the CMS plugin's crontab command, the
#      migrations the deploy resolves, and Alchemy's Astro build served in
#      workerd with a local D1 store, through its /gq routes and gq frontend
#      refresh and events check. The runtime's own behaviour, on a real
#      WordPress too, is proved in Quick-Release/gq-content.
#   4. consent.sh: the generated Site's consent UI, routes and records
#      (CONSENT-1, LEGAL-1): gq-content's shared acceptance suite in
#      Chromium, POST /gq/consent into a local consent database and its
#      authenticated reads, and gq site check's consent part with GA4 on,
#      monolingual and bilingual. Needs Playwright's Chromium.
#
# Each proof deletes what it created. The live half is the gq-smoke wizard
# (scripts/smoke/gq-smoke-up.sh, stages 18 to 22). Stops at the first failure.

set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo"

step() { printf '\n== %s\n' "$1"; }

step "pnpm check"
pnpm check
step "Generated Frontend checks (frontend-check.sh)"
scripts/smoke/frontend-check.sh
step "Content pair wiring proof (content-pair.sh)"
scripts/smoke/content-pair.sh
step "Consent proof (consent.sh)"
scripts/smoke/consent.sh
printf '\nLocal acceptance gate passed. The live half: scripts/smoke/gq-smoke-up.sh (stages 18-22).\n'

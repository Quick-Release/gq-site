#!/usr/bin/env bash
#
# The content package pair's wiring proof (ADR 0020): generates a disposable
# content site from this checkout's blueprint, installs its Frontend's npm
# dependencies (the pinned @getquick/content among them) and its CI Worker's
# (for Wrangler's local workerd runtime), then runs content-pair.mjs: the
# pins, the CMS plugin's scheduler command and identity against its published
# ZIP, the publication migrations infra/frontend.run.ts resolves, and the
# Frontend built by Alchemy's Astro Cloudflare build, served in workerd with
# a local D1 store migrated from them, through its /gq routes. The Site
# declares headless forms (gq.ops.json `forms`), so its managed /gq/forms/
# route is built and answered too.
#
# The site installs @getquick/site from this checkout, not npm
# (this-checkout.sh). Generation stays offline and secret-free; only
# `pnpm install` and the plugin ZIP's download (a public GitHub release
# asset) use the network. Nothing is provisioned or deployed: no Cloudflare
# account, token or remote resource is used. Needs unzip. The site is deleted
# afterwards unless KEEP=1.

set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
source "$repo/scripts/smoke/this-checkout.sh"
parent=$(mktemp -d "${TMPDIR:-/tmp}/gq-content-pair.XXXXXX")
if [[ "${KEEP:-}" == 1 ]]; then
  echo "Keeping the site in $parent/acme"
else
  trap 'rm -rf "$parent"' EXIT
fi

cd "$parent"
node "$repo/bin/gq.mjs" new acme --project acme --variant content >/dev/null
use_this_checkout "$repo" "$parent/acme"
cd acme
node -e '
const fs = require("node:fs");
const ops = JSON.parse(fs.readFileSync("gq.ops.json", "utf8"));
ops.wordpress.plugins.push("gravityforms");
ops.forms = { provider: "gravityforms", spam: ["honeypot"] };
fs.writeFileSync("gq.ops.json", JSON.stringify(ops, null, 2) + "\n");
'
node "$repo/bin/gq.mjs" sync >/dev/null
CI=1 pnpm install --filter @acme/frontend... --filter @acme/ci... --filter . >/dev/null

node "$repo/scripts/smoke/content-pair.mjs" "$parent/acme"

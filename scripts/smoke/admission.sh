#!/usr/bin/env bash
#
# A guarded Site's request admission (deploy/ploi/admission.sh) on a real
# stack: generates a disposable content site guarding a package from this
# checkout's blueprint, then runs admission/stack.sh in a disposable Docker
# container (admission/Dockerfile) with nginx serving the admin domain over
# TLS (a throwaway CA the container trusts), PHP-FPM with
# opcache.validate_timestamps=0, and the WordPress the CMS skeleton pins
# installed by Composer under the skeleton's Bedrock config. stack.sh runs
# the generated admission.sh verbatim, as the deploy does, and checks:
#
#   - a slow request that started before the hold finishes (or, with PHP-FPM's
#     default process_control_timeout, is ended by the reload) before `begin`
#     returns, so no package changes while it runs;
#   - held: every PHP route (front page, installer, upgrader, setup-config,
#     login, admin, xmlrpc, REST, a plugin's own PHP file) answers 503 with the
#     hold's nonce before any WordPress or plugin code runs; static files are
#     still served (the gate covers PHP only);
#   - WP-CLI works while held (a recovery);
#   - a real Composer reinstall that deletes web/wp leaves the gate, the hold
#     and .user.ini alone, and every request meanwhile is held;
#   - the hold appears and lifts without a reload (opcache doesn't hide it);
#   - a deploy killed, or failing late (an extension), after `begin` stays held;
#   - a failed `begin` removes only its own hold and keeps an earlier one;
#   - .user.ini's other settings stay; a prepend gq didn't write is refused.
#
# Needs docker and node (with this checkout's dependencies installed).
# Downloads (Ubuntu packages, Composer packages, WP-CLI, the SQLite
# integration) use the network; nothing is provisioned or deployed anywhere.

set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
image="gq-admission-smoke"
version=$(sed -n 's/.*"roots\/wordpress": "\([0-9.]*\)".*/\1/p' "$repo/blueprint/templates/apps/cms/composer.json")

parent=$(mktemp -d "${TMPDIR:-/tmp}/gq-admission.XXXXXX")
trap 'rm -rf "$parent"' EXIT

cd "$parent"
node "$repo/bin/gq.mjs" new acme --project acme --variant content >/dev/null
node -e '
const { readFileSync, writeFileSync } = require("node:fs");
const path = process.argv[1];
const ops = JSON.parse(readFileSync(path, "utf8"));
ops.domains = { ...ops.domains, admin: "cms.acme.test", frontend: "www.acme.test" };
ops.deployment = {
  protected: true,
  state: "authorized",
  guardedPackages: ["getquick/gq-support"],
  approval: { stage: "prod", slot: "acme/production" },
};
writeFileSync(path, JSON.stringify(ops, null, 2) + "\n");
' "$parent/acme/gq.ops.json"
(cd "$parent/acme" && node "$repo/bin/gq.mjs" sync >/dev/null)
grep -qx 'ADMIN_HOST="cms.acme.test"' "$parent/acme/deploy/ploi/admission.sh"

docker build -q -t "$image" "$repo/scripts/smoke/admission" >/dev/null
docker run --rm \
  -e WORDPRESS_VERSION="$version" \
  -v "$parent/acme:/src:ro" \
  -v "$repo/scripts/smoke/admission/stack.sh:/stack.sh:ro" \
  "$image" bash /stack.sh

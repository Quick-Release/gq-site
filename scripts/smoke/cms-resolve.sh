#!/usr/bin/env bash
#
# Resolves both generated CMS skeletons against the real GETQUICK registry:
# generates a disposable content and a disposable commerce site from this
# checkout's blueprint and runs `composer update --dry-run` in each one's
# apps/cms, so every pin (getquick/* among them) must resolve together, as a
# Site's first `composer install` does. It then checks that Composer locked
# each GETQUICK package at the blueprint's pin. 0.29.0 shipped pins that
# couldn't resolve (GQ Design 0.9.4 beside packages requiring ^0.3.1); the
# package suite's offline check reads the recorded requirements
# (blueprint/package-requirements.json), and this reads the registry itself.
#
# The registry is private, so this needs its login: COMPOSER_AUTH with an
# http-basic entry for proxy.composer.getquick.io (Composer reads it from the
# environment; it is never written to disk or printed). Without one the
# script refuses before generating anything (exit 3); it never passes without
# resolving. `--probe` stops after that check. Needs php and composer.
#
# Generation stays offline and secret-free; only Composer uses the network.
# Nothing is installed, provisioned or deployed, and the sites are deleted
# afterwards unless KEEP=1.

set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
host=proxy.composer.getquick.io

if ! node -e '
  const auth = JSON.parse(process.env.COMPOSER_AUTH || "{}");
  const login = auth["http-basic"]?.[process.argv[1]];
  process.exit(login?.username && login?.password ? 0 : 1);
' "$host" 2>/dev/null; then
  echo "REFUSED: COMPOSER_AUTH has no http-basic login for $host." >&2
  echo "Both CMS skeletons require private getquick/* packages from it, so this check needs" >&2
  echo "the registry login: run it with COMPOSER_AUTH set (from any Site, gq sigillo run reads the" >&2
  echo "fleet's from GQ Platform ops: gq sigillo run staging -- <gq-site>/scripts/smoke/cms-resolve.sh)," >&2
  echo "or in CI give the workflow a COMPOSER_AUTH secret. Nothing was generated or resolved." >&2
  exit 3
fi
# --probe: only whether the login is there (CI decides whether to run).
[[ "${1:-}" == --probe ]] && exit 0

parent=$(mktemp -d "${TMPDIR:-/tmp}/gq-cms-resolve.XXXXXX")
if [[ "${KEEP:-}" == 1 ]]; then
  echo "Keeping the sites in $parent"
else
  trap 'rm -rf "$parent"' EXIT
fi
# A clean Composer home: no global config, plugins or other logins.
export COMPOSER_HOME="$parent/composer-home"
mkdir -p "$COMPOSER_HOME"

cd "$parent"
node "$repo/bin/gq.mjs" new content --project resolvecontent --variant content >/dev/null
node "$repo/bin/gq.mjs" new commerce --project resolvecommerce --variant commerce >/dev/null

status=0
for variant in content commerce; do
  echo "== $variant: composer update --dry-run in apps/cms"
  cms="$parent/$variant/apps/cms"
  if ! (cd "$cms" && composer update --dry-run --no-interaction --no-progress --no-scripts \
    --no-plugins --no-ansi >"$parent/$variant.log" 2>&1); then
    cat "$parent/$variant.log" >&2
    echo "FAILED: the $variant CMS skeleton's requirements don't resolve." >&2
    status=1
    continue
  fi
  # Every getquick/* pin is what Composer locks.
  if ! node -e '
    const fs = require("node:fs");
    const [composerFile, logFile, variant] = process.argv.slice(1);
    const pins = JSON.parse(fs.readFileSync(composerFile, "utf8")).require;
    const log = fs.readFileSync(logFile, "utf8");
    let failed = false;
    for (const [name, pin] of Object.entries(pins)) {
      if (!name.startsWith("getquick/")) continue;
      const match = new RegExp(`Locking ${name.replace("/", "\\/")} \\(v?([^)]+)\\)`).exec(log);
      const locked = match?.[1] ?? "nothing";
      console.log(`${variant}: ${name} ${pin} → ${locked}`);
      if (locked !== pin) failed = true;
    }
    process.exit(failed ? 1 : 0);
  ' "$cms/composer.json" "$parent/$variant.log" "$variant"; then
    echo "FAILED: the $variant CMS skeleton resolves, but not at the blueprint's GETQUICK pins." >&2
    status=1
  fi
done
[[ "$status" -eq 0 ]] && echo "Both CMS skeletons resolve at the blueprint's pins."
exit "$status"

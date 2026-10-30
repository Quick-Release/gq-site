#!/usr/bin/env bash
#
# Generates a disposable commerce site from this checkout's blueprint
# (ADR 0017), installs it, installs it again with a frozen lockfile, and runs
# gq sync --check and gq verify: its Frontend's check, lint, test and build,
# the CI scripts' tests and the infra and CI type checks. The CMS's Composer
# checks skip without Composer or the private registry's login. Then it
# proves the storefront Runtime is mounted and declared (#89 slice 6): the
# lockfile has no Ekis path, the built Frontend answers /api/store/* and
# /api/auth/* from the Runtime, and the deploy declares the bindings the
# installed package's infra.json lists and refuses to run without them.
#
# A commerce Site has no readiness yet (#26): this proves generation and the
# skeleton's checks, nothing about a working shop.
#
# The Frontend depends on private @quick-release packages (the storefront
# Runtime and its auth contract) on GitHub Packages, so installing needs a
# read:packages token: GITHUB_PACKAGES_TOKEN when set (written to a throwaway
# user-level npm config, never to the site), otherwise the caller's own npm
# config. Without one that can read them, the script refuses before
# generating anything (exit 3), naming what is missing: it never passes
# without installing.
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

if [[ -n "${GITHUB_PACKAGES_TOKEN:-}" ]]; then
  # Replaces the caller's user config for this script's installs only.
  (umask 077 && printf '//npm.pkg.github.com/:_authToken=%s\n' "$GITHUB_PACKAGES_TOKEN" >"$parent/user.npmrc")
  export NPM_CONFIG_USERCONFIG="$parent/user.npmrc"
fi

# Every @quick-release package the skeleton pins must be readable, or the
# install below can't run.
skeleton="$repo/blueprint/templates/commerce/apps/frontend/package.json"
unreadable=()
for spec in $(node -e '
  const { dependencies } = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  for (const [name, version] of Object.entries(dependencies))
    if (name.startsWith("@quick-release/")) console.log(`${name}@${version}`);
' "$skeleton"); do
  if ! (cd "$parent" && pnpm view "$spec" version --registry=https://npm.pkg.github.com >/dev/null 2>&1); then
    unreadable+=("$spec")
  fi
done
if ((${#unreadable[@]} > 0)); then
  echo "REFUSED: can't read ${unreadable[*]} from GitHub Packages (npm.pkg.github.com)." >&2
  echo "A commerce Site's Frontend installs them, so this check needs a read:packages token" >&2
  echo "that can read them: set GITHUB_PACKAGES_TOKEN, or log in to npm.pkg.github.com in your" >&2
  echo "user-level npm config. In GitHub Actions, each package must grant this repository" >&2
  echo "Actions access. Nothing was generated, installed or verified." >&2
  exit 3
fi

cd "$parent"
node "$repo/bin/gq.mjs" new "$project" --project "$project" --variant commerce --locale pt_PT_ao90 >/dev/null
use_this_checkout "$repo" "$parent/$project"
cd "$project"
CI=1 pnpm install >/dev/null
CI=1 pnpm install --frozen-lockfile >/dev/null
# Installed from registries only: no git or path dependency on Ekis.
if grep -inE 'ekis|github:|git\+' pnpm-lock.yaml; then
  echo "pnpm-lock.yaml resolves a package from git or Ekis (above)." >&2
  exit 1
fi
pnpm exec gq sync --check
pnpm exec gq verify
# The build leaves no managed file changed.
pnpm exec gq sync --check

# The storefront Runtime: mounted in the built Frontend, declared by the
# deploy plan, and required by the deploy (commerce-runtime.mjs).
node "$repo/scripts/smoke/commerce-runtime.mjs" "$PWD"

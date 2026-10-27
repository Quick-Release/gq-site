#!/usr/bin/env bash
#
# The CI install step's Composer proof: generates a disposable content site
# from this checkout's blueprint, builds its CI runner image (infra/ci/Dockerfile,
# the image every Cloudflare CI step runs in, as root), then runs
# ci-composer.mjs: the install step's own Composer command, from a clean CMS
# (no vendor, lockfile or Composer cache) inside that image. Installer plugins
# must run, WordPress packages must land in their installer-paths and the
# wpgraphql-blocks patch must apply and verify; without the image's
# COMPOSER_ALLOW_SUPERUSER, the same install must fail as it did in CI.
#
# The GETQUICK packages come from the private registry, which needs
# COMPOSER_AUTH; the proof drops them and installs every public package the
# CMS requires, leaving its allow-plugins, installer-paths and scripts as
# generated. Generation stays offline and secret-free; only the image build
# and Composer's downloads use the network. Needs Docker. Nothing is
# provisioned or deployed. The site is deleted afterwards unless KEEP=1.

set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
parent=$(mktemp -d "${TMPDIR:-/tmp}/gq-ci-composer.XXXXXX")
image="gq-ci-composer-smoke:$$"
cleanup() {
  # The containers write as root: hand the files back before removing them.
  docker run --rm --entrypoint chown -v "$parent:/smoke" "$image" -R "$(id -u):$(id -g)" /smoke \
    >/dev/null 2>&1 || true
  [[ "${KEEP:-}" == 1 ]] || rm -rf "$parent"
  docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT
[[ "${KEEP:-}" == 1 ]] && echo "Keeping the site in $parent/orbit"

cd "$parent"
node "$repo/bin/gq.mjs" new orbit --project orbit --variant content --framework astro >/dev/null
docker build -q -t "$image" orbit/infra/ci >/dev/null

node "$repo/scripts/smoke/ci-composer.mjs" "$parent/orbit" "$image"

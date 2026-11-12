#!/usr/bin/env bash
#
# The CI image's Node proof: generates a disposable content site per Frontend
# framework (Astro and TanStack) from this checkout's blueprint, builds its CI
# runner image (infra/ci/Dockerfile, the image every Cloudflare CI step runs
# in) and checks, inside it, that:
#
# - node is the Sites' pinned Node (the site's .nvmrc), the only node on PATH,
#   and pnpm is the root package.json's packageManager;
# - the image's own entrypoint, the sandbox server, starts, answers its health
#   check and runs a command on that Node, and its JavaScript executors run it;
# - the Frontend's dependencies install and its `check` (Astro: `astro
#   check`, which refuses a Node older than its engines) passes, as the
#   release's verify step runs it.
#
# The site installs @getquick/site from this checkout (this-checkout.sh).
# Generation stays offline and secret-free; the image build and pnpm install
# use the network. Needs Docker. Nothing is provisioned or deployed. The sites
# are deleted afterwards unless KEEP=1.

set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
source "$repo/scripts/smoke/this-checkout.sh"
parent=$(mktemp -d "${TMPDIR:-/tmp}/gq-ci-node.XXXXXX")
image="gq-ci-node-smoke:$$"
container="gq-ci-node-smoke-$$"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  # The containers write as root: hand the files back before removing them.
  docker run --rm --entrypoint chown -v "$parent:$parent" "$image" -R "$(id -u):$(id -g)" "$parent" \
    >/dev/null 2>&1 || true
  [[ "${KEEP:-}" == 1 ]] || rm -rf "$parent"
  docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT
[[ "${KEEP:-}" == 1 ]] && echo "Keeping the sites in $parent"

fail() {
  echo "✗ $*" >&2
  exit 1
}

in_image() {
  local site=$1
  shift
  docker run --rm --entrypoint bash -e CI=1 -v "$parent:$parent" -w "$site" "$image" -c "$*"
}

for framework in astro tanstack; do
  project="orbit-$framework"
  site="$parent/$project"
  cd "$parent"
  node "$repo/bin/gq.mjs" new "$project" --project "$project" --variant content \
    --framework "$framework" >/dev/null
  use_this_checkout "$repo" "$site"
  # Both frameworks render the same Dockerfile; build it once.
  if [[ $framework == astro ]]; then
    docker build -q -t "$image" "$site/infra/ci" >/dev/null

    node_version="v$(cat "$site/.nvmrc")"
    package_manager=$(node -p 'require(process.argv[1]).packageManager' "$site/package.json")
    [[ $(in_image "$site" node --version) == "$node_version" ]] ||
      fail "the CI image's node isn't the Sites' $node_version"
    [[ $(in_image "$site" which -a node) == /usr/local/bin/node ]] ||
      fail "the CI image has more than one node on PATH"
    [[ "pnpm@$(in_image "$site" pnpm --version)" == "$package_manager" ]] ||
      fail "the CI image's pnpm isn't $package_manager"

    # The sandbox server, as Cloudflare starts it: its own entrypoint.
    docker run -d --name "$container" "$image" >/dev/null
    for _ in $(seq 30); do
      docker exec "$container" curl -fsS -m 2 http://127.0.0.1:3000/api/ping >/dev/null 2>&1 && break
      sleep 1
    done
    docker exec "$container" curl -fsS -m 2 http://127.0.0.1:3000/api/ping >/dev/null ||
      fail "the sandbox server didn't start"
    executed=$(docker exec "$container" curl -fsS -m 30 -X POST http://127.0.0.1:3000/api/execute \
      -H 'content-type: application/json' -d '{"command":"node --version","sessionId":"smoke"}')
    node -e '
      const [body, expected] = process.argv.slice(1);
      const result = JSON.parse(body);
      if (!result.success || result.stdout.trim() !== expected) {
        throw new Error(`the sandbox server ran node as ${body}`);
      }
    ' "$executed" "$node_version"
    executors=$(docker exec "$container" bash -c \
      'for p in $(pgrep -f "^node .*node_executor\.js"); do readlink "/proc/$p/exe"; done | sort -u')
    [[ $executors == /usr/local/bin/node ]] ||
      fail "the sandbox server's JavaScript executors run ${executors:-no node}"
    docker rm -f "$container" >/dev/null
  fi

  # The release's verify step: the Frontend's check on the image's Node.
  in_image "$site" "pnpm install --filter '@$project/frontend...' --filter . >/dev/null && pnpm --filter '@$project/frontend' check"
  echo "✓ $framework: the Frontend's check passes in the CI image on $node_version"
done

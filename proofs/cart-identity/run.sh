#!/usr/bin/env bash
# Runs the live proof against the disposable store over HTTPS, trusting DDEV's local CA.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAROOT="$(mkcert -CAROOT)"
export NODE_EXTRA_CA_CERTS="$CAROOT/rootCA.pem"
exec node --test --test-concurrency=1 "$@" "$HERE/isolation.test.mjs"

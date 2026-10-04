#!/usr/bin/env bash
# Disposable, loopback-only Woo store for the cart identity proof.
#
#   env.sh up               create the DDEV project and install pinned WordPress/Woo
#   env.sh reset            restore the synthetic fixtures (run before each scenario)
#   env.sh extension on|off mount or remove the gq-cart-identity mu-plugin
#   env.sh versions         print the runtime/provider versions as JSON
#   env.sh down             delete this project only and verify its containers are gone
#
# Everything lives under GQ_PROOF_DIR (default: $TMPDIR/gq-cart-identity-proof).
# Synthetic credentials are generated into mode-0600 files outside the docroot and
# never passed as command-line arguments.
set -euo pipefail

PROJECT=gq-cart-identity-proof
WORDPRESS_VERSION=7.1.2
WOOCOMMERCE_VERSION=11.1.2
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="${GQ_PROOF_DIR:-${TMPDIR:-/tmp}/$PROJECT}"
MARKER="$DIR/.proof/owner"

ddev_in() { (cd "$DIR" && ddev "$@"); }

owned() { [[ -f "$MARKER" ]] && [[ "$(cat "$MARKER")" == "$PROJECT" ]]; }

require_owned() {
  if ! owned; then
    echo "No $PROJECT environment owned by this proof at $DIR" >&2
    exit 1
  fi
}

random_secret() { node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))'; }

up() {
  if ddev describe "$PROJECT" >/dev/null 2>&1 && ! owned; then
    echo "A DDEV project named $PROJECT already exists and is not owned by this proof; refusing." >&2
    exit 1
  fi
  # down deletes $DIR, so only ever take ownership of a new or empty directory.
  if [[ -d "$DIR" ]] && ! owned && [[ -n "$(ls -A "$DIR")" ]]; then
    echo "$DIR is not empty and not owned by this proof; choose another GQ_PROOF_DIR." >&2
    exit 1
  fi
  mkdir -p "$DIR/.proof" "$DIR/web"
  chmod 700 "$DIR/.proof"
  echo "$PROJECT" >"$MARKER"
  for name in admin-password customer-password other-password; do
    if [[ ! -f "$DIR/.proof/$name" ]]; then
      (umask 077 && random_secret >"$DIR/.proof/$name")
    fi
  done
  cp "$HERE/env/seed.php" "$DIR/.proof/seed.php"

  ddev_in config --project-name="$PROJECT" --project-type=wordpress --docroot=web \
    --php-version=8.4 --database=mariadb:11.8 --performance-mode=none --omit-containers=ddev-ssh-agent
  ddev_in start -y
  if ! ddev_in wp core is-installed >/dev/null 2>&1; then
    ddev_in wp core download --version="$WORDPRESS_VERSION" --force
    # WP-CLI echoes --prompt input and prints a generated password, so discard this
    # output; seed.php then sets the real password from the mode-0600 file.
    ddev_in wp core install --url="https://$PROJECT.ddev.site" --title="GQ cart identity proof" \
      --admin_user=gq-proof-admin --admin_email=admin@example.invalid --skip-email >/dev/null 2>&1
  fi
  ddev_in wp rewrite structure '/%postname%/' --hard
  ddev_in wp plugin install woocommerce --version="$WOOCOMMERCE_VERSION" --activate --force
  mkdir -p "$DIR/web/wp-content/mu-plugins"
  cp "$HERE/fixture/gq-proof-auth.php" "$DIR/web/wp-content/mu-plugins/gq-proof-auth.php"
  ddev_in wp eval-file /var/www/html/.proof/seed.php install
  versions
}

reset() {
  require_owned
  ddev_in wp eval-file /var/www/html/.proof/seed.php reset
}

extension() {
  require_owned
  local target="$DIR/web/wp-content/mu-plugins/gq-cart-identity.php"
  case "${1:-}" in
    on)
      mkdir -p "$(dirname "$target")"
      cp "$HERE/woo-extension/gq-cart-identity.php" "$target"
      ;;
    off) rm -f "$target" ;;
    *)
      echo "usage: env.sh extension on|off" >&2
      exit 2
      ;;
  esac
}

versions() {
  require_owned
  local store
  store="$(ddev_in wp eval-file /var/www/html/.proof/seed.php versions | tail -1)"
  STORE="$store" DDEV="$(ddev --version)" DOCKER="$(docker info --format '{{.ServerVersion}}')" \
    node -e 'const v = JSON.parse(process.env.STORE); console.log(JSON.stringify({ ddev: process.env.DDEV.split(" ").at(-1), docker: process.env.DOCKER, ...v }))'
}

down() {
  require_owned
  ddev_in delete --omit-snapshot -y
  local left
  left="$(docker ps -a --filter "label=com.ddev.site-name=$PROJECT" --format '{{.Names}}')"
  if [[ -n "$left" ]]; then
    echo "Containers still present for $PROJECT: $left" >&2
    exit 1
  fi
  rm -rf "$DIR"
  echo "Deleted $PROJECT; no containers remain and $DIR is removed."
}

case "${1:-}" in
  up) up ;;
  reset) reset ;;
  extension) extension "${2:-}" ;;
  versions) versions ;;
  down) down ;;
  *)
    grep '^#   ' "$0"
    exit 2
    ;;
esac

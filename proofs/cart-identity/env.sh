#!/usr/bin/env bash
# Disposable, loopback-only Woo store for the cart identity proof.
#
#   env.sh up                           create the DDEV project; install WP, Woo and GETQUICK plugins
#   env.sh reset                        restore the synthetic fixtures (run before each scenario)
#   env.sh ecommerce baseline|candidate install GQ eCommerce from the baseline ref or candidate tree
#   env.sh versions                     print runtime, provider and plugin versions as JSON
#   env.sh fault drop-registry|end-sessions  inject a fault for the next scenario
#   env.sh down                         delete this project only and verify its containers are gone
#
# Everything lives under GQ_PROOF_DIR (default: $TMPDIR/gq-cart-identity-proof).
# Synthetic credentials are generated into mode-0600 files outside the docroot and
# never passed as command-line arguments.
#
# Plugin sources (local clones, read only):
#   GQ_CONFIG_REPO            GETQUICK Config, installed from its HEAD as a must-use plugin
#   GQ_DESIGN_REPO            GQ Design, installed from its HEAD
#   GQ_ECOMMERCE_REPO         GQ eCommerce; `ecommerce baseline` installs GQ_ECOMMERCE_BASELINE (default 0220d8c, the last commit without isolation)
#   GQ_ECOMMERCE_CANDIDATE    GQ eCommerce working tree that `ecommerce candidate` installs
set -euo pipefail

PROJECT=gq-cart-identity-proof
WORDPRESS_VERSION=7.1.2
WOOCOMMERCE_VERSION=11.1.2
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="${GQ_PROOF_DIR:-${TMPDIR:-/tmp}/$PROJECT}"
MARKER="$DIR/.proof/owner"
PLUGINS="$DIR/web/wp-content/plugins"
MU_PLUGINS="$DIR/web/wp-content/mu-plugins"

ddev_in() { (cd "$DIR" && ddev "$@"); }

owned() { [[ -f "$MARKER" ]] && [[ "$(cat "$MARKER")" == "$PROJECT" ]]; }

require_owned() {
  if ! owned; then
    echo "No $PROJECT environment owned by this proof at $DIR" >&2
    exit 1
  fi
}

require_source() {
  if [[ -z "${!1:-}" ]] || ! git -C "${!1}" rev-parse --git-dir >/dev/null 2>&1; then
    echo "Set $1 to a local git clone." >&2
    exit 1
  fi
}

random_secret() { node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))'; }

# Replaces $2 with the tree of git ref $3 in repository $1 and records where it came from.
install_ref() {
  local repo="$1" target="$2" ref="$3" name
  name="$(basename "$target")"
  rm -rf "$target" && mkdir -p "$target"
  git -C "$repo" archive "$ref" | tar -x -C "$target"
  record_source "$name" "$(git -C "$repo" rev-parse "$ref")" false
}

record_source() {
  NAME="$1" COMMIT="$2" DIRTY="$3" FILE="$DIR/.proof/sources.json" node -e '
    const fs = require("fs");
    const file = process.env.FILE;
    const sources = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    sources[process.env.NAME] = { commit: process.env.COMMIT, dirty: process.env.DIRTY === "true" };
    fs.writeFileSync(file, JSON.stringify(sources));'
}

up() {
  require_source GQ_CONFIG_REPO
  require_source GQ_DESIGN_REPO
  require_source GQ_ECOMMERCE_REPO
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
  for name in admin-password customer-password other-password proxy-secret; do
    if [[ ! -f "$DIR/.proof/$name" ]]; then
      (umask 077 && random_secret >"$DIR/.proof/$name")
    fi
  done
  cp "$HERE/env/seed.php" "$DIR/.proof/seed.php"

  ddev_in config --project-name="$PROJECT" --project-type=wordpress --docroot=web \
    --php-version=8.4 --database=mariadb:11.8 --performance-mode=none --omit-containers=ddev-ssh-agent
  # The suites swap plugin code between requests; never serve a stale opcode cache.
  mkdir -p "$DIR/.ddev/php"
  printf 'opcache.revalidate_freq=0\n' >"$DIR/.ddev/php/gq-proof.ini"
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

  mkdir -p "$MU_PLUGINS"
  cp "$HERE/fixture/gq-proof-runtime.php" "$MU_PLUGINS/gq-proof-runtime.php"
  install_ref "$GQ_CONFIG_REPO" "$MU_PLUGINS/getquick-config" HEAD
  printf '<?php\nrequire_once __DIR__ . "/getquick-config/getquick-config.php";\n' \
    >"$MU_PLUGINS/getquick-config-loader.php"
  # GQ eCommerce's main branch still requires the pre-rename slug `getquick-design`.
  install_ref "$GQ_DESIGN_REPO" "$PLUGINS/getquick-design" HEAD
  ddev_in wp plugin activate getquick-design
  ecommerce baseline
  ddev_in wp plugin activate gq-ecommerce
  ddev_in wp eval-file /var/www/html/.proof/seed.php install
  versions
}

ecommerce() {
  require_owned
  case "${1:-}" in
    baseline)
      require_source GQ_ECOMMERCE_REPO
      install_ref "$GQ_ECOMMERCE_REPO" "$PLUGINS/gq-ecommerce" "${GQ_ECOMMERCE_BASELINE:-0220d8c}"
      ;;
    candidate)
      require_source GQ_ECOMMERCE_CANDIDATE
      rsync -a --delete --exclude .git --exclude node_modules \
        "$GQ_ECOMMERCE_CANDIDATE/" "$PLUGINS/gq-ecommerce/"
      local dirty=false
      [[ -n "$(git -C "$GQ_ECOMMERCE_CANDIDATE" status --porcelain)" ]] && dirty=true
      record_source gq-ecommerce "$(git -C "$GQ_ECOMMERCE_CANDIDATE" rev-parse HEAD)" "$dirty"
      ;;
    *)
      echo "usage: env.sh ecommerce baseline|candidate" >&2
      exit 2
      ;;
  esac
}

reset() {
  require_owned
  ddev_in wp eval-file /var/www/html/.proof/seed.php reset
}

fault() {
  require_owned
  case "${1:-}" in
    drop-registry | end-sessions) ddev_in wp eval-file /var/www/html/.proof/seed.php "$1" ;;
    *)
      echo "usage: env.sh fault drop-registry|end-sessions" >&2
      exit 2
      ;;
  esac
}

versions() {
  require_owned
  local store
  store="$(ddev_in wp eval-file /var/www/html/.proof/seed.php versions | tail -1)"
  STORE="$store" DDEV="$(ddev --version)" DOCKER="$(docker info --format '{{.ServerVersion}}')" \
    SOURCES="$(cat "$DIR/.proof/sources.json")" node -e '
      const v = JSON.parse(process.env.STORE);
      console.log(JSON.stringify({
        ddev: process.env.DDEV.split(" ").at(-1),
        docker: process.env.DOCKER,
        ...v,
        sources: JSON.parse(process.env.SOURCES),
      }));'
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
  ecommerce) ecommerce "${2:-}" ;;
  fault) fault "${2:-}" ;;
  versions) versions ;;
  down) down ;;
  *)
    grep '^#   ' "$0"
    exit 2
    ;;
esac

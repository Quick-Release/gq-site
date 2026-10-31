#!/usr/bin/env bash
#
# Inside the disposable admission smoke container (see ../admission.sh), as
# root.
#
#   stack.sh fixtures  the releases' SQLite drop-in and Composer locks
#   stack.sh run       the server, then every check
#
# The server is set up as a Ploi server has it, but by this script, not by
# Ploi's template: a `ploi` user owning the Site and running PHP-FPM's
# pools, allowed exactly `sudo -n service php<version>-fpm reload`; nginx
# serving the admin domain over TLS. The generated deploy/ploi/admin.sh runs
# as that user, verbatim, as Ploi would run it.

set -euo pipefail

PHP_VERSION=8.3
HOST=cms.acme.test
OTHER_HOST=other.acme.test
HOME_DIR=/home/ploi
SITE=$HOME_DIR/$HOST
APP=$SITE/apps/cms
WEB=$APP/web
STATE=$SITE/.gq/state
GATE=$SITE/.gq/admission.php
FPM=/etc/php/$PHP_VERSION/fpm
POOL=$FPM/pool.d/www.conf
SUDOERS=/etc/sudoers.d/ploi-fpm
WORK=/work/run
SQLITE_URL=https://downloads.wordpress.org/plugin/sqlite-database-integration.latest-stable.zip

fixtures() {
  mkdir -p /work/cache
  [ -s /work/cache/sqlite.zip ] || curl -fsSL -o /work/cache/sqlite.zip "$SQLITE_URL"
  for release in r1 r2 r3; do
    local app=/work/releases/$release/apps/cms
    unzip -q -o /work/cache/sqlite.zip -d "$app/web/app/plugins"
    # The database outside the release (the deploy's rsync --delete owns
    # web/app/database); a MySQL Site keeps it off the server's files.
    {
      echo "<?php define('DB_DIR', '$HOME_DIR/database/'); ?>"
      sed -e "s#{SQLITE_IMPLEMENTATION_FOLDER_PATH}#$WEB/app/plugins/sqlite-database-integration#g" \
        -e "s#{SQLITE_PLUGIN}#sqlite-database-integration/load.php#g" \
        "$app/web/app/plugins/sqlite-database-integration/db.copy"
    } >"$app/web/app/db.php"
  done
  for release in r1 r2; do
    (cd "/work/releases/$release/apps/cms" \
      && COMPOSER_ALLOW_SUPERUSER=1 composer update -q --no-install --no-scripts --no-interaction)
  done
  chmod -R a+rX /work
}

failures=0
check() {
  if [ "$2" = ok ]; then
    echo "ok   $1"
  else
    echo "FAIL $1${3:+: $3}"
    tail -n 3 /var/log/nginx/error.log 2>/dev/null | sed 's/^/     nginx: /' || true
    failures=$((failures + 1))
  fi
}
as_ploi() {
  runuser -u ploi -- env HOME="$HOME_DIR" PATH=/usr/local/bin:/usr/bin:/bin "$@"
}
stamp() {
  while IFS= read -r line; do printf '%s %s\n' "$(date +%s.%N)" "$line"; done
}
# deploy <release> <log> [VARIABLE=value...]: the generated admin.sh, as
# Ploi runs it, timestamped into <log>; returns its exit code.
deploy() {
  local release="$1" log="$2" code
  shift 2
  tar -czf "/work/archives/$release.tar.gz" -C "/work/releases/$release" .
  chmod 0644 "/work/archives/$release.tar.gz"
  set +e
  (cd "$SITE" && as_ploi env PLOI_SITE_PATH="$SITE" ARCHIVE_URL="file:///work/archives/$release.tar.gz" \
    COMPOSER_AUTH='{"http-basic":{}}' COMPOSER_HOME="$HOME_DIR/.composer" "$@" \
    bash "/work/releases/$release/deploy/ploi/admin.sh") 2>&1 | stamp >"$log"
  code="${PIPESTATUS[0]}"
  set -e
  return "$code"
}
admission() {
  local command="$1"
  shift
  as_ploi env SITE_PATH="$SITE" APP_PATH=apps/cms "$@" bash /work/releases/r1/deploy/ploi/admission.sh "$command"
}
wp() { as_ploi bash -c 'cd "$1" && shift && wp "$@"' _ "$APP" "$@"; }
# request <url> [curl options]: the status; headers and body in $WORK.
request() {
  local url="$1"
  shift
  curl -sS -o "$WORK/body" -D "$WORK/headers" -w '%{http_code}' --max-time 30 \
    --resolve "$HOST:443:127.0.0.1" --resolve "$OTHER_HOST:443:127.0.0.1" "$@" "$url" 2>/dev/null || true
}
# The admission state: open only when it reads exactly "open".
is_open() { [ "$(od -An -tx1 "$STATE" 2>/dev/null | tr -d ' \n')" = 6f70656e0a ]; }
is_held() { ! is_open; }
gate_header() { tr -d '\r' <"$WORK/headers" | sed -n 's/^[Xx]-[Gg][Qq]-[Gg]ate: //p'; }
# Restarts PHP-FPM (stopped, gone, started) and waits until both pools
# accept connections.
restart_fpm() {
  local socket ready
  service "php$PHP_VERSION-fpm" stop >/dev/null 2>&1 || true
  for _ in $(seq 1 300); do
    pgrep -f "php-fpm: master process" >/dev/null || break
    sleep 0.1
  done
  pkill -KILL -f "php-fpm: " 2>/dev/null || true
  rm -f /run/php/php$PHP_VERSION-fpm*.sock
  service "php$PHP_VERSION-fpm" start >/dev/null
  for socket in "/run/php/php$PHP_VERSION-fpm.sock" "/run/php/php$PHP_VERSION-fpm-plain.sock"; do
    ready=false
    for _ in $(seq 1 100); do
      if [ -S "$socket" ] && php -r "exit(@stream_socket_client('unix://$socket') ? 0 : 1);"; then
        ready=true
        break
      fi
      sleep 0.1
    done
    [ "$ready" = true ] || { echo "PHP-FPM didn't come up ($socket)" >&2; tail -n 5 "/var/log/php$PHP_VERSION-fpm.log" >&2; exit 1; }
  done
}

# pool_setting <none|value|admin> [user_ini.filename]: www's prepend.
pool_setting() {
  sed -i '/auto_prepend_file\|user_ini.filename/d' "$POOL"
  case "$1" in
    value) echo "php_value[auto_prepend_file] = $GATE" >>"$POOL" ;;
    admin) echo "php_admin_value[auto_prepend_file] = $GATE" >>"$POOL" ;;
  esac
  [ -z "${2:-}" ] || echo "php_admin_value[user_ini.filename] = $2" >>"$POOL"
  restart_fpm
}
# admin_pool <www|plain>: the pool nginx sends the admin domain's PHP to.
admin_pool() {
  local socket=/run/php/php$PHP_VERSION-fpm.sock
  [ "$1" = www ] || socket=/run/php/php$PHP_VERSION-fpm-$1.sock
  echo "fastcgi_pass unix:$socket;" >/etc/nginx/gq-admin-pool.conf
  service nginx reload >/dev/null
  sleep 0.5
}

# --- the held window ----------------------------------------------------------
#
# A poller requests the Site's PHP routes throughout; must-use and plugin
# markers note every web request that ran WordPress or a plugin's own file.
# A deploy's held window runs from its "Held:" line to the hold file going
# (less 100ms for the watcher's granularity):
# no marker may fall in it, and every polled request in it answers 503 (or
# nginx's own 404 while no PHP file exists for the path at all).

POLL_URLS=(/ /wp/wp-login.php /wp/wp-admin/install.php /wp/wp-admin/upgrade.php
  /wp/wp-admin/setup-config.php /app/plugins/gq-support/gq-support.php /app/plugins/sneaky/sneaky.php
  /app/plugins/basedir/basedir.php /app/plugins/basedir/lowmem/lowmem.php)
start_poller() {
  : >"$WORK/polled"
  : >"$WORK/holds"
  rm -f "$WORK/stop-poller"
  (
    while [ ! -e "$WORK/stop-poller" ]; do
      for path in "${POLL_URLS[@]}"; do
        printf '%s %s %s\n' "$(date +%s.%N)" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
          --resolve "$HOST:443:127.0.0.1" "https://$HOST$path" || true)" "$path" >>"$WORK/polled"
      done
    done
  ) &
  poller=$!
  (
    last=""
    while [ ! -e "$WORK/stop-poller" ]; do
      if is_open; then now=off; else now=on; fi
      if [ "$now" != "$last" ]; then echo "$(date +%s.%N) $now" >>"$WORK/holds"; last=$now; fi
      sleep 0.02
    done
  ) &
  watcher=$!
}
stop_poller() {
  touch "$WORK/stop-poller"
  wait "$poller" "$watcher" 2>/dev/null || true
}
# check_held_window <label> <log>
check_held_window() {
  local from to ran polled bad
  from=$(awk '/ Held: / { print $1; exit }' "$2")
  if [ -z "$from" ]; then
    check "$1: the deploy held the Site" failed "no Held: line"
    return
  fi
  to=$(awk -v from="$from" '$1 > from && $2 == "off" { print $1; exit }' "$WORK/holds")
  to="${to:-$(date +%s.%N)}"
  # The watcher sees the hold go within 20ms; requests are stamped when
  # they start. A request (or marker) up to 100ms before that is counted
  # as after the lift.
  to=$(awk -v to="$to" 'BEGIN { printf "%.6f", to - 0.1 }')
  touch "$HOME_DIR/wordpress-ran" "$HOME_DIR/plugin-ran"
  ran=$(cat "$HOME_DIR/wordpress-ran" "$HOME_DIR/plugin-ran" \
    | awk -v from="$from" -v to="$to" '$1 >= from && $1 < to')
  polled=$(awk -v from="$from" -v to="$to" '$1 >= from && $1 < to { print $2 }' "$WORK/polled" \
    | sort | uniq -c | awk '{ printf "%s×%s ", $1, $2 }')
  bad=$(awk -v from="$from" -v to="$to" '$1 >= from && $1 < to && $2 != 503 && $2 != 404' "$WORK/polled")
  check "$1: while held, no WordPress or plugin code ran for a web request (polled ${polled:-nothing})" \
    "$({ [ -z "$ran" ] && [ -z "$bad" ] && [ -n "$polled" ]; } && echo ok)" "${ran}${bad}"
}

run() {
  mkdir -p "$WORK"
  chmod 0777 "$WORK"

  # --- the server -----------------------------------------------------------
  useradd -m -s /bin/bash ploi
  chmod 0755 "$HOME_DIR"
  echo "ploi ALL=(root) NOPASSWD: /usr/sbin/service php$PHP_VERSION-fpm reload" >"$SUDOERS"
  chmod 0440 "$SUDOERS"
  # Two pools of one PHP-FPM: www (the Site's) and plain (no prepend), each
  # static, so their workers change only when PHP-FPM reloads.
  sed -i -e 's/^user = www-data/user = ploi/; s/^group = www-data/group = ploi/' \
    -e 's/^pm = .*/pm = static/; s/^pm.max_children = .*/pm.max_children = 3/' "$POOL"
  sed -e 's/^\[www\]/[plain]/' -e "s#^listen = .*#listen = /run/php/php$PHP_VERSION-fpm-plain.sock#" \
    -e 's/^pm.max_children = .*/pm.max_children = 2/' "$POOL" >"$FPM/pool.d/plain.conf"
  printf 'opcache.enable=1\nopcache.validate_timestamps=0\n' >"$FPM/conf.d/99-gq-smoke.ini"

  local tls=/etc/nginx/gq-smoke
  mkdir -p "$tls"
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=gq smoke CA" \
    -keyout "$tls/ca.key" -out "$tls/ca.crt" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=$HOST" -keyout "$tls/site.key" -out "$tls/site.csr" 2>/dev/null
  printf 'subjectAltName=DNS:%s,DNS:%s\n' "$HOST" "$OTHER_HOST" >"$tls/san.ext"
  openssl x509 -req -in "$tls/site.csr" -CA "$tls/ca.crt" -CAkey "$tls/ca.key" -CAcreateserial \
    -days 2 -extfile "$tls/san.ext" -out "$tls/site.crt" 2>/dev/null
  cp "$tls/ca.crt" /usr/local/share/ca-certificates/gq-smoke.crt
  update-ca-certificates >/dev/null 2>&1

  # The admin domain sends every PHP script to one pool (gq-admin-pool.conf);
  # one script under its web root goes without DOCUMENT_ROOT; a second Site
  # shares pool www.
  cat >/etc/nginx/sites-enabled/default <<NGINX
server {
  listen 443 ssl;
  server_name $HOST;
  ssl_certificate $tls/site.crt;
  ssl_certificate_key $tls/site.key;
  root $WEB;
  index index.php;
  location / { try_files \$uri \$uri/ /index.php?\$query_string; }
  location = /docroot-check.php {
    fastcgi_param SCRIPT_FILENAME \$realpath_root\$fastcgi_script_name;
    fastcgi_param REQUEST_METHOD \$request_method;
    fastcgi_param SCRIPT_NAME \$fastcgi_script_name;
    include /etc/nginx/gq-admin-pool.conf;
  }
  location ~ \.php\$ {
    try_files \$uri /index.php =404;
    fastcgi_split_path_info ^(.+\.php)(/.+)\$;
    fastcgi_index index.php;
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME \$realpath_root\$fastcgi_script_name;
    include /etc/nginx/gq-admin-pool.conf;
  }
}
server {
  listen 443 ssl;
  server_name $OTHER_HOST;
  ssl_certificate $tls/site.crt;
  ssl_certificate_key $tls/site.key;
  root $HOME_DIR/other/web;
  location ~ \.php\$ {
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME \$realpath_root\$fastcgi_script_name;
    fastcgi_pass unix:/run/php/php$PHP_VERSION-fpm.sock;
  }
}
NGINX
  echo "fastcgi_pass unix:/run/php/php$PHP_VERSION-fpm.sock;" >/etc/nginx/gq-admin-pool.conf

  curl -fsSL -o /usr/local/bin/wp https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar
  chmod 0755 /usr/local/bin/wp
  mkdir -p "$SITE" "$HOME_DIR/other/web" "$HOME_DIR/database"
  echo '<?php echo "other site\n";' >"$HOME_DIR/other/web/index.php"
  # Ploi's site-root .env (its environment editor); admin.sh copies it.
  {
    echo "WP_ENV=production"
    echo "WP_HOME=https://$HOST"
    echo "WP_SITEURL=https://$HOST/wp"
    echo "DB_NAME=wordpress"
    echo "DB_USER=wordpress"
    echo "DB_PASSWORD=wordpress"
    for key in AUTH_KEY SECURE_AUTH_KEY LOGGED_IN_KEY NONCE_KEY AUTH_SALT SECURE_AUTH_SALT LOGGED_IN_SALT NONCE_SALT; do
      echo "$key=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
    done
  } >"$SITE/.env"
  chown -R ploi:ploi "$HOME_DIR"
  restart_fpm
  service nginx start >/dev/null

  # --- the reviewed human bootstrap: the gate first, then the pool setting --
  local code=0 status label nonce held slow deployer session
  admission prepare >"$WORK/prepare" 2>&1 || code=$?
  check "bootstrap: admission.sh prepare installs the gate, writes no admission state (so the Site is held) and installs no package" \
    "$({ [ "$code" = 0 ] && [ -f "$GATE" ] && [ ! -e "$STATE" ] && [ ! -e "$WEB/wp" ] && [ -d "$WEB/gq-admission" ]; } && echo ok)" \
    "$(cat "$WORK/prepare")"

  # --- false controls: only php_admin_value on the serving pool enforces it -
  for setting in none value user-ini custom-value plain-pool; do
    case "$setting" in
      none) pool_setting none; label="no prepend" ;;
      value) pool_setting value; label="php_value prepend" ;;
      user-ini)
        pool_setting none
        echo "auto_prepend_file = $GATE" >"$WEB/.user.ini"
        chown ploi:ploi "$WEB/.user.ini"
        label="a root .user.ini prepend"
        ;;
      custom-value) pool_setting value .htuser; label="php_value prepend with user_ini.filename .htuser" ;;
      plain-pool)
        pool_setting admin
        admin_pool plain
        label="php_admin_value on www, but nginx sends the admin domain to pool plain of the same PHP-FPM"
        ;;
    esac
    code=0
    deploy r1 "$WORK/false-$setting.log" || code=$?
    check "false control, $label: the deploy refuses before any hold or package change" \
      "$({ [ "$code" != 0 ] && grep -q "ran without the gate" "$WORK/false-$setting.log" \
        && [ ! -e "$WEB/wp" ] && [ ! -e "$APP/vendor" ] && [ ! -e "$STATE" ] \
        && [ -z "$(ls -A "$WEB/gq-admission")" ]; } && echo ok)" "exit $code: $(tail -n 3 "$WORK/false-$setting.log")"
    rm -f "$WEB/.user.ini"
  done
  admin_pool www
  pool_setting admin

  # The gate missing under the pool setting fails closed, which is why the
  # bootstrap installs it first.
  mv "$GATE" "$GATE.away"
  echo '<?php echo "x";' >"$WEB/x.php"
  chown ploi:ploi "$WEB/x.php"
  status=$(request "https://$HOST/x.php")
  check "a missing gate under php_admin_value fails closed (PHP answers $status)" "$({ [ "$status" = 500 ]; } && echo ok)"
  mv "$GATE.away" "$GATE"
  rm -f "$WEB/x.php"

  # --- a pre-hold request with PHP-FPM's default process_control_timeout ----
  # From an open Site (as a finished deploy leaves it): without a state the
  # Site is held, and the request wouldn't run at all.
  admission lift >/dev/null
  echo '<?php usleep(8000000); file_put_contents("/home/ploi/slow-abrupt", "done"); echo "slow\n";' >"$WEB/slow-abrupt.php"
  chown ploi:ploi "$WEB/slow-abrupt.php"
  (request "https://$HOST/slow-abrupt.php" >"$WORK/abrupt") &
  slow=$!
  sleep 1
  code=0
  admission begin >"$WORK/begin-abrupt" 2>&1 || code=$?
  wait "$slow" || true
  check "default process_control_timeout: the reload ends the pre-hold request (502, never finished) before begin returns" \
    "$({ [ "$code" = 0 ] && [ "$(cat "$WORK/abrupt")" = 502 ] && [ ! -e "$HOME_DIR/slow-abrupt" ]; } && echo ok)" \
    "exit $code, status $(cat "$WORK/abrupt"): $(cat "$WORK/begin-abrupt")"
  admission lift >/dev/null
  rm -f "$WEB/slow-abrupt.php"
  sed -i 's/^\[global\]$/[global]\nprocess_control_timeout = 20s/' "$FPM/php-fpm.conf"
  restart_fpm

  start_poller

  # --- first bootstrap: no WordPress core, no web/index.php -----------------
  code=0
  deploy r1 "$WORK/first.log" || code=$?
  check "first guarded deploy without core or web/index.php, through the real admin.sh" \
    "$({ [ "$code" = 0 ] && [ -f "$WEB/wp/wp-settings.php" ] && [ -f "$WEB/index.php" ] && is_open \
      && grep -q "Verified getquick/gq-support 0.1.11" "$WORK/first.log"; } && echo ok)" "exit $code: $(tail -n 5 "$WORK/first.log")"
  check_held_window "first deploy" "$WORK/first.log"
  code=0
  wp core install --url="https://$HOST" --title=Acme --admin_user=editor \
    --admin_password=editor-password --admin_email=editor@example.test --skip-email >"$WORK/install" 2>&1 || code=$?
  check "WordPress installs after the first deploy (as an administrator would)" "$({ [ "$code" = 0 ]; } && echo ok)" "$(cat "$WORK/install")"

  # --- the installed Site, a pre-hold request draining ----------------------
  (curl -s -o /dev/null -w '%{http_code}' --max-time 40 --resolve "$HOST:443:127.0.0.1" \
    "https://$HOST/slow.php?ms=6000&tag=graceful" >"$WORK/graceful") &
  slow=$!
  sleep 1
  code=0
  deploy r1 "$WORK/second.log" || code=$?
  wait "$slow" || true
  check "an installed Site's guarded deploy activates the theme and plugins and finishes" \
    "$({ [ "$code" = 0 ] && is_open && [ "$(wp theme list --status=active --field=name)" = getquick-theme ] \
      && wp plugin is-active gq-support; } && echo ok)" "exit $code: $(tail -n 5 "$WORK/second.log")"
  held=$(awk '/ Held: / { print $1; exit }' "$WORK/second.log")
  check "a request that started before the hold finished (200) before the hold was proven" \
    "$({ [ "$(cat "$WORK/graceful")" = 200 ] && [ -n "$held" ] \
      && awk -v a="$(cat "$HOME_DIR/slow-graceful" 2>/dev/null || echo 9e99)" -v b="$held" 'BEGIN { exit !(a < b) }'; } && echo ok)" \
    "status $(cat "$WORK/graceful")"
  check_held_window "installed deploy" "$WORK/second.log"

  # --- core reinstalled, and a nested override arriving during Composer -----
  rm -rf "$WEB/wp"
  code=0
  deploy r2 "$WORK/sneaky.log" || code=$?
  check "a deploy that reinstalls core and installs a package shipping .user.ini (auto_prepend_file =) finishes" \
    "$({ [ "$code" = 0 ] && [ -f "$WEB/wp/wp-settings.php" ] && [ -f "$WEB/app/plugins/sneaky/.user.ini" ]; } && echo ok)" \
    "exit $code: $(tail -n 5 "$WORK/sneaky.log")"
  check_held_window "core reinstall with a nested override" "$WORK/sneaky.log"
  status=$(request "https://$HOST/app/plugins/sneaky/sneaky.php")
  check "lifted: the package's nested .user.ini doesn't turn the pool's prepend off" \
    "$({ [ "$status" = 200 ] && grep -qx "sneaky ran; prepend=$GATE" "$WORK/body"; } && echo ok)" "$status $(cat "$WORK/body")"

  # A package whose .user.ini keeps PHP from reading the admission state
  # (open_basedir), or starves it (memory_limit), is held even while open:
  # its scripts never run, which is the cost of failing closed.
  status=$(request "https://$HOST/app/plugins/basedir/basedir.php")
  check "open: a package's nested open_basedir that hides the state holds its own scripts (503), never runs them" \
    "$({ [ "$status" = 503 ] && [ "$(gate_header)" = invalid ] && ! grep -q basedir "$HOME_DIR/plugin-ran"; } && echo ok)" \
    "$status $(gate_header)"
  status=$(request "https://$HOST/app/plugins/basedir/lowmem/lowmem.php")
  check "open: a package directory whose .user.ini starves memory doesn't run its script (PHP answers $status)" \
    "$({ [ "$status" != 200 ] && ! grep -q lowmem "$HOME_DIR/plugin-ran" \
      && ! tr -d '\r' <"$WORK/headers" | grep -qi '^x-gq-smoke-ran:'; } && echo ok)" "$status"

  # --- a late extension failure keeps the hold ------------------------------
  code=0
  deploy r3 "$WORK/late.log" || code=$?
  check "a deploy whose extension fails after verification exits 4 and stays held" \
    "$({ [ "$code" = 4 ] && is_held; } && echo ok)" "exit $code"
  check_held_window "late failure" "$WORK/late.log"

  # While held: every PHP route and a plugin's own file; a script without
  # DOCUMENT_ROOT; static files and another Site in the same pool aren't
  # held; WP-CLI works.
  nonce=$(sed -n 's/^held \([0-9a-f]\{32\}\)$/\1/p' "$STATE" 2>/dev/null || true)
  for path in / /wp/wp-login.php /wp/wp-admin/ /wp/wp-admin/install.php /wp/wp-admin/upgrade.php \
    /wp/wp-admin/setup-config.php /wp/xmlrpc.php /wp-json/ /app/plugins/gq-support/gq-support.php \
    /app/plugins/sneaky/sneaky.php /no-such-page/; do
    status=$(request "https://$HOST$path")
    check "held: $path answers 503 with the hold's nonce" \
      "$({ [ "$status" = 503 ] && [ "$(gate_header)" = "$nonce" ]; } && echo ok)" "$status $(gate_header)"
  done
  echo '<?php file_put_contents("/home/ploi/plugin-ran", sprintf("%.6f docroot\n", microtime(true)), FILE_APPEND); echo "ran";' \
    >"$WEB/docroot-check.php"
  chown ploi:ploi "$WEB/docroot-check.php"
  status=$(request "https://$HOST/docroot-check.php")
  check "held: a script under the web root that reaches PHP without DOCUMENT_ROOT is held" \
    "$({ [ "$status" = 503 ] && ! grep -q docroot "$HOME_DIR/plugin-ran" 2>/dev/null; } && echo ok)" "$status"
  rm -f "$WEB/docroot-check.php"
  status=$(request "https://$HOST/wp/wp-includes/css/dashicons.min.css")
  check "held: a static file is still served (the gate covers PHP only)" "$({ [ "$status" = 200 ]; } && echo ok)" "$status"
  status=$(request "https://$OTHER_HOST/index.php")
  check "held: another Site's PHP in the same pool isn't held" \
    "$({ [ "$status" = 200 ] && [ -z "$(gate_header)" ]; } && echo ok)" "$status"
  check "held: WP-CLI runs (a recovery)" "$({ [ "$(wp option get siteurl)" = "https://$HOST/wp" ]; } && echo ok)"

  # --- a failed begin keeps an earlier hold --------------------------------
  mv "$SUDOERS" "$WORK/sudoers"
  code=0
  deploy r2 "$WORK/no-reload.log" || code=$?
  mv "$WORK/sudoers" "$SUDOERS"
  check "a deploy whose reload is refused fails before any package change and keeps the earlier hold" \
    "$({ [ "$code" != 0 ] && is_held && grep -q "The Site stays held." "$WORK/no-reload.log" \
      && ! grep -q "Verified" "$WORK/no-reload.log"; } && echo ok)" "exit $code: $(tail -n 3 "$WORK/no-reload.log")"

  # --- recovery: another guarded deploy lifts it -----------------------------
  code=0
  deploy r2 "$WORK/recover.log" || code=$?
  status=$(request "https://$HOST/wp/wp-login.php")
  check "recovery: a guarded deploy of an approved release lifts the earlier hold" \
    "$({ [ "$code" = 0 ] && is_open && [ "$status" = 200 ]; } && echo ok)" "exit $code, $status"

  # --- killed during Composer's core install; then recovered ----------------
  rm -rf "$WEB/wp"
  tar -czf /work/archives/r2.tar.gz -C /work/releases/r2 .
  (cd "$SITE" && as_ploi env PLOI_SITE_PATH="$SITE" ARCHIVE_URL=file:///work/archives/r2.tar.gz \
    COMPOSER_AUTH='{"http-basic":{}}' COMPOSER_HOME="$HOME_DIR/.composer" \
    setsid bash /work/releases/r2/deploy/ploi/admin.sh >"$WORK/killed.log" 2>&1) &
  deployer=$!
  for _ in $(seq 1 600); do pgrep -u ploi -f "composer install" >/dev/null && break; sleep 0.05; done
  session=$(ps -o sid= -p "$(pgrep -o -u ploi -f "composer install" || echo 0)" 2>/dev/null | tr -d ' ' || true)
  [ -z "$session" ] || pkill -KILL -s "$session" || true
  wait "$deployer" 2>/dev/null || true
  status=$(request "https://$HOST/wp/wp-login.php")
  check "a deploy killed while Composer installs (no trap runs) stays held" \
    "$({ [ -n "$session" ] && is_held && [ "$status" = 503 ]; } && echo ok)" "session ${session:-none}, $status"
  code=0
  deploy r2 "$WORK/recover-killed.log" || code=$?
  status=$(request "https://$HOST/wp/wp-login.php")
  check "recovery after the kill: the next guarded deploy restores core and lifts the hold" \
    "$({ [ "$code" = 0 ] && [ -f "$WEB/wp/wp-settings.php" ] && is_open && [ "$status" = 200 ]; } && echo ok)" \
    "exit $code, $status: $(tail -n 3 "$WORK/recover-killed.log")"
  check_held_window "recovery after the kill" "$WORK/recover-killed.log"

  # --- only a positive "open" serves: the state tampered with, on PHP-FPM ---
  local tamper
  for tamper in unreadable malformed absent symlink directory; do
    case "$tamper" in
      unreadable) chmod 000 "$STATE" ;;
      malformed) printf 'opened\n' >"$STATE" ;;
      absent) rm -f "$STATE" ;;
      symlink)
        printf 'open\n' >"$HOME_DIR/open-elsewhere"
        rm -f "$STATE"
        ln -s "$HOME_DIR/open-elsewhere" "$STATE"
        ;;
      directory) rm -f "$STATE" && mkdir "$STATE" ;;
    esac
    status=$(request "https://$HOST/wp/wp-login.php")
    check "a state that is $tamper holds every PHP request (503), opcache.validate_timestamps=0 and no reload" \
      "$({ [ "$status" = 503 ]; } && echo ok)" "$status"
    rm -rf "$STATE"
    printf 'open\n' >"$STATE"
    chown ploi:ploi "$STATE"
    chmod 0644 "$STATE"
  done
  status=$(request "https://$HOST/wp/wp-login.php")
  check "the state back to exactly open serves again at once, no reload" "$({ [ "$status" = 200 ]; } && echo ok)" "$status"

  # --- a custom user_ini.filename is challenged too -------------------------
  pool_setting admin .htuser
  code=0
  deploy r2 "$WORK/htuser.log" || code=$?
  check "php_admin_value with user_ini.filename .htuser: the challenge covers .htuser and the deploy finishes" \
    "$({ [ "$code" = 0 ] && is_open && [ -z "$(ls -A "$WEB/gq-admission")" ]; } && echo ok)" \
    "exit $code: $(tail -n 3 "$WORK/htuser.log")"

  stop_poller
  check "the poller ran throughout ($(wc -l <"$WORK/polled") requests)" "$({ [ "$(wc -l <"$WORK/polled")" -gt 100 ]; } && echo ok)"

  if [ "$failures" -gt 0 ]; then
    for log in "$WORK"/*.log; do
      echo "--- $log"
      tail -n 12 "$log"
    done
    echo "--- nginx error log"
    tail -n 12 /var/log/nginx/error.log || true
    echo "$failures check(s) failed."
    exit 1
  fi
  echo "A guarded Site's generated admin.sh, with its pool-enforced request admission, held every PHP request on real nginx and PHP-FPM before any WordPress or plugin code ran: first bootstrap, a core reinstall with a nested override, a late failure, a refused reload, a kill, and their recoveries."
}

case "${1:-}" in
  fixtures) fixtures ;;
  run) run ;;
  *)
    echo "Usage: stack.sh fixtures | run" >&2
    exit 2
    ;;
esac

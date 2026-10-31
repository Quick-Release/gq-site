#!/usr/bin/env bash
#
# Runs inside the disposable admission smoke container (see ../admission.sh),
# as root: sets the stack up as a Ploi server has it (a `ploi` user owning the
# Site and running PHP-FPM's pool, allowed exactly `sudo -n service
# php<version>-fpm reload`), then drives the generated admission.sh as that
# user. /src is the generated guarded site.

set -euo pipefail

PHP_VERSION=8.3
HOST=cms.acme.test
HOME_DIR=/home/ploi
SITE=$HOME_DIR/$HOST
APP=$SITE/apps/cms
WEB=$APP/web
HOLD=$SITE/.gq/hold
GATE=$SITE/.gq/admission.php
INI=$WEB/.user.ini
FPM_CONF=/etc/php/$PHP_VERSION/fpm/php-fpm.conf
SUDOERS=/etc/sudoers.d/ploi-fpm

failures=0
check() {
  if [ "$2" = ok ]; then
    echo "ok   $1"
  else
    echo "FAIL $1${3:+: $3}"
    failures=$((failures + 1))
  fi
}
# check_that <label> <command...>: passes when the command succeeds.
check_that() {
  local label="$1"
  shift
  if "$@"; then check "$label" ok; else check "$label" failed; fi
}
as_ploi() {
  runuser -u ploi -- env HOME="$HOME_DIR" PATH=/usr/local/bin:/usr/bin:/bin "$@"
}
# admission <begin|lift> [VARIABLE=value...]
admission() {
  local command="$1"
  shift
  as_ploi env SITE_PATH="$SITE" APP_PATH=apps/cms "$@" bash "$SITE/deploy/ploi/admission.sh" "$command"
}
wp() {
  as_ploi bash -c 'cd "$1" && shift && wp "$@"' _ "$APP" "$@"
}
# The status of a request; its headers in $WORK/headers.
WORK=$(mktemp -d)
request() {
  curl -sS -o "$WORK/body" -D "$WORK/headers" -w '%{http_code}' --max-time 30 \
    --resolve "$HOST:443:127.0.0.1" "$@" 2>/dev/null || echo 000
}
nonce_header() {
  tr -d '\r' <"$WORK/headers" | sed -n 's/^[Xx]-[Gg][Qq]-[Hh]old: //p'
}
# The workers of this PHP-FPM, as "<pid> <start time>".
workers() {
  ps -e -o pid= -o comm= -o lstart= -o args= \
    | awk '$2 ~ /^php-fpm/ && index($0, "php-fpm: pool ") { print $1, $3, $4, $5, $6, $7 }' | sort
}
digest() { sha256sum "$@" | awk '{ print $1 }'; }

# --- the server ---------------------------------------------------------------

useradd -m -s /bin/bash ploi
chmod 0755 "$HOME_DIR"
echo "ploi ALL=(root) NOPASSWD: /usr/sbin/service php$PHP_VERSION-fpm reload" >"$SUDOERS"
chmod 0440 "$SUDOERS"
pool=/etc/php/$PHP_VERSION/fpm/pool.d/www.conf
# A static pool: its workers change only when PHP-FPM reloads.
sed -i -e 's/^user = www-data/user = ploi/; s/^group = www-data/group = ploi/' \
  -e 's/^pm = .*/pm = static/; s/^pm.max_children = .*/pm.max_children = 4/' "$pool"
printf 'opcache.enable=1\nopcache.validate_timestamps=0\n' \
  >"/etc/php/$PHP_VERSION/fpm/conf.d/99-gq-smoke.ini"

# A throwaway CA the container trusts, and the admin domain's certificate.
tls=/etc/nginx/gq-smoke
mkdir -p "$tls"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=gq smoke CA" \
  -keyout "$tls/ca.key" -out "$tls/ca.crt" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=$HOST" \
  -keyout "$tls/site.key" -out "$tls/site.csr" 2>/dev/null
printf 'subjectAltName=DNS:%s\n' "$HOST" >"$tls/san.ext"
openssl x509 -req -in "$tls/site.csr" -CA "$tls/ca.crt" -CAkey "$tls/ca.key" -CAcreateserial \
  -days 2 -extfile "$tls/san.ext" -out "$tls/site.crt" 2>/dev/null
cp "$tls/ca.crt" /usr/local/share/ca-certificates/gq-smoke.crt
update-ca-certificates >/dev/null 2>&1

# nginx as Ploi configures a Site: files as they are, everything else through
# index.php, PHP through FPM.
cat >/etc/nginx/sites-enabled/default <<NGINX
server {
  listen 443 ssl;
  server_name $HOST;
  ssl_certificate $tls/site.crt;
  ssl_certificate_key $tls/site.key;
  root $WEB;
  index index.php;
  location / { try_files \$uri \$uri/ /index.php?\$query_string; }
  location ~ \.php\$ {
    try_files \$uri /index.php =404;
    fastcgi_split_path_info ^(.+\.php)(/.+)\$;
    fastcgi_pass unix:/run/php/php$PHP_VERSION-fpm.sock;
    fastcgi_index index.php;
    fastcgi_param SCRIPT_FILENAME \$realpath_root\$fastcgi_script_name;
    include fastcgi_params;
  }
}
NGINX

# --- the Site: the generated Bedrock config and WordPress through Composer -----

curl -fsSL -o /usr/local/bin/wp https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar
chmod 0755 /usr/local/bin/wp
mkdir -p "$SITE/deploy/ploi" "$WEB/app/plugins/gq-probe" "$WEB/app/mu-plugins" "$WEB/app/themes"
cp /src/deploy/ploi/admission.sh "$SITE/deploy/ploi/admission.sh"
cp -r /src/apps/cms/config "$APP/config"
cp /src/apps/cms/web/index.php /src/apps/cms/web/wp-config.php "$WEB/"
cp /src/apps/cms/wp-cli.yml "$APP/"
cat >"$APP/composer.json" <<JSON
{
  "require": {
    "roots/wordpress": "$WORDPRESS_VERSION",
    "roots/wp-config": "^1.0",
    "oscarotero/env": "^2.0",
    "vlucas/phpdotenv": "^5.0"
  },
  "config": { "allow-plugins": { "roots/wordpress-core-installer": true } },
  "extra": { "wordpress-install-dir": "web/wp" }
}
JSON
cat >"$APP/.env" <<ENV
WP_ENV=production
WP_HOME=https://$HOST
WP_SITEURL=https://$HOST/wp
DB_NAME=wordpress
DB_USER=wordpress
DB_PASSWORD=wordpress
ENV
for key in AUTH_KEY SECURE_AUTH_KEY LOGGED_IN_KEY NONCE_KEY AUTH_SALT SECURE_AUTH_SALT LOGGED_IN_SALT NONCE_SALT; do
  echo "$key=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')" >>"$APP/.env"
done
# WordPress on SQLite: the integration's drop-in.
curl -fsSL -o "$WORK/sqlite.zip" \
  https://downloads.wordpress.org/plugin/sqlite-database-integration.latest-stable.zip
unzip -q "$WORK/sqlite.zip" -d "$WEB/app/plugins"
sqlite=$WEB/app/plugins/sqlite-database-integration
sed -e "s#{SQLITE_IMPLEMENTATION_FOLDER_PATH}#$sqlite#g" \
  -e "s#{SQLITE_PLUGIN}#sqlite-database-integration/load.php#g" "$sqlite/db.copy" >"$WEB/app/db.php"
# Markers: a must-use plugin noting every web request WordPress handles, a
# plugin's own PHP file noting each time it runs, a slow script, and one
# showing PHP's settings.
cat >"$WEB/app/mu-plugins/gq-marker.php" <<'PHP'
<?php
if (PHP_SAPI !== 'cli') {
    file_put_contents('/home/ploi/wordpress-ran', ($_SERVER['REQUEST_URI'] ?? '') . "\n", FILE_APPEND);
}
PHP
cat >"$WEB/app/plugins/gq-probe/gq-probe.php" <<'PHP'
<?php
/* Plugin Name: gq probe */
file_put_contents('/home/ploi/plugin-ran', ($_SERVER['REQUEST_URI'] ?? '') . "\n", FILE_APPEND);
echo "plugin ran\n";
PHP
cat >"$WEB/slow.php" <<'PHP'
<?php
usleep((int) ($_GET['ms'] ?? 6000) * 1000);
file_put_contents('/home/ploi/slow-' . preg_replace('/[^a-z0-9]/', '', $_GET['tag'] ?? 'x'), sprintf("%.3f\n", microtime(true)));
echo "slow done\n";
PHP
cat >"$WEB/settings.php" <<'PHP'
<?php
echo ini_get('memory_limit'), ' ', ini_get('auto_prepend_file'), ' ', ini_get('opcache.validate_timestamps'),
    ' ', (function_exists('opcache_get_status') && (opcache_get_status(false)['opcache_enabled'] ?? false)) ? 'opcache' : 'no-opcache', "\n";
PHP
# A setting of the Site's own, which the admission must keep.
printf 'memory_limit = 200M\n' >"$INI"
chown -R ploi:ploi "$HOME_DIR"

as_ploi bash -c "cd '$APP' && composer install -q --no-interaction"
wp core install --url="https://$HOST" --title=Acme --admin_user=editor \
  --admin_password=editor-password --admin_email=editor@example.test --skip-email >/dev/null

service "php$PHP_VERSION-fpm" start >/dev/null
service nginx start >/dev/null

status=$(request "https://$HOST/wp/wp-login.php")
check "before: WordPress serves its login page over TLS for $HOST" "$([ "$status" = 200 ] && echo ok)" "$status"
: >"$HOME_DIR/wordpress-ran"

# --- a pre-hold request, with PHP-FPM's default process_control_timeout -------

curl -sS -o /dev/null -w '%{http_code}' --max-time 30 --resolve "$HOST:443:127.0.0.1" \
  "https://$HOST/slow.php?ms=8000&tag=abrupt" >"$WORK/abrupt" 2>/dev/null &
slow=$!
sleep 1
if admission begin >"$WORK/begin" 2>&1; then begun=ok; else begun=failed; fi
wait "$slow" || true
check "default process_control_timeout: begin succeeds" "$begun" "$(cat "$WORK/begin")"
check "default process_control_timeout: the reload ended the pre-hold request before begin returned (502, never finished)" \
  "$([ "$(cat "$WORK/abrupt")" = 502 ] && [ ! -e "$HOME_DIR/slow-abrupt" ] && echo ok)" \
  "status $(cat "$WORK/abrupt")"
admission lift >/dev/null

status=$(request "https://$HOST/settings.php")
read -r memory prepend validate opcache <"$WORK/body"
check "lifted: the Site's own .user.ini setting stays (memory_limit $memory)" "$([ "$memory" = 200M ] && echo ok)"
check "lifted: PHP-FPM prepends the gate" "$([ "$prepend" = "$GATE" ] && echo ok)" "$prepend"
check "PHP-FPM runs with opcache on and validate_timestamps=0" \
  "$([ "$validate" = 0 ] && [ "$opcache" = opcache ] && echo ok)" "$validate $opcache"

# --- a pre-hold request, with a graceful reload -------------------------------

sed -i 's/^\[global\]$/[global]\nprocess_control_timeout = 20s/' "$FPM_CONF"
service "php$PHP_VERSION-fpm" restart >/dev/null
sleep 1

curl -sS -o /dev/null -w '%{http_code}' --max-time 30 --resolve "$HOST:443:127.0.0.1" \
  "https://$HOST/slow.php?ms=6000&tag=graceful" >"$WORK/graceful" 2>/dev/null &
slow=$!
sleep 1
if admission begin >"$WORK/begin" 2>&1; then begun=ok; else begun=failed; fi
begun_at=$(date +%s.%N)
wait "$slow" || true
nonce=$(cat "$HOLD" 2>/dev/null || true)
check "graceful reload: begin succeeds" "$begun" "$(cat "$WORK/begin")"
check "graceful reload: the pre-hold request finished (200) before begin returned" \
  "$([ "$(cat "$WORK/graceful")" = 200 ] && [ -e "$HOME_DIR/slow-graceful" ] \
    && awk -v a="$(cat "$HOME_DIR/slow-graceful")" -v b="$begun_at" 'BEGIN { exit !(a < b) }' && echo ok)" \
  "status $(cat "$WORK/graceful")"

# --- held ----------------------------------------------------------------------

: >"$HOME_DIR/wordpress-ran"
for path in / /wp/wp-login.php /wp/wp-admin/ /wp/wp-admin/install.php /wp/wp-admin/upgrade.php \
  /wp/wp-admin/setup-config.php /wp/xmlrpc.php /wp-json/ /app/plugins/gq-probe/gq-probe.php \
  "/slow.php?ms=1&tag=held" /no-such-page/; do
  status=$(request "https://$HOST$path")
  check "held: $path answers 503 with the hold's nonce" \
    "$([ "$status" = 503 ] && [ "$(nonce_header)" = "$nonce" ] && echo ok)" "$status $(nonce_header)"
done
status=$(request -X POST -d log=editor -d pwd=editor-password "https://$HOST/wp/wp-login.php")
check "held: a login POST answers 503" "$([ "$status" = 503 ] && echo ok)" "$status"
check_that "held: no-store, Retry-After, and a body naming nothing" \
  bash -c "tr -d '\r' <'$WORK/headers' | grep -qix 'cache-control: no-store' \
    && tr -d '\r' <'$WORK/headers' | grep -qi '^retry-after: ' \
    && [ \"\$(cat '$WORK/body')\" = 'This site is temporarily unavailable.' ]"
check "held: no WordPress or plugin code ran for any web request" \
  "$([ ! -s "$HOME_DIR/wordpress-ran" ] && [ ! -e "$HOME_DIR/plugin-ran" ] && [ ! -e "$HOME_DIR/slow-held" ] && echo ok)"
status=$(request "https://$HOST/wp/wp-includes/css/dashicons.min.css")
check "held: a static file is still served (the gate covers PHP only)" "$([ "$status" = 200 ] && echo ok)" "$status"

check "held: WP-CLI runs (a recovery)" \
  "$([ "$(wp option get siteurl)" = "https://$HOST/wp" ] && echo ok)"
check "held: WordPress isn't in maintenance mode for WP-CLI" \
  "$([ "$(wp eval 'echo wp_is_maintenance_mode() ? "on" : "off";')" = off ] && echo ok)"

# A real Composer reinstall that deletes web/wp, with requests meanwhile.
before=$(digest "$GATE" "$HOLD" "$INI")
(
  while [ ! -e "$WORK/stop" ]; do
    for path in / /wp/wp-admin/setup-config.php /wp/wp-admin/install.php; do
      request "https://$HOST$path" >>"$WORK/during"
      echo >>"$WORK/during"
    done
  done
) &
poller=$!
# A file Composer doesn't know: gone afterwards only if web/wp was deleted.
as_ploi touch "$WEB/wp/gq-left-behind"
as_ploi bash -c "cd '$APP' && composer reinstall --no-interaction roots/wordpress-no-content" \
  >"$WORK/composer" 2>&1 && reinstalled=ok || reinstalled=failed
touch "$WORK/stop"
wait "$poller" || true
check "held: Composer deleted web/wp and reinstalled WordPress" \
  "$([ "$reinstalled" = ok ] && [ ! -e "$WEB/wp/gq-left-behind" ] && [ -f "$WEB/wp/wp-settings.php" ] && echo ok)" \
  "$(cat "$WORK/composer")"
check "held: the gate, the hold and .user.ini are untouched by Composer" \
  "$([ "$(digest "$GATE" "$HOLD" "$INI")" = "$before" ] && echo ok)"
check "held: every request during the reinstall answered 503 ($(grep -c . "$WORK/during") requests)" \
  "$([ -s "$WORK/during" ] && ! grep -qv '^503$' "$WORK/during" && echo ok)" \
  "$(sort "$WORK/during" | uniq -c | tr '\n' ' ')"
check "held: no WordPress code ran during the reinstall" "$([ ! -s "$HOME_DIR/wordpress-ran" ] && echo ok)"

# --- lifted without a reload, held again without one ----------------------------

before=$(workers)
admission lift >/dev/null
status=$(request "https://$HOST/wp/wp-login.php")
check "lift: WordPress serves again at once, without a reload" \
  "$([ "$status" = 200 ] && [ -z "$(nonce_header)" ] && [ "$(workers)" = "$before" ] && echo ok)" "$status"
echo 0123456789abcdef0123456789abcdef >"$HOLD"
chown ploi:ploi "$HOLD"
status=$(request "https://$HOST/wp/wp-login.php")
check "a hold placed without a reload holds at once (opcache.validate_timestamps=0)" \
  "$([ "$status" = 503 ] && [ "$(nonce_header)" = 0123456789abcdef0123456789abcdef ] && echo ok)" "$status"
rm -f "$HOLD"

# --- a deploy killed, or failing late, after begin stays held ---------------------

cat >"$WORK/deploy.sh" <<DEPLOY
set -e
SITE_PATH="$SITE" APP_PATH=apps/cms bash "$SITE/deploy/ploi/admission.sh" begin
echo composing
cd "$APP" && composer reinstall -q --no-interaction roots/wordpress-no-content
sleep "\${LINGER:-0}"
[ -z "\${LATE_FAILURE:-}" ] || exit 9
SITE_PATH="$SITE" APP_PATH=apps/cms bash "$SITE/deploy/ploi/admission.sh" lift
DEPLOY
chmod 0755 "$WORK" "$WORK/deploy.sh"

as_ploi env LINGER=30 setsid bash "$WORK/deploy.sh" >"$WORK/killed" 2>&1 &
deployer=$!
for _ in $(seq 1 600); do grep -q composing "$WORK/killed" && break; sleep 0.1; done
sleep 0.3
session=$(ps -o sid= -p "$(pgrep -o -u ploi -f "$WORK/deploy.sh")" | tr -d ' ')
pkill -KILL -s "$session"
wait "$deployer" 2>/dev/null || true
status=$(request "https://$HOST/wp/wp-login.php")
check "a deploy killed mid-install (no trap runs) stays held" \
  "$(grep -q composing "$WORK/killed" && [ -f "$HOLD" ] && [ "$status" = 503 ] && echo ok)" "$status"
# The recovery: WordPress's files back (WP-CLI and Composer work while held),
# then the hold lifted.
as_ploi bash -c "cd '$APP' && if [ -f web/wp/wp-settings.php ]; then composer reinstall -q --no-interaction roots/wordpress-no-content; else rm -rf web/wp && composer install -q --no-interaction; fi"
admission lift >/dev/null

if as_ploi env LATE_FAILURE=1 bash "$WORK/deploy.sh" >"$WORK/late" 2>&1; then late=0; else late=$?; fi
status=$(request "https://$HOST/wp/wp-login.php")
check "a deploy failing late (an extension) stays held" \
  "$([ "$late" = 9 ] && [ -f "$HOLD" ] && [ "$status" = 503 ] && echo ok)" "exit $late, $status"

# --- a failed begin removes only its own hold -------------------------------------

mv "$SUDOERS" "$WORK/sudoers"
if admission begin >"$WORK/kept" 2>&1; then kept=0; else kept=$?; fi
status=$(request "https://$HOST/wp/wp-login.php")
check "a failed begin keeps the hold an earlier failed deploy left" \
  "$([ "$kept" != 0 ] && [ -f "$HOLD" ] && [ "$status" = 503 ] \
    && grep -q "The hold an earlier failed deploy left stays" "$WORK/kept" && echo ok)" "$(cat "$WORK/kept")"
admission lift >/dev/null
if admission begin >"$WORK/removed" 2>&1; then removed=0; else removed=$?; fi
status=$(request "https://$HOST/wp/wp-login.php")
check "a failed begin removes the hold it placed, and says what it changed" \
  "$([ "$removed" != 0 ] && [ ! -e "$HOLD" ] && [ "$status" = 200 ] \
    && grep -q "No package file was changed;" "$WORK/removed" \
    && grep -q "The hold this attempt placed was removed" "$WORK/removed" && echo ok)" "$(cat "$WORK/removed")"
mv "$WORK/sudoers" "$SUDOERS"

# --- a prepend gq didn't write is refused ------------------------------------------

printf 'memory_limit = 200M\nauto_prepend_file = /home/ploi/other.php\n' >"$INI"
chown ploi:ploi "$INI"
before=$(workers)
ini_before=$(digest "$INI")
if admission begin >"$WORK/conflict" 2>&1; then conflict=0; else conflict=$?; fi
check "a .user.ini prepend gq didn't write is refused, before any change or reload" \
  "$([ "$conflict" != 0 ] && [ "$(digest "$INI")" = "$ini_before" ] && [ ! -e "$HOLD" ] \
    && [ "$(workers)" = "$before" ] && grep -q "won't replace or chain" "$WORK/conflict" && echo ok)" \
  "exit $conflict, hold $([ -e "$HOLD" ] && echo present || echo absent), workers $([ "$(workers)" = "$before" ] && echo same || echo changed): $(cat "$WORK/conflict")"

if [ "$failures" -gt 0 ]; then
  echo "--- nginx error log"
  tail -n 20 /var/log/nginx/error.log || true
  echo "--- PHP-FPM log"
  tail -n 20 "/var/log/php$PHP_VERSION-fpm.log" || true
  echo "$failures check(s) failed."
  exit 1
fi
echo "A guarded Site's request admission holds every PHP request on real nginx and PHP-FPM (opcache.validate_timestamps=0) before any WordPress code runs, drains pre-hold requests before begin returns, survives a Composer reinstall, kills and late failures, and lifts without a reload."

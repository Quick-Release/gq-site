// Runs a CMS deploy script as Ploi runs it, against a release archive and a
// site directory in a temporary directory. wp, composer, rsync, curl, php and
// sudo are stubs on PATH that append each call to a log (tool, then each
// argument, tab-separated); nothing reaches a network, a database or the
// caller's own tools. rsync copies (without deleting) so shipped files land;
// curl copies the archive from a local path.
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { temporaryDirectory } from "./fixture-site.mjs";

const RELEASE_SHA = "0123abcd";

const RECORD = `record() { local line="$1"; shift; for arg in "$@"; do line+=$'\\t'"$arg"; done; printf '%s\\n' "$line" >> "$DEPLOY_CALLS"; }`;

const STUBS = {
  // WordPress is installed unless WP_INSTALLED=0, every plugin asked about
  // is active, and every core language is installed unless
  // WP_LANGUAGE_INSTALLED=0.
  // Of the wp eval checks, the gq-config one passes and the S3 Uploads
  // one doesn't (no bucket). Polylang's languages (polylang.sh's
  // `wp eval-file - languages`) are WP_POLYLANG_LANGUAGES, and the
  // permalink structure (`wp option get permalink_structure`) is
  // WP_PERMALINK_STRUCTURE. A call starting with a line of WP_FAILING fails.
  wp: `record wp "$@"
while IFS= read -r failing; do
  if [ -n "$failing" ] && [[ "$*" == "$failing"* ]]; then exit 1; fi
done <<< "\${WP_FAILING:-}"
if [ "$1 \${2:-} \${3:-}" = "language core is-installed" ]; then
  [ "\${WP_LANGUAGE_INSTALLED:-1}" = 1 ]
  exit
fi
if [ "$1 \${2:-} \${3:-}" = "eval-file - languages" ]; then
  [ -z "\${WP_POLYLANG_LANGUAGES:-}" ] || printf '%s\\n' "$WP_POLYLANG_LANGUAGES"
  exit
fi
if [ "$1 \${2:-} \${3:-}" = "option get permalink_structure" ]; then
  printf '%s\\n' "\${WP_PERMALINK_STRUCTURE:-}"
  exit
fi
case "$1 \${2:-}" in
  "core is-installed") [ "\${WP_INSTALLED:-1}" = 1 ] ;;
  "eval "*GETQUICK_CONFIG_VERSION*) exit 0 ;;
  "eval "*S3_UPLOADS_BUCKET*) exit 1 ;;
  *) exit 0 ;;
esac`,
  // Records whether the guarded-package admission hold is already in place when
  // it runs (from apps/cms); COMPOSER_EXIT makes it fail, COMPOSER_KILL=1
  // kills the deploy script itself (SIGKILL: no exit trap runs).
  composer: `record composer "$@"
if [ -f ../../.gq/hold ]; then record composer-saw-hold; fi
printf '%s' "\${COMPOSER_AUTH:-}" > "$DEPLOY_CALLS.composer-auth"
if [ "\${COMPOSER_KILL:-0}" = 1 ]; then kill -KILL "$PPID"; fi
exit "\${COMPOSER_EXIT:-0}"`,
  // REAL_RSYNC=1 runs the system's rsync with the script's own arguments
  // (its --delete and protect filters included).
  rsync: `record rsync "$@"
if [ "\${REAL_RSYNC:-0}" = 1 ]; then exec /usr/bin/rsync "$@"; fi
source="\${@: -2:1}"
target="\${@: -1}"
mkdir -p "$target"
cp -R "$source." "$target"`,
  // The request admission's probes (--resolve) answer as a server whose
  // pool prepends the gate (php_admin_value): a challenge probe answers with
  // the gate's headers (X-GQ-Gate open, or the hold's nonce with a 503),
  // PHP_VERSION (CURL_PHP, 8.3.6), the worker's pid (101 before PHP-FPM's
  // reload, 202 after; CURL_PID and CURL_PID_AFTER override) and
  // user_ini.filename (CURL_USER_INI, .user.ini). CURL_PROBE=ungated runs the
  // probe script itself (the gate didn't answer), stale answers another
  // nonce, down fails to connect; CURL_UNGATED_AFTER=1 runs it only once
  // PHP-FPM has reloaded. Each challenge probe is recorded as probe-saw with
  // the challenge files beside it.
  curl: `record curl "$@"
case " $* " in
  *" --resolve "*)
    [ "\${CURL_PROBE:-}" = down ] && exit 7
    url="\${@: -1}"
    output=/dev/null
    previous=""
    for arg in "$@"; do
      [ "$previous" = --output ] && output="$arg"
      previous="$arg"
    done
    path="/\${url#https://*/}"
    reloaded=0
    [ -f "$DEPLOY_CALLS.reloaded" ] && reloaded=1
    case "$path" in
      /gq-admission/*/probe.php)
        dir="$SITE_PATH/apps/cms/web\${path%/probe.php}"
        record probe-saw "$(cd "$dir" && LC_ALL=C ls -A | paste -sd ' ' -)"
        if [ "\${CURL_PROBE:-}" = ungated ] || { [ "\${CURL_UNGATED_AFTER:-0}" = 1 ] && [ "$reloaded" = 1 ]; }; then
          printf 'UNGATED\\n' >"$output"
          printf 'HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\n\\r\\n'
          exit 0
        fi
        pid="\${CURL_PID:-101}"
        [ "$reloaded" = 1 ] && pid="\${CURL_PID_AFTER:-202}"
        if [ -f "$SITE_PATH/.gq/hold" ]; then
          status="503 Service Unavailable"
          gate="$(cat "$SITE_PATH/.gq/hold")"
          [ "\${CURL_PROBE:-}" = stale ] && gate=00000000000000000000000000000000
        else
          status="200 OK"
          gate=open
        fi
        printf 'gq admission probe\\n' >"$output"
        printf 'HTTP/1.1 %s\\r\\nX-GQ-Gate: %s\\r\\nX-GQ-Php: %s\\r\\nX-GQ-Pid: %s\\r\\nX-GQ-User-Ini: %s\\r\\n\\r\\n' \\
          "$status" "$gate" "\${CURL_PHP:-8.3.6}" "$pid" "\${CURL_USER_INI:-.user.ini}"
        exit 0 ;;
    esac
    printf 'HTTP/1.1 404 Not Found\\r\\n\\r\\n'
    exit 0 ;;
esac
while [ "$#" -gt 1 ]; do
  if [ "$1" = -o ]; then output="$2"; fi
  shift
done
cp "$1" "$output"`,
  php: `record php "$@"
if [ "\${1:-}" = scripts/patch-dependencies.php ]; then exit "\${DEPENDENCY_PATCH_EXIT:-0}"; fi
printf '8.3'`,
  // A PHP-FPM reload marks the reload done; SUDO_EXIT makes sudo fail.
  sudo: `record sudo "$@"
[ "\${SUDO_EXIT:-0}" = 0 ] || exit "$SUDO_EXIT"
case "$*" in *"fpm reload"*) touch "$DEPLOY_CALLS.reloaded" ;; esac`,
  // PHP-FPM 8.3's master (pid 10) with two pools: www's worker 101 before
  // the reload and 202 after (PS_STUCK=1 keeps 101 running, PS_NONE=1 shows
  // no 8.3 worker, PS_NO_MASTER=1 no PHP-FPM process at all), and pool
  // other's worker 303 before, 304 after; PHP-FPM 8.2's master (20) and its
  // worker 401, which never goes; and a grep whose arguments name PHP-FPM
  // 8.3's master, which isn't one.
  ps: `processes() {
  echo "  999   500 grep Sat Oct 31 08:00:00 2026 grep -F php-fpm: master process (/etc/php/8.3/fpm/php-fpm.conf)"
  [ "\${PS_NO_MASTER:-0}" = 1 ] && return
  echo "   10     1 php-fpm8.3 Sat Oct 31 08:00:00 2026 php-fpm: master process (/etc/php/8.3/fpm/php-fpm.conf)"
  echo "   20     1 php-fpm8.2 Sat Oct 31 08:00:00 2026 php-fpm: master process (/etc/php/8.2/fpm/php-fpm.conf)"
  echo "  401    20 php-fpm8.2 Sat Oct 31 08:30:00 2026 php-fpm: pool www"
  [ "\${PS_NONE:-0}" = 1 ] && return
  if [ ! -f "$DEPLOY_CALLS.reloaded" ] || [ "\${PS_STUCK:-0}" = 1 ]; then
    echo "  101    10 php-fpm8.3 Sat Oct 31 09:00:00 2026 php-fpm: pool www"
    echo "  303    10 php-fpm8.3 Sat Oct 31 09:00:00 2026 php-fpm: pool other"
  fi
  if [ -f "$DEPLOY_CALLS.reloaded" ]; then
    echo "  202    10 php-fpm8.3 Sat Oct 31 09:10:00 2026 php-fpm: pool www"
    echo "  304    10 php-fpm8.3 Sat Oct 31 09:10:00 2026 php-fpm: pool other"
  fi
}
case "$*" in
  *comm=*) processes ;;
  *lstart=*) processes | awk '{ print $1, $4, $5, $6, $7, $8 }' ;;
  *) exec /bin/ps "$@" ;;
esac`,
};

// Deploys a release holding `releaseFiles` (site-relative path → content;
// RELEASE, apps/cms/composer.json, apps/cms/web/index.php and the script
// itself as deploy/ploi/admin.sh are added) with `script`, to a site holding
// `siteFiles` (and `siteLinks`, path → symlink target, and `siteDirectories`)
// and an installed WordPress (none with `installed: false`),
// with every core language installed (none with `languageInstalled: false`),
// Polylang holding `polylangLanguages` (lines of slug, locale and order;
// none by default), `permalinkStructure` as its permalink structure (plain,
// "", by default) and each wp call that starts with one of `failing`
// exiting 1.
// Resolves to the exit `code`, `stdout`, `stderr`, both as `output`, the
// `site` directory, the recorded `calls` (each an array: tool, then
// arguments) and the COMPOSER_AUTH composer saw.
export async function deploy(
  script,
  {
    releaseFiles = {},
    siteFiles = {},
    siteLinks = {},
    siteDirectories = [],
    installed = true,
    languageInstalled = true,
    polylangLanguages = [],
    permalinkStructure = "",
    failing = [],
    composerAuth = '{"http-basic":{}}',
    patchExit = 0,
    composerOnly = false,
    composerExit = 0,
    composerKill = false,
    env: extraEnv = {},
  } = {},
) {
  const directory = await temporaryDirectory();
  const [stubs, release, site] = ["stubs", "release", "site"].map((name) => join(directory, name));
  for (const [name, body] of Object.entries(STUBS)) {
    await writeExecutable(join(stubs, name), `#!/bin/bash\nset -eu\n${RECORD}\n${body}\n`);
  }
  await writeFiles(release, {
    RELEASE: `version=1.2.3\ncommit=${RELEASE_SHA}\nref=v1.2.3\n`,
    "apps/cms/composer.json": "{}\n",
    "apps/cms/web/index.php": "<?php\n",
    "deploy/ploi/admin.sh": script,
    ...releaseFiles,
  });
  const archive = join(directory, "release.tar.gz");
  await spawnProcess("tar", ["-czf", archive, "-C", release, "."], { check: true });
  await mkdir(site, { recursive: true });
  await writeFiles(site, {
    ...(installed ? { "apps/cms/web/wp/wp-load.php": "<?php\n" } : {}),
    ...siteFiles,
  });
  for (const [path, target] of Object.entries(siteLinks)) {
    await mkdir(dirname(join(site, path)), { recursive: true });
    await symlink(target, join(site, path));
  }
  for (const path of siteDirectories) await mkdir(join(site, path), { recursive: true });
  const scriptPath = join(directory, "admin.sh");
  await writeFile(scriptPath, script);

  const calls = join(directory, "calls");
  await writeFile(calls, "");
  const result = await spawnProcess("bash", [scriptPath], {
    cwd: site,
    env: {
      PATH: `${stubs}:/usr/bin:/bin`,
      HOME: directory,
      ARCHIVE_URL: archive,
      COMPOSER_AUTH: composerAuth,
      DEPLOY_CALLS: calls,
      WP_INSTALLED: installed ? "1" : "0",
      WP_LANGUAGE_INSTALLED: languageInstalled ? "1" : "0",
      WP_POLYLANG_LANGUAGES: polylangLanguages.join("\n"),
      WP_PERMALINK_STRUCTURE: permalinkStructure,
      WP_FAILING: failing.join("\n"),
      DEPENDENCY_PATCH_EXIT: String(patchExit),
      COMPOSER_ONLY: composerOnly ? "true" : "false",
      COMPOSER_EXIT: String(composerExit),
      COMPOSER_KILL: composerKill ? "1" : "0",
      ...extraEnv,
    },
  });
  const recorded = await readFile(calls, "utf8");
  return {
    ...result,
    site,
    calls:
      recorded === ""
        ? []
        : recorded
            .trimEnd()
            .split("\n")
            .map((line) => line.split("\t")),
    composerAuth: await readFile(`${calls}.composer-auth`, "utf8").catch(() => undefined),
  };
}

// An extension (or any script) that records `name` as a call when it runs,
// then exits with `code`.
export function recordingExtension(name, code = 0) {
  return `#!/usr/bin/env bash\nprintf 'extension\\t%s\\t%s\\n' ${JSON.stringify(name)} "$PWD" >> "$DEPLOY_CALLS"\nexit ${code}\n`;
}

async function writeFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

async function writeExecutable(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  await chmod(path, 0o755);
}

// `check` rejects when the command exits non-zero.
function spawnProcess(command, args, { cwd, env, check = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let output = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (check && code !== 0) reject(new Error(`${command} failed: ${stderr}`));
      else resolve({ code, stdout, stderr, output });
    });
  });
}

// Runs a CMS deploy script as Ploi runs it, against a release archive and a
// site directory in a temporary directory. wp, composer, rsync, curl, php and
// sudo are stubs on PATH that append each call to a log (tool, then each
// argument, tab-separated); nothing reaches a network, a database or the
// caller's own tools. rsync copies (without deleting) so shipped files land;
// curl copies the archive from a local path.
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { temporaryDirectory } from "./fixture-site.mjs";

const RELEASE_SHA = "0123abcd";

const RECORD = `record() { local line="$1"; shift; for arg in "$@"; do line+=$'\\t'"$arg"; done; printf '%s\\n' "$line" >> "$DEPLOY_CALLS"; }`;

const STUBS = {
  // WordPress is installed unless WP_INSTALLED=0, every plugin asked about
  // is active, and every core language is installed unless
  // WP_LANGUAGE_INSTALLED=0.
  // Of the wp eval checks, the getquick-config one passes and the S3 Uploads
  // one doesn't (no bucket). Polylang's languages (polylang.sh's
  // `wp eval-file - languages`) are WP_POLYLANG_LANGUAGES. A call starting
  // with a line of WP_FAILING fails.
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
case "$1 \${2:-}" in
  "core is-installed") [ "\${WP_INSTALLED:-1}" = 1 ] ;;
  "eval "*GETQUICK_CONFIG_VERSION*) exit 0 ;;
  "eval "*S3_UPLOADS_BUCKET*) exit 1 ;;
  *) exit 0 ;;
esac`,
  composer: `record composer "$@"
printf '%s' "\${COMPOSER_AUTH:-}" > "$DEPLOY_CALLS.composer-auth"`,
  rsync: `record rsync "$@"
source="\${@: -2:1}"
target="\${@: -1}"
mkdir -p "$target"
cp -R "$source." "$target"`,
  curl: `record curl "$@"
while [ "$#" -gt 1 ]; do
  if [ "$1" = -o ]; then output="$2"; fi
  shift
done
cp "$1" "$output"`,
  php: `record php "$@"
printf '8.3'`,
  sudo: `record sudo "$@"`,
};

// Deploys a release holding `releaseFiles` (site-relative path → content;
// RELEASE, apps/cms/composer.json, apps/cms/web/index.php and the script
// itself as deploy/ploi/admin.sh are added) with `script`, to a site holding
// `siteFiles` and an installed WordPress (none with `installed: false`),
// with every core language installed (none with `languageInstalled: false`),
// Polylang holding `polylangLanguages` (lines of slug, locale and order;
// none by default) and each wp call that starts with one of `failing`
// exiting 1.
// Resolves to the exit `code`, `stdout`, `stderr`, both as `output`, the
// `site` directory, the recorded `calls` (each an array: tool, then
// arguments) and the COMPOSER_AUTH composer saw.
export async function deploy(
  script,
  {
    releaseFiles = {},
    siteFiles = {},
    installed = true,
    languageInstalled = true,
    polylangLanguages = [],
    failing = [],
    composerAuth = '{"http-basic":{}}',
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
      WP_FAILING: failing.join("\n"),
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

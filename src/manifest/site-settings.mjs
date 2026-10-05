// What release, version, verify and doctor read about a site: the
// blueprint's defaults for its variant with the additions its gq.ops.json
// declares (`release`, `verify`, `doctor`) appended. The content variant
// has defaults for all three (VARIANT_DEFAULTS.content below); commerce has
// none until a commerce site adopts the blueprint (phase 4), so a commerce
// site declares everything as additions.
import { access } from "node:fs/promises";
import { join } from "node:path";

import { MANIFEST_FILENAME } from "./schema.mjs";

// The release config module gq.ops.json replaced; `gq sync --manifest` folds
// it in. The name carries over from the vendored shop-devtools.
export const RELEASE_CONFIG_FILENAME = "shop-devtools.config.mjs";

// Every site's version file and changelog; neither is configurable.
const VERSION_FILE = "VERSION";
const CHANGELOG_PATH = "CHANGELOG.md";

const NO_DEFAULTS = {
  release: { jsonFiles: [], textFiles: [], paths: [] },
  verify: { checks: [] },
  doctor: { requiredFiles: {} },
};

const COMPOSER_CHECK = (...args) => ({
  cmd: "composer",
  args: ["--working-dir=apps/cms", ...args],
  requires: ["php"],
});

export const VARIANT_DEFAULTS = {
  content: {
    release: {
      jsonFiles: ["package.json", "apps/frontend/package.json"],
      textFiles: [],
      paths: [
        VERSION_FILE,
        CHANGELOG_PATH,
        "README.md",
        "package.json",
        "pnpm-workspace.yaml",
        MANIFEST_FILENAME,
        "infra",
        "deploy/ploi/admin.sh",
        "AGENTS.md",
        "apps/cms/.gitignore",
        "apps/cms/composer.json",
        "apps/cms/composer.lock",
        "apps/frontend/package.json",
      ],
    },
    // What `gq verify`, the pre-push hook, `gq release push` and Cloudflare
    // CI run, in order.
    verify: {
      checks: [
        { cmd: "pnpm", args: ["run", "check"] },
        { cmd: "pnpm", args: ["run", "lint"] },
        { cmd: "pnpm", args: ["run", "test"] },
        { cmd: "pnpm", args: ["run", "test:scripts"] },
        { cmd: "pnpm", args: ["run", "infra:check"] },
        { cmd: "pnpm", args: ["run", "ci:check"] },
        COMPOSER_CHECK("validate"),
        COMPOSER_CHECK("run", "lint"),
        COMPOSER_CHECK("run", "test"),
      ],
    },
    doctor: {
      requiredFiles: {
        "apps/cms": ["composer.json", ".ddev/config.yaml"],
        "apps/frontend": ["package.json", "astro.config.mjs"],
      },
    },
  },
  commerce: NO_DEFAULTS,
};

// The settings for the validated manifest `config` of the site at
// `projectRoot`. A release config module still beside it hasn't been folded
// in, so its settings would be silently ignored: that is refused.
export async function loadSiteSettings({ config, projectRoot }) {
  if (await hasReleaseConfig(projectRoot)) {
    throw new Error(
      `${RELEASE_CONFIG_FILENAME} is no longer read: the release, verify and doctor settings ` +
        `live in ${MANIFEST_FILENAME}. Run gq sync --manifest to fold it in.`,
    );
  }
  return siteSettings(config);
}

export function siteSettings(config) {
  const defaults = VARIANT_DEFAULTS[config.variant];
  const release = config.release ?? {};
  return {
    versionFile: VERSION_FILE,
    changelogPath: CHANGELOG_PATH,
    jsonFiles: [...defaults.release.jsonFiles, ...(release.jsonFiles ?? [])],
    textFiles: [...defaults.release.textFiles, ...(release.textFiles ?? [])].map(compileTextFile),
    releasePaths: [...defaults.release.paths, ...(release.paths ?? [])],
    checks: [...defaults.verify.checks, ...(config.verify?.checks ?? [])].map((check) => ({
      args: [],
      ...check,
    })),
    requiredFiles: appendRequiredFiles(
      defaults.doctor.requiredFiles,
      config.doctor?.requiredFiles ?? {},
    ),
  };
}

// A text file's patterns as the manifest writes them ({ regexp, flags?,
// replacement } with `{version}` in the replacement) → a RegExp and a
// function of the version.
function compileTextFile({ path, patterns }) {
  return {
    path,
    patterns: patterns.map(({ regexp, flags, replacement }) => ({
      regexp: new RegExp(regexp, flags),
      replacement: (version) => replacement.replaceAll("{version}", version),
    })),
  };
}

function appendRequiredFiles(defaults, additions) {
  const merged = Object.fromEntries(
    Object.entries(defaults).map(([app, files]) => [app, [...files]]),
  );
  for (const [app, files] of Object.entries(additions)) {
    merged[app] = [...(merged[app] ?? []), ...files];
  }
  return merged;
}

// Whether the site at `root` still has a release config module to fold in.
export async function hasReleaseConfig(root) {
  try {
    await access(join(root, RELEASE_CONFIG_FILENAME));
    return true;
  } catch {
    return false;
  }
}

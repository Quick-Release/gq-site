export default {
  versionFile: "VERSION",
  releaseBranch: "main",
  changelogPath: "CHANGELOG.md",
  jsonFiles: ["package.json", "apps/frontend/package.json"],
  // The GETQUICK plugins and theme live in their own repositories and are
  // versioned there; apps/cms installs them from the GETQUICK Composer registry.
  // The Larkspur child theme follows this release, like the Astro frontend.
  textFiles: [
    {
      path: "apps/cms/web/app/themes/larkspur-theme/style.css",
      patterns: [
        {
          regexp: /^Version: .+$/m,
          replacement: (version) => `Version: ${version}`,
        },
      ],
    },
    {
      path: "apps/cms/web/app/themes/larkspur-theme/functions.php",
      patterns: [
        {
          regexp: /define\( 'LARKSPUR_THEME_VERSION', '[^']+' \);/,
          replacement: (version) => `define( 'LARKSPUR_THEME_VERSION', '${version}' );`,
        },
      ],
    },
  ],
  composer: null,
  releasePaths: [
    "VERSION",
    "CHANGELOG.md",
    "README.md",
    "package.json",
    "pnpm-workspace.yaml",
    "shop-devtools.config.mjs",
    "gq.ops.json",
    "infra",
    "deploy/ploi/admin.sh",
    "AGENTS.md",
    "apps/cms/.gitignore",
    "apps/cms/composer.json",
    "apps/cms/composer.lock",
    "apps/frontend/package.json",
    "apps/cms/web/app/themes/larkspur-theme/style.css",
    "apps/cms/web/app/themes/larkspur-theme/functions.php",
  ],
  // What `pnpm verify` (gq verify), the pre-push hook, `pnpm push` and
  // Cloudflare CI run, in order. Locally `gq verify` skips a check whose
  // `requires` isn't here (php: Composer and apps/cms/vendor); CI runs all.
  checks: [
    { cmd: "pnpm", args: ["run", "check"] },
    { cmd: "pnpm", args: ["run", "lint"] },
    { cmd: "pnpm", args: ["run", "test"] },
    { cmd: "pnpm", args: ["run", "test:scripts"] },
    { cmd: "pnpm", args: ["run", "infra:check"] },
    { cmd: "pnpm", args: ["run", "ci:check"] },
    // WordPress core is exact-pinned on purpose (warning only); plugins track
    // their latest releases with caret constraints.
    { cmd: "composer", args: ["--working-dir=apps/cms", "validate"], requires: ["php"] },
    { cmd: "composer", args: ["--working-dir=apps/cms", "run", "lint"], requires: ["php"] },
    { cmd: "composer", args: ["--working-dir=apps/cms", "run", "test"], requires: ["php"] },
  ],
  // What `pnpm run doctor` (gq doctor) requires each app to have.
  doctor: {
    requiredFiles: {
      "apps/cms": ["composer.json", ".ddev/config.yaml"],
      "apps/frontend": ["package.json", "astro.config.mjs"],
    },
  },
  // Nothing deploys from here: the v* tag pushed to GitHub is mirrored to the
  // Cloudflare Artifacts repository, whose CI Workflow (infra/ci/cloudflare.ci.ts)
  // runs the checks and then deploys the admin (gq ploi release) and the frontend.
  deploys: [],
};

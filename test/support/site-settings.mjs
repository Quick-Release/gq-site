// Release, verify and doctor as a test reads them through run(): a site's
// version-carrying files, a recording exec that answers release push's git
// queries, and what each command ran or reported. The CONTENT_ lists are
// the content variant's release, verify and doctor defaults, literally.
import { recordingExec } from "./fixture-site.mjs";

export const CONTENT_CHECKS = [
  "pnpm run check",
  "pnpm run lint",
  "pnpm run test",
  "pnpm run test:scripts",
  "pnpm run infra:check",
  "pnpm run ci:check",
  "composer --working-dir=apps/cms validate",
  "composer --working-dir=apps/cms run lint",
  "composer --working-dir=apps/cms run test",
];

export const CONTENT_RELEASE_PATHS = [
  "VERSION",
  "CHANGELOG.md",
  "README.md",
  "package.json",
  "pnpm-workspace.yaml",
  "gq.ops.json",
  "infra",
  "deploy/ploi/admin.sh",
  "AGENTS.md",
  "apps/cms/.gitignore",
  "apps/cms/composer.json",
  "apps/cms/composer.lock",
  "apps/frontend/package.json",
];

export const CONTENT_REQUIRED_FILES = [
  "apps/cms/composer.json",
  "apps/cms/.ddev/config.yaml",
  "apps/frontend/package.json",
  "apps/frontend/astro.config.mjs",
];

export function versionedFiles(version, files = {}) {
  return {
    VERSION: `${version}\n`,
    "CHANGELOG.md": "# Changelog\n",
    "package.json": `${JSON.stringify({ name: "site", version }, null, 2)}\n`,
    "apps/frontend/package.json": `${JSON.stringify({ name: "frontend", version }, null, 2)}\n`,
    ...files,
  };
}

// Answers the git queries `release push` reads; everything else succeeds.
export function releaseExec() {
  return recordingExec(({ command, args }) => {
    if (command !== "git") return {};
    const line = args.join(" ");
    if (line === "diff --cached --name-only") return { stdout: "VERSION\n" };
    if (line === "rev-parse --abbrev-ref HEAD") return { stdout: "main\n" };
    return {};
  });
}

// What `release push` ran: its checks, and the paths its release commit staged.
export function releaseRun(exec) {
  const lines = exec.calls.map(({ command, args }) => [command, ...args].join(" "));
  const checks = lines.filter((line) => !line.startsWith("git "));
  const add = exec.calls.find(({ command, args }) => command === "git" && args[0] === "add");
  return { checks, paths: add?.args.slice(1) };
}

// The checks `gq verify --ci` ran.
export const verifyChecks = (exec) =>
  exec.calls.map(({ command, args }) => [command, ...args].join(" "));

// The files `gq doctor` reports missing.
export const missingFiles = (stdout) =>
  [...stdout.matchAll(/✗ (\S+) is missing$/gmu)].map(([, path]) => path);

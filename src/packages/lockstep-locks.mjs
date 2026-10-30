// What a Site's lockfiles install of each lockstep group (ADR 0018): the
// Composer half from apps/cms/composer.lock, the npm half from the root
// pnpm-lock.yaml. GQ Design releases its plugin and its npm packages at one
// version, so a Site whose locks disagree runs a contract its renderer wasn't
// built for. gq doctor fails it, naming both. A Site that locks no npm member
// (a content Site) has nothing to compare.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import catalogue from "../../blueprint/packages.json" with { type: "json" };
import { isNpm, lockstepGroups } from "./catalogue.mjs";
import { parseVersion } from "./versions.mjs";

export const COMPOSER_LOCK = "apps/cms/composer.lock";
export const PNPM_LOCK = "pnpm-lock.yaml";

// One result per group the Site's pnpm lock has a member of:
// { group, composer: [{ name, version }], npm: [{ name, version }], problem }.
export async function lockstepLocks(root) {
  const pnpm = await readFile(join(root, PNPM_LOCK), "utf8").catch(() => null);
  if (pnpm === null) return [];
  const composerLock = await readFile(join(root, COMPOSER_LOCK), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
  const results = [];
  for (const [group, members] of lockstepGroups(catalogue)) {
    const npm = members
      .filter(isNpm)
      .flatMap(({ name }) => pnpmVersions(pnpm, name).map((version) => ({ name, version })));
    if (npm.length === 0) continue;
    const composer = members
      .filter((pkg) => !isNpm(pkg))
      .flatMap(({ name }) => {
        const locked = [
          ...(composerLock?.packages ?? []),
          ...(composerLock?.["packages-dev"] ?? []),
        ].filter((entry) => entry?.name === name && typeof entry.version === "string");
        return locked.map((entry) => ({ name, version: normalise(entry.version) }));
      });
    results.push({ group, composer, npm, problem: problem(group, composerLock, composer, npm) });
  }
  return results;
}

function problem(group, composerLock, composer, npm) {
  const describe = (entries, file) =>
    `${file} locks ${entries.map(({ name, version }) => `${name} ${version}`).join(", ")}`;
  if (composerLock === null) {
    return {
      level: "warn",
      message: `${describe(npm, PNPM_LOCK)}, but there is no ${COMPOSER_LOCK} to compare: run pnpm cms:composer`,
    };
  }
  if (composer.length === 0) {
    return {
      level: "fail",
      message: `${describe(npm, PNPM_LOCK)}, but ${COMPOSER_LOCK} locks no ${group} plugin: ${group} is released in lockstep (ADR 0018)`,
    };
  }
  const versions = new Set([...composer, ...npm].map(({ version }) => version));
  if (versions.size === 1) return null;
  // A Composer branch install (dev-main) has no version to compare.
  if (composer.some(({ version }) => parseVersion(version) === null)) {
    return {
      level: "warn",
      message: `${describe(composer, COMPOSER_LOCK)}, a branch, so it can't be compared with ${describe(npm, PNPM_LOCK).replace(`${PNPM_LOCK} locks `, "")}`,
    };
  }
  return {
    level: "fail",
    message: `${describe(composer, COMPOSER_LOCK)} but ${describe(npm, PNPM_LOCK)}: ${group} releases them in lockstep (ADR 0018), so move them to one version`,
  };
}

// Every version of `name` pnpm-lock.yaml (lockfile v9) resolves: its
// `packages:` keys are `name@version` or `'@scope/name@version'`.
export function pnpmVersions(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
  const pattern = new RegExp(`^ {2}'?${escaped}@([^'():\\s]+)'?:`, "gmu");
  return [...new Set([...text.matchAll(pattern)].map((match) => match[1]))].sort();
}

function normalise(version) {
  return version.replace(/^v(?=\d)/u, "");
}

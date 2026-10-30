// The package catalogue (blueprint/packages.json): which GETQUICK packages
// the blueprint knows, where each is discovered and installed from, and its
// upgrade policy. Composer packages (WordPress plugins and themes) are pinned
// by the require keys of the blueprint's CMS composer.json (composerFile);
// npm packages (`ecosystem: "npm"`, from GitHub Packages) by the dependencies
// of npmFile, the commerce Frontend's managed keys. The catalogue holds no
// version constraints and is checked against both, so they can't disagree.
// Packages one upstream releases together at one version share a
// `lockstep` group (ADR 0018), pinned exactly and moved together.
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { parseVersion } from "./versions.mjs";

export const CATALOGUE_FILENAME = "packages.json";
export const GITHUB_PACKAGES = "github-packages";
const PACKAGE_NAME = "@getquick/site";
const INSTALLED_BLUEPRINT = fileURLToPath(new URL("../../blueprint/", import.meta.url));

const composerName = z
  .string()
  .regex(
    /^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9](([_.]|-{1,2})?[a-z0-9]+)*$/u,
    "must be a Composer package name",
  );
const npmName = z
  .string()
  .regex(
    /^@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-~][a-z0-9-._~]*$/u,
    "must be a scoped npm package name",
  );
const version = z
  .string()
  .refine((text) => parseVersion(text) !== null, "must be a version, like 0.4.0");

const upstream = z.discriminatedUnion("discovery", [
  z.strictObject({
    repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/u, "must be owner/name"),
    discovery: z.literal("tags"),
  }),
  z.strictObject({
    repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/u, "must be owner/name"),
    discovery: z.literal("releases"),
    asset: z.string().includes("{version}", { message: "must contain {version}" }),
  }),
]);

const common = {
  upstream,
  variants: z.array(z.enum(["content", "commerce"])),
  // blueprint: composerFile requires it and gq proposes its constraint.
  // site: a Site requires it itself; reported, never written.
  // none: no variant installs it; reported, never written.
  requirement: z.enum(["blueprint", "site", "none"]),
  // caret: propose the newest installable version inside the current caret
  // range; anything newer is a breaking upgrade, blocked for review.
  // exact: an exact pin; propose the newest installable version (a lockstep
  // group's newest version every member's registry serves).
  // manual: report only.
  policy: z.enum(["caret", "exact", "manual"]),
  // Released together at one version by one upstream: pinned to the same
  // version and proposed together, or not at all.
  lockstep: z.string().min(1).optional(),
  holds: z.array(z.strictObject({ from: version, reason: z.string().min(1) })).optional(),
  formerNames: z.array(composerName).optional(),
  migrations: z
    .array(
      z.strictObject({
        kind: z.enum(["rename", "replace", "remove", "activate"]),
        from: composerName.optional(),
        status: z.enum(["unplanned", "planned"]),
        reason: z.string().min(1),
      }),
    )
    .optional(),
  note: z.string().optional(),
};

const entry = z.union([
  z.strictObject({
    name: composerName,
    ecosystem: z.literal("composer").optional(),
    // The name of a Composer repository in composerFile: the canonical, and
    // only, install source. There is no fallback to GitHub.
    install: z.strictObject({ registry: z.string().min(1) }),
    ...common,
  }),
  z.strictObject({
    name: npmName,
    ecosystem: z.literal("npm"),
    // GitHub Packages, for the owner's scope (@quick-release): read with a
    // read:packages token from GITHUB_PACKAGES_TOKEN or the user's npm config.
    install: z.strictObject({ registry: z.literal(GITHUB_PACKAGES) }),
    ...common,
  }),
]);

const catalogueSchema = z.strictObject({
  $comment: z.string().optional(),
  schemaVersion: z.literal(1),
  composerFile: z.string().min(1),
  // The npm pins: a JSON file whose dependencies pin every blueprint npm package.
  npmFile: z.string().min(1).optional(),
  packages: z.array(entry).min(1),
});

// Where the blueprint is: a gq-site checkout's own blueprint when cwd is in
// one (the only place --write may change), else the installed package's.
export async function locateBlueprint(cwd) {
  const root = await gitRoot(cwd);
  if (root && existsSync(join(root, "blueprint", CATALOGUE_FILENAME))) {
    const manifest = JSON.parse(
      await readFile(join(root, "package.json"), "utf8").catch(() => "{}"),
    );
    if (manifest.name === PACKAGE_NAME) {
      return { directory: join(root, "blueprint"), root, writable: true };
    }
  }
  return { directory: INSTALLED_BLUEPRINT, root: dirname(INSTALLED_BLUEPRINT), writable: false };
}

// The validated catalogue and composerFile's text and JSON.
export async function loadCatalogue(blueprint) {
  const path = join(blueprint.directory, CATALOGUE_FILENAME);
  const result = catalogueSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`blueprint/${CATALOGUE_FILENAME} is invalid:\n  ${issues.join("\n  ")}`);
  }
  const catalogue = result.data;
  const composerPath = join(blueprint.directory, catalogue.composerFile);
  const composerText = await readFile(composerPath, "utf8");
  const composer = JSON.parse(composerText);
  const npmPath = catalogue.npmFile ? join(blueprint.directory, catalogue.npmFile) : null;
  const npmText = npmPath ? await readFile(npmPath, "utf8") : null;
  const npm = npmText === null ? null : JSON.parse(npmText);
  const problems = catalogueProblems(catalogue, composer, npm);
  if (problems.length > 0) {
    const files = [catalogue.composerFile, catalogue.npmFile].filter(Boolean).join(" or ");
    throw new Error(
      `blueprint/${CATALOGUE_FILENAME} disagrees with ${files}:\n  ${problems.join("\n  ")}`,
    );
  }
  return {
    catalogue,
    composer,
    composerText,
    composerPath,
    composerFile: relative(blueprint.root, composerPath),
    npm,
    npmText,
    npmPath,
    npmFile: npmPath ? relative(blueprint.root, npmPath) : null,
  };
}

export function isNpm(pkg) {
  return pkg.ecosystem === "npm";
}

// A package's blueprint pin: its require value in composerFile, or its
// dependency in npmFile; null when the blueprint doesn't pin it.
export function blueprintPin(pkg, composer, npm) {
  const pins = isNpm(pkg) ? (npm?.dependencies ?? {}) : (composer.require ?? {});
  return Object.hasOwn(pins, pkg.name) ? pins[pkg.name] : null;
}

// Every disagreement between the catalogue and its pin files (composerFile,
// and npmFile when it has npm packages), as sentences.
export function catalogueProblems(catalogue, composer, npm = null) {
  const problems = [];
  const require = composer.require ?? {};
  const names = new Set();
  for (const pkg of catalogue.packages) {
    if (names.has(pkg.name)) problems.push(`${pkg.name} is listed twice.`);
    names.add(pkg.name);
    if (isNpm(pkg)) {
      problems.push(...npmProblems(pkg, catalogue, npm));
      continue;
    }
    const registry = registryRepository(composer, pkg.install.registry);
    if (!registry) {
      problems.push(
        `${pkg.name} installs from ${pkg.install.registry}, which isn't a composer repository there.`,
      );
    } else if (!coveredBy(registry, pkg.name)) {
      problems.push(`${pkg.name} installs from ${pkg.install.registry}, whose "only" excludes it.`);
    }
    const required = Object.hasOwn(require, pkg.name);
    if (pkg.requirement === "blueprint" && !required) {
      problems.push(`${pkg.name} is a blueprint requirement but isn't in require.`);
    }
    if (pkg.requirement !== "blueprint" && required) {
      problems.push(
        `${pkg.name} is in require but the catalogue says requirement "${pkg.requirement}".`,
      );
    }
    if (pkg.requirement === "blueprint" && pkg.variants.length === 0) {
      problems.push(`${pkg.name} is a blueprint requirement of no variant.`);
    }
  }
  // Every requirement served by a catalogued registry is catalogued, so none
  // escapes discovery.
  const registries = new Set(catalogue.packages.map((pkg) => pkg.install.registry));
  for (const name of Object.keys(require)) {
    if (names.has(name)) continue;
    const served = [...registries].some((registry) => {
      const repository = registryRepository(composer, registry);
      return repository?.only && coveredBy(repository, name);
    });
    if (served)
      problems.push(`${name} is required from a catalogued registry but isn't catalogued.`);
  }
  // Every @quick-release dependency npmFile pins is catalogued.
  for (const name of Object.keys(npm?.dependencies ?? {})) {
    if (name.startsWith("@quick-release/") && !names.has(name)) {
      problems.push(`${name} is pinned in ${catalogue.npmFile} but isn't catalogued.`);
    }
  }
  problems.push(...lockstepProblems(catalogue, composer, npm));
  return problems;
}

function npmProblems(pkg, catalogue, npm) {
  if (!catalogue.npmFile || npm === null) {
    return [`${pkg.name} is an npm package, but the catalogue names no npmFile to pin it in.`];
  }
  const pinned = Object.hasOwn(npm.dependencies ?? {}, pkg.name);
  const problems = [];
  if (pkg.requirement === "blueprint" && !pinned) {
    problems.push(`${pkg.name} is a blueprint requirement but isn't in ${catalogue.npmFile}.`);
  }
  if (pkg.requirement !== "blueprint" && pinned) {
    problems.push(
      `${pkg.name} is in ${catalogue.npmFile} but the catalogue says requirement "${pkg.requirement}".`,
    );
  }
  if (pkg.requirement === "blueprint" && pkg.variants.length === 0) {
    problems.push(`${pkg.name} is a blueprint requirement of no variant.`);
  }
  if (pkg.requirement === "site") {
    problems.push(`${pkg.name}: npm packages are pinned by the blueprint or not at all.`);
  }
  return problems;
}

// A lockstep group's members are pinned exactly, to one version, and are
// proposed with one policy.
function lockstepProblems(catalogue, composer, npm) {
  const problems = [];
  for (const [group, members] of lockstepGroups(catalogue)) {
    if (members.length < 2) problems.push(`Lockstep group ${group} has one member.`);
    const policies = new Set(members.map((pkg) => pkg.policy));
    if (policies.size > 1 || !policies.has("exact")) {
      problems.push(`Lockstep group ${group}'s members must all have policy "exact".`);
    }
    const pins = members
      .filter((pkg) => pkg.requirement === "blueprint")
      .map((pkg) => [pkg.name, blueprintPin(pkg, composer, npm)]);
    for (const [name, pin] of pins) {
      if (pin !== null && parseVersion(pin)?.text !== pin) {
        problems.push(
          `${name} is in lockstep group ${group}, so its pin must be exact, not ${pin}.`,
        );
      }
    }
    if (new Set(pins.map(([, pin]) => pin)).size > 1) {
      problems.push(
        `Lockstep group ${group} is pinned to different versions: ${pins.map(([name, pin]) => `${name} ${pin}`).join(", ")}.`,
      );
    }
  }
  return problems;
}

// group → its members, in catalogue order.
export function lockstepGroups(catalogue) {
  const groups = new Map();
  for (const pkg of catalogue.packages) {
    if (!pkg.lockstep) continue;
    if (!groups.has(pkg.lockstep)) groups.set(pkg.lockstep, []);
    groups.get(pkg.lockstep).push(pkg);
  }
  return groups;
}

export function registryRepository(composer, name) {
  return (composer.repositories ?? []).find(
    (repository) => repository.name === name && repository.type === "composer",
  );
}

function coveredBy(repository, packageName) {
  if (!repository.only) return true;
  return repository.only.some((pattern) =>
    new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`, "u").test(packageName),
  );
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function gitRoot(start) {
  let directory = await realpath(resolve(start)).catch(() => resolve(start));
  while (true) {
    if (existsSync(join(directory, ".git"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

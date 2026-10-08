// The package catalogue (blueprint/packages.json): which GETQUICK Composer
// packages the blueprint knows, where each is discovered and installed from,
// and its upgrade policy. It holds no version constraints; the blueprint's
// pins stay the require keys of its CMS composer.json (composerFile), which
// the catalogue is checked against, so the two can't disagree.
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { parseVersion } from "./versions.mjs";

export const CATALOGUE_FILENAME = "packages.json";
const PACKAGE_NAME = "@getquick/site";
const INSTALLED_BLUEPRINT = fileURLToPath(new URL("../../blueprint/", import.meta.url));

const composerName = z
  .string()
  .regex(
    /^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9](([_.]|-{1,2})?[a-z0-9]+)*$/u,
    "must be a Composer package name",
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

const entry = z.strictObject({
  name: composerName,
  upstream,
  // The name of a Composer repository in composerFile: the canonical, and only,
  // install source. There is no fallback to GitHub.
  install: z.strictObject({ registry: z.string().min(1) }),
  variants: z.array(z.enum(["content", "commerce"])),
  // blueprint: composerFile requires it and gq proposes its constraint.
  // site: a Site requires it itself; reported, never written.
  // none: no variant installs it; reported, never written.
  requirement: z.enum(["blueprint", "site", "none"]),
  // caret: propose the newest installable version inside the current caret
  // range; anything newer is a breaking upgrade, blocked for review.
  // manual: report only.
  policy: z.enum(["caret", "manual"]),
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
});

const catalogueSchema = z.strictObject({
  $comment: z.string().optional(),
  schemaVersion: z.literal(1),
  composerFile: z.string().min(1),
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
  const problems = catalogueProblems(catalogue, composer);
  if (problems.length > 0) {
    throw new Error(
      `blueprint/${CATALOGUE_FILENAME} disagrees with ${catalogue.composerFile}:\n  ${problems.join("\n  ")}`,
    );
  }
  return {
    catalogue,
    composer,
    composerText,
    composerPath,
    composerFile: relative(blueprint.root, composerPath),
  };
}

// Every disagreement between the catalogue and composerFile, as sentences.
export function catalogueProblems(catalogue, composer) {
  const problems = [];
  const require = composer.require ?? {};
  const names = new Set();
  for (const pkg of catalogue.packages) {
    if (names.has(pkg.name)) problems.push(`${pkg.name} is listed twice.`);
    names.add(pkg.name);
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
  return problems;
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

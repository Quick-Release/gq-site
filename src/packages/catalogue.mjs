// The package catalogue (blueprint/packages.json): which GETQUICK packages
// the blueprint knows, where each is discovered and installed from, and its
// upgrade policy. Composer packages (WordPress plugins and themes) are pinned
// by the require keys of the blueprint's CMS composer.json (composerFile);
// npm packages (`ecosystem: "npm"`, from GitHub Packages) by the dependencies
// of npmFile, the commerce Frontend's managed keys. The catalogue holds no
// version constraints and is checked against both, so they can't disagree.
// Packages one upstream releases together at one version share a
// `lockstep` group (ADR 0018), pinned exactly and moved together.
//
// A variant whose CMS skeleton has its own composer.json names it in
// variantComposerFiles; each file must require exactly the blueprint
// packages of its variants, at the same pin. requirementsFile records what
// each pinned version requires of other packages its registry serves (the
// registry's own metadata), so the pins are checked to satisfy one another
// offline: a pin that a pinned package's requirement excludes can't be
// installed (#142's gq-design 0.9.4 beside getquick-theme 0.5.1's ^0.3.1).
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { parseVersion, satisfiesConstraint } from "./versions.mjs";

export const CATALOGUE_FILENAME = "packages.json";
export const VARIANTS = ["content", "commerce"];
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
  // A variant's own CMS composer.json, when it isn't composerFile.
  variantComposerFiles: z
    .strictObject(Object.fromEntries(VARIANTS.map((variant) => [variant, z.string().min(1)])))
    .partial()
    .optional(),
  // What each pinned Composer package's pinned version requires (requirementsSchema).
  requirementsFile: z.string().min(1).optional(),
  // The npm pins: a JSON file whose dependencies pin every blueprint npm package.
  npmFile: z.string().min(1).optional(),
  packages: z.array(entry).min(1),
});

const requirementsSchema = z.strictObject({
  $comment: z.string().optional(),
  schemaVersion: z.literal(1),
  packages: z.record(
    composerName,
    z.strictObject({ version, require: z.record(composerName, z.string().min(1)) }),
  ),
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

// The validated catalogue; each CMS composer.json's text and JSON (composer
// is composerFile's, composers every file with the variants it serves); the
// npm pins; and the recorded requirements.
export async function loadCatalogue(blueprint) {
  const path = join(blueprint.directory, CATALOGUE_FILENAME);
  const result = catalogueSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`blueprint/${CATALOGUE_FILENAME} is invalid:\n  ${issues.join("\n  ")}`);
  }
  const catalogue = result.data;
  const composers = [];
  for (const { file, variants } of composerFiles(catalogue)) {
    const composerPath = join(blueprint.directory, file);
    const text = await readFile(composerPath, "utf8");
    composers.push({
      file,
      variants,
      path: composerPath,
      relativePath: relative(blueprint.root, composerPath),
      text,
      json: JSON.parse(text),
    });
  }
  const [main] = composers;
  const npmPath = catalogue.npmFile ? join(blueprint.directory, catalogue.npmFile) : null;
  const npmText = npmPath ? await readFile(npmPath, "utf8") : null;
  const npm = npmText === null ? null : JSON.parse(npmText);
  let requirements = null;
  const requirementsPath = catalogue.requirementsFile
    ? join(blueprint.directory, catalogue.requirementsFile)
    : null;
  if (requirementsPath) {
    const parsed = requirementsSchema.safeParse(
      JSON.parse(await readFile(requirementsPath, "utf8")),
    );
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      );
      throw new Error(
        `blueprint/${catalogue.requirementsFile} is invalid:\n  ${issues.join("\n  ")}`,
      );
    }
    requirements = parsed.data;
  }
  const problems = catalogueProblems(catalogue, main.json, npm, { composers, requirements });
  if (problems.length > 0) {
    const files = [
      ...composers.map((composer) => composer.file),
      catalogue.npmFile,
      catalogue.requirementsFile,
    ].filter(Boolean);
    throw new Error(
      `blueprint/${CATALOGUE_FILENAME} disagrees with ${files.join(" or ")}:\n  ${problems.join("\n  ")}`,
    );
  }
  return {
    catalogue,
    // Every CMS composer.json's require, merged (they agree on each pin).
    composer: mergedComposer(composers),
    composers,
    composerText: main.text,
    composerPath: main.path,
    composerFile: main.relativePath,
    npm,
    npmText,
    npmPath,
    npmFile: npmPath ? relative(blueprint.root, npmPath) : null,
    requirements,
    requirementsPath,
    requirementsFile: requirementsPath ? relative(blueprint.root, requirementsPath) : null,
  };
}

// The CMS composer.json files, each with the variants whose skeleton uses
// it: composerFile first, for every variant variantComposerFiles doesn't name.
export function composerFiles(catalogue) {
  const files = new Map([[catalogue.composerFile, []]]);
  for (const variant of VARIANTS) {
    const file = catalogue.variantComposerFiles?.[variant] ?? catalogue.composerFile;
    if (!files.has(file)) files.set(file, []);
    files.get(file).push(variant);
  }
  return [...files].map(([file, variants]) => ({ file, variants }));
}

// composerFile's JSON with every file's require merged in, the view planning
// reads pins from.
export function mergedComposer(composers) {
  const [main] = composers;
  const require = {};
  for (const { json } of composers) {
    for (const [name, value] of Object.entries(json.require ?? {})) {
      if (!Object.hasOwn(require, name)) require[name] = value;
    }
  }
  return { ...main.json, require };
}

// The requirements file's text for `requirements`, as gq writes it.
export function requirementsText(requirements) {
  return `${JSON.stringify(requirements, null, 2)}\n`;
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

// Every disagreement between the catalogue and its pin files (each CMS
// composer.json, npmFile when it has npm packages, and requirementsFile), as
// sentences. `composer` is composerFile's JSON; `composers` lists every CMS
// composer.json ({ file, variants, json }) when the catalogue names more than
// composerFile, and `requirements` is requirementsFile's JSON.
export function catalogueProblems(catalogue, composer, npm = null, options = {}) {
  const problems = [];
  const composers =
    options.composers ??
    composerFiles(catalogue).map(({ file, variants }) => ({
      file,
      variants,
      json: file === catalogue.composerFile ? composer : null,
    }));
  const names = new Set();
  for (const pkg of catalogue.packages) {
    if (names.has(pkg.name)) problems.push(`${pkg.name} is listed twice.`);
    names.add(pkg.name);
    if (isNpm(pkg)) {
      problems.push(...npmProblems(pkg, catalogue, npm));
      continue;
    }
    if (pkg.requirement === "blueprint" && pkg.variants.length === 0) {
      problems.push(`${pkg.name} is a blueprint requirement of no variant.`);
    }
  }
  const several = composers.length > 1;
  for (const { file, variants, json } of composers) {
    if (json === null) {
      problems.push(`${file} (the ${variants.join(", ")} CMS composer.json) wasn't read.`);
      continue;
    }
    problems.push(...composerProblems(catalogue, names, json, several ? { file, variants } : null));
  }
  problems.push(...pinAgreementProblems(catalogue, composers));
  // Every @quick-release dependency npmFile pins is catalogued.
  for (const name of Object.keys(npm?.dependencies ?? {})) {
    if (name.startsWith("@quick-release/") && !names.has(name)) {
      problems.push(`${name} is pinned in ${catalogue.npmFile} but isn't catalogued.`);
    }
  }
  const readable = composers.filter(({ json }) => json !== null);
  const merged = readable.length > 0 ? mergedComposer(readable) : composer;
  problems.push(...lockstepProblems(catalogue, merged, npm));
  if (catalogue.requirementsFile && !options.requirements) {
    problems.push(`${catalogue.requirementsFile} wasn't read.`);
  } else if (options.requirements && readable.length === composers.length) {
    problems.push(...requirementProblems(catalogue, composers, options.requirements));
  }
  return problems;
}

// One CMS composer.json against the catalogue: it requires a Composer
// package exactly when the package is a blueprint requirement of one of the
// file's variants (`scope`; every variant when the catalogue has one file),
// from a registry it names.
function composerProblems(catalogue, names, composer, scope) {
  const problems = [];
  const require = composer.require ?? {};
  const where = scope ? ` (${scope.file})` : "";
  for (const pkg of catalogue.packages) {
    if (isNpm(pkg)) continue;
    const required = Object.hasOwn(require, pkg.name);
    const expected =
      pkg.requirement === "blueprint" &&
      (!scope || pkg.variants.some((variant) => scope.variants.includes(variant)));
    if (required || expected) {
      const registry = registryRepository(composer, pkg.install.registry);
      if (!registry) {
        problems.push(
          `${pkg.name} installs from ${pkg.install.registry}, which isn't a composer repository there${where}.`,
        );
      } else if (!coveredBy(registry, pkg.name)) {
        problems.push(
          `${pkg.name} installs from ${pkg.install.registry}, whose "only" excludes it${where}.`,
        );
      }
    }
    if (pkg.requirement === "blueprint" && expected && !required) {
      problems.push(`${pkg.name} is a blueprint requirement but isn't in require${where}.`);
    }
    if (pkg.requirement !== "blueprint" && required) {
      problems.push(
        `${pkg.name} is in require${where} but the catalogue says requirement "${pkg.requirement}".`,
      );
    } else if (pkg.requirement === "blueprint" && required && !expected) {
      problems.push(
        `${pkg.name} is in require${where}, but the catalogue's variants for it (${pkg.variants.join(", ")}) don't include ${scope.variants.join(", ")}.`,
      );
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
      problems.push(`${name} is required from a catalogued registry${where} but isn't catalogued.`);
  }
  return problems;
}

// A package every CMS composer.json pins is pinned to one version.
function pinAgreementProblems(catalogue, composers) {
  const problems = [];
  const readable = composers.filter(({ json }) => json !== null);
  for (const pkg of catalogue.packages) {
    if (isNpm(pkg)) continue;
    const pins = readable
      .filter(({ json }) => Object.hasOwn(json.require ?? {}, pkg.name))
      .map(({ file, json }) => [file, json.require[pkg.name]]);
    if (new Set(pins.map(([, pin]) => pin)).size > 1) {
      problems.push(
        `${pkg.name} is pinned to different versions: ${pins.map(([file, pin]) => `${pin} in ${file}`).join(", ")}.`,
      );
    }
  }
  return problems;
}

// The recorded requirements agree with the pins: every pinned Composer
// package has its pinned version's record, and every record's requirements
// are satisfied by each composer.json that pins it.
function requirementProblems(catalogue, composers, requirements) {
  const problems = [];
  const file = catalogue.requirementsFile;
  const records = requirements.packages;
  const pinned = new Map();
  for (const pkg of catalogue.packages) {
    if (isNpm(pkg)) continue;
    for (const { json } of composers) {
      const pin = json?.require?.[pkg.name];
      if (pin !== undefined && !pinned.has(pkg.name)) pinned.set(pkg.name, pin);
    }
  }
  for (const [name, pin] of pinned) {
    const exact = parseVersion(pin);
    const record = records[name];
    if (!exact || exact.text !== pin) {
      problems.push(
        `${name} is pinned to ${pin}, not an exact version, so ${file} can't record what it requires.`,
      );
    } else if (!record) {
      problems.push(`${file} doesn't record what ${name} ${pin} requires.`);
    } else if (parseVersion(record.version)?.text !== pin) {
      problems.push(
        `${file} records what ${name} ${record.version} requires, but the blueprint pins ${pin}: record ${pin}'s requirements (gq packages check shows them).`,
      );
    }
  }
  for (const name of Object.keys(records)) {
    if (!pinned.has(name))
      problems.push(`${file} records ${name}, which the blueprint doesn't pin.`);
  }
  for (const [name, record] of Object.entries(records)) {
    if (!pinned.has(name)) continue;
    for (const [required, constraint] of Object.entries(record.require)) {
      for (const { file: composerFile, json } of composers) {
        if (!Object.hasOwn(json?.require ?? {}, name)) continue;
        const pin = json.require[required];
        if (pin === undefined) {
          problems.push(
            `${name} ${record.version} requires ${required} ${constraint}, which ${composerFile} doesn't pin.`,
          );
          continue;
        }
        const version = parseVersion(pin);
        const satisfied = version ? satisfiesConstraint(version, constraint) : null;
        if (satisfied === null) {
          problems.push(
            `${name} ${record.version} requires ${required} ${constraint}, which can't be checked against ${composerFile}'s ${pin}.`,
          );
        } else if (!satisfied) {
          problems.push(
            `${name} ${record.version} requires ${required} ${constraint}, but ${composerFile} pins ${required} ${pin}: Composer can't install them together.`,
          );
        }
      }
    }
  }
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

export function coveredBy(repository, packageName) {
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

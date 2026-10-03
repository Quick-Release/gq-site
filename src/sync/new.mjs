// gq new: creates a content site from the blueprint in a new directory: a v1
// gq.ops.json, the managed files, the create-once scaffolding (the CMS and
// Frontend skeletons among it) and gq.lock.json, then `git init`. In a
// terminal it asks for the values its arguments lack; elsewhere it names
// them. The site's main language (--locale, a WordPress locale) is asked for
// too, and is en_US when not given outside a terminal. Needs no network and
// no secrets: it prints the provisioning steps, which stay in the existing
// commands, and runs none of them.
import { cancel, isCancel, select, text } from "@clack/prompts";
import { mkdir, readdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

import packageTemplate from "../../blueprint/templates/fragments/package.keys.json" with { type: "json" };
import { MANIFEST_FILENAME, validateManifest, writeManifest } from "../manifest/manifest.mjs";
import { LOCALE_PATTERN, SCHEMA_URL, SCHEMA_VERSION, VARIANTS } from "../manifest/schema.mjs";
import { applyManagedFiles, planManagedFiles } from "./managed-files.mjs";

export const NEW_USAGE = ["gq new <dir> --project <name> --variant content [--locale <locale>]"];

const VALUE_OPTIONS = { "--project": "project", "--variant": "variant", "--locale": "locale" };

// The main language a new site gets unless it is given another.
const DEFAULT_LOCALE = "en_US";
const LOCALE_HINT = "a WordPress locale, like en_US, pt_PT or pt_PT_ao90";

// What `project` names: npm packages, Workers, buckets and the DDEV project.
const PROJECT_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

// The plugins the CMS skeleton's composer.json installs, in the order its
// deploy activates them.
const CONTENT_PLUGINS = [
  "gq-design",
  "gq-support",
  "wp-graphql",
  "wpgraphql-blocks",
  "s3-uploads",
  "simple-history",
  "cimo-image-optimizer",
  "safe-svg",
];

// The root scripts that provision a new site, in order. Each runs its gq
// command through gq sigillo run, which injects the command's secrets.
// cf:media and ploi:media host the CMS's uploads on R2, independently of it;
// frontend:secrets generates the Frontend's refresh token and event key
// before ci:deploy gives them to CI releases and ploi:events gives the event
// key and the retry/reconciliation crontab to the CMS.
const PROVISIONING = [
  "ploi:provision",
  "cf:deploy-token",
  "cf:releases",
  "cf:media",
  "ploi:media",
  "cf:ci",
  "github:setup",
  "frontend:secrets",
  "ci:deploy",
  "ploi:events",
];

export function isNewCommand(argv) {
  return argv[0] === "new";
}

export async function runNewCommand(args, { cwd, env, exec, stdin, io, interactive }) {
  const given = parseNewArguments(args);
  if (given.variant === "commerce") {
    throw new Error("gq new --variant commerce is not supported until phase 4.");
  }
  const options = interactive ? await askForMissing(given, { stdin, io }) : given;
  if (options === undefined) return 1;
  const missing = missingValues(options);
  if (missing.length > 0) {
    throw new Error(
      `gq new is missing ${listed(missing)}; pass them, or run it in a terminal to be asked. ` +
        `Usage: ${NEW_USAGE[0]}`,
    );
  }
  const { directory, project, variant, locale = DEFAULT_LOCALE } = options;
  if (!PROJECT_PATTERN.test(project)) {
    throw new Error(
      `--project must be lowercase letters, digits and hyphens, starting with a letter: ${project}`,
    );
  }
  if (!LOCALE_PATTERN.test(locale)) throw new Error(`--locale must be ${LOCALE_HINT}: ${locale}`);
  const manifest = validateManifest({
    $schema: SCHEMA_URL,
    schemaVersion: SCHEMA_VERSION,
    project,
    variant,
    wordpress: { plugins: CONTENT_PLUGINS, locale },
  });
  const root = resolve(cwd, directory);
  if ((await readDirectoryIfExists(root))?.length > 0) throw new Error(`${root} is not empty.`);

  await mkdir(root, { recursive: true });
  await writeManifest(join(root, MANIFEST_FILENAME), manifest);
  const plan = await planManagedFiles(root, manifest);
  await applyManagedFiles(root, plan);
  const result = await exec("git", ["init", "--quiet"], { cwd: root, env });
  if (result.code !== 0) {
    throw new Error(`git init failed in ${root}: ${(result.stderr || result.stdout).trim()}`);
  }

  io.out(`Created ${project} (${variant}, ${locale}) in ${root}:`);
  for (const { path } of [{ path: MANIFEST_FILENAME }, ...plan.files, plan.lock]) {
    io.out(`  ${path}`);
  }
  reportProvisioning(io, { project, directory: relative(cwd, root) || "." });
  return 0;
}

function reportProvisioning(io, { project, directory }) {
  io.out("");
  io.out(`Next, provision ${project} with the existing commands (gq new ran none of them):`);
  io.out(`  cd ${directory}`);
  io.out("  pnpm install");
  io.out("  # Fill in gq.ops.json (sigillo, domains, ploi, releases, media, backups,");
  io.out("  # cloudflare, artifacts, ci, github), then regenerate the managed files.");
  io.out("  # Leave github out to keep the code in Cloudflare Artifacts only:");
  io.out("  pnpm exec gq sync");
  for (const script of PROVISIONING) {
    io.out(scriptLine(script));
    // An Artifacts-only site pushes to Artifacts instead of connecting GitHub.
    if (script === "github:setup") {
      io.out(
        `  ${"pnpm git:artifacts setup".padEnd(24)}  # or, without github: origin is Artifacts`,
      );
    }
  }
  io.out("  # Release (pnpm push minor), install WordPress, then release again so the CMS");
  io.out("  # deploy activates the plugins and theme and applies the event key. CI releases");
  io.out("  # deploy the Frontend with its publication store. Then prepare the Site (until");
  io.out("  # then its pages are a 503) and prove its uploads with a CMS check user:");
  io.out(scriptLine("frontend:refresh"));
  io.out(scriptLine("media:check:upload"));
  io.out("  # Ready only when every part holds: CMS schema, Frontend store and secrets,");
  io.out("  # the CMS's scheduler reconciling, and independent media (exit 1 until then):");
  io.out(scriptLine("site:check"));
}

function scriptLine(script) {
  const command = packageTemplate.scripts[script].replace(/^gq sigillo run \S+ -- /u, "");
  return `  ${`pnpm ${script}`.padEnd(24)}  # ${command}`;
}

// The options with each missing one asked for, the project suggested from
// the directory's name and the directory from the project's; undefined when
// the person cancels.
async function askForMissing(given, { stdin, io }) {
  const streams = { input: stdin, output: io.stdout };
  const options = { ...given };
  if (options.project === undefined) {
    const project = await text({
      message: "Project name (names its packages, Workers and DDEV project)",
      initialValue: options.directory === undefined ? "" : basename(options.directory),
      validate: (value) =>
        PROJECT_PATTERN.test(value ?? "")
          ? undefined
          : "Lowercase letters, digits and hyphens, starting with a letter.",
      ...streams,
    });
    if (isCancel(project)) return cancelled(io);
    options.project = project;
  }
  if (options.directory === undefined) {
    const directory = await text({
      message: "Directory to create it in",
      initialValue: options.project,
      validate: (value) => (value?.trim() ? undefined : "A directory is required."),
      ...streams,
    });
    if (isCancel(directory)) return cancelled(io);
    options.directory = directory.trim();
  }
  if (options.variant === undefined) {
    const variant = await select({
      message: "Variant",
      options: VARIANTS.map((value) =>
        value === "content"
          ? { value, label: "content", hint: "a content site" }
          : { value, label: value, hint: "not supported until phase 4", disabled: true },
      ),
      ...streams,
    });
    if (isCancel(variant)) return cancelled(io);
    options.variant = variant;
  }
  if (options.locale === undefined) {
    const locale = await text({
      message: "Main language (a WordPress locale: en_US, pt_PT, pt_PT_ao90…)",
      initialValue: DEFAULT_LOCALE,
      validate: (value) =>
        LOCALE_PATTERN.test(value ?? "") ? undefined : `Must be ${LOCALE_HINT}.`,
      ...streams,
    });
    if (isCancel(locale)) return cancelled(io);
    options.locale = locale;
  }
  return options;
}

function cancelled(io) {
  cancel("gq new cancelled; nothing was written.", { output: io.stdout });
  return undefined;
}

function missingValues({ directory, project, variant }) {
  return [
    ...(directory === undefined ? ["<dir>"] : []),
    ...(project === undefined ? ["--project"] : []),
    ...(variant === undefined ? ["--variant"] : []),
  ];
}

// "a", "a and b", "a, b and c".
function listed(items) {
  return items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

async function readDirectoryIfExists(directory) {
  try {
    return await readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    if (error.code === "ENOTDIR") {
      throw new Error(`${directory} is not a directory.`, { cause: error });
    }
    throw error;
  }
}

// Each value may be missing; anything else unexpected is a usage error.
function parseNewArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const option = VALUE_OPTIONS[argument];
    if (option && options[option] === undefined && args[index + 1] !== undefined) {
      options[option] = args[index + 1];
      index += 1;
    } else if (!argument.startsWith("--") && options.directory === undefined) {
      options.directory = argument;
    } else throw new Error(`Usage: ${NEW_USAGE[0]}`);
  }
  if (options.variant !== undefined && !VARIANTS.includes(options.variant)) {
    throw new Error(`--variant must be ${VARIANTS.join(" or ")}: ${options.variant}`);
  }
  return options;
}

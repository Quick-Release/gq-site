// `gq content`: an agent's reads and writes of one page's (or post's) raw
// block markup on the Site's production CMS, over REST as the Site's agent
// user behind Cloudflare Access (gq-platform ADR 0011):
//
//   gq content get <id> --out <file> [--type page|post] [--revision <id>]
//   gq content diff <id> --file <file> [--type page|post]
//   gq content validate <id> --file <file> [--type page|post]
//   gq content put <id> --file <file> [--type page|post] [--yes] [--without-validation]
//
// `get` writes `content.raw` as stored, or, to a `.json` file, its parsed
// block tree, which is what an edit changes (blocks moved, attributes set),
// never the markup's text. `diff` compares a file with what the CMS holds
// now. `validate` writes the file to the same post in the Site's DDEV CMS
// and opens it in the block editor (validate.mjs). `put` writes it once, only
// if those same bytes passed validate and the post hasn't changed since
// `get`, then confirms WordPress stored them and recorded a new revision: the
// rollback. A `.json` file is serialized first; its bytes are what's checked.
//
// Credentials come only from the environment (gq sigillo run production --
// …): GQ_CMS_AGENT_USERNAME / GQ_CMS_AGENT_APPLICATION_PASSWORD always, and
// GQ_CMS_AGENT_ACCESS_CLIENT_ID / _SECRET or a `cloudflared access login`
// session for the edge (transport.mjs). Nothing here publishes: the Frontend
// gets the change through gq frontend refresh.

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { CMS_PATH, ddevStatus } from "../cms/local.mjs";
import { readEnvFile } from "../cli/env-files.mjs";
import { createReporter } from "../cli/reporter.mjs";
import { assertLocalTarget } from "../db/sync.mjs";
import { loadProjectContext } from "../ops/project-context.mjs";
import { outlineText, parseBlocks, serializeBlocks, unparsableBlocks } from "./blocks.mjs";
import { evaluateInPage, findChrome } from "./browser.mjs";
import { diffStat, unifiedDiff } from "./diff.mjs";
import { createReceipts, sha256 } from "./receipts.mjs";
import { readPost, readRevision, revisionIds, writePost } from "./remote.mjs";
import {
  agentAuthorization,
  agentClient,
  cmsOrigin,
  CONTENT_TYPES,
  edgeCredential,
} from "./transport.mjs";
import { validateLocally } from "./validate.mjs";

const ACTIONS = new Map([
  [
    "get",
    [
      "gq content get <id> --out <file> [--type page|post] [--revision <id>]",
      ["out", "type", "revision"],
    ],
  ],
  ["diff", ["gq content diff <id> --file <file> [--type page|post]", ["file", "type"]]],
  ["validate", ["gq content validate <id> --file <file> [--type page|post]", ["file", "type"]]],
  [
    "put",
    [
      "gq content put <id> --file <file> [--type page|post] [--yes] [--without-validation]",
      ["file", "type", "yes", "without-validation"],
    ],
  ],
]);

export const CONTENT_USAGE = [...ACTIONS.values()].map(([usage]) => usage);

const OPTIONS = {
  out: { type: "string" },
  file: { type: "string" },
  type: { type: "string" },
  revision: { type: "string" },
  yes: { type: "boolean" },
  "without-validation": { type: "boolean" },
};

export function isContentCommand(argv) {
  return argv[0] === "content";
}

function usage() {
  return new Error(`Usage:\n${CONTENT_USAGE.map((line) => `  ${line}`).join("\n")}`);
}

export function parseContentArguments(argv) {
  const [action, ...rest] = argv;
  const entry = ACTIONS.get(action);
  if (!entry) throw usage();
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new Error(`${error.message}\n${entry[0]}`, { cause: error });
  }
  const { values, positionals } = parsed;
  for (const name of Object.keys(values)) {
    if (!entry[1].includes(name))
      throw new Error(`--${name} is not valid for gq content ${action}.`);
  }
  if (positionals.length !== 1 || !/^[1-9][0-9]*$/u.test(positionals[0])) {
    throw new Error(`Name one post ID.\n${entry[0]}`);
  }
  const type = values.type ?? "page";
  if (!CONTENT_TYPES.has(type)) throw new Error(`--type is page or post, not ${type}.`);
  if (values.revision !== undefined && !/^[1-9][0-9]*$/u.test(values.revision)) {
    throw new Error("--revision is a revision ID.");
  }
  const file = action === "get" ? values.out : values.file;
  if (!file)
    throw new Error(`${action === "get" ? "--out" : "--file"} <file> is required.\n${entry[0]}`);
  return {
    action,
    id: Number(positionals[0]),
    type,
    base: CONTENT_TYPES.get(type),
    file,
    revision: values.revision === undefined ? undefined : Number(values.revision),
    yes: values.yes === true,
    withoutValidation: values["without-validation"] === true,
  };
}

/** The markup a file holds: as is, or a `.json` block tree serialized. */
export async function readMarkup(path) {
  const text = await readFile(path, "utf8");
  if (!path.endsWith(".json")) return text;
  let tree;
  try {
    tree = JSON.parse(text);
  } catch {
    throw new Error(`${path} isn't JSON; a .json file holds a block tree from gq content get.`);
  }
  return serializeBlocks(tree);
}

// `argv` is everything after `gq content`. Resolves to the exit code.
// `openEditor` stands in for the headless Chrome (tests).
export async function runContentCommand(argv, dependencies) {
  const command = parseContentArguments(argv);
  const context = await loadProjectContext({ cwd: dependencies.cwd, env: dependencies.env });
  const ops = context.config;
  const origin = cmsOrigin(ops);
  const file = resolve(context.invocationDirectory, command.file);
  const receipts = createReceipts({ env: context.env, admin: ops.domains.admin });
  const shared = { ...dependencies, context, ops, origin, file, receipts, command };
  if (command.action === "validate") return validate(shared);
  return { get, diff, put }[command.action](shared);
}

async function remote({ context, exec, fetch, origin }) {
  const authorization = agentAuthorization(context.env);
  const edge = await edgeCredential({ env: context.env, exec, origin });
  return { request: agentClient({ origin, authorization, edge, fetch }), edge };
}

const label = ({ type, id }) => `${type} ${id}`;

async function get(shared) {
  const { command, file, io, receipts } = shared;
  const { request, edge } = await remote(shared);
  const read = command.revision
    ? await readRevision(request, command.base, command.id, command.revision)
    : await readPost(request, command.base, command.id);
  if (command.revision && read.parent !== command.id) {
    throw new Error(
      `Revision ${command.revision} belongs to ${read.parent}, not ${label(command)}.`,
    );
  }
  const tree = parseBlocks(read.raw);
  if (file.endsWith(".json")) {
    // A tree that doesn't serialize to the stored markup would rewrite more
    // than the edit.
    if (unparsableBlocks(tree).length > 0 || serializeBlocks(tree) !== read.raw) {
      throw new Error(
        `The parsed tree of ${label(command)} doesn't serialize back to its markup byte for byte; get it as .html.`,
      );
    }
    await writeFile(file, `${JSON.stringify(tree, null, 2)}\n`);
  } else {
    await writeFile(file, read.raw);
  }
  if (!command.revision) {
    await receipts.recordBase(command.type, command.id, {
      sha256: sha256(read.raw),
      modifiedGmt: read.modifiedGmt,
      readAt: new Date().toISOString(),
    });
  }
  const what = command.revision
    ? `revision ${command.revision} of ${label(command)}`
    : `${label(command)} (${read.status})`;
  io.out(
    `Wrote ${what} to ${command.file}: ${tree.filter((node) => node.blockName).length} top-level blocks, ${Buffer.byteLength(read.raw)} bytes.`,
  );
  io.out(`Edge: ${edge.kind}.`);
  return 0;
}

function printDiff(io, before, after, { from, to }) {
  const blocks = unifiedDiff(outlineText(parseBlocks(before)), outlineText(parseBlocks(after)), {
    from,
    to,
  });
  io.out(blocks ? `Blocks:\n${blocks}` : "Blocks: the same structure and attributes.");
  io.out(`Markup:\n${unifiedDiff(before, after, { from, to })}`);
}

async function diff(shared) {
  const { command, file, io } = shared;
  const markup = await readMarkup(file);
  const { request } = await remote(shared);
  const current = await readPost(request, command.base, command.id);
  if (current.raw === markup) {
    io.out(`${command.file} is what the CMS holds for ${label(command)}.`);
    return 0;
  }
  printDiff(io, current.raw, markup, { from: `cms ${label(command)}`, to: command.file });
  return 0;
}

async function composerLockDigest(context) {
  const lock = await readFile(join(context.projectRoot, CMS_PATH, "composer.lock"), "utf8").catch(
    () => "",
  );
  return lock ? sha256(lock) : null;
}

async function validate(shared) {
  const { command, context, env, exec, file, io, ops, receipts } = shared;
  const markup = await readMarkup(file);
  const cmsRoot = join(context.projectRoot, CMS_PATH);
  if ((await ddevStatus(exec, cmsRoot, env)) !== "running") {
    throw new Error("The local CMS isn't running: gq cms start, and gq db sync for live content.");
  }
  const local = assertLocalTarget(await readEnvFile(join(cmsRoot, ".env")), {
    liveDomains: [ops.domains.admin, ops.domains.frontend].filter(Boolean),
  });
  const openEditor =
    shared.openEditor ??
    (async (page) => {
      const binary = findChrome(env);
      if (!binary) throw new Error("validate needs Chrome or Chromium; set CHROMIUM to one.");
      return evaluateInPage({ binary, ...page });
    });
  const wp = (args, options = {}) =>
    exec("ddev", ["wp", ...args], { cwd: cmsRoot, env, ...options });
  io.out(`Validating ${command.file} as ${label(command)} in ${local.homeUrl}`);
  const result = await validateLocally({
    wp,
    openEditor,
    origin: local.homeUrl,
    id: command.id,
    type: command.type,
    content: markup,
  });
  if (!result.ok) {
    io.err(`✗ ${result.reason}.`);
    for (const problem of result.problems) {
      io.err(`  ${problem.path} ${problem.name}: ${problem.reason}`);
      for (const issue of problem.issues ?? [])
        io.err(`      ${issue.replaceAll("\n", "\n      ")}`);
    }
    if (result.storedContent !== undefined)
      io.err(unifiedDiff(markup, result.storedContent, { from: command.file, to: "stored" }));
    return 1;
  }
  const digest = sha256(markup);
  await receipts.recordValidation(command.type, command.id, digest, {
    validatedAt: new Date().toISOString(),
    composerLock: await composerLockDigest(context),
    blocks: result.count,
  });
  io.out(`✓ ${result.count} blocks valid in the Site's editor (sha256 ${digest.slice(0, 12)}).`);
  for (const { path, name } of result.migrated) {
    io.out(
      `  ! ${path} ${name}: valid only as an older version of the block; the editor rewrites it on its next save.`,
    );
  }
  if (result.freeform > 0)
    io.out(
      `  ${result.freeform} classic (freeform) block(s): loose HTML, not checked against a save().`,
    );
  return 0;
}

async function put(shared) {
  const { command, context, file, interactive, io, receipts } = shared;
  const markup = await readMarkup(file);
  const digest = sha256(markup);
  const ui = createReporter(io, interactive);

  if (command.withoutValidation) {
    io.err("! --without-validation: writing markup the Site's editor hasn't validated.");
  } else {
    const receipt = await receipts.readValidation(command.type, command.id, digest);
    if (!receipt) {
      throw new Error(
        `These bytes haven't passed gq content validate ${command.id} --file ${command.file}${command.type === "page" ? "" : ` --type ${command.type}`}; validate them first.`,
      );
    }
    if (receipt.composerLock !== (await composerLockDigest(context))) {
      throw new Error("apps/cms/composer.lock changed since validation; validate again.");
    }
  }

  const { request } = await remote(shared);
  const current = await readPost(request, command.base, command.id);
  const base = await receipts.readBase(command.type, command.id);
  if (!base)
    throw new Error(
      `Run gq content get ${command.id} first: put only changes content it has read.`,
    );
  if (base.sha256 !== sha256(current.raw)) {
    throw new Error(
      `${label(command)} changed in the CMS since gq content get (modified ${current.modifiedGmt}); get it again and redo the edit.`,
    );
  }
  if (current.raw === markup) {
    io.out(`${label(command)} already holds ${command.file}; nothing to write.`);
    return 0;
  }

  const { removed, added } = diffStat(current.raw, markup);
  io.out(`${label(command)} (${current.status}, ${current.link}): -${removed} +${added} lines.`);
  if (!command.yes) {
    if (!interactive)
      throw new Error("Pass --yes to write to the production CMS non-interactively.");
    if (
      !(await ui.confirm(
        `Write ${command.file} to ${label(command)} on ${shared.ops.domains.admin}?`,
      ))
    ) {
      io.out("Nothing written.");
      return 0;
    }
  }

  const before = await revisionIds(request, command.base, command.id);
  // The rollback is the newest revision, if it holds what is about to be replaced.
  const previous =
    before.length > 0 &&
    (await readRevision(request, command.base, command.id, before[0])).raw === current.raw
      ? before[0]
      : null;
  const written = await writePost(request, command.base, command.id, markup);
  const after = await revisionIds(request, command.base, command.id);
  const created = after.filter((revision) => !before.includes(revision));
  await receipts.recordBase(command.type, command.id, {
    sha256: sha256(written.raw),
    modifiedGmt: written.modifiedGmt,
    readAt: new Date().toISOString(),
  });
  const rollback = previous
    ? `Roll back: gq content get ${command.id} --revision ${previous} --out <file>, then validate and put it.`
    : "No earlier revision holds the replaced markup; keep the file gq content get wrote as the rollback.";
  if (written.raw !== markup) {
    io.err(
      `✗ WordPress stored other markup than ${command.file} (KSES or a content filter changed it).`,
    );
    io.err(unifiedDiff(markup, written.raw, { from: command.file, to: "stored" }));
    io.err(rollback);
    return 1;
  }
  if (created.length === 0) {
    io.err(
      `✗ Wrote ${label(command)}, but WordPress recorded no new revision (it records none for a change of whitespace only).`,
    );
    io.err(rollback);
    return 1;
  }
  const revision = await readRevision(request, command.base, command.id, created[0]);
  if (revision.raw !== markup) {
    io.err(`✗ Revision ${created[0]} doesn't hold what was written.`);
    return 1;
  }
  io.out(`✓ Wrote ${label(command)}; revision ${created[0]} holds it.`);
  io.out(rollback);
  const path = URL.canParse(written.link) ? new URL(written.link).pathname : null;
  io.out(
    `Publish to the Frontend: gq frontend refresh${path ? ` --uri ${path}` : ""}, then check the live page.`,
  );
  return 0;
}

// The blueprint's managed files in one site. blueprint/ownership.json, which
// ships with the package, lists every path the blueprint touches by category;
// anything it doesn't list is site-owned and never read or written here.
// gq.lock.json, committed at the site root, records the gq version, the
// schema version and the hash of each managed file and section as gq last
// wrote it, so one whose hash no longer matches is a local edit rather than
// an old template. Fully generated files are regular files, executable or
// not, and symlinks (whose target is what gets hashed); a generated section
// is the part of a site's text file between gq's begin and end lines; managed
// keys are the keys of a site's JSON file that gq sets, each hashed apart.
// A create-once file is written only when absent and never written again
// (the lock records it as created once it exists, whoever wrote it), unless
// gq sync --recreate asks for it. A file gq manages keys of that starts from
// an `initial` template (the root package.json) gets that template's keys
// only when gq creates it; `gq sync --recreate <path>` adds each of them the
// file lacks, and changes no key it has. One of an app skeleton (its `app`, the
// app's directory) is written only with its app: while that directory is
// missing, so an app the site already has never gains skeleton files. A
// fully generated file with a `manifestKey` exists only while gq.ops.json
// has that key: without it, gq sync writes none, and removes one it wrote
// that the site hasn't edited since.
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import ownership from "../../blueprint/ownership.json" with { type: "json" };
import packageTemplate from "../../blueprint/templates/fragments/package.keys.json" with { type: "json" };
import packageJson from "../../package.json" with { type: "json" };
import { deployStatusMarker } from "../ploi/provision.mjs";
import { frontendFramework } from "../manifest/schema.mjs";
import { VERSION } from "../version.mjs";

export const LOCK_FILENAME = "gq.lock.json";

const BLUEPRINT = new URL("../../blueprint/", import.meta.url);

// A blueprint template's text, as it ships.
function readTemplate(template) {
  return readFile(new URL(template, BLUEPRINT), "utf8");
}

// A template's text with each `{{name}}` replaced by the site's value for
// it (templateValues), or by `<name>` while gq.ops.json lacks that value,
// so a site can be generated before it is provisioned. A name gq doesn't
// know is refused, so a typo can't ship as literal text.
async function renderTemplate(template, manifest) {
  const values = templateValues(manifest);
  return (await readTemplate(template)).replaceAll(/\{\{([\w.]+)\}\}/gu, (token, name) => {
    if (!Object.hasOwn(values, name)) {
      throw new Error(`The blueprint's ${template} uses ${token}, which gq doesn't render.`);
    }
    return values[name] ?? `<${name}>`;
  });
}

// What a template's `{{name}}` stands for: the manifest's site values under
// their key paths (`variant` among them), `Project` (project in PascalCase, for names and prose),
// `deployStatusMarker` (the CMS deploy's status line, which gq ploi release
// waits for), `deployment.guardedPackages` space-separated (empty for a Site
// that guards none), `wordpress.plugins` space-separated (none until the manifest
// lists some, so the deploy script stays valid shell), `wordpress.locale`
// (empty without one, so the deploy leaves the language alone),
// `wordpress.languages` as space-separated locale:slug pairs (empty for a
// monolingual Site, so the deploy leaves Polylang alone), the blueprint's
// own pins in the root package.json, `packageManager`
// and `nodeEngine` (engines.node), so a copy of one can't drift, and the
// versions a new site installs: `gqVersion` (this @getquick/site) and
// `sigilloVersion` (the Sigillo CLI it is tested with). Only fully
// generated and create-once templates, and managed keys' initial file, are
// rendered; a section's or managed keys' template is used as it ships.
const ADMIN_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/u;

function templateValues(manifest) {
  const { project } = manifest;
  return {
    project,
    variant: manifest.variant,
    Project: project
      .split(/[^A-Za-z0-9]+/u)
      .filter(Boolean)
      .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
      .join(""),
    packageManager: packageTemplate.packageManager,
    nodeEngine: packageTemplate.engines.node,
    gqVersion: VERSION,
    sigilloVersion: packageJson.devDependencies.sigillo,
    deployStatusMarker: deployStatusMarker(project),
    "wordpress.plugins": (manifest.wordpress?.plugins ?? []).join(" "),
    "deployment.guardedPackages": (manifest.deployment?.guardedPackages ?? []).join(" "),
    "wordpress.locale": manifest.wordpress?.locale ?? "",
    "wordpress.languages": (manifest.wordpress?.languages ?? [])
      .map(({ locale, slug }) => `${locale}:${slug}`)
      .join(" "),
    "ci.worker": manifest.ci?.worker,
    "ci.backupBucket": manifest.ci?.backupBucket,
    "artifacts.namespace": manifest.artifacts?.namespace,
    "artifacts.repo": manifest.artifacts?.repo,
    "cloudflare.accountId": manifest.cloudflare?.accountId,
    "domains.admin": manifest.domains?.admin,
    // For a shell script: the admin domain only if it is a plain hostname,
    // else empty (the script then refuses), so nothing else can reach a shell.
    "domains.adminHost": ADMIN_HOST.test(manifest.domains?.admin ?? "")
      ? manifest.domains.admin
      : "",
    "domains.frontend": manifest.domains?.frontend,
    // Optional: a site without one keeps its code in Artifacts only, so it
    // renders empty rather than as a placeholder to fill in.
    "github.repository": manifest.github?.repository ?? "",
  };
}

// What gq sync would do in `root` for the validated `manifest`: for each
// managed path, its `status` (`unchanged`, `create`, `update`, or `edited`
// when the site changed it since gq last wrote it), its `current` and
// rendered `content` (for a symlink, its target as a line of text, so either
// can be diffed), the `scope` gq manages when that is only part of an
// existing file, and the lock to record (`lock.status` `unchanged`, `create`
// or `update`). `recreate` lists the create-once files to write again, and
// the files with initial keys to add the missing ones to.
export async function planManagedFiles(root, manifest, { recreate = [] } = {}) {
  const applicable = ownership.createOnce.filter((entry) => appliesTo(entry, manifest));
  const recreatable = applicable.filter(({ template }) => template !== undefined);
  const initialFiles = ownership.managedKeys
    .filter((entry) => entry.initial !== undefined && appliesTo(entry, manifest))
    .map(({ path }) => path);
  const apps = new Set(applicable.flatMap(({ app }) => app ?? []));
  for (const path of recreate) {
    if (!recreatable.some((entry) => entry.path === path) && !initialFiles.includes(path)) {
      const rootFiles = recreatable.flatMap((entry) => (entry.app ? [] : [entry.path]));
      throw new Error(
        `gq sync can't recreate ${path}: --recreate takes a file the blueprint creates once ` +
          `(${rootFiles.join(", ")}, or a file of the ${[...apps].join(" or ")} skeleton)` +
          initialFiles
            .map((file) => `, or ${file}, to add the keys a new one starts with`)
            .join("") +
          ".",
      );
    }
  }
  const lock = await readLock(root);
  const missingApps = new Set();
  for (const app of apps) {
    if ((await readEntry(join(root, app))) === undefined) missingApps.add(app);
  }
  const applies = (entry) => appliesTo(entry, manifest);
  const created = await Promise.all(
    ownership.createOnce
      .filter(applies)
      .map((entry) => planCreateOnce(root, lock, manifest, entry, { recreate, missingApps })),
  );
  // A file gq creates once and manages keys of (a skeleton's composer.json)
  // is written once, with its keys set.
  const writing = new Map(
    created
      .filter(({ status }) => status === "create" || status === "update")
      .map((plan) => [plan.path, plan]),
  );
  const keyed = await Promise.all(
    ownership.managedKeys.filter(applies).map((entry) =>
      planKeys(root, lock, manifest, entry, writing.get(entry.path), {
        addInitial: recreate.includes(entry.path),
      }),
    ),
  );
  for (const keys of keyed) {
    const file = writing.get(keys.path);
    if (file === undefined) continue;
    file.content = keys.content;
    file.write = { ...file.write, bytes: keys.content };
    file.record = { ...file.record, ...keys.record };
  }
  const planned = [
    ...(await Promise.all([
      ...ownership.fullyGenerated
        .filter(applies)
        .map((entry) => planGeneratedFile(root, lock, manifest, entry)),
      ...ownership.fullyGenerated
        .filter((entry) => !applies(entry) && entry.manifestKey !== undefined)
        .map((entry) => planRetiredFile(root, lock, entry)),
      ...ownership.generatedSections.filter(applies).map((entry) => planSection(root, lock, entry)),
    ])),
    ...keyed.filter(({ path }) => !writing.has(path)),
    ...created,
  ];
  planned.sort((a, b) => (a.path < b.path ? -1 : 1));
  // A create-once file without a template (gq.ops.json) is only recorded.
  const files = planned.filter(({ status }) => status !== undefined);

  const recorded = { files: {}, sections: {}, keys: {}, created: [] };
  for (const { record } of planned) {
    for (const [kind, value] of Object.entries(record)) {
      if (kind === "created") recorded.created.push(...value);
      else Object.assign(recorded[kind], value);
    }
  }
  const content = `${JSON.stringify(
    { gq: VERSION, schemaVersion: manifest.schemaVersion, ...recorded },
    null,
    2,
  )}\n`;
  const status = lock === undefined ? "create" : lock.text === content ? "unchanged" : "update";
  return { files, lock: { path: LOCK_FILENAME, status, content } };
}

// Writes what `plan` creates or updates, and removes what it removes, the
// lock last. Refuses a plan with an edited file: nothing is written then.
// What a whole managed file or symlink replaces is removed first, so a write
// never goes through a symlink the site left there; a file gq manages only
// part of is a regular file (or missing), written in place so it keeps its
// mode.
export async function applyManagedFiles(root, plan) {
  if (plan.files.some(({ status }) => status === "edited")) {
    throw new Error("Refusing to write managed files over local edits.");
  }
  const lock = { status: plan.lock.status, write: { replace: true, bytes: plan.lock.content } };
  for (const { path: file, status, write } of [...plan.files, { path: LOCK_FILENAME, ...lock }]) {
    if (status === "unchanged") continue;
    const path = join(root, file);
    if (status === "remove") {
      await rm(path, { force: true });
      continue;
    }
    await mkdir(dirname(path), { recursive: true });
    if (write.replace) await rm(path, { force: true });
    if (write.symlink !== undefined) await symlink(write.symlink, path);
    else {
      await writeFile(path, write.bytes);
      if (write.executable) await chmod(path, 0o755);
    }
  }
}

// Whether an ownership entry applies to the Site: one marked with
// `variants` applies only to a Site of one of them (ADR 0017), so two entries
// may share a path, each for its own variants; one marked with a `framework`
// only to a Site whose Frontend uses it; one marked with a
// `contentRuntime` applies only to a Site whose gq.ops.json names that
// runtime (ADR 0020), so a Site generated before keeps what it copied; one
// marked with a `manifestKey` only while gq.ops.json has that key (`forms`).
export function appliesTo(entry, manifest) {
  return (
    (entry.variants === undefined || entry.variants.includes(manifest.variant)) &&
    (entry.framework === undefined || entry.framework === frontendFramework(manifest)) &&
    (entry.contentRuntime === undefined || entry.contentRuntime === manifest.contentRuntime) &&
    (entry.manifestKey === undefined || manifest[entry.manifestKey] !== undefined)
  );
}

// A fully generated file whose `manifestKey` gq.ops.json no longer has: gq
// sync removes it while it is as gq last wrote it, and otherwise leaves it,
// the site's now. Either way the lock stops recording it.
async function planRetiredFile(root, lock, { path }) {
  const written = lock?.files[path];
  const current = written === undefined ? undefined : await readEntry(join(root, path));
  const status = current !== undefined && hashEntry(current) === written ? "remove" : undefined;
  return {
    path,
    status,
    current: current && displayEntry(current),
    content: Buffer.alloc(0),
    record: {},
  };
}

// A fully generated file or symlink, rendered whole from its template.
async function planGeneratedFile(
  root,
  lock,
  manifest,
  { path, template, symlink, executable = false },
) {
  const rendered =
    symlink === undefined
      ? { bytes: Buffer.from(await renderTemplate(template, manifest)), executable }
      : { symlink };
  const current = await readEntry(join(root, path));
  const [currentHash, renderedHash] = [hashEntry(current), hashEntry(rendered)];
  let status;
  if (current === undefined) status = "create";
  else if (sameEntry(current, rendered)) status = "unchanged";
  // Unedited since gq wrote it, or differing from the template only in mode.
  else if (currentHash !== undefined && [lock?.files[path], renderedHash].includes(currentHash)) {
    status = "update";
  } else status = "edited";
  return {
    path,
    status,
    current: current && displayEntry(current),
    content: displayEntry(rendered),
    write: { replace: true, ...rendered },
    record: { files: { [path]: renderedHash } },
  };
}

// A generated section: the template, from its `BEGIN gq` line to its
// `END gq` line, inside a text file the site owns otherwise. It is
// rewritten in place; a file without one gets it appended, and a missing
// file is created holding only the section.
async function planSection(root, lock, { path, template }) {
  const section = await readTemplate(template);
  const record = { sections: { [path]: hash(section) } };
  const current = await readEntry(join(root, path));
  if (current === undefined) {
    const content = Buffer.from(section);
    return { path, status: "create", content, write: { bytes: content }, record };
  }
  if (current.bytes === undefined) {
    throw new Error(`${path} must be a regular file: gq sync manages a section of it.`);
  }
  const text = current.bytes.toString("utf8");
  const found = findSection(path, text, sectionMarkers(section));
  let status;
  let next;
  if (found === undefined) {
    status = "update";
    next = text === "" ? section : `${text}${text.endsWith("\n") ? "" : "\n"}\n${section}`;
  } else {
    if (found.text === section) status = "unchanged";
    else if (hash(found.text) === lock?.sections[path]) status = "update";
    else status = "edited";
    next = `${text.slice(0, found.start)}${section}${text.slice(found.end)}`;
  }
  const content = Buffer.from(next);
  return {
    path,
    status,
    scope: "generated section",
    current: current.bytes,
    content,
    write: { bytes: content },
    record,
  };
}

// Managed keys: every leaf of the template, a JSON object, set in the site's
// JSON file at the same key path (joined with dots in the lock). The file is
// edited as text, so every other key keeps its bytes: a managed value is
// replaced where it stands, a missing key is added after its siblings in the
// file's indentation, and a key the template no longer has is removed if
// the site hasn't changed it since gq wrote it (else it is the site's now).
// A missing file is created holding the managed keys after the site's own
// that it starts with: the rendered `initial` template's.
// `creating`, the plan of a create-once file at the same path, is what the
// keys are set in instead: the file as gq is about to write it. With
// `addInitial` (gq sync --recreate), an existing file also gains each key of
// the `initial` template it lacks (missingInitialLeaves), the site's own
// from then on: the lock doesn't record them.
async function planKeys(
  root,
  lock,
  manifest,
  { path, template, initial },
  creating,
  { addInitial = false } = {},
) {
  const managed = leafKeys(JSON.parse(await readTemplate(template)));
  const record = {
    keys: { [path]: Object.fromEntries(managed.map(({ key, value }) => [key, hashValue(value)])) },
  };
  const current = creating ? { bytes: creating.content } : await readEntry(join(root, path));
  if (current === undefined) {
    // A file only a skeleton creates (apps/cms/composer.json) has no initial
    // keys of its own here.
    if (initial === undefined) {
      throw new Error(
        `${path} is missing, and gq sync manages keys of it: restore it, or recreate it ` +
          `with gq sync --recreate ${path}.`,
      );
    }
    const object = JSON.parse(await renderTemplate(initial, manifest));
    for (const { segments, value } of managed) setNested(object, segments, value);
    const content = Buffer.from(`${JSON.stringify(object, null, 2)}\n`);
    return { path, status: "create", content, write: { bytes: content }, record };
  }
  if (current.bytes === undefined) {
    throw new Error(`${path} must be a regular file: gq sync manages keys of it.`);
  }
  const text = current.bytes.toString("utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not a valid JSON object: ${error.message}`, { cause: error });
  }
  if (!isPlainObject(parsed)) throw new Error(`${path} is not a valid JSON object: not an object.`);

  const document = parseSpans(text);
  const written = lock?.keys[path] ?? {};
  const changed = [];
  const edited = [];
  const edits = [];
  // What each object gains and loses, by its node.
  const objects = new Map();
  const changesTo = (node, depth, sorted = false) => {
    if (!objects.has(node)) objects.set(node, { depth, sorted, added: {}, removed: new Set() });
    return objects.get(node);
  };
  for (const { key, segments, value } of managed) {
    const found = locateKey(path, document, segments);
    if (found.member === undefined) {
      changed.push(key);
      const sorted = isDependencyMap(path, segments.slice(0, found.depth));
      setNested(changesTo(found.parent, found.depth, sorted).added, found.rest, value);
      continue;
    }
    const { node } = found.member;
    const currentValue = JSON.parse(text.slice(node.start, node.end));
    if (JSON.stringify(currentValue) === JSON.stringify(value)) continue;
    if (creating || hashValue(currentValue) === written[key]) changed.push(key);
    else edited.push(key);
    edits.push({ start: node.start, end: node.end, text: JSON.stringify(value) });
  }
  const initialAdded = [];
  if (addInitial && initial !== undefined) {
    const leaves = leafKeys(JSON.parse(await renderTemplate(initial, manifest)));
    for (const { key, segments, value } of missingInitialLeaves(parsed, leaves, managed)) {
      const found = locateKey(path, document, segments);
      initialAdded.push(key);
      const sorted = isDependencyMap(path, segments.slice(0, found.depth));
      setNested(changesTo(found.parent, found.depth, sorted).added, found.rest, value);
    }
  }
  const retired = Object.keys(written).filter((key) => !(key in record.keys[path]));
  for (const key of retired) {
    let found;
    try {
      found = locateKey(path, document, key.split("."));
    } catch {
      continue;
    }
    const { member } = found;
    if (member === undefined) continue;
    if (hashValue(JSON.parse(text.slice(member.node.start, member.node.end))) !== written[key]) {
      continue;
    }
    changed.push(key);
    changesTo(found.parent, found.depth).removed.add(member);
  }
  const indent = /^([ \t]+)\S/mu.exec(text)?.[1] ?? "  ";
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  for (const [node, changes] of objects) {
    edits.push(...objectEdits(node, changes, { indent, newline }));
  }

  let status = "unchanged";
  if (edited.length > 0) status = "edited";
  else if (changed.length > 0 || initialAdded.length > 0) status = "update";
  const content = status === "unchanged" ? current.bytes : Buffer.from(applyEdits(text, edits));
  const scope =
    edited.length > 0
      ? `managed keys ${edited.join(", ")}`
      : [
          ...(changed.length > 0 || initialAdded.length === 0
            ? [`managed keys ${changed.join(", ")}`]
            : []),
          ...(initialAdded.length > 0 ? [`initial keys ${initialAdded.join(", ")}`] : []),
        ].join("; ");
  return {
    path,
    status,
    scope,
    current: current.bytes,
    content,
    write: { bytes: content },
    record,
  };
}

// The keys of the `initial` templates the Site's files lack, for each file
// gq manages keys of that has one (the root package.json): `[{ path, keys }]`,
// leaving out a file without any. A missing file has none: gq sync creates
// it with all of them. `gq sync --recreate <path>` adds them.
export async function missingInitialKeys(root, manifest) {
  const missing = [];
  for (const entry of ownership.managedKeys) {
    const { path, template, initial } = entry;
    if (initial === undefined || !appliesTo(entry, manifest)) continue;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(join(root, path), "utf8"));
    } catch {
      continue;
    }
    if (!isPlainObject(parsed)) continue;
    const managed = leafKeys(JSON.parse(await readTemplate(template)));
    const leaves = leafKeys(JSON.parse(await renderTemplate(initial, manifest)));
    const keys = missingInitialLeaves(parsed, leaves, managed).map(({ key }) => key);
    if (keys.length > 0) missing.push({ path, keys });
  }
  return missing;
}

// The `leaves` of an initial template that `parsed`, a Site's file, lacks:
// not the `managed` ones (gq sets those anyway), not one with a value in the
// way that isn't an object, and not a dependency the file has in any
// dependency map (`@getquick/site` under `dependencies` is there).
function missingInitialLeaves(parsed, leaves, managed) {
  const managedKeys = new Set(managed.map(({ key }) => key));
  const dependencies = new Set(
    [...DEPENDENCY_MAPS].flatMap((map) =>
      isPlainObject(parsed[map]) ? Object.keys(parsed[map]) : [],
    ),
  );
  return leaves.filter(({ key, segments }) => {
    if (managedKeys.has(key)) return false;
    if (segments.length === 2 && DEPENDENCY_MAPS.has(segments[0])) {
      return !dependencies.has(segments[1]);
    }
    let value = parsed;
    for (const name of segments) {
      if (!isPlainObject(value)) return false;
      if (!Object.hasOwn(value, name)) return true;
      value = value[name];
    }
    return false;
  });
}

// Each leaf of `object` (a value that isn't a non-empty object) with its
// key path, as `segments` and joined with dots as `key`.
function leafKeys(object, prefix = []) {
  return Object.entries(object).flatMap(([name, value]) => {
    const segments = [...prefix, name];
    return isPlainObject(value) && Object.keys(value).length > 0
      ? leafKeys(value, segments)
      : [{ key: segments.join("."), segments, value }];
  });
}

function setNested(object, segments, value) {
  let parent = object;
  for (const name of segments.slice(0, -1)) parent = parent[name] ??= {};
  parent[segments.at(-1)] = value;
}

// The `member` at `segments` in a parsed document; when it is missing, the
// deepest object on the way (`parent`, at `depth`) and the segments it lacks
// (`rest`). A value in the way that isn't an object is refused rather than
// replaced.
function locateKey(path, document, segments) {
  let parent = document;
  for (const [index, name] of segments.entries()) {
    const member = parent.members.findLast(({ key }) => key === name);
    if (member === undefined) return { parent, depth: index, rest: segments.slice(index) };
    if (index === segments.length - 1) return { member, parent, depth: index };
    if (member.node.members === undefined) {
      throw new Error(
        `${path} ${segments.slice(0, index + 1).join(".")} must be an object: ` +
          `gq sync manages ${segments.join(".")} in it.`,
      );
    }
    parent = member.node;
  }
  throw new Error("A key path needs at least one segment.");
}

// A package.json dependency map, whose keys formatters (Oxfmt's
// sortPackageJson, as in a Site's own `vp fmt`) keep in order.
const DEPENDENCY_MAPS = new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);
function isDependencyMap(path, segments) {
  return (
    (path === "package.json" || path.endsWith("/package.json")) &&
    segments.length === 1 &&
    DEPENDENCY_MAPS.has(segments[0])
  );
}

// The text edits that remove an object's `removed` members and add its
// `added` keys after the members that remain, each on its own line at the
// object's `depth` + 1. In a `sorted` object (a dependency map) whose
// remaining keys are in order, each added key goes where it sorts instead,
// so the Site's formatter has nothing to reorder. An object left with no
// members is rewritten whole.
function objectEdits(node, { depth, sorted, added, removed }, { indent, newline }) {
  const inner = newline + indent.repeat(depth + 1);
  const line = ([key, value]) =>
    `${JSON.stringify(key)}: ${JSON.stringify(value, null, indent).replaceAll("\n", inner)}`;
  const remaining = node.members.filter((member) => !removed.has(member));
  const keys = remaining.map(({ key }) => key);
  let entries = Object.entries(added);
  const before = new Map();
  if (sorted && keys.every((key, index) => index === 0 || keys[index - 1] < key)) {
    entries = entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const last = [];
    for (const entry of entries) {
      const next = remaining.find(({ key }) => key > entry[0]);
      if (next === undefined) last.push(entry);
      else before.set(next, [...(before.get(next) ?? []), entry]);
    }
    entries = last;
  }
  const lines = entries.map(line);
  if (remaining.length === 0) {
    const text =
      lines.length === 0
        ? ""
        : `${inner}${lines.join(`,${inner}`)}${newline}${indent.repeat(depth)}`;
    return [{ start: node.start + 1, end: node.end - 1, text }];
  }
  const edits = [];
  node.members.forEach((member, index) => {
    if (!removed.has(member)) return;
    // After a remaining member, drop from the end of the one before; ahead
    // of them all, up to the next key.
    edits.push(
      node.members.slice(0, index).some((before) => !removed.has(before))
        ? { start: node.members[index - 1].node.end, end: member.node.end, text: "" }
        : { start: member.keyStart, end: node.members[index + 1].keyStart, text: "" },
    );
  });
  for (const [member, ahead] of before) {
    const at = member.keyStart;
    edits.push({ start: at, end: at, text: `${ahead.map(line).join(`,${inner}`)},${inner}` });
  }
  if (lines.length > 0) {
    const at = remaining.at(-1).node.end;
    edits.push({ start: at, end: at, text: `,${inner}${lines.join(`,${inner}`)}` });
  }
  return edits;
}

// `edits` (non-overlapping ranges of `text`) applied from the last; at the
// same offset, a removal before the insertion that follows it.
function applyEdits(text, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  return sorted.reduce(
    (result, { start, end, text: replacement }) =>
      `${result.slice(0, start)}${replacement}${result.slice(end)}`,
    text,
  );
}

// Where a valid JSON text's values are: an object as `{ start, end, members }`
// (each member's `key`, `keyStart` and value `node`), anything else as
// `{ start, end }`, offsets end-exclusive.
function parseSpans(text) {
  let at = 0;
  const skipSpace = () => {
    while (/\s/u.test(text[at] ?? "")) at += 1;
  };
  const skipString = () => {
    at += 1;
    while (text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
    at += 1;
  };
  const value = () => {
    skipSpace();
    const start = at;
    if (text[at] === "{" || text[at] === "[") {
      const object = text[at] === "{";
      const members = [];
      at += 1;
      skipSpace();
      while (text[at] !== (object ? "}" : "]")) {
        if (object) {
          const keyStart = at;
          skipString();
          const key = JSON.parse(text.slice(keyStart, at));
          skipSpace();
          at += 1;
          members.push({ key, keyStart, node: value() });
        } else value();
        skipSpace();
        if (text[at] === ",") {
          at += 1;
          skipSpace();
        }
      }
      at += 1;
      return object ? { start, end: at, members } : { start, end: at };
    }
    if (text[at] === '"') skipString();
    else while (at < text.length && !/[\s,\]}]/u.test(text[at])) at += 1;
    return { start, end: at };
  };
  return value();
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hashValue(value) {
  return hash(JSON.stringify(value));
}

// A create-once file: written from its rendered template when it is missing
// and the lock doesn't record it as created (or when `recreate` names it),
// and never otherwise. A skeleton's file is written only while its `app` is
// in `missingApps`, unless `recreate` names it.
async function planCreateOnce(
  root,
  lock,
  manifest,
  { path, template, app, executable = false },
  { recreate, missingApps },
) {
  const current = await readEntry(join(root, path));
  const recorded = current !== undefined || lock?.created.includes(path) === true;
  if (template === undefined) return { path, record: { created: recorded ? [path] : [] } };

  const content = Buffer.from(await renderTemplate(template, manifest));
  const creatable = app === undefined || missingApps.has(app);
  let status = "unchanged";
  if (current === undefined) {
    if ((!recorded && creatable) || recreate.includes(path)) status = "create";
  } else if (recreate.includes(path) && !current.bytes?.equals(content)) {
    if (current.bytes === undefined) {
      throw new Error(`${path} isn't a regular file, so gq sync --recreate won't replace it.`);
    }
    status = "update";
  }
  return {
    path,
    status,
    current: current?.bytes,
    content,
    write: { replace: true, bytes: content, executable },
    record: { created: status === "unchanged" && !recorded ? [] : [path] },
  };
}

// The lines that open and close a template's section: a line starting with
// the template's first line up to `BEGIN gq` (so the rest of it can change
// between releases), and the template's last line exactly.
function sectionMarkers(section) {
  const lines = section.trimEnd().split("\n");
  const at = lines[0].indexOf("BEGIN gq");
  if (at === -1 || !lines.at(-1).includes("END gq")) {
    throw new Error("A generated section template must open with BEGIN gq and close with END gq.");
  }
  return { begin: lines[0].slice(0, at + "BEGIN gq".length), end: lines.at(-1) };
}

// Where `text` holds the section between `markers`, with its `text` ending
// in a newline; undefined when it has neither marker. Anything but one begin
// line followed by one end line is refused: gq can't tell what it wrote.
function findSection(path, text, { begin, end }) {
  const begins = [];
  const ends = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith(begin)) begins.push(offset);
    else if (line === end) ends.push(Math.min(offset + line.length + 1, text.length));
    offset += line.length + 1;
  }
  if (begins.length === 0 && ends.length === 0) return undefined;
  if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) {
    throw new Error(
      `${path} must hold gq's generated section once, from a "${begin}…" line to a ` +
        `"${end}" line. Restore the markers, or remove both and gq sync appends the section.`,
    );
  }
  const found = text.slice(begins[0], ends[0]);
  return { start: begins[0], end: ends[0], text: found.endsWith("\n") ? found : `${found}\n` };
}

// What is at `path`, not following a symlink: undefined when nothing is,
// `{ symlink }`, `{ bytes, executable }`, or `{ other }` naming what else
// (such as a directory) stands where a file or symlink belongs.
async function readEntry(path) {
  const stats = await unlessMissing(lstat(path));
  if (stats === undefined) return undefined;
  if (stats.isSymbolicLink()) return { symlink: await readlink(path) };
  if (stats.isFile()) {
    return { bytes: await readFile(path), executable: (stats.mode & 0o111) !== 0 };
  }
  return { other: stats.isDirectory() ? "directory" : "special file" };
}

function sameEntry(current, rendered) {
  if (rendered.symlink !== undefined) return current.symlink === rendered.symlink;
  return (
    current.bytes?.equals(rendered.bytes) === true && current.executable === rendered.executable
  );
}

// A file's hash covers its bytes only, so a lost executable bit is restored
// rather than taken for a local edit; a symlink's covers its target, marked
// so a regular file holding the same text doesn't match it. Anything else
// has no hash, so it never matches the lock.
function hashEntry(entry) {
  if (entry === undefined) return undefined;
  if (entry.symlink !== undefined) return hash(`symlink\0${entry.symlink}`);
  if (entry.bytes !== undefined) return hash(entry.bytes);
  return undefined;
}

function displayEntry(entry) {
  if (entry.symlink !== undefined) return Buffer.from(`symlink -> ${entry.symlink}\n`);
  if (entry.bytes !== undefined) return entry.bytes;
  return Buffer.from(`${entry.other}\n`);
}

// The lock's `files` and `sections` hashes by path, `keys` hashes by path
// and key, and the create-once files it has `created`. A lock an older gq
// wrote may lack all but `files`.
async function readLock(root) {
  const buffer = await unlessMissing(readFile(join(root, LOCK_FILENAME)));
  if (buffer === undefined) return undefined;
  const text = buffer.toString("utf8");
  let lock;
  try {
    lock = JSON.parse(text);
  } catch (error) {
    throw new Error(`${LOCK_FILENAME} is not valid JSON: ${error.message}`, { cause: error });
  }
  if (!isHashMap(lock?.files)) {
    throw new Error(`${LOCK_FILENAME} must map each managed path to its hash under "files".`);
  }
  if (lock.sections !== undefined && !isHashMap(lock.sections)) {
    throw new Error(`${LOCK_FILENAME} must map each path to its section's hash under "sections".`);
  }
  if (
    lock.keys !== undefined &&
    !(isPlainObject(lock.keys) && Object.values(lock.keys).every((keys) => isHashMap(keys)))
  ) {
    throw new Error(`${LOCK_FILENAME} must map each path to its keys' hashes under "keys".`);
  }
  if (
    lock.created !== undefined &&
    !(Array.isArray(lock.created) && lock.created.every((path) => typeof path === "string"))
  ) {
    throw new Error(`${LOCK_FILENAME} must list the create-once files it created under "created".`);
  }
  // An older gq would take a newer one's files for old templates and
  // downgrade them.
  if (typeof lock.gq === "string" && isNewerVersion(lock.gq, VERSION)) {
    throw new Error(
      `${LOCK_FILENAME} was written by gq ${lock.gq}, newer than the installed ${VERSION}. ` +
        "Update @getquick/site.",
    );
  }
  return {
    text,
    files: lock.files,
    sections: lock.sections ?? {},
    keys: lock.keys ?? {},
    created: lock.created ?? [],
  };
}

function isHashMap(value) {
  return isPlainObject(value) && Object.values(value).every((hash) => typeof hash === "string");
}

// Compares the numeric major.minor.patch of two versions.
function isNewerVersion(version, than) {
  const parts = (value) => value.split(/[.+-]/u, 3).map(Number);
  const [a, b] = [parts(version), parts(than)];
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

function hash(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

// What `operation` resolves to, or undefined when the path it reads is missing.
async function unlessMissing(operation) {
  try {
    return await operation;
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

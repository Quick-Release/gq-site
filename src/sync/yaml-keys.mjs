// Managed keys in a Site's YAML file (pnpm-workspace.yaml): the `yaml`
// package parses the file to find each key, and gq edits only the bytes of
// the values it sets, so every comment, blank line, quote style and key order
// of the rest of the file is kept as the Site wrote it. A value is replaced
// where it stands. A missing key is added on a line of its own, in the
// mapping's indentation: inside a nested mapping (catalog, overrides) before
// the first key that sorts after it, at the top level after the last key. A
// mapping gq needs but the file lacks is added whole. A key gq retires is
// removed with its line. Only block mappings are edited: a flow mapping (`{
// … }`) or a non-mapping value in the way is refused, never rewritten.
import { isMap, isNode, isScalar, parseDocument, stringify } from "yaml";

// The file parsed, refusing invalid YAML and a top level that isn't a
// mapping (an empty file is an empty one).
export function parseYamlMapping(path, text) {
  const document = parseDocument(text);
  if (document.errors.length > 0) {
    throw new Error(`${path} is not valid YAML: ${document.errors[0].message}`);
  }
  if (document.contents !== null && !isMap(document.contents)) {
    throw new Error(`${path} is not a YAML mapping.`);
  }
  return document;
}

// The value at `segments`, as plain data, or undefined when it is missing.
export function readYamlKey(document, segments) {
  let node = document.contents;
  for (const name of segments) {
    if (!isMap(node)) return undefined;
    const pair = findPair(node, name);
    if (pair === undefined) return undefined;
    node = pair.value;
  }
  if (node === null) return null;
  return isNode(node) ? node.toJSON() : node;
}

// `text` with each of `set` ({ segments, value }) set and each of `remove`
// (segments) removed; a key to remove that is missing is left alone.
export function editYamlKeys(path, text, { set = [], remove = [] }) {
  const document = parseYamlMapping(path, text);
  const step = indentStep(text, document);
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  // One stand-in per mapping that has no node yet, so what each gains is
  // added together.
  const standIns = new Map();
  const edits = [];
  // What each mapping gains, nested by the segments it lacks.
  const additions = new Map();
  for (const { segments, value } of set) {
    const found = locate(path, document, segments, standIns);
    if (found.pair !== undefined) {
      edits.push(replaceValue(text, found.pair, value));
      continue;
    }
    if (!additions.has(found.parent)) additions.set(found.parent, {});
    setNested(additions.get(found.parent), found.rest, value);
  }
  for (const segments of remove) {
    const found = locate(path, document, segments, standIns);
    if (found.pair === undefined) continue;
    if (found.pair.value?.anchor) {
      throw new Error(
        `${path} ${keyPath(segments)} has an anchor: gq sync won't remove a value other keys may alias.`,
      );
    }
    const start = lineStart(text, found.pair.key.range[0]);
    edits.push({ start, end: lineEnd(text, valueEnd(found.pair)), text: "" });
  }
  for (const [parent, added] of additions) {
    for (const edit of insertions(path, text, parent, added, step)) {
      edits.push({ ...edit, text: edit.text.replaceAll("\n", newline) });
    }
  }
  return applyEdits(text, edits);
}

// Where `segments` is: its `pair`, or the deepest mapping on the way
// (`parent`: a map node, `{ under: pair }` for a key with no value yet, or
// `{ root: true }` for an empty file) and the segments it lacks (`rest`).
function locate(path, document, segments, standIns) {
  const standIn = (key, value) => {
    if (!standIns.has(key)) standIns.set(key, value);
    return standIns.get(key);
  };
  let parent = document.contents ?? standIn(document, { root: true });
  for (const [index, name] of segments.entries()) {
    if (parent.root || parent.under) {
      return { parent, rest: segments.slice(index) };
    }
    if (!isMap(parent) || parent.flow) {
      const at = segments.slice(0, index);
      throw new Error(
        `${path} ${keyPath(at)} must be a block mapping: gq sync manages ${keyPath(segments)} in it.`,
      );
    }
    const pair = findPair(parent, name);
    if (pair === undefined) return { parent, rest: segments.slice(index) };
    if (index === segments.length - 1) {
      if (
        pair.value !== null &&
        (!isScalar(pair.value) || ["BLOCK_LITERAL", "BLOCK_FOLDED"].includes(pair.value.type))
      ) {
        throw new Error(`${path} ${keyPath(segments)} must be a single value: gq sync manages it.`);
      }
      return { pair };
    }
    parent = isEmpty(pair.value) ? standIn(pair, { under: pair }) : pair.value;
  }
  throw new Error("A key path needs at least one segment.");
}

function findPair(map, name) {
  return map.items.find(({ key }) => (isScalar(key) ? String(key.value) : key) === name);
}

function isEmpty(value) {
  return value === null || (isScalar(value) && value.value === null && value.source === "");
}

// The edit that writes `value` in place of a pair's scalar.
function replaceValue(text, pair, value) {
  const formatted = formatScalar(value);
  if (isEmpty(pair.value)) {
    // Right after the colon, so a comment that follows stays a comment.
    const at = text.indexOf(":", pair.key.range[1]) + 1;
    return { start: at, end: at, text: ` ${formatted}` };
  }
  const [start, end] = pair.value.range;
  return { start, end, text: formatted };
}

// The edits that add `added` (nested by key) to `parent`, each top key on its
// own lines. In a nested mapping a key goes before the first one that sorts
// after it, ahead of that key's own comment lines unless it is the mapping's
// first (whose comments head the whole mapping); otherwise after the last.
function insertions(path, text, parent, added, step) {
  if (parent.root) {
    const prefix = text === "" || text.endsWith("\n") ? "" : "\n";
    return [
      { start: text.length, end: text.length, indent: 0, text: prefix + block(added, 0, step) },
    ];
  }
  if (parent.under) {
    const indent = column(text, parent.under.key.range[0]) + step;
    const at = lineEnd(text, parent.under.key.range[1]);
    const prefix = text[at - 1] === "\n" || at === 0 ? "" : "\n";
    // An empty scalar after `key:` (a trailing space) is left as it is.
    return [{ start: at, end: at, indent, text: prefix + block(added, indent, step) }];
  }
  const indent = column(text, parent.items[0].key.range[0]);
  const nested = indent > 0;
  const at = new Map();
  for (const entry of Object.entries(added).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const next = nested ? parent.items.findIndex(({ key }) => String(key.value) > entry[0]) : -1;
    let position;
    if (next === -1) {
      position = lineEnd(text, valueEnd(parent.items.at(-1)));
    } else {
      position = lineStart(text, parent.items[next].key.range[0]);
      if (next > 0) position = commentsAbove(text, position, indent);
    }
    at.set(position, [...(at.get(position) ?? []), entry]);
  }
  return [...at].map(([position, entries]) => {
    const prefix = position === text.length && !text.endsWith("\n") ? "\n" : "";
    return {
      start: position,
      end: position,
      indent,
      text: prefix + block(Object.fromEntries(entries), indent, step),
    };
  });
}

// The start of the comment lines at `indent` right above the line at `at`.
function commentsAbove(text, at, indent) {
  let position = at;
  while (position > 0) {
    const start = lineStart(text, position - 1);
    const line = text.slice(start, position - 1);
    if (!(line.startsWith(" ".repeat(indent)) && line.slice(indent).startsWith("#"))) break;
    position = start;
  }
  return position;
}

function block(object, indent, step) {
  return Object.entries(object)
    .map(([key, value]) => {
      const pad = " ".repeat(indent);
      if (value !== null && typeof value === "object") {
        return `${pad}${formatKey(key)}:\n${block(value, indent + step, step)}`;
      }
      return `${pad}${formatKey(key)}: ${formatScalar(value)}\n`;
    })
    .join("");
}

// A key as the blueprint's templates write it: plain when it is a plain
// name, double-quoted otherwise.
function formatKey(key) {
  return /^[A-Za-z_][\w-]*$/u.test(key) ? key : JSON.stringify(key);
}

// A value on one line, quoted only when YAML would read it plain as
// something else.
function formatScalar(value) {
  const text = stringify(value, { lineWidth: 0 }).trimEnd();
  if (text.includes("\n")) throw new Error(`gq can't write ${JSON.stringify(value)} on one line.`);
  return text;
}

// How far a nested mapping's keys sit in from their parent's: the first
// nested block mapping's, or 2.
function indentStep(text, document) {
  if (!isMap(document.contents)) return 2;
  for (const { key, value } of document.contents.items) {
    if (isMap(value) && !value.flow && value.items.length > 0) {
      return column(text, value.items[0].key.range[0]) - column(text, key.range[0]);
    }
  }
  return 2;
}

function valueEnd(pair) {
  return pair.value?.range?.[1] ?? pair.key.range[1];
}

function column(text, offset) {
  return offset - lineStart(text, offset);
}

function lineStart(text, offset) {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

// Just past the newline that ends the line holding `offset`.
function lineEnd(text, offset) {
  const newline = text.indexOf("\n", Math.max(offset - 1, 0));
  return newline === -1 ? text.length : newline + 1;
}

function setNested(object, segments, value) {
  let parent = object;
  for (const name of segments.slice(0, -1)) parent = parent[name] ??= {};
  parent[segments.at(-1)] = value;
}

// `edits` (non-overlapping ranges of `text`) applied from the last. Of two
// insertions at one offset, the deeper one (a key with no value yet getting
// its first keys) ends up first, so a mapping appended after it doesn't
// swallow them.
function applyEdits(text, edits) {
  const sorted = [...edits].sort(
    (a, b) => b.start - a.start || b.end - a.end || (a.indent ?? 0) - (b.indent ?? 0),
  );
  return sorted.reduce(
    (result, { start, end, text: replacement }) =>
      `${result.slice(0, start)}${replacement}${result.slice(end)}`,
    text,
  );
}

// A key path as the lock and gq's messages name it: segments joined with
// dots, a segment that holds a dot, bracket or quote as `["…"]`
// (`catalog["@alchemy.run/cloudflare"]`).
export function keyPath(segments) {
  return segments
    .map((name, index) =>
      /[.[\]"]/u.test(name) || name === ""
        ? `[${JSON.stringify(name)}]`
        : `${index === 0 ? "" : "."}${name}`,
    )
    .join("");
}

// The segments of a key path keyPath wrote.
export function keySegments(path) {
  const segments = [];
  const pattern = /\.?([^.[\]"]+)|\[("(?:[^"\\]|\\.)*")\]/guy;
  let match;
  while ((match = pattern.exec(path)) !== null) {
    segments.push(match[1] ?? JSON.parse(match[2]));
    if (pattern.lastIndex === path.length) return segments;
  }
  throw new Error(`Not a key path: ${path}`);
}

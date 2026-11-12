// Managed keys of a YAML file (pnpm-workspace.yaml): the versions that must
// move with the managed infra (the Alchemy packages and Effect in `catalog`,
// and the Effect pins in `overrides` and `peerDependencyRules`). The file is
// otherwise the Site's, so it is edited line by line: a managed value is
// replaced where it stands, keeping its line's indentation and comment; a
// missing key is added among its siblings, before the first one whose name
// sorts after it; a missing map is appended. Only the block mappings
// pnpm-workspace.yaml uses are understood: `name:` on a line of its own, its
// entries indented under it, one `key: scalar` per line. Anything else where
// a managed key goes is refused rather than guessed at.
//
// A managed key the lock doesn't record yet is set without asking: its value
// came from the create-once skeleton an earlier blueprint wrote, which these
// keys take over. Once recorded, a key the Site changed is an edit, as for
// the JSON files' managed keys. A key the template stops managing stays as it
// is, the Site's from then on.

// `segments` is the key path (`["catalog", "alchemy"]`); its lock key joins
// the segments with dots.
export function editYamlKeys(path, text, managed) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  // A last line without its newline gets one, so a key added after it starts
  // a line of its own.
  const lines = (text === "" || text.endsWith("\n") ? text : `${text}${newline}`)
    .split(/(?<=\n)/u)
    .filter((line) => line !== "");
  const results = [];
  for (const { key, segments, value } of managed) {
    const found = locate(path, lines, segments);
    if (found.line !== undefined) {
      const current = found.value;
      if (current === String(value)) continue;
      results.push({ key, current });
      const original = lines[found.line];
      const ending = /\r?\n$/u.exec(original)?.[0] ?? "";
      const body = original.slice(0, original.length - ending.length);
      // An empty value (`effect:`, YAML's null) gains one after its colon.
      const written = found.empty ? ` ${formatScalar(value)}` : formatScalar(value);
      lines[found.line] =
        `${body.slice(0, found.valueStart)}${written}${body.slice(found.valueEnd)}${ending}`;
      continue;
    }
    results.push({ key, current: undefined });
    insert(lines, found, segments, value, newline);
  }
  return { content: lines.join(""), changes: results };
}

// The value at `segments` in a YAML file's text, or undefined when it has
// none (or isn't a block mapping gq can read there).
export function readYamlKey(path, text, segments) {
  try {
    return locate(path, text.split(/(?<=\n)/u), segments).value;
  } catch {
    return undefined;
  }
}

// The line holding `segments`, or where it would go: the deepest existing
// map (`depth` segments found) and its block's lines.
function locate(path, lines, segments) {
  let block = { start: 0, end: lines.length, indent: -1 };
  for (let depth = 0; depth < segments.length; depth += 1) {
    const entries = blockEntries(path, lines, block);
    const entry = entries.find(({ name }) => name === segments[depth]);
    if (entry === undefined) return { depth, block, entries };
    if (depth === segments.length - 1) {
      if (entry.special) {
        throw new Error(
          `${path}: ${segments.join(".")} isn't a plain or quoted value gq sync can edit ` +
            "(an anchor, alias, tag, block or flow value).",
        );
      }
      const empty = entry.value === undefined;
      if (empty && entry.blockEnd > entry.line + 1) {
        throw new Error(
          `${path}: ${segments.join(".")} is a map, but gq sync manages it as a single value.`,
        );
      }
      return {
        line: entry.line,
        value: empty ? "" : entry.value,
        empty,
        valueStart: empty ? entry.keyEnd : entry.valueStart,
        valueEnd: empty ? entry.keyEnd : entry.valueEnd,
      };
    }
    if (entry.value !== undefined) {
      throw new Error(
        `${path}: ${segments.slice(0, depth + 1).join(".")} must be a map: gq sync manages ` +
          `${segments.join(".")}.`,
      );
    }
    block = { start: entry.line + 1, end: entry.blockEnd, indent: entry.indent };
  }
  throw new Error(`${path}: ${segments.join(".")} has no key.`);
}

const ENTRY = /^( *)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'#:][^:#]*?)[ \t]*:(?:[ \t]+|$)(.*)$/u;

// The entries directly inside `block` (lines start..end, nested deeper than
// `indent`): each `{ name, line, indent, value, valueStart, valueEnd,
// blockEnd }`, with `value` undefined for a key that opens a nested map.
function blockEntries(path, lines, { start, end, indent }) {
  const entries = [];
  let childIndent;
  for (let line = start; line < end; line += 1) {
    const text = lines[line].replace(/\r?\n$/u, "");
    if (/^\s*(#.*)?$/u.test(text) || /^(---|\.\.\.)\s*(#.*)?$/u.test(text)) continue;
    const spaces = /^ */u.exec(text)[0].length;
    if (spaces <= indent) break;
    if (childIndent === undefined) childIndent = spaces;
    if (spaces !== childIndent) continue;
    if (text.trimStart().startsWith("- ") || text.trim() === "-") continue;
    const match = ENTRY.exec(text);
    if (match === null) {
      throw new Error(`${path}: line ${line + 1} isn't a \`key: value\` line gq sync can edit.`);
    }
    const [, , rawName, rest] = match;
    const name = unquote(rawName);
    const restStart = text.length - rest.length;
    const keyEnd = text.indexOf(":", spaces + rawName.length) + 1;
    const parsed = scalar(path, line, rest);
    const valueStart = restStart + parsed.offset;
    entries.push({
      name,
      line,
      indent: spaces,
      keyEnd,
      value: parsed.value,
      special: parsed.special ?? false,
      valueStart,
      valueEnd: valueStart + parsed.length,
    });
  }
  // Each entry's block runs to its last nested line, before the next entry
  // at its indentation (and any comment above that entry).
  for (const [index, entry] of entries.entries()) {
    const next = entries[index + 1];
    entry.blockEnd = blockEnd(lines, entry.line, next?.line ?? end, entry.indent);
  }
  return entries;
}

// The line after the last one nested under `line` (deeper than `indent`),
// leaving out trailing blank and comment lines at or above its indentation.
function blockEnd(lines, line, end, indent) {
  let last = line;
  for (let index = line + 1; index < end; index += 1) {
    const text = lines[index].replace(/\r?\n$/u, "");
    if (/^\s*$/u.test(text)) continue;
    const spaces = /^ */u.exec(text)[0].length;
    if (spaces <= indent) break;
    last = index;
  }
  return last + 1;
}

// A value after `key:` (`rest`): a plain or quoted scalar and where it is in
// `rest`, without a trailing comment. Nothing, or only a comment, is
// undefined (a nested map follows, or YAML's null). An anchor, alias, tag,
// block or flow value is `special`: kept as it is, never edited.
function scalar(path, line, rest) {
  if (rest === "" || /^[ \t]*(#.*)?$/u.test(rest))
    return { value: undefined, offset: 0, length: 0 };
  if (/^[&*!|>{[]/u.test(rest))
    return { value: rest, special: true, offset: 0, length: rest.length };
  let length;
  if (rest.startsWith('"')) length = /^"(?:[^"\\]|\\.)*"/u.exec(rest)?.[0].length;
  else if (rest.startsWith("'")) length = /^'(?:[^']|'')*'/u.exec(rest)?.[0].length;
  else length = rest.replace(/[ \t]+#.*$/u, "").replace(/[ \t]+$/u, "").length;
  if (length === undefined || !/^([ \t]+#.*|[ \t]*)$/u.test(rest.slice(length))) {
    throw new Error(`${path}: line ${line + 1} has a value gq sync can't read.`);
  }
  return { value: unquote(rest.slice(0, length)), offset: 0, length };
}

function unquote(text) {
  if (text.startsWith('"')) return JSON.parse(text);
  if (text.startsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  return text;
}

// A key or value as the blueprint's templates write it: plain when YAML
// reads it back as the same string, double-quoted otherwise.
function formatScalar(value) {
  const text = String(value);
  const plain =
    /^[A-Za-z0-9_.^~+-][A-Za-z0-9_.^~<>=*+@/:-]*$/u.test(text) &&
    !text.endsWith(":") &&
    !/^(true|false|null|yes|no|on|off|~)$/iu.test(text) &&
    !/^[-+]?(\d[\d_]*\.?[\d_]*|\.\d+)([eE][-+]?\d+)?$/u.test(text) &&
    !/^0[xob]/iu.test(text) &&
    !/^\d{4}-\d{2}-\d{2}/u.test(text);
  return plain ? text : JSON.stringify(text);
}

function formatKey(name) {
  return /^[A-Za-z0-9_-]+$/u.test(name) ? name : JSON.stringify(name);
}

// Adds the missing `segments` (from `found.depth` on) with `value`: inside the
// deepest existing map, before its first entry whose name sorts after the
// new one, at its entries' indentation; a new top-level map is appended to
// the file.
function insert(lines, { depth, block, entries }, segments, value, newline) {
  const indentStep = 2;
  const indent = entries[0]?.indent ?? (depth === 0 ? 0 : block.indent + indentStep);
  const nested = segments.slice(depth);
  const rendered = nested.map((name, index) => {
    const pad = " ".repeat(indent + index * indentStep);
    const last = index === nested.length - 1;
    return `${pad}${formatKey(name)}:${last ? ` ${formatScalar(value)}` : ""}${newline}`;
  });
  // A new top-level map goes at the end of the file.
  const after = depth === 0 ? undefined : entries.find(({ name }) => name > nested[0]);
  if (after !== undefined) {
    lines.splice(after.line, 0, ...rendered);
    return;
  }
  if (entries.length > 0 && depth > 0) {
    const end = entries.at(-1).blockEnd;
    lines.splice(end, 0, ...rendered);
    return;
  }
  if (depth === 0) {
    lines.push(...rendered);
    return;
  }
  lines.splice(block.start, 0, ...rendered);
}

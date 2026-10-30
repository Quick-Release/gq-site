// A unified line diff of two texts, enough for a dry run before a content
// write: the lines both share at either end are set aside and the middle is
// compared by its longest common subsequence.

const CONTEXT = 3;
const MAXIMUM_CELLS = 16_000_000;

function lines(text) {
  if (text === "") return [];
  const split = text.split("\n");
  if (split.at(-1) === "") split.pop();
  return split;
}

// Each line of `a` and `b` as [" " | "-" | "+", line], in order.
function editScript(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  if (middleA.length * middleB.length > MAXIMUM_CELLS) {
    // Too large to compare line by line: all of one, then all of the other.
    return [
      ...a.slice(0, start).map((line) => [" ", line]),
      ...middleA.map((line) => ["-", line]),
      ...middleB.map((line) => ["+", line]),
      ...a.slice(endA).map((line) => [" ", line]),
    ];
  }
  const width = middleB.length + 1;
  // lengths[i * width + j]: the LCS length of middleA[i..] and middleB[j..].
  const lengths = new Uint32Array((middleA.length + 1) * width);
  for (let i = middleA.length - 1; i >= 0; i -= 1) {
    for (let j = middleB.length - 1; j >= 0; j -= 1) {
      lengths[i * width + j] =
        middleA[i] === middleB[j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }
  const script = a.slice(0, start).map((line) => [" ", line]);
  let i = 0;
  let j = 0;
  while (i < middleA.length || j < middleB.length) {
    if (i < middleA.length && j < middleB.length && middleA[i] === middleB[j]) {
      script.push([" ", middleA[i]]);
      i += 1;
      j += 1;
    } else if (
      j >= middleB.length ||
      (i < middleA.length && lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])
    ) {
      script.push(["-", middleA[i]]);
      i += 1;
    } else {
      script.push(["+", middleB[j]]);
      j += 1;
    }
  }
  for (const line of a.slice(endA)) script.push([" ", line]);
  return script;
}

/**
 * `before` → `after` as a unified diff labelled `from` and `to`, or "" when
 * they are the same.
 */
export function unifiedDiff(before, after, { from = "before", to = "after" } = {}) {
  if (before === after) return "";
  const script = editScript(lines(before), lines(after));
  const changed = script.flatMap(([kind], index) => (kind === " " ? [] : [index]));
  if (changed.length === 0) {
    // Only a final newline differs.
    return `--- ${from}\n+++ ${to}\n\\ The texts differ only in their final newline\n`;
  }
  const hunks = [];
  for (const index of changed) {
    const last = hunks.at(-1);
    if (last && index - last.end <= CONTEXT * 2) last.end = index;
    else hunks.push({ start: index, end: index });
  }
  const output = [`--- ${from}`, `+++ ${to}`];
  for (const hunk of hunks) {
    const first = Math.max(0, hunk.start - CONTEXT);
    const last = Math.min(script.length - 1, hunk.end + CONTEXT);
    const before = script.slice(0, first);
    const lineA = before.filter(([kind]) => kind !== "+").length;
    const lineB = before.filter(([kind]) => kind !== "-").length;
    const body = script.slice(first, last + 1);
    const countA = body.filter(([kind]) => kind !== "+").length;
    const countB = body.filter(([kind]) => kind !== "-").length;
    output.push(
      `@@ -${lineA + (countA ? 1 : 0)},${countA} +${lineB + (countB ? 1 : 0)},${countB} @@`,
    );
    for (const [kind, line] of body) output.push(`${kind}${line}`);
  }
  return `${output.join("\n")}\n`;
}

/** How many lines `unifiedDiff` would remove and add. */
export function diffStat(before, after) {
  const script = editScript(lines(before), lines(after));
  return {
    removed: script.filter(([kind]) => kind === "-").length,
    added: script.filter(([kind]) => kind === "+").length,
  };
}

// Gutenberg block markup as a tree, so content is edited by moving and
// changing parsed blocks, never by splicing strings (gq-platform ADR 0011).
//
// `parseBlocks` is the block serialization default parser
// (@wordpress/block-serialization-default-parser, the same grammar as PHP's
// parse_blocks): it needs no block registrations and yields, for each block,
// `blockName` (null for loose HTML), `attrs`, `innerBlocks`, `innerHTML` and
// `innerContent` (strings, with null where each inner block goes).
// `serializeBlocks` is its inverse, as the editor and PHP's serialize_blocks
// write a block. Neither knows what a block's `save()` would produce: that is
// what `gq content validate` asks the Site's own editor.

const TOKENIZER =
  /<!--\s+(\/)?wp:([a-z][a-z0-9_-]*\/)?([a-z][a-z0-9_-]*)\s+(\{(?:(?=([^}]+|\}+(?=\})|(?!\}\s+\/?-->)[\s\S])*)\5|[\s\S]*?)\}\s+)?(\/)?-->/gu;

function block(blockName, attrs) {
  return { blockName, attrs, innerBlocks: [], innerHTML: "", innerContent: [] };
}

function freeform(html) {
  return { blockName: null, attrs: {}, innerBlocks: [], innerHTML: html, innerContent: [html] };
}

function parseAttributes(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** The block tree of `document` (a post's raw `post_content`). */
export function parseBlocks(document) {
  const output = [];
  const stack = [];
  const tokenizer = new RegExp(TOKENIZER.source, TOKENIZER.flags);
  let offset = 0;

  const addFreeform = (length = document.length - offset) => {
    if (length > 0) output.push(freeform(document.slice(offset, offset + length)));
  };
  const addInnerBlock = (child, tokenStart, tokenLength, lastOffset) => {
    const parent = stack.at(-1);
    parent.block.innerBlocks.push(child);
    const html = document.slice(parent.prevOffset, tokenStart);
    if (html) {
      parent.block.innerHTML += html;
      parent.block.innerContent.push(html);
    }
    parent.block.innerContent.push(null);
    parent.prevOffset = lastOffset ?? tokenStart + tokenLength;
  };
  const addBlockFromStack = (endOffset) => {
    const frame = stack.pop();
    const html =
      endOffset === undefined
        ? document.slice(frame.prevOffset)
        : document.slice(frame.prevOffset, endOffset);
    if (html) {
      frame.block.innerHTML += html;
      frame.block.innerContent.push(html);
    }
    if (frame.leadingHtmlStart !== null) {
      output.push(freeform(document.slice(frame.leadingHtmlStart, frame.tokenStart)));
    }
    output.push(frame.block);
  };

  for (;;) {
    const match = tokenizer.exec(document);
    if (match === null) {
      if (stack.length === 0) addFreeform();
      while (stack.length > 0) addBlockFromStack();
      return output;
    }
    const [token, closer, namespace, name, attributes, , isVoid] = match;
    const start = match.index;
    const length = token.length;
    const blockName = `${namespace ?? "core/"}${name}`;
    const attrs = attributes ? parseAttributes(attributes) : {};
    const leadingHtmlStart = start > offset ? offset : null;

    if (isVoid) {
      if (stack.length === 0) {
        if (leadingHtmlStart !== null)
          output.push(freeform(document.slice(leadingHtmlStart, start)));
        output.push(block(blockName, attrs));
      } else {
        addInnerBlock(block(blockName, attrs), start, length);
      }
      offset = start + length;
    } else if (!closer) {
      stack.push({
        block: block(blockName, attrs),
        tokenStart: start,
        prevOffset: start + length,
        leadingHtmlStart,
      });
      offset = start + length;
    } else if (stack.length === 0) {
      // A closer with nothing open: the rest is loose HTML, as the parser has it.
      addFreeform();
      return output;
    } else if (stack.length === 1) {
      addBlockFromStack(start);
      offset = start + length;
    } else {
      const top = stack.pop();
      const html = document.slice(top.prevOffset, start);
      top.block.innerHTML += html;
      top.block.innerContent.push(html);
      top.prevOffset = start + length;
      addInnerBlock(top.block, top.tokenStart, 0, start + length);
      offset = start + length;
    }
  }
}

// As the editor (and PHP's serialize_block_attributes) encodes them, so the
// result can't close the comment or read as HTML.
function serializeAttributes(attrs) {
  return JSON.stringify(attrs)
    .replaceAll("--", "\\u002d\\u002d")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll('\\"', "\\u0022");
}

/** One block (with its inner blocks) as markup. */
export function serializeBlock(node) {
  let index = 0;
  let content = "";
  for (const chunk of node.innerContent ?? []) {
    if (typeof chunk === "string") content += chunk;
    else {
      const inner = node.innerBlocks?.[index];
      index += 1;
      if (!inner)
        throw new Error(`${node.blockName} has fewer innerBlocks than innerContent places.`);
      content += serializeBlock(inner);
    }
  }
  if (index !== (node.innerBlocks?.length ?? 0)) {
    throw new Error(
      `${node.blockName} has ${node.innerBlocks.length} innerBlocks but ${index} places for them in innerContent.`,
    );
  }
  if (node.blockName === null || node.blockName === undefined) return content;
  if (node.attrs === null) {
    throw new Error(`${node.blockName} has attributes that aren't JSON; fix them in the markup.`);
  }
  const name = node.blockName.startsWith("core/") ? node.blockName.slice(5) : node.blockName;
  const attrs =
    node.attrs && Object.keys(node.attrs).length > 0 ? `${serializeAttributes(node.attrs)} ` : "";
  return content
    ? `<!-- wp:${name} ${attrs}-->${content}<!-- /wp:${name} -->`
    : `<!-- wp:${name} ${attrs}/-->`;
}

/** A block tree (as parseBlocks gives it, edited or not) as markup. */
export function serializeBlocks(blocks) {
  if (!Array.isArray(blocks)) throw new Error("A block tree is a JSON array of blocks.");
  return blocks.map(serializeBlock).join("");
}

/**
 * The tree's blocks, depth first, as `{ path, name, attrs }`: `path` is the
 * block's position ("2.0.1"), loose HTML between blocks is left out unless it
 * holds more than whitespace.
 */
export function blockOutline(blocks, prefix = "") {
  return blocks.flatMap((node, index) => {
    const path = `${prefix}${index}`;
    if (node.blockName === null && !node.innerHTML.trim()) return [];
    return [
      { path, name: node.blockName ?? "(html)", attrs: node.attrs },
      ...blockOutline(node.innerBlocks ?? [], `${path}.`),
    ];
  });
}

/** The outline as text, one block per line, indented by depth. */
export function outlineText(blocks) {
  return blockOutline(blocks)
    .map(({ path, name, attrs }) => {
      const depth = path.split(".").length - 1;
      const shown = attrs && Object.keys(attrs).length > 0 ? ` ${JSON.stringify(attrs)}` : "";
      return `${"  ".repeat(depth)}${name}${shown}`;
    })
    .join("\n");
}

/** Blocks whose attributes aren't JSON: a tree with any can't be re-serialized. */
export function unparsableBlocks(blocks) {
  return blockOutline(blocks).filter(({ attrs }) => attrs === null);
}

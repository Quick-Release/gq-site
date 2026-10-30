import assert from "node:assert/strict";
import test from "node:test";

import {
  blockOutline,
  outlineText,
  parseBlocks,
  serializeBlocks,
  unparsableBlocks,
} from "../../src/content/blocks.mjs";
import { diffStat, unifiedDiff } from "../../src/content/diff.mjs";

const PAGE = `<!-- wp:group {"layout":{"type":"constrained"}} -->
<div class="wp-block-group"><!-- wp:heading -->
<h2 class="wp-block-heading">Title</h2>
<!-- /wp:heading --></div>
<!-- /wp:group -->

<!-- wp:buttons -->
<div class="wp-block-buttons"><!-- wp:button {"url":"https://a.test/?a=1\\u0026b=2"} -->
<div class="wp-block-button"><a class="wp-block-button__link" href="https://a.test/">Go</a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons -->

<!-- wp:acme/title-with-label {"label":"\\u003cnew\\u003e \\u002d\\u002d \\u0022x\\u0022"} /-->`;

test("parses blocks as parse_blocks does: names, attributes, nesting and loose HTML", () => {
  const blocks = parseBlocks(PAGE);
  assert.deepEqual(
    blocks.map((block) => block.blockName),
    ["core/group", null, "core/buttons", null, "acme/title-with-label"],
  );
  const [group, , buttons, , title] = blocks;
  assert.deepEqual(group.attrs, { layout: { type: "constrained" } });
  assert.equal(group.innerBlocks[0].blockName, "core/heading");
  assert.deepEqual(group.innerContent, ['\n<div class="wp-block-group">', null, "</div>\n"]);
  assert.equal(buttons.innerBlocks[0].attrs.url, "https://a.test/?a=1&b=2");
  assert.equal(title.attrs.label, '<new> -- "x"');
  assert.deepEqual(title.innerContent, []);
  assert.equal(blocks[1].innerHTML, "\n\n");
});

test("serializes a parsed tree back to the same bytes", () => {
  assert.equal(serializeBlocks(parseBlocks(PAGE)), PAGE);
  assert.equal(serializeBlocks(parseBlocks("Just HTML")), "Just HTML");
  assert.equal(serializeBlocks(parseBlocks("")), "");
});

test("serializes attributes as the editor does, so they can't close the comment", () => {
  const markup = serializeBlocks([
    {
      blockName: "core/paragraph",
      attrs: { note: '--> <b> & "q"' },
      innerBlocks: [],
      innerHTML: "<p>x</p>",
      innerContent: ["<p>x</p>"],
    },
  ]);
  assert.equal(
    markup,
    '<!-- wp:paragraph {"note":"\\u002d\\u002d\\u003e \\u003cb\\u003e \\u0026 \\u0022q\\u0022"} --><p>x</p><!-- /wp:paragraph -->',
  );
  assert.deepEqual(parseBlocks(markup)[0].attrs, { note: '--> <b> & "q"' });
});

test("a moved block serializes where the tree puts it", () => {
  const blocks = parseBlocks(PAGE);
  const [group, , buttons] = blocks;
  group.innerBlocks.push(buttons);
  group.innerContent.splice(-1, 0, "\n\n", null);
  const moved = serializeBlocks([group]);
  assert.match(
    moved,
    /<!-- \/wp:heading -->\n\n<!-- wp:buttons -->[\s\S]*<!-- \/wp:buttons --><\/div>\n<!-- \/wp:group -->$/u,
  );
  assert.equal(serializeBlocks(parseBlocks(moved)), moved);
});

test("refuses a tree whose innerContent and innerBlocks disagree", () => {
  const [group] = parseBlocks(PAGE);
  group.innerBlocks.push(group.innerBlocks[0]);
  assert.throws(() => serializeBlocks([group]), /2 innerBlocks but 1 places/u);
  group.innerBlocks = [];
  assert.throws(() => serializeBlocks([group]), /fewer innerBlocks/u);
  assert.throws(() => serializeBlocks({}), /JSON array/u);
});

test("finds attributes that aren't JSON, which can't be re-serialized", () => {
  const blocks = parseBlocks('<!-- wp:paragraph {"a":} --><p>x</p><!-- /wp:paragraph -->');
  assert.equal(blocks[0].attrs, null);
  assert.deepEqual(
    unparsableBlocks(blocks).map(({ name }) => name),
    ["core/paragraph"],
  );
  assert.throws(() => serializeBlocks(blocks), /aren't JSON/u);
});

test("outlines the tree by path, leaving out whitespace between blocks", () => {
  const blocks = parseBlocks(PAGE);
  assert.deepEqual(
    blockOutline(blocks).map(({ path, name }) => `${path} ${name}`),
    [
      "0 core/group",
      "0.0 core/heading",
      "2 core/buttons",
      "2.0 core/button",
      "4 acme/title-with-label",
    ],
  );
  assert.equal(
    outlineText(blocks).split("\n")[3],
    '  core/button {"url":"https://a.test/?a=1&b=2"}',
  );
});

test("diffs texts line by line with context", () => {
  const before = "a\nb\nc\nd\ne\nf\ng\nh\n";
  const after = "a\nb\nc\nD\ne\nf\ng\nh\ni\n";
  assert.equal(
    unifiedDiff(before, after, { from: "cms", to: "file" }),
    "--- cms\n+++ file\n@@ -1,8 +1,9 @@\n a\n b\n c\n-d\n+D\n e\n f\n g\n h\n+i\n",
  );
  assert.deepEqual(diffStat(before, after), { removed: 1, added: 2 });
  assert.equal(unifiedDiff("same", "same"), "");
  assert.match(unifiedDiff("x", "x\n"), /only in their final newline/u);
});

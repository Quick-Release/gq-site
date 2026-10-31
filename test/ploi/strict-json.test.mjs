// JSON.parse, refusing a repeated member name: what an approval record and the
// Operator's configuration are read with.
import assert from "node:assert/strict";
import test from "node:test";

import { parseStrictJson } from "../../src/ploi/strict-json.mjs";

test("strict JSON refuses a repeated member name anywhere, and otherwise parses as JSON.parse does", () => {
  const text = '{"a":[1,{"b":"\\"x\\""}],"c":null,"d":-1.5e3,"e":true}';
  assert.deepEqual(parseStrictJson(text), JSON.parse(text));
  assert.throws(() => parseStrictJson('{"a":1,"a":2}'), /Repeated member name "a"/u);
  assert.throws(
    () => parseStrictJson('{"files":{"x.php":"1","x.php":"2"}}'),
    /Repeated member name "x\.php"/u,
  );
  assert.throws(() => parseStrictJson('{"a":1} {"a":1}'), /Unexpected text/u);
  assert.throws(() => parseStrictJson('{"a":1,}'), /Expected a member name/u);
  assert.equal(Object.getPrototypeOf(parseStrictJson('{"__proto__":{"x":1}}')), Object.prototype);
});

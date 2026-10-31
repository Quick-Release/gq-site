// JSON.parse, except that an object repeating a member name is refused
// instead of silently keeping the last value. For text that is authority
// (an approval record), where a duplicate could hide what a reviewer saw.

// The value `text` holds; throws on invalid JSON or a repeated member name.
export function parseStrictJson(text) {
  let at = 0;
  const fail = (message) => {
    throw new SyntaxError(`${message} at position ${at}`);
  };
  const space = () => {
    while (at < text.length && " \t\n\r".includes(text[at])) at += 1;
  };
  const string = () => {
    const start = at;
    at += 1;
    while (at < text.length && text[at] !== '"') {
      if (text[at] === "\\") at += 1;
      at += 1;
    }
    if (at >= text.length) fail("Unterminated string");
    at += 1;
    return JSON.parse(text.slice(start, at));
  };
  const value = () => {
    space();
    const character = text[at];
    if (character === "{") {
      at += 1;
      const object = {};
      const names = new Set();
      space();
      if (text[at] === "}") {
        at += 1;
        return object;
      }
      for (;;) {
        space();
        if (text[at] !== '"') fail("Expected a member name");
        const name = string();
        if (names.has(name)) fail(`Repeated member name ${JSON.stringify(name)}`);
        names.add(name);
        space();
        if (text[at] !== ":") fail("Expected ':'");
        at += 1;
        Object.defineProperty(object, name, {
          value: value(),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        space();
        if (text[at] === ",") {
          at += 1;
          continue;
        }
        if (text[at] === "}") {
          at += 1;
          return object;
        }
        fail("Expected ',' or '}'");
      }
    }
    if (character === "[") {
      at += 1;
      const array = [];
      space();
      if (text[at] === "]") {
        at += 1;
        return array;
      }
      for (;;) {
        array.push(value());
        space();
        if (text[at] === ",") {
          at += 1;
          continue;
        }
        if (text[at] === "]") {
          at += 1;
          return array;
        }
        fail("Expected ',' or ']'");
      }
    }
    if (character === '"') return string();
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(
      text.slice(at),
    );
    if (!literal) fail("Unexpected token");
    at += literal[0].length;
    return JSON.parse(literal[0]);
  };
  const result = value();
  space();
  if (at !== text.length) fail("Unexpected text after the JSON value");
  return result;
}

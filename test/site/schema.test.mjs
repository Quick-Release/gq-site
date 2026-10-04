// The fields `gq site check` validates against WPGraphQL are the ones the
// Frontend skeleton's queries read (apps/frontend/src/lib/wordpress.ts), so
// a field added to a query can't be left out of the readiness check.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { SCHEMA_QUERY } from "../../src/site/readiness.mjs";

const wordpress = readFileSync(
  new URL("../../blueprint/templates/apps/frontend/src/lib/wordpress.ts", import.meta.url),
  "utf8",
);

// GraphQL's own words; the queries' names, variables, argument names,
// literal values and the JavaScript interpolated into a query are left out
// too.
const NOT_FIELDS = new Set(["query", "on", "true", "false", "if", "include", "skip", "where"]);
// A multilingual Site's fields (GQ Polylang for WPGraphQL), which a
// monolingual Site's CMS doesn't have: gq site check doesn't validate them
// yet, until its readiness checks each language.
const MULTILINGUAL_FIELDS = new Set(["language"]);

function selections(text) {
  return new Set(
    text
      .replace(/\$\{[^}]*\}/gu, "")
      .replace(/^\s*query \w+(\([^)]*\))?/mu, "")
      .replace(/\$\w+/gu, "")
      .replace(/\w+\s*:/gu, "")
      .replace(/"[^"]*"/gu, "")
      .match(/[A-Za-z_]\w*/gu)
      .filter((word) => !NOT_FIELDS.has(word) && !/^[A-Z]+$/u.test(word)),
  );
}

test("the readiness schema check covers every field the Frontend's queries read", () => {
  const queries = [...wordpress.matchAll(/\/\* GraphQL \*\/ `([^`]*)`/gu)].map((match) => match[1]);
  assert.equal(
    queries.length,
    6,
    "HomePage, another language's HomePage, SiteChrome, EntryByUri, DesignPresets, PublishedRoutes",
  );
  const checked = selections(SCHEMA_QUERY);
  const missing = new Set();
  for (const query of queries) {
    for (const field of selections(query)) {
      if (!checked.has(field) && !MULTILINGUAL_FIELDS.has(field)) missing.add(field);
    }
  }
  assert.deepEqual([...missing], []);
  assert.match(SCHEMA_QUERY, /location: PRIMARY/u, "the menu location the Frontend reads");
});

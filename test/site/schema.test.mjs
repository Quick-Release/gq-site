// The fields `gq site check` validates against WPGraphQL are the ones the
// pinned content runtime's queries read (@getquick/content, the version the
// blueprint pins; src/sync/content-pair.mjs), so a field the runtime adds to
// a query can't be left out of the readiness check.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { SCHEMA_QUERY } from "../../src/site/readiness.mjs";
import { CONTENT_PAIR } from "../../src/sync/content-pair.mjs";

const runtime = new URL(import.meta.resolve(`${CONTENT_PAIR.npm}/server`));
const installed = JSON.parse(readFileSync(new URL("../package.json", runtime), "utf8"));
const server = readFileSync(runtime, "utf8");
// The queries delivery reads with; the consent settings query only runs on a
// Site that enables the runtime's consent CMS settings.
const DELIVERY_QUERIES =
  /`(\s*query (?:HomePage|SiteChrome|EntryByUri|DesignPresets|PublishedRoutes)\b[^`]*)`/gu;

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

test("the readiness schema check covers every field the pinned runtime's queries read", () => {
  assert.equal(installed.version, CONTENT_PAIR.version, "the devDependency is the blueprint's pin");
  const queries = [...server.matchAll(DELIVERY_QUERIES)].map((match) => match[1]);
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

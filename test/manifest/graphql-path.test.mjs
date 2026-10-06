import assert from "node:assert/strict";
import test from "node:test";

import { manifestSchema, wordpressGraphqlUrl } from "../../src/manifest/schema.mjs";

const OPS = {
  schemaVersion: 1,
  project: "fixture",
  variant: "content",
  domains: { admin: "cms.example.test", frontend: "www.example.test" },
};

for (const graphqlPath of [undefined, "/graphql", "/wp/graphql"]) {
  test(`the manifest accepts ${graphqlPath ?? "no GraphQL path"} and resolves the public endpoint`, () => {
    const ops = manifestSchema.parse({
      ...OPS,
      wordpress: { plugins: [], ...(graphqlPath ? { graphqlPath } : {}) },
    });
    assert.equal(
      wordpressGraphqlUrl(ops),
      `https://cms.example.test${graphqlPath ?? "/wp/graphql"}`,
    );
    assert.equal(
      wordpressGraphqlUrl(ops, { localOrigin: "https://fixture.ddev.site/" }),
      "https://fixture.ddev.site/wp/graphql",
    );
  });
}

test("Sites without a wordpress block keep the existing GraphQL endpoint", () => {
  assert.equal(
    wordpressGraphqlUrl(manifestSchema.parse(OPS)),
    "https://cms.example.test/wp/graphql",
  );
});

test("the GraphQL path is an exact enum, not an arbitrary route or URL", () => {
  for (const graphqlPath of [
    " /graphql",
    "/graphql ",
    "graphql",
    "/graphql/",
    "/wp-json/graphql",
    "/graphql?query=x",
    "https://other.example.test/graphql",
    null,
  ]) {
    const parsed = manifestSchema.safeParse({ ...OPS, wordpress: { plugins: [], graphqlPath } });
    assert.equal(parsed.success, false, String(graphqlPath));
    assert.deepEqual(parsed.error.issues[0].path, ["wordpress", "graphqlPath"]);
  }
});

// Managed deploy files are generated through gq sync, then evaluated against
// isolated Alchemy/Effect stand-ins. No provider, credential or real build runs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createFixtureSite } from "../support/fixture-site.mjs";

const OPS = {
  schemaVersion: 1,
  project: "fixture",
  variant: "content",
  domains: { admin: "cms.example.test", frontend: "www.example.test" },
  cloudflare: { accountId: "fixture-account" },
};

const STUBS = {
  "node_modules/alchemy/package.json": JSON.stringify({
    type: "module",
    exports: { ".": "./index.js", "./Stack": "./Stack.js", "./Cloudflare": "./Cloudflare.js" },
  }),
  "node_modules/alchemy/index.js":
    "export const Stack = () => undefined; export const RemovalPolicy = { retain: () => value => value };",
  "node_modules/alchemy/Stack.js":
    "export const Stack = { *[Symbol.iterator]() { return { stage: process.env.TEST_STAGE }; } };",
  "node_modules/alchemy/Cloudflare.js": `
    export const Website = { Astro: (_id, props) => props };
    export const D1 = { Database: () => ({
      *[Symbol.iterator]() { return { binding: "fixture-d1" }; },
      pipe() { return this; }
    }) };
    export const providers = () => undefined;
    export const state = () => undefined;
  `,
  "node_modules/effect/package.json": JSON.stringify({
    type: "module",
    exports: { "./Effect": "./Effect.js", "./Redacted": "./Redacted.js" },
  }),
  "node_modules/effect/Effect.js": `
    export const gen = fn => fn();
    export function runSync(iterator) {
      let step = iterator.next();
      while (!step.done) step = iterator.next(step.value);
      return step.value;
    }
  `,
  "node_modules/effect/Redacted.js": "export const make = value => ({ redacted: value });",
};

async function generatedDeploy({ graphqlPath, durable = true } = {}) {
  const fixture = await createFixtureSite({
    ops: { ...OPS, wordpress: { plugins: [], ...(graphqlPath ? { graphqlPath } : {}) } },
    files: {
      ...STUBS,
      "apps/frontend/README.md": "Site-owned Frontend\n",
      ...(durable ? { "apps/frontend/migrations/0001.sql": "-- fixture\n" } : {}),
    },
  });
  const synced = await fixture.run(["sync"]);
  assert.equal(synced.code, 0, synced.stderr);
  // An executable named alchemy captures only the public URL; it never deploys.
  const executable = fixture.path("alchemy");
  await writeFile(
    executable,
    `#!${process.execPath}\nconsole.log(JSON.stringify({ url: process.env.PUBLIC_WORDPRESS_GRAPHQL_URL }));\n`,
  );
  await chmod(executable, 0o755);
  const run = (args, env) => {
    const result = spawnSync(process.execPath, args, {
      cwd: join(fixture.root, "infra"),
      encoding: "utf8",
      env: { PATH: fixture.root, TEST_STAGE: "prod", ...env },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  return {
    script: (env = {}) => run(["scripts/deploy-frontend.mjs"], env),
    website: (env = {}) =>
      run(
        [
          "--experimental-strip-types",
          "--input-type=module",
          "--eval",
          'import { Website } from "./frontend.run.ts"; import { runSync } from "effect/Effect"; console.log(JSON.stringify(runSync(Website)));',
        ],
        env,
      ),
  };
}

for (const graphqlPath of [undefined, "/wp/graphql", "/graphql"]) {
  for (const durable of [false, true]) {
    test(`generated deploy uses ${graphqlPath ?? "default /wp/graphql"}, store=${durable}`, async () => {
      const deploy = await generatedDeploy({ graphqlPath, durable });
      const expected = `https://cms.example.test${graphqlPath ?? "/wp/graphql"}`;
      assert.equal(deploy.script().url, expected);
      const website = deploy.website();
      assert.equal(website.env.PUBLIC_WORDPRESS_GRAPHQL_URL, expected);
      assert.equal(Boolean(website.env.PUBLICATION_DB), durable);
      assert.equal(website.env.GQ_AUTH_AUTOMATION_CLIENT_ID, undefined);
    });
  }
}

test("generated deploy preserves an explicit public URL override", async () => {
  const deploy = await generatedDeploy({ graphqlPath: "/graphql" });
  const url = "https://cms.example.test/wp/graphql";
  const env = { PUBLIC_WORDPRESS_GRAPHQL_URL: url };
  assert.equal(deploy.script(env).url, url);
  assert.equal(deploy.website(env).env.PUBLIC_WORDPRESS_GRAPHQL_URL, url);
});

test("the production URL binding does not override non-production builds", async () => {
  const deploy = await generatedDeploy({ graphqlPath: "/graphql" });
  assert.equal(deploy.website({ TEST_STAGE: "dev" }).env.PUBLIC_WORDPRESS_GRAPHQL_URL, undefined);
});

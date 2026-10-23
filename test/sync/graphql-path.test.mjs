// Managed deploy files are generated through gq sync, then evaluated against
// isolated Alchemy/Effect stand-ins. No provider, credential or real build runs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
    "export const Stack = (_id, _options, program) => program; export const RemovalPolicy = { retain: () => value => value };",
  "node_modules/alchemy/Stack.js":
    "export const Stack = { *[Symbol.iterator]() { return { stage: process.env.TEST_STAGE }; } };",
  "node_modules/alchemy/Cloudflare.js": `
    export const Website = { Astro: (_id, props) => (function* () {
      const result = yield* props;
      return { ...result, bind: () => function* (bindings) { globalThis.previewBindings = bindings; } };
    })() };
    export const Worker = (id, props) => ({ worker: id, props });
    export const RateLimit = (name, props) => ({ rateLimit: name, ...props });
    export const D1 = { Database: (id, props) => ({
      *[Symbol.iterator]() { return { database: id, ...props }; },
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

// A consent Runtime as the Frontend installs it: @getquick/content with its
// `./consent/migrations` export.
const CONSENT_RUNTIME = {
  "apps/frontend/node_modules/@getquick/content/package.json": JSON.stringify({
    name: "@getquick/content",
    type: "module",
    exports: { "./consent/migrations": { import: "./dist/consent-migrations.js" } },
  }),
  "apps/frontend/node_modules/@getquick/content/dist/consent-migrations.js":
    'export const consentMigrationsDirectory = "/fixture/consent-migrations/";\n',
};

async function generatedDeploy({ graphqlPath, durable = true, consent = false, ops = {} } = {}) {
  const fixture = await createFixtureSite({
    ops: { ...OPS, wordpress: { plugins: [], ...(graphqlPath ? { graphqlPath } : {}) }, ...ops },
    files: {
      ...STUBS,
      "apps/frontend/README.md": "Site-owned Frontend\n",
      ...(durable ? { "apps/frontend/migrations/0001.sql": "-- fixture\n" } : {}),
      ...(consent ? CONSENT_RUNTIME : {}),
    },
  });
  const synced = await fixture.run(["sync"]);
  assert.equal(synced.code, 0, synced.stderr);
  await mkdir(fixture.path("node_modules/@getquick"), { recursive: true });
  await symlink(
    fileURLToPath(new URL("../../", import.meta.url)),
    fixture.path("node_modules/@getquick/site"),
    "dir",
  );
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
    root: fixture.root,
    script: (env = {}) => run(["scripts/deploy-frontend.mjs"], env),
    scriptResult: (env = {}) =>
      spawnSync(process.execPath, ["scripts/deploy-frontend.mjs"], {
        cwd: join(fixture.root, "infra"),
        encoding: "utf8",
        env: { PATH: fixture.root, ...env },
      }),
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
    bindings: (env = {}) =>
      run(
        [
          "--experimental-strip-types",
          "--input-type=module",
          "--eval",
          'import stack from "./frontend.run.ts"; import { runSync } from "effect/Effect"; runSync(stack); console.log(JSON.stringify(globalThis.previewBindings ?? {}));',
        ],
        env,
      ),
    purge: (env = {}) =>
      run(
        [
          "--experimental-strip-types",
          "--input-type=module",
          "--eval",
          'import { ConsentPurge } from "./consent.ts"; import { runSync } from "effect/Effect"; console.log(JSON.stringify({ worker: ConsentPurge.worker, props: runSync(ConsentPurge.props) }));',
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

test("a Frontend with the consent Runtime binds its consent records, in eu, and their purge", async () => {
  const deploy = await generatedDeploy({ consent: true });
  const token = "fixture-consent-read-token-0123456789abcdef";

  const { env } = deploy.website({ CONSENT_READ_TOKEN: token });

  assert.deepEqual(env.CONSENT_DB, {
    database: "FixtureConsent",
    name: "fixture-fe-consent",
    jurisdiction: "eu",
    migrations: "/fixture/consent-migrations/",
  });
  assert.equal(env.CONSENT_RATE_LIMITER.rateLimit, "CONSENT_RATE_LIMITER");
  assert.deepEqual(env.CONSENT_RATE_LIMITER.simple, { limit: 30, period: 60 });
  assert.ok(Number.isInteger(env.CONSENT_RATE_LIMITER.namespaceId));
  assert.deepEqual(env.CONSENT_READ_TOKEN, { redacted: token });
  // The publication store is still its own database.
  assert.equal(env.PUBLICATION_DB.name, "fixture-fe-publications");

  // Another stage gets its own database, also in eu, and its own counters.
  const preview = deploy.website({ TEST_STAGE: "preview" }).env;
  assert.equal(preview.CONSENT_DB.name, "fixture-fe-consent-preview");
  assert.equal(preview.CONSENT_DB.jurisdiction, "eu");
  assert.equal(preview.CONSENT_READ_TOKEN, undefined);
  assert.notEqual(preview.CONSENT_RATE_LIMITER.namespaceId, env.CONSENT_RATE_LIMITER.namespaceId);

  const purge = deploy.purge();
  assert.equal(purge.worker, "FixtureConsentPurge");
  assert.equal(purge.props.name, "fixture-consent-purge");
  assert.deepEqual(purge.props.crons, ["17 3 * * *"]);
  assert.equal(purge.props.workersDev, false);
  assert.match(purge.props.main, /\/apps\/frontend\/workers\/consent-purge\.ts$/u);
  assert.equal(purge.props.env.SITE_ID, "fixture");
  assert.equal(purge.props.env.CONSENT_DB.jurisdiction, "eu");
});

test("a Frontend without the consent Runtime deploys as before: no consent bindings", async () => {
  const deploy = await generatedDeploy();

  const { env } = deploy.website({
    CONSENT_READ_TOKEN: "fixture-consent-read-token-0123456789abcdef",
  });

  for (const name of ["CONSENT_DB", "CONSENT_RATE_LIMITER", "CONSENT_READ_TOKEN"]) {
    assert.equal(env[name], undefined, name);
  }
});

test("a Site's consent.retentionDays is bound to the Frontend and the purge Worker", async () => {
  const deploy = await generatedDeploy({ consent: true, ops: { consent: { retentionDays: 365 } } });

  assert.equal(deploy.website().env.CONSENT_RETENTION_DAYS, "365");
  assert.equal(deploy.website({ TEST_STAGE: "preview" }).env.CONSENT_RETENTION_DAYS, "365");
  assert.equal(deploy.purge().props.env.CONSENT_RETENTION_DAYS, "365");
});

test("without consent.retentionDays neither Worker gets a retention: the Runtime's default", async () => {
  const deploy = await generatedDeploy({ consent: true });

  assert.equal("CONSENT_RETENTION_DAYS" in deploy.website().env, false);
  assert.equal("CONSENT_RETENTION_DAYS" in deploy.purge().props.env, false);
});

test("a retention without the consent Runtime binds nothing to the Frontend", async () => {
  const deploy = await generatedDeploy({ ops: { consent: { retentionDays: 365 } } });

  assert.equal("CONSENT_RETENTION_DAYS" in deploy.website().env, false);
});

// The generated purge entry, run in Node against the installed consent
// Runtime and a D1 stand-in over node:sqlite holding the Runtime's own
// migrations. Nothing is deployed.
const PURGE_RUN = `
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { consentMigrationsDirectory } from "@getquick/content/consent/migrations";
import purge from "./workers/consent-purge.ts";

const sqlite = new DatabaseSync(":memory:");
for (const file of readdirSync(consentMigrationsDirectory).sort()) {
  sqlite.exec(readFileSync(join(consentMigrationsDirectory, file), "utf8"));
}
const CONSENT_DB = {
  prepare(query) {
    let values = [];
    const statement = {
      bind: (...bound) => ((values = bound), statement),
      run: async () => ({ meta: { changes: Number(sqlite.prepare(query).run(...values).changes) } }),
      all: async () => ({ results: sqlite.prepare(query).all(...values) }),
      first: async () => sqlite.prepare(query).get(...values) ?? null,
    };
    return statement;
  },
};
const insert = sqlite.prepare(
  "INSERT INTO consent_records (consent_id, site_id, recorded_at, decided_at, expires_at, config_version, legal_revisions, preferences, analytics, marketing, external_media, action, language, ui_version) VALUES (?, 'fixture', ?, ?, ?, '1', '{}', 0, 0, 0, 0, 'reject_all', 'en', '1')",
);
const DAY = 86_400_000;
// Each decision stopped being in force (expired) that many days ago.
for (const [id, days] of [["past-a-year", 400], ["within-a-year", 300]]) {
  const expired = new Date(Date.now() - days * DAY).toISOString();
  const decided = new Date(Date.now() - (days + 183) * DAY).toISOString();
  insert.run(id, decided, decided, expired);
}
const env = JSON.parse(process.env.PURGE_ENV);
const log = console.log;
console.log = () => {};
await purge.scheduled({}, { ...env, CONSENT_DB });
console.log = log;
console.log(JSON.stringify(sqlite.prepare("SELECT consent_id FROM consent_records ORDER BY id").all().map((row) => row.consent_id)));
`;

async function generatedPurge() {
  const fixture = await createFixtureSite({ ops: OPS });
  const synced = await fixture.run(["sync"]);
  assert.equal(synced.code, 0, synced.stderr);
  const frontend = fixture.path("apps/frontend");
  await mkdir(join(frontend, "node_modules/@getquick"), { recursive: true });
  await symlink(
    fileURLToPath(new URL("../../node_modules/@getquick/content", import.meta.url)),
    join(frontend, "node_modules/@getquick/content"),
  );
  await writeFile(join(frontend, "purge-run.mjs"), PURGE_RUN);
  return (env) => {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "purge-run.mjs"],
      {
        cwd: frontend,
        encoding: "utf8",
        env: { PATH: process.env.PATH, PURGE_ENV: JSON.stringify({ SITE_ID: "fixture", ...env }) },
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
}

test("the purge entry deletes records past the Site's retention and keeps newer ones", async () => {
  const purge = await generatedPurge();

  assert.deepEqual(purge({ CONSENT_RETENTION_DAYS: "365" }), ["within-a-year"]);
  // Without it, the Runtime's default (1826 days) keeps both.
  assert.deepEqual(purge({}), ["past-a-year", "within-a-year"]);
});

test("preview config and secrets are runtime bindings, absent from Astro build env", async () => {
  const deploy = await generatedDeploy({
    ops: {
      preview: {
        cmsUrl: "https://cms.example.test",
        audience: "https://www.example.test/gq/preview",
      },
    },
  });
  const env = {
    GQ_PREVIEW_CMS_USERNAME: "site-preview",
    GQ_PREVIEW_CMS_APPLICATION_PASSWORD: "private-password",
    GQ_PREVIEW_ACCESS_CLIENT_ID: "dedicated-id",
    GQ_PREVIEW_ACCESS_CLIENT_SECRET: "dedicated-secret",
  };
  const website = deploy.website(env);
  assert.equal(website.env.GQ_PREVIEW_CMS_URL, undefined);
  for (const key of Object.keys(env)) assert.equal(website.env[key], undefined);
  assert.deepEqual(deploy.bindings(env), {
    env: {
      GQ_PREVIEW_CMS_URL: "https://cms.example.test",
      GQ_PREVIEW_AUDIENCE: "https://www.example.test/gq/preview",
      GQ_PREVIEW_CMS_USERNAME: { redacted: "site-preview" },
      GQ_PREVIEW_CMS_APPLICATION_PASSWORD: { redacted: "private-password" },
      GQ_PREVIEW_ACCESS_CLIENT_ID: { redacted: "dedicated-id" },
      GQ_PREVIEW_ACCESS_CLIENT_SECRET: { redacted: "dedicated-secret" },
    },
  });
  assert.deepEqual((await generatedDeploy()).bindings(), {});
});

test("managed deploy rejects malformed preview and partial secrets before Alchemy", async () => {
  const preview = {
    cmsUrl: "https://cms.example.test",
    audience: "https://www.example.test/gq/preview",
  };
  const deploy = await generatedDeploy({ ops: { preview } });
  const partial = deploy.scriptResult({ GQ_PREVIEW_ACCESS_CLIENT_SECRET: "do-not-disclose" });
  assert.equal(partial.status, 1);
  assert.equal(partial.stdout, "");
  assert.match(partial.stderr, /must be nonempty and set together/u);
  assert.doesNotMatch(partial.stderr, /do-not-disclose/u);
  const missing = deploy.scriptResult();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /GQ_PREVIEW_CMS_USERNAME/u);
  assert.equal(missing.stdout, "");
  for (const invalid of [null, false, 0, "", { cmsUrl: preview.cmsUrl }]) {
    await writeFile(join(deploy.root, "gq.ops.json"), JSON.stringify({ ...OPS, preview: invalid }));
    const result = deploy.scriptResult();
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /preview.cmsUrl/u);
  }
});

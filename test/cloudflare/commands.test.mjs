// The Cloudflare provisioning commands (`gq cloudflare deploy-token`,
// `releases`, `media` and `ci`) at the run() seam: a fixture site with
// content-site `cloudflare`, `releases`, `media`, `artifacts` and `ci`
// blocks, an in-memory Cloudflare account behind a recording fetch, and an
// in-memory Sigillo behind a recording exec. Nothing here reaches the network
// or a real secret store.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  accountPermissions,
  deployTokenSpec,
  zonePermissions,
} from "../../src/cloudflare/deploy-token.mjs";
import { bucketPolicies, planToken, tokenName } from "../../src/cloudflare/tokens.mjs";
import {
  createFixtureSite,
  json,
  recordingExec,
  recordingFetch,
} from "../support/fixture-site.mjs";

const SIGILLO = Object.freeze({
  apiUrl: "https://secrets.example.test",
  projectId: "PROJECT123",
  environments: { operations: "ops", staging: "stage" },
});

const OPS = Object.freeze({
  schemaVersion: 1,
  project: "fixture",
  variant: "content",
  sigillo: SIGILLO,
  cloudflare: { accountId: "account-1", zoneId: "zone-1", zoneName: "example.test" },
  releases: { bucket: "fixture-releases", prefix: "admin/" },
  media: { bucket: "fixture-media", domain: "media.example.test" },
  artifacts: { namespace: "fixture-ns", repo: "fixture-repo" },
  ci: { worker: "fixture-ci", backupBucket: "fixture-ci-backups" },
});

const ENV = Object.freeze({ CLOUDFLARE_TOKEN_MANAGER_API_TOKEN: "manager-secret" });
const SIGILLO_BIN = "node_modules/.bin/sigillo";

function site({ ops = OPS } = {}) {
  return createFixtureSite({
    ops,
    files: {
      "package.json": `${JSON.stringify({ devDependencies: { sigillo: "0.13.0" } })}\n`,
      [SIGILLO_BIN]: "#!/bin/sh\n",
    },
  });
}

const PERMISSION_GROUPS = [
  ...accountPermissions,
  ...zonePermissions,
  "Artifacts Read",
  "Artifacts Write",
  "Workers Containers Read",
  "Workers Containers Write",
  "Workers R2 Storage Read",
  "Workers R2 Storage Write",
  "Workers R2 Storage Bucket Item Read",
  "Workers R2 Storage Bucket Item Write",
].map((name, index) => ({ id: `group-${index}`, name }));

// An in-memory Cloudflare account: API tokens (by name), R2 buckets with
// custom domains, and Artifacts namespaces (as created: `{ namespace,
// jurisdiction? }`, unrestricted without one) and repositories. Every
// request's bearer token is recorded, so a test can tell the manager token
// from a temporary one.
function fakeCloudflare({
  tokens = [],
  buckets = [],
  domains = {},
  namespaces = [],
  repos = [],
} = {}) {
  const state = {
    tokens: tokens.map((token) => ({ status: "active", ...token })),
    buckets: [...buckets],
    domains: structuredClone(domains),
    repos: [...repos],
    namespaces: [...namespaces],
    deleted: [],
    created: [],
    updated: [],
  };
  let next = 1;
  const fetch = recordingFetch(({ method, url, body }) => {
    const { pathname, search } = new URL(url);
    const prefix = "/client/v4/accounts/account-1";
    assert.ok(pathname.startsWith(prefix), `outside the account: ${url}`);
    const path = `${pathname.slice(prefix.length)}${search}`;
    const data = body === undefined ? undefined : JSON.parse(body);
    const ok = (result) => ({ success: true, result });

    // Cloudflare lists tokens a page at a time: 20 unless asked, at most 50.
    const tokenPage = /^\/tokens\?(.*)$/u.exec(path);
    if (method === "GET" && tokenPage) {
      const query = new URLSearchParams(tokenPage[1]);
      const size = Math.min(Number(query.get("per_page") ?? 20), 50);
      const page = Number(query.get("page") ?? 1);
      return {
        success: true,
        result: state.tokens.slice((page - 1) * size, page * size),
        result_info: {
          page,
          per_page: size,
          total_count: state.tokens.length,
          total_pages: Math.ceil(state.tokens.length / size),
        },
      };
    }
    if (method === "GET" && path === "/tokens/permission_groups") return ok(PERMISSION_GROUPS);
    if (method === "POST" && path === "/tokens") {
      const token = { id: `token-${next}`, value: `value-${next}`, status: "active", ...data };
      next += 1;
      state.tokens.push(token);
      state.created.push(token);
      return ok(token);
    }
    const tokenValue = /^\/tokens\/([^/]+)\/value$/u.exec(path);
    if (method === "PUT" && tokenValue) return ok(`rolled-${tokenValue[1]}`);
    const tokenId = /^\/tokens\/([^/]+)$/u.exec(path);
    if (method === "PUT" && tokenId) {
      state.updated.push({ id: tokenId[1], ...data });
      return ok({ id: tokenId[1], ...data });
    }
    if (method === "DELETE" && tokenId) {
      state.deleted.push(tokenId[1]);
      state.tokens = state.tokens.filter((token) => token.id !== tokenId[1]);
      return ok({});
    }
    const listed = /^\/r2\/buckets\?name_contains=(.+)$/u.exec(path);
    if (method === "GET" && listed) {
      return ok({
        buckets: state.buckets.filter((name) => name.includes(listed[1])).map((name) => ({ name })),
      });
    }
    if (method === "POST" && path === "/r2/buckets") {
      state.buckets.push(data.name);
      return ok({});
    }
    const custom = /^\/r2\/buckets\/([^/]+)\/domains\/custom(?:\/(.+))?$/u.exec(path);
    if (custom) {
      const list = (state.domains[custom[1]] ??= []);
      if (method === "GET") return ok({ domains: list });
      if (method === "POST") {
        list.push({ domain: data.domain, enabled: data.enabled });
        return ok({});
      }
      if (method === "PUT") {
        list.find((entry) => entry.domain === custom[2]).enabled = data.enabled;
        return ok({});
      }
    }
    if (method === "GET" && path === "/workers/subdomain") return ok({ subdomain: "fixture-sub" });
    const repo = /^\/artifacts\/namespaces\/([^/]+)\/repos\/([^/]+)$/u.exec(path);
    if (method === "GET" && repo) {
      const found = state.repos.find((entry) => entry.name === repo[2]);
      return found ? ok(found) : new Response("{}", { status: 404 });
    }
    if (method === "GET" && path === "/artifacts/namespaces") {
      return ok(
        state.namespaces.map(({ namespace, jurisdiction = "unrestricted" }) => ({
          namespace,
          jurisdiction,
        })),
      );
    }
    if (method === "POST" && path === "/artifacts/namespaces") {
      state.namespaces.push(data);
      return ok({});
    }
    const repos = /^\/artifacts\/namespaces\/([^/]+)\/repos$/u.exec(path);
    if (method === "POST" && repos) {
      const created = {
        name: data.name,
        remote: `https://git.example.test/${repos[1]}/${data.name}.git`,
      };
      state.repos.push(created);
      return ok(created);
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  return { fetch, state };
}

// An in-memory Sigillo environment behind the site's CLI. `secrets` lists
// names; `set` reads the value from stdin; `get --raw` prints it.
function fakeSigillo(stored = {}) {
  const secrets = { ...stored };
  const exec = recordingExec(({ command, args, input }) => {
    assert.ok(command.endsWith(SIGILLO_BIN), `unexpected child: ${command}`);
    const environment = args[args.indexOf("--env") + 1];
    assert.equal(environment, "stage", "secrets go to the staging environment");
    if (args[0] === "secrets" && args[1] === "set") {
      assert.ok(!args.includes(input), "a value never goes in argv");
      secrets[args[2]] = input;
      return {};
    }
    if (args[0] === "secrets" && args[1] === "get") return { stdout: `${secrets[args[2]]}\n` };
    if (args[0] === "secrets") return { stdout: Object.keys(secrets).join("\n") };
    return { code: 1, stderr: `unexpected sigillo ${args.join(" ")}` };
  });
  return { exec, secrets };
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const bearer = (request) => request.headers.Authorization;

// --- naming and policies ----------------------------------------------------

test("names every token after the project", () => {
  assert.equal(tokenName("larkspur", "Staging Alchemy"), "GETQUICK LARKSPUR Staging Alchemy");
  assert.equal(tokenName("larkspur", "Media R2"), "GETQUICK LARKSPUR Media R2");
  assert.equal(tokenName("larkspur", "Releases R2"), "GETQUICK LARKSPUR Releases R2");
});

test("scopes the deploy token's zone permissions to the configured zone only", () => {
  const spec = deployTokenSpec({ project: "fixture", accountId: "acct", zoneId: "zone1" });
  const [account, zone] = spec.policies(PERMISSION_GROUPS);
  assert.deepEqual(account.resources, { "com.cloudflare.api.account.acct": "*" });
  assert.deepEqual(zone.resources, { "com.cloudflare.api.account.zone.zone1": "*" });
  assert.equal(account.permission_groups.length, accountPermissions.length);
  assert.equal(zone.permission_groups.length, zonePermissions.length);
});

test("fails on an unknown permission group", () => {
  const spec = deployTokenSpec({ project: "fixture", accountId: "a", zoneId: "z" });
  assert.throws(() => spec.policies(PERMISSION_GROUPS.slice(1)), /no permission group named/u);
});

test("only creates or rolls a token when something is missing", () => {
  assert.equal(planToken(undefined, false), "create");
  assert.equal(planToken({ status: "disabled" }, true), "create");
  assert.equal(planToken({ status: "active" }, true), "ok");
  assert.equal(planToken({ status: "active" }, false), "roll");
});

test("scopes a bucket token to object access on one bucket", () => {
  const groups = [
    { id: "r", name: "Workers R2 Storage Bucket Item Read" },
    { id: "w", name: "Workers R2 Storage Bucket Item Write" },
  ];
  const [policy] = bucketPolicies({ accountId: "acct", bucket: "larkspur-releases" }, groups);
  assert.deepEqual(policy.resources, {
    "com.cloudflare.edge.r2.bucket.acct_default_larkspur-releases": "*",
  });
  assert.deepEqual(policy.permission_groups, [{ id: "r" }, { id: "w" }]);
});

// --- gq cloudflare deploy-token ----------------------------------------------

test("cloudflare deploy-token creates the zone-scoped token and stores it in Sigillo staging", async () => {
  const fixture = await site();
  const { fetch, state } = fakeCloudflare();
  const { exec, secrets } = fakeSigillo();

  const result = await fixture.run(["cloudflare", "deploy-token"], { env: ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  const [created] = state.created;
  assert.equal(created.name, "GETQUICK FIXTURE Staging Alchemy");
  assert.deepEqual(Object.keys(created.policies[1].resources), [
    "com.cloudflare.api.account.zone.zone-1",
  ]);
  assert.equal(secrets.CLOUDFLARE_API_TOKEN, created.value);
  assert.ok(fetch.requests.every((request) => bearer(request) === "Bearer manager-secret"));
  assert.doesNotMatch(result.stdout, new RegExp(created.value, "u"), "the value is never printed");
});

test("cloudflare deploy-token changes nothing when the token and its value exist", async () => {
  const fixture = await site();
  const { fetch, state } = fakeCloudflare({
    tokens: [{ id: "t1", name: "GETQUICK FIXTURE Staging Alchemy" }],
  });
  const { exec } = fakeSigillo({ CLOUDFLARE_API_TOKEN: "stored" });

  const result = await fixture.run(["cloudflare", "deploy-token"], { env: ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Nothing to do\./u);
  assert.deepEqual(state.created, []);
  assert.ok(exec.calls.every(({ args }) => args[1] !== "set"));
});

test("cloudflare deploy-token finds its token on a later page instead of creating it again", async () => {
  const fixture = await site();
  const others = Array.from({ length: 60 }, (_, index) => ({
    id: `other-${index}`,
    name: `GETQUICK CLIENT${index} Staging Alchemy`,
  }));
  const { fetch, state } = fakeCloudflare({
    tokens: [...others, { id: "t1", name: "GETQUICK FIXTURE Staging Alchemy" }],
  });
  const { exec } = fakeSigillo({ CLOUDFLARE_API_TOKEN: "stored" });

  const result = await fixture.run(["cloudflare", "deploy-token"], { env: ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Nothing to do\./u);
  assert.deepEqual(state.created, [], "no duplicate token");
});

test("the deploy token can create and migrate the Frontend's D1 publication store", () => {
  assert.ok(accountPermissions.includes("D1 Read"));
  assert.ok(accountPermissions.includes("D1 Write"));
  const spec = deployTokenSpec({ project: "fixture", accountId: "acct", zoneId: "zone1" });
  assert.deepEqual(spec.permissions, [...accountPermissions, ...zonePermissions]);
});

test("cloudflare deploy-token adds the permissions an older token lacks, keeping its value", async () => {
  const fixture = await site();
  const granted = (names) =>
    PERMISSION_GROUPS.filter(({ name }) => names.includes(name)).map(({ id, name }) => ({
      id,
      name,
    }));
  const withoutD1 = accountPermissions.filter((name) => !name.startsWith("D1 "));
  const { fetch, state } = fakeCloudflare({
    tokens: [
      {
        id: "t1",
        name: "GETQUICK FIXTURE Staging Alchemy",
        policies: [
          { permission_groups: granted(withoutD1) },
          { permission_groups: granted(zonePermissions) },
        ],
      },
    ],
  });
  const { exec, secrets } = fakeSigillo({ CLOUDFLARE_API_TOKEN: "stored" });

  const dryRun = await fixture.run(["cloudflare", "deploy-token", "--dry-run"], {
    env: ENV,
    fetch,
    exec,
  });
  assert.equal(dryRun.code, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /~ add D1 Read, D1 Write to its permissions \(its value is kept\)/u);
  assert.deepEqual(state.updated, []);

  const result = await fixture.run(["cloudflare", "deploy-token"], { env: ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  const [update] = state.updated;
  assert.equal(update.id, "t1");
  assert.equal(update.name, "GETQUICK FIXTURE Staging Alchemy");
  assert.equal(update.status, "active");
  const names = update.policies[0].permission_groups.map(
    ({ id }) => PERMISSION_GROUPS.find((group) => group.id === id).name,
  );
  assert.deepEqual(names, accountPermissions);
  assert.equal(secrets.CLOUDFLARE_API_TOKEN, "stored", "the value is kept");
  assert.deepEqual(state.created, []);
  assert.ok(
    fetch.requests.every(({ url }) => !url.endsWith("/value")),
    "nothing is rolled",
  );
});

test("cloudflare deploy-token leaves a token with every permission alone", async () => {
  const fixture = await site();
  const { fetch, state } = fakeCloudflare({
    tokens: [
      {
        id: "t1",
        name: "GETQUICK FIXTURE Staging Alchemy",
        policies: [{ permission_groups: PERMISSION_GROUPS.map(({ id, name }) => ({ id, name })) }],
      },
    ],
  });
  const { exec } = fakeSigillo({ CLOUDFLARE_API_TOKEN: "stored" });

  const result = await fixture.run(["cloudflare", "deploy-token"], { env: ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Nothing to do\./u);
  assert.deepEqual(state.updated, []);
});

test("cloudflare deploy-token rolls a token whose value Sigillo lost", async () => {
  const fixture = await site();
  const { fetch } = fakeCloudflare({
    tokens: [{ id: "t1", name: "GETQUICK FIXTURE Staging Alchemy" }],
  });
  const { exec, secrets } = fakeSigillo();

  const result = await fixture.run(["cloudflare", "deploy-token"], { env: ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(secrets.CLOUDFLARE_API_TOKEN, "rolled-t1");
});

test("cloudflare deploy-token --dry-run only reports the plan", async () => {
  const fixture = await site();
  const { fetch, state } = fakeCloudflare();
  const { exec, secrets } = fakeSigillo();

  const result = await fixture.run(["cloudflare", "deploy-token", "--dry-run"], {
    env: ENV,
    fetch,
    exec,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\+ create token, store it in Sigillo stage/u);
  assert.match(result.stdout, /Dry run: nothing changed\./u);
  assert.deepEqual(state.created, []);
  assert.deepEqual(secrets, {});
  assert.ok(fetch.requests.every(({ method }) => method === "GET"));
});

test("cloudflare deploy-token names the missing zone ID", async () => {
  const fixture = await site({
    ops: { ...OPS, cloudflare: { accountId: "account-1", zoneName: "example.test" } },
  });

  const result = await fixture.run(["cloudflare", "deploy-token"], { env: ENV });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /cloudflare\.zoneId is required: copy the example\.test Zone ID/u);
});

test("the Cloudflare commands need the token-manager token", async () => {
  const fixture = await site();
  for (const command of ["deploy-token", "releases", "media", "ci"]) {
    const result = await fixture.run(["cloudflare", command]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /CLOUDFLARE_TOKEN_MANAGER_API_TOKEN is missing/u, command);
  }
});

// --- gq cloudflare releases --------------------------------------------------

test("cloudflare releases creates the bucket with a temporary token, then stores the scoped key", async () => {
  const fixture = await site();
  const { fetch, state } = fakeCloudflare();
  const { exec, secrets } = fakeSigillo();

  const result = await fixture.run(["cloudflare", "releases"], { env: ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(state.buckets, ["fixture-releases"]);
  const [temporary, scoped] = state.created;
  assert.equal(temporary.name, "GETQUICK FIXTURE releases bucket setup (temporary)");
  assert.ok(temporary.expires_on, "the setup token expires");
  assert.deepEqual(state.deleted, [temporary.id], "the setup token is deleted");
  const bucketCreate = fetch.requests.find(
    ({ method, url }) => method === "POST" && url.endsWith("/r2/buckets"),
  );
  assert.equal(bearer(bucketCreate), `Bearer ${temporary.value}`);

  assert.equal(scoped.name, "GETQUICK FIXTURE Releases R2");
  assert.deepEqual(Object.keys(scoped.policies[0].resources), [
    "com.cloudflare.edge.r2.bucket.account-1_default_fixture-releases",
  ]);
  // R2's S3 credentials derive from the token: ID and SHA-256 of the value.
  assert.equal(secrets.R2_ACCESS_KEY_ID, scoped.id);
  assert.equal(secrets.R2_SECRET_ACCESS_KEY, sha256(scoped.value));
});

test("cloudflare releases keeps an existing bucket and token", async () => {
  const fixture = await site();
  const { fetch, state } = fakeCloudflare({
    buckets: ["fixture-releases"],
    tokens: [{ id: "t1", name: "GETQUICK FIXTURE Releases R2" }],
  });
  const { exec } = fakeSigillo({ R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s" });

  const result = await fixture.run(["cloudflare", "releases"], { env: ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Bucket fixture-releases exists; credentials in Sigillo stage/u);
  assert.deepEqual(
    state.created.map(({ name }) => name),
    ["GETQUICK FIXTURE releases bucket setup (temporary)"],
  );
  assert.ok(exec.calls.every(({ args }) => args[1] !== "set"));
});

// --- gq cloudflare media -----------------------------------------------------

test("cloudflare media creates the bucket, attaches its domain and stores S3_UPLOADS_*", async () => {
  const fixture = await site();
  const { fetch, state } = fakeCloudflare();
  const { exec, secrets } = fakeSigillo();

  const result = await fixture.run(["cloudflare", "media"], { env: ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(state.buckets, ["fixture-media"]);
  assert.deepEqual(state.domains["fixture-media"], [
    { domain: "media.example.test", enabled: true },
  ]);
  const [temporary, scoped] = state.created;
  assert.equal(temporary.name, "GETQUICK FIXTURE media bucket setup (temporary)");
  assert.deepEqual(Object.keys(temporary.policies[1].resources), [
    "com.cloudflare.api.account.zone.zone-1",
  ]);
  assert.deepEqual(state.deleted, [temporary.id]);
  assert.equal(scoped.name, "GETQUICK FIXTURE Media R2");
  assert.equal(secrets.S3_UPLOADS_KEY, scoped.id);
  assert.equal(secrets.S3_UPLOADS_SECRET, sha256(scoped.value));
  assert.match(result.stdout, /https:\/\/media\.example\.test attached/u);
});

test("cloudflare media re-enables a disabled custom domain", async () => {
  const fixture = await site();
  const { fetch, state } = fakeCloudflare({
    buckets: ["fixture-media"],
    domains: { "fixture-media": [{ domain: "media.example.test", enabled: false }] },
    tokens: [{ id: "t1", name: "GETQUICK FIXTURE Media R2" }],
  });
  const { exec } = fakeSigillo({ S3_UPLOADS_KEY: "k", S3_UPLOADS_SECRET: "s" });

  const result = await fixture.run(["cloudflare", "media"], { env: ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(state.domains["fixture-media"][0].enabled, true);
  assert.match(
    result.stdout,
    /Bucket fixture-media exists; https:\/\/media\.example\.test enabled/u,
  );
});

// --- gq cloudflare ci --------------------------------------------------------

test("cloudflare ci creates the CI tokens, the backup bucket and the Artifacts repository", async () => {
  const fixture = await site();
  const { fetch, state } = fakeCloudflare();
  const { exec, secrets } = fakeSigillo();

  const result = await fixture.run(["cloudflare", "ci"], { env: ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(state.buckets, ["fixture-ci-backups"]);
  const byName = Object.fromEntries(state.created.map((token) => [token.name, token]));
  const artifacts = byName["GETQUICK FIXTURE Artifacts"];
  const backups = byName["GETQUICK FIXTURE CI Backups R2"];
  const deploy = byName["GETQUICK FIXTURE CI Deploy"];
  assert.ok(artifacts && backups && deploy, Object.keys(byName).join(", "));
  assert.equal(secrets.ARTIFACTS_API_TOKEN, artifacts.value);
  assert.equal(secrets.CI_BACKUP_R2_ACCESS_KEY_ID, backups.id);
  assert.equal(secrets.CI_BACKUP_R2_SECRET_ACCESS_KEY, sha256(backups.value));
  assert.equal(secrets.CI_DEPLOY_API_TOKEN, deploy.value);
  // In the EU unless the Site says otherwise.
  assert.deepEqual(state.namespaces, [{ namespace: "fixture-ns", jurisdiction: "eu" }]);
  assert.deepEqual(
    state.repos.map(({ name }) => name),
    ["fixture-repo"],
  );
  // The repository is created with the new Artifacts token.
  const repoCreate = fetch.requests.find(
    ({ method, url }) => method === "POST" && url.endsWith("/repos"),
  );
  assert.equal(bearer(repoCreate), `Bearer ${artifacts.value}`);
  assert.match(
    result.stdout,
    /remote https:\/\/git\.example\.test\/fixture-ns\/fixture-repo\.git/u,
  );
});

test("cloudflare ci reads the stored Artifacts token when it creates nothing", async () => {
  const fixture = await site();
  const { fetch, state } = fakeCloudflare({
    buckets: ["fixture-ci-backups"],
    namespaces: [{ namespace: "fixture-ns", jurisdiction: "eu" }],
    repos: [{ name: "fixture-repo", remote: "https://git.example.test/existing.git" }],
    tokens: [
      { id: "a", name: "GETQUICK FIXTURE Artifacts" },
      { id: "b", name: "GETQUICK FIXTURE CI Backups R2" },
      { id: "c", name: "GETQUICK FIXTURE CI Deploy" },
    ],
  });
  const { exec } = fakeSigillo({
    ARTIFACTS_API_TOKEN: "stored-artifacts",
    CI_BACKUP_R2_ACCESS_KEY_ID: "k",
    CI_BACKUP_R2_SECRET_ACCESS_KEY: "s",
    CI_DEPLOY_API_TOKEN: "d",
  });

  const result = await fixture.run(["cloudflare", "ci"], { env: ENV, fetch, exec });

  assert.equal(result.code, 0, result.stderr);
  assert.ok(
    exec.calls.some(({ args }) => args.join(" ").startsWith("secrets get ARTIFACTS_API_TOKEN")),
  );
  const repoRead = fetch.requests.find(({ url }) => url.includes("/artifacts/"));
  assert.equal(bearer(repoRead), "Bearer stored-artifacts");
  assert.ok(state.created.every(({ name }) => name.endsWith("(temporary)")));
});

test("cloudflare ci creates the namespace in the jurisdiction gq.ops.json names", async () => {
  for (const [jurisdiction, created] of [
    ["us", { namespace: "fixture-ns", jurisdiction: "us" }],
    // The API takes no jurisdiction for an unrestricted namespace.
    ["unrestricted", { namespace: "fixture-ns" }],
  ]) {
    const fixture = await site({
      ops: { ...OPS, artifacts: { ...OPS.artifacts, jurisdiction } },
    });
    const { fetch, state } = fakeCloudflare();
    const { exec } = fakeSigillo();

    const result = await fixture.run(["cloudflare", "ci"], { env: ENV, fetch, exec });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(state.namespaces, [created]);
  }
});

test("cloudflare ci stops at a namespace in another jurisdiction, creating no repository", async () => {
  const fixture = await site();
  const { fetch, state } = fakeCloudflare({ namespaces: [{ namespace: "fixture-ns" }] });
  const { exec } = fakeSigillo();

  const result = await fixture.run(["cloudflare", "ci"], { env: ENV, fetch, exec });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /Artifacts namespace fixture-ns is unrestricted, but gq\.ops\.json artifacts\.jurisdiction is eu/u,
  );
  assert.match(result.stderr, /set artifacts\.jurisdiction to "unrestricted"/u);
  assert.match(result.stderr, /DELETE \/accounts\/account-1\/artifacts\/namespaces\/fixture-ns/u);
  assert.deepEqual(state.namespaces, [{ namespace: "fixture-ns" }]);
  assert.deepEqual(state.repos, []);
  assert.ok(
    !fetch.requests.some(({ method, url }) => method === "POST" && url.includes("/artifacts/")),
  );
});

test("cloudflare ci checks an existing namespace's jurisdiction before it changes anything", async () => {
  const provisioned = {
    buckets: [],
    namespaces: [{ namespace: "fixture-ns", jurisdiction: "us" }],
    tokens: [
      { id: "a", name: "GETQUICK FIXTURE Artifacts" },
      { id: "b", name: "GETQUICK FIXTURE CI Backups R2" },
      { id: "c", name: "GETQUICK FIXTURE CI Deploy" },
    ],
  };
  const stored = {
    ARTIFACTS_API_TOKEN: "stored-artifacts",
    CI_BACKUP_R2_ACCESS_KEY_ID: "k",
    CI_BACKUP_R2_SECRET_ACCESS_KEY: "s",
    CI_DEPLOY_API_TOKEN: "d",
  };
  for (const argv of [
    ["cloudflare", "ci"],
    ["cloudflare", "ci", "--dry-run"],
  ]) {
    const fixture = await site();
    const { fetch, state } = fakeCloudflare(provisioned);
    const { exec } = fakeSigillo(stored);

    const result = await fixture.run(argv, { env: ENV, fetch, exec });

    assert.equal(result.code, 1, argv.join(" "));
    assert.match(result.stderr, /Artifacts namespace fixture-ns is us, but .+ is eu/u);
    assert.deepEqual(state.buckets, []);
    assert.deepEqual(state.created, []);
    assert.ok(!fetch.requests.some(({ method }) => method !== "GET"), argv.join(" "));
  }
});

test("cloudflare ci names the gq.ops.json keys it needs", async () => {
  const fixture = await site({ ops: { ...OPS, ci: undefined } });

  const result = await fixture.run(["cloudflare", "ci"], { env: ENV });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /gq\.ops\.json needs cloudflare\.accountId, artifacts\.namespace\/repo and ci\.backupBucket/u,
  );
});

test("a Cloudflare error without messages still names the HTTP status", async () => {
  const fixture = await site();
  const fetch = recordingFetch(() => json({ success: false, errors: [] }, 503));
  const { exec } = fakeSigillo();

  const result = await fixture.run(["cloudflare", "deploy-token"], { env: ENV, fetch, exec });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Cloudflare GET \/tokens\?per_page=50&page=1 failed: 503/u);
});

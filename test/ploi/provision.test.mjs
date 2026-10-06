// Unit tests of the provisioning plan and its actions against an in-memory Ploi.
// The command itself is covered at the run() seam in ploi-workflows.test.mjs.
import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAction,
  deploy,
  inspect,
  isEnvReady,
  planActions,
  renderEnv,
  syncDeployScript,
} from "../../src/ploi/provision.mjs";

const template = [
  "DB_NAME='larkspur'",
  "DB_USER='larkspur_user'",
  "DB_PASSWORD='replace-with-a-strong-password'",
  "WP_HOME='https://larkspur-admin.bnq.pt'",
  "AUTH_KEY='replace-me'",
  "NONCE_SALT='replace-me'",
].join("\n");

const config = {
  root: "/nonexistent",
  project: "larkspur",
  domain: "larkspur-admin.bnq.pt",
  frontendDomain: "larkspur-fe.bnq.pt",
  serverId: "1",
  siteId: "10",
  systemUser: "larkspur",
  projectRoot: "/",
  webDirectory: "/apps/cms/web",
  database: "larkspur_staging",
  deployScriptPath: "deploy/ploi/admin.sh",
  deployScript: "#!/usr/bin/env bash\necho deploy\n",
  envTemplate: template,
};

const domains = { adminDomain: "larkspur-admin.bnq.pt", frontendDomain: "larkspur-fe.bnq.pt" };
const readyEnv = renderEnv(template, { database: "larkspur_staging", password: "pw", ...domains });

// In-memory Ploi: GET/list read the fixture, everything else is recorded.
function fakeClient(fixture) {
  const writes = [];
  return {
    writes,
    async list(path) {
      return fixture.lists[path] ?? [];
    },
    async request(method, path, body) {
      if (method !== "GET") {
        writes.push({ method, path, body });
        return fixture.responses?.[`${method} ${path}`] ?? { data: {} };
      }
      return fixture.gets[path] ?? {};
    },
  };
}

function provisionedFixture() {
  const site = {
    id: 10,
    domain: config.domain,
    status: "active",
    system_user: "larkspur",
    web_directory: "/apps/cms/web",
    project_root: "/",
  };
  return {
    lists: {
      "/system-users": [{ name: "larkspur" }],
      "/sites": [site],
      "/databases": [{ id: 5, name: "larkspur_staging" }],
      "/sites/10/certificates": [{ type: "letsencrypt", status: "active" }],
    },
    gets: {
      "": { data: { ip_address: "203.0.113.7" } },
      "/sites/10": { data: site },
      "/sites/10/repository": {
        data: { repository: { provider: "none" } },
      },
      "/sites/10/env": { data: readyEnv },
      "/sites/10/deploy/script": { deploy_script: config.deployScript },
    },
  };
}

const resolvesToServer = async () => [{ address: "203.0.113.7" }];
const doesNotResolve = async () => {
  throw new Error("ENOTFOUND");
};

test("renders the .env with the database, password and unique salts", () => {
  let counter = 0;
  const env = renderEnv(
    `${template}\nGRAPHQL_CORS_ORIGINS='https://old.example'\nGETQUICK_FRONTEND_URL='https://old.example'`,
    {
      database: "larkspur_staging",
      password: "generated",
      adminDomain: "admin.example.test",
      frontendDomain: "fe.example.test",
      secret: () => `salt-${(counter += 1)}`,
    },
  );
  assert.match(env, /^WP_HOME='https:\/\/admin\.example\.test'$/mu);
  assert.match(env, /^GRAPHQL_CORS_ORIGINS='https:\/\/fe\.example\.test'$/mu);
  assert.match(env, /^GETQUICK_FRONTEND_URL='https:\/\/fe\.example\.test'$/mu);
  assert.match(env, /^DB_NAME='larkspur_staging'$/mu);
  assert.match(env, /^DB_USER='larkspur_staging'$/mu);
  assert.match(env, /^DB_PASSWORD='generated'$/mu);
  assert.match(env, /^AUTH_KEY='salt-1'$/mu);
  assert.match(env, /^NONCE_SALT='salt-2'$/mu);
  assert.ok(isEnvReady(env, "larkspur_staging"));
  assert.ok(!isEnvReady(template, "larkspur_staging"));
});

test("a fully provisioned site plans no changes and makes no writes", async () => {
  const client = fakeClient(provisionedFixture());
  const state = await inspect(client, config, resolvesToServer);
  const plan = planActions(config, state);

  assert.deepEqual(
    plan.filter((item) => item.kind !== "ok"),
    [],
  );
  assert.deepEqual(client.writes, []);
});

test("an empty server plans every resource, in dependency order", async () => {
  const client = fakeClient({
    lists: {},
    gets: { "": { data: { ip_address: "203.0.113.7" } } },
  });
  const state = await inspect(client, config, doesNotResolve);
  const plan = planActions(config, state);

  assert.deepEqual(
    plan.map((item) => `${item.kind}:${item.id}`),
    [
      "create:system-user",
      "create:site",
      "create:deployments",
      "create:database",
      "update:deploy-script",
      "warn:certificate",
    ],
  );
});

test("never recreates an existing database whose password is unknown", async () => {
  const fixture = provisionedFixture();
  fixture.gets["/sites/10/env"] = { data: template };
  const state = await inspect(fakeClient(fixture), config, resolvesToServer);
  const plan = planActions(config, state);

  assert.equal(
    plan.find((item) => item.id === "database"),
    undefined,
  );
  assert.equal(plan.find((item) => item.id === "database-credentials").kind, "update");
});

test("reports drift without touching the site's system user", async () => {
  const fixture = provisionedFixture();
  const site = { ...fixture.gets["/sites/10"].data, system_user: "ploi", web_directory: "/web" };
  fixture.gets["/sites/10"] = { data: site };
  const state = await inspect(fakeClient(fixture), config, resolvesToServer);
  const plan = planActions(config, state);

  assert.equal(plan.find((item) => item.id === "site-user").kind, "warn");
  assert.equal(plan.find((item) => item.id === "site-paths").kind, "update");
});

test("writes the .env before creating the database, with matching credentials", async () => {
  const client = fakeClient({ lists: {}, gets: {} });
  const state = { site: { id: 10 } };
  await applyAction({ id: "database" }, { client, config, state });

  assert.deepEqual(
    client.writes.map((write) => `${write.method} ${write.path}`),
    ["PATCH /sites/10/env", "POST /databases"],
  );
  const [envWrite, databaseWrite] = client.writes;
  assert.ok(envWrite.body.content.includes(`DB_PASSWORD='${databaseWrite.body.password}'`));
  assert.equal(databaseWrite.body.name, "larkspur_staging");
  assert.equal(databaseWrite.body.site_id, 10);
});

test("waits for the new deploy log and reads its status marker", async () => {
  let polls = 0;
  const client = {
    async request(method, path) {
      if (method === "POST") return {};
      if (path.startsWith("/sites/10/log?")) {
        polls += 1;
        return { data: polls > 2 ? [{ id: 9, type: "deploy" }, { id: 3 }] : [{ id: 3 }] };
      }
      if (path === "/sites/10/log/9") {
        return { data: { content: "composer install\nLARKSPUR_DEPLOY_STATUS=success SHA=abc" } };
      }
      return {};
    },
  };

  const result = await deploy(client, 10, { project: "larkspur", pollMs: 1, timeoutMs: 1000 });
  assert.equal(result.status, "success");
  assert.equal(result.sha, "abc");
});

test("plans the switch from a git repository to custom deployments", async () => {
  const fixture = provisionedFixture();
  fixture.gets["/sites/10/repository"] = {
    data: {
      repository: { user: "Quick-Release", name: "larkspur", branch: "main", provider: "github" },
    },
  };
  const state = await inspect(fakeClient(fixture), config, resolvesToServer);
  const deployments = planActions(config, state).find((item) => item.id === "deployments");
  assert.equal(deployments.kind, "update");
  assert.match(deployments.title, /Quick-Release\/larkspur/u);
});

function repositoryClient({ env, failCustom = false }) {
  const state = { env, repository: { provider: "github" }, writes: [] };
  state.client = {
    async request(method, path, body) {
      state.writes.push(`${method} ${path}`);
      if (method === "GET" && path === "/sites/10/env") return { data: state.env };
      if (method === "GET" && path === "/sites/10/repository")
        return { data: { repository: state.repository } };
      if (method === "DELETE") {
        state.env = "";
        state.repository = null;
      }
      if (method === "POST" && failCustom) throw new Error("422");
      if (method === "PATCH") state.env = body.content;
      return {};
    },
  };
  return state;
}

test("switching to custom deployments waits for removal and restores the .env", async () => {
  const ploi = repositoryClient({ env: "DB_NAME='larkspur_staging'" });
  const state = { site: { id: 10 }, repository: { provider: "github" } };
  await applyAction({ id: "deployments" }, { client: ploi.client, config, state, pollMs: 1 });

  assert.deepEqual(ploi.writes, [
    "GET /sites/10/env",
    "DELETE /sites/10/repository",
    "GET /sites/10/repository",
    "POST /sites/10/repository/custom-deployments",
    "GET /sites/10/env",
    "PATCH /sites/10/env",
  ]);
  assert.equal(ploi.env, "DB_NAME='larkspur_staging'");
  assert.deepEqual(state.repository, { provider: "none" });
});

test("restores the .env even when enabling custom deployments fails", async () => {
  const ploi = repositoryClient({ env: "DB_NAME='larkspur_staging'", failCustom: true });
  const state = { site: { id: 10 }, repository: { provider: "github" } };
  await assert.rejects(
    applyAction({ id: "deployments" }, { client: ploi.client, config, state, pollMs: 1 }),
    /422/u,
  );
  assert.equal(ploi.env, "DB_NAME='larkspur_staging'");
});

test("recreates the database user with the password written to the .env", async () => {
  let users = [{ id: 7, user: "larkspur_staging" }];
  const writes = [];
  const client = {
    async request(method, path, body) {
      writes.push({ method, path, body });
      if (method === "GET") return { data: users };
      if (method === "DELETE") users = [];
      return {};
    },
  };
  const state = { site: { id: 10 }, database: { id: 5 } };
  await applyAction({ id: "database-credentials" }, { client, config, state, pollMs: 1 });

  const envWrite = writes.find((write) => write.method === "PATCH");
  const created = writes.find((write) => write.method === "POST");
  assert.equal(envWrite.path, "/sites/10/env");
  assert.ok(
    writes.some((write) => write.method === "DELETE" && write.path === "/databases/5/users/7"),
  );
  assert.equal(created.path, "/databases/5/users");
  assert.equal(created.body.user, "larkspur_staging");
  assert.ok(envWrite.body.content.includes(`DB_PASSWORD='${created.body.password}'`));
  assert.ok(writes.indexOf(envWrite) < writes.indexOf(created));
});

test("leaves a matching Ploi deploy script alone", async () => {
  const client = fakeClient(provisionedFixture());
  assert.equal(await syncDeployScript(client, "10", `${config.deployScript}\n`), false);
  assert.deepEqual(client.writes, []);
});

test("replaces a stale Ploi deploy script before deploying", async () => {
  const fixture = provisionedFixture();
  fixture.gets["/sites/10/deploy/script"] = { deploy_script: "#!/usr/bin/env bash\necho old\n" };
  const client = fakeClient(fixture);
  assert.equal(await syncDeployScript(client, "10", config.deployScript), true);
  assert.deepEqual(client.writes, [
    {
      method: "PATCH",
      path: "/sites/10/deploy/script",
      body: { deploy_script: config.deployScript },
    },
  ]);
});

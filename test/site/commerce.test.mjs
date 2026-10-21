// The commands on a commerce Site (ADR 0017), at the run() seam and the
// provisioning plan: what is content-only refuses by name, gq frontend
// secrets generates the storefront Runtime's secrets, gq ci deploy forwards
// them, and gq ploi provision gives the CMS the proxy secret. Nothing here
// reaches the network or a real secret store.
import assert from "node:assert/strict";
import test from "node:test";

import { secretsPayload } from "../../src/ci/deploy.mjs";
import { applyAction, planActions, renderEnv } from "../../src/ploi/provision.mjs";
import { createFixtureSite, FIXTURE_OPS, recordingExec } from "../support/fixture-site.mjs";

const OPS = Object.freeze({
  ...FIXTURE_OPS,
  variant: "commerce",
  sigillo: {
    apiUrl: "https://secrets.example.test",
    projectId: "PROJECT123",
    environments: { operations: "ops", staging: "stage" },
  },
  domains: { admin: "shop-cms.example.test", frontend: "shop.example.test" },
});

const SIGILLO_BIN = "node_modules/.bin/sigillo";

function site() {
  return createFixtureSite({
    ops: OPS,
    files: {
      "package.json": `${JSON.stringify({ devDependencies: { sigillo: "0.13.0" } })}\n`,
      [SIGILLO_BIN]: "#!/bin/sh\n",
    },
  });
}

test("content-only commands refuse a commerce Site and say why", async () => {
  const fixture = await site();
  for (const [argv, message] of [
    [
      ["site", "check"],
      /gq site check isn't for a commerce Site: commerce readiness isn't defined yet \(https:\/\/github\.com\/Quick-Release\/gq-site\/issues\/26\)/u,
    ],
    [
      ["frontend", "refresh"],
      /gq frontend refresh isn't for a commerce Site: its storefront has no publication store/u,
    ],
    [["frontend", "events", "check"], /gq frontend events check isn't for a commerce Site/u],
    [["ploi", "events"], /gq ploi events isn't for a commerce Site: it has no publication events/u],
  ]) {
    const exec = recordingExec();
    const result = await fixture.run(argv, { exec, fetch: unexpectedFetch });
    assert.equal(result.code, 1, argv.join(" "));
    assert.match(result.stderr, message, argv.join(" "));
    assert.deepEqual(exec.calls, [], argv.join(" "));
  }
});

async function unexpectedFetch(url) {
  throw new Error(`unexpected request to ${url}`);
}

// Sigillo staging: lists names, stores what it is given over stdin.
function fakeSigillo(stored = {}) {
  const secrets = { ...stored };
  const exec = recordingExec(({ command, args, input }) => {
    assert.ok(command.endsWith(SIGILLO_BIN), `unexpected child: ${command}`);
    assert.equal(args[args.indexOf("--env") + 1], "stage", "secrets go to staging");
    if (args[0] === "secrets" && args[1] === "set") {
      assert.ok(!args.includes(input), "a value never goes in argv");
      secrets[args[2]] = input;
      return {};
    }
    if (args[0] === "secrets") return { stdout: Object.keys(secrets).join("\n") };
    return { code: 1, stderr: `unexpected sigillo ${args.join(" ")}` };
  });
  return { exec, secrets };
}

test("frontend secrets generates the storefront Runtime's secrets on a commerce Site", async () => {
  const fixture = await site();
  const { exec, secrets } = fakeSigillo({ CLOUDFLARE_API_TOKEN: "deploy" });

  const result = await fixture.run(["frontend", "secrets"], { exec });

  assert.equal(result.code, 0, result.stderr);
  assert.match(secrets.GETQUICK_STOREFRONT_PROXY_SECRET, /^[0-9a-f]{64}$/u);
  // A keyring is a base64url key of at least 32 bytes.
  for (const name of ["GETQUICK_AUTH_COOKIE_SECRET", "GETQUICK_CART_SESSION_SECRET"]) {
    assert.match(secrets[name], /^[A-Za-z0-9_-]{43}$/u, name);
    assert.ok(Buffer.from(secrets[name], "base64url").length >= 32, name);
  }
  assert.notEqual(secrets.GETQUICK_AUTH_COOKIE_SECRET, secrets.GETQUICK_CART_SESSION_SECRET);
  assert.equal(secrets.FRONTEND_REFRESH_TOKEN, undefined);
  assert.equal(secrets.PUBLICATION_EVENT_SECRET, undefined);
  for (const name of [
    "GETQUICK_STOREFRONT_PROXY_SECRET",
    "GETQUICK_AUTH_COOKIE_SECRET",
    "GETQUICK_CART_SESSION_SECRET",
  ]) {
    assert.ok(!result.stdout.includes(secrets[name]), "a value is never printed");
  }
  assert.match(result.stdout, /pnpm ploi:provision gives the CMS the proxy secret/u);
  assert.doesNotMatch(result.stdout, /ploi:events/u);
});

test("ci deploy forwards the storefront secrets and the packages token when the store has them", () => {
  const environment = {
    CLOUDFLARE_API_TOKEN: "cf",
    CI_BACKUP_R2_ACCESS_KEY_ID: "a",
    CI_BACKUP_R2_SECRET_ACCESS_KEY: "b",
    PLOI_API_TOKEN: "p",
    R2_ACCESS_KEY_ID: "c",
    R2_SECRET_ACCESS_KEY: "d",
    COMPOSER_AUTH: "{}",
  };
  const content = JSON.parse(secretsPayload(environment, { github: false }));
  assert.equal(content.GETQUICK_STOREFRONT_PROXY_SECRET, undefined);

  const commerce = JSON.parse(
    secretsPayload(
      {
        ...environment,
        GETQUICK_STOREFRONT_PROXY_SECRET: "proxy",
        GETQUICK_AUTH_COOKIE_SECRET: "cookie",
        GETQUICK_CART_SESSION_SECRET: "cart",
        GITHUB_PACKAGES_TOKEN: "packages",
      },
      { github: false },
    ),
  );
  assert.equal(commerce.GETQUICK_STOREFRONT_PROXY_SECRET, "proxy");
  assert.equal(commerce.GETQUICK_AUTH_COOKIE_SECRET, "cookie");
  assert.equal(commerce.GETQUICK_CART_SESSION_SECRET, "cart");
  assert.equal(commerce.GITHUB_PACKAGES_TOKEN, "packages");
  assert.equal(commerce.TURNSTILE_SECRET, undefined);
});

const template = [
  "DB_NAME='shop'",
  "DB_USER='shop'",
  "DB_PASSWORD='replace-with-a-strong-password'",
  "WP_HOME='https://shop-cms.example.test'",
  "GETQUICK_STOREFRONT_PROXY_SECRET=''",
  "AUTH_KEY='replace-me'",
].join("\n");

const config = {
  project: "shop",
  domain: "shop-cms.example.test",
  frontendDomain: "shop.example.test",
  serverId: "1",
  siteId: "10",
  systemUser: "shop",
  projectRoot: "/",
  webDirectory: "/apps/cms/web",
  database: "shop",
  deployScriptPath: "deploy/ploi/admin.sh",
  deployScript: "#!/usr/bin/env bash\n",
  envTemplate: template,
};

function provisioned(env) {
  return {
    serverIp: "203.0.113.7",
    systemUser: { name: "shop" },
    site: {
      id: 10,
      domain: config.domain,
      system_user: "shop",
      web_directory: "/apps/cms/web",
      project_root: "/",
    },
    database: { id: 5, name: "shop" },
    repository: { provider: "none" },
    env,
    envReady: true,
    deployScript: config.deployScript,
    certificate: { type: "letsencrypt", status: "active" },
    dnsAddresses: ["203.0.113.7"],
  };
}

const readyEnv = renderEnv(template, {
  database: "shop",
  password: "pw",
  adminDomain: config.domain,
  frontendDomain: config.frontendDomain,
});
const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";

const proxyStep = (plan) => plan.find(({ id }) => id === "storefront-proxy-secret");

test("ploi provision gives a commerce CMS the storefront's proxy secret, never showing it", async () => {
  const plan = planActions({ ...config, storefrontProxySecret: SECRET }, provisioned(readyEnv));
  const step = proxyStep(plan);
  assert.equal(step.kind, "update");
  assert.doesNotMatch(step.title, new RegExp(SECRET, "u"));

  const writes = [];
  const client = {
    async request(method, path, body) {
      if (method === "GET") return { data: readyEnv };
      writes.push({ method, path, body });
      return { data: {} };
    },
  };
  await applyAction(step, {
    client,
    config: { ...config, storefrontProxySecret: SECRET },
    state: provisioned(readyEnv),
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "/sites/10/env");
  assert.match(
    writes[0].body.content,
    new RegExp(`^GETQUICK_STOREFRONT_PROXY_SECRET='${SECRET}'$`, "mu"),
  );
  assert.match(writes[0].body.content, /^DB_PASSWORD='pw'$/mu);

  const applied = planActions(
    { ...config, storefrontProxySecret: SECRET },
    provisioned(writes[0].body.content),
  );
  assert.equal(proxyStep(applied).kind, "ok");
});

test("ploi provision warns when the proxy secret isn't in the store, and a content Site has no such step", () => {
  const missing = proxyStep(
    planActions({ ...config, storefrontProxySecret: "" }, provisioned(readyEnv)),
  );
  assert.equal(missing.kind, "warn");
  assert.match(missing.title, /run pnpm frontend:secrets/u);

  const short = proxyStep(
    planActions({ ...config, storefrontProxySecret: "short" }, provisioned(readyEnv)),
  );
  assert.equal(short.kind, "warn");

  assert.equal(proxyStep(planActions(config, provisioned(readyEnv))), undefined);
});

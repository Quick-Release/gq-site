// `gq cloudflare custom-hostname` and its `status` at the run() seam: a
// fixture Site whose production Frontend is a Cloudflare for SaaS custom
// hostname (domains.frontendTarget), an in-memory zone with its custom
// hostnames, fallback origin and Worker routes behind a recording fetch, and
// the client's DNS behind a fake DNS over HTTPS. Nothing reaches the network.
import assert from "node:assert/strict";
import test from "node:test";

import { manifestSchema } from "../../src/manifest/schema.mjs";
import { createFixtureSite, json, recordingFetch } from "../support/fixture-site.mjs";

const OPS = Object.freeze({
  schemaVersion: 1,
  project: "fixture",
  variant: "content",
  domains: {
    admin: "cms.example.test",
    frontend: "www.client.example",
    frontendTarget: "fixture.example.test",
  },
  cloudflare: { accountId: "account-1", zoneId: "zone-1", zoneName: "example.test" },
});
const ENV = Object.freeze({ CLOUDFLARE_TOKEN_MANAGER_API_TOKEN: "manager-secret" });

const PERMISSION_GROUPS = [
  "Zone Read",
  "SSL and Certificates Read",
  "SSL and Certificates Write",
  "Workers Routes Read",
].map((name, index) => ({ id: `group-${index}`, name }));

// The zone's own fallback origin, which serves no Site.
const FALLBACK = Object.freeze({ origin: "saas-fallback.example.test", status: "active" });

const OWNERSHIP = {
  type: "txt",
  name: "_cf-custom-hostname.www.client.example",
  value: "ownership-token",
};

// The account's tokens and one zone's Cloudflare for SaaS state. `saas:
// false` is a zone where Cloudflare for SaaS isn't enabled. `dns` maps
// "<name> <type>" to the answers' data.
function fakeCloudflare({
  saas = true,
  fallback = null,
  hostnames = [],
  routes = [],
  dcvUuid = "abc123",
  dns = {},
} = {}) {
  const state = {
    fallback,
    hostnames: structuredClone(hostnames),
    routes,
    created: [],
    deleted: [],
    policies: [],
  };
  const ok = (result) => ({ success: true, result });
  const fetch = recordingFetch(({ method, url, body }) => {
    const { hostname: host, pathname, search, searchParams } = new URL(url);
    const data = body === undefined ? undefined : JSON.parse(body);
    if (host === "cloudflare-dns.com") {
      const type = searchParams.get("type");
      const answers = dns[`${searchParams.get("name")} ${type}`] ?? [];
      const code = { CNAME: 5, CAA: 257 }[type];
      return { Status: 0, Answer: answers.map((data) => ({ type: code, data })) };
    }
    const account = "/client/v4/accounts/account-1";
    if (pathname.startsWith(account)) {
      const path = pathname.slice(account.length);
      if (method === "GET" && path === "/tokens/permission_groups") return ok(PERMISSION_GROUPS);
      if (method === "POST" && path === "/tokens") {
        state.policies.push(data.policies);
        return ok({ id: "temporary", value: "temporary-secret" });
      }
      if (method === "DELETE" && path === "/tokens/temporary") {
        state.deleted.push("temporary");
        return ok({});
      }
    }
    const zone = "/client/v4/zones/zone-1";
    assert.ok(pathname.startsWith(zone), `outside the zone: ${url}`);
    const path = `${pathname.slice(zone.length)}${search}`;
    if (!saas && path.startsWith("/custom_hostnames")) {
      return json({ success: false, errors: [{ code: 1400, message: "Not entitled" }] }, 403);
    }
    if (method === "GET" && path.startsWith("/custom_hostnames?")) {
      return ok(state.hostnames.filter((entry) => entry.hostname === searchParams.get("hostname")));
    }
    if (method === "POST" && path === "/custom_hostnames") {
      const created = {
        id: "hostname-1",
        hostname: data.hostname,
        status: "pending",
        ssl: { ...data.ssl, status: "pending_validation", validation_records: [] },
        ownership_verification: OWNERSHIP,
      };
      state.created.push(data);
      state.hostnames.push(created);
      return ok({ id: created.id, hostname: created.hostname });
    }
    if (method === "GET" && path === "/custom_hostnames/fallback_origin") {
      return state.fallback
        ? ok(state.fallback)
        : json(
            { success: false, errors: [{ code: 1551, message: "No fallback origin found" }] },
            404,
          );
    }
    if (method === "GET" && path === "/dcv_delegation/uuid") return ok({ uuid: dcvUuid });
    if (method === "GET" && path === "/workers/routes") return ok(state.routes);
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  return { fetch, state };
}

async function site(ops = OPS) {
  return createFixtureSite({ ops });
}

test("gq.ops.json domains.frontendTarget names the Frontend's host in the zone, outside which domains.frontend is", () => {
  assert.equal(manifestSchema.safeParse(OPS).success, true);
  const issues = (domains) =>
    manifestSchema
      .safeParse({ ...OPS, domains: { ...OPS.domains, ...domains } })
      .error?.issues.map(({ path, message }) => `${path.join(".")}: ${message}`) ?? [];
  assert.match(
    issues({ frontendTarget: "WWW.client.example" }).join("\n"),
    /domains\.frontendTarget: must be/u,
  );
  assert.match(
    issues({ frontendTarget: "fixture.other.test" }).join("\n"),
    /must be a hostname in example\.test/u,
  );
  assert.match(
    issues({ frontend: "www.example.test" }).join("\n"),
    /domains\.frontend: is in example\.test/u,
  );
});

const PROXY = Object.freeze({ trustedProxies: ["192.0.2.10", "2001:db8:1:2::/64"] });

test("gq.ops.json domains.frontendProxy forwards domains.frontend to frontendTarget from its trusted addresses", () => {
  const proxied = { ...OPS, domains: { ...OPS.domains, frontendProxy: PROXY } };
  assert.equal(manifestSchema.safeParse(proxied).success, true);
  const issues = (domains) =>
    manifestSchema
      .safeParse({ ...OPS, domains })
      .error?.issues.map(({ path, message }) => `${path.join(".")}: ${message}`) ?? [];
  assert.match(
    issues({
      admin: "cms.example.test",
      frontend: "www.example.test",
      frontendProxy: PROXY,
    }).join("\n"),
    /domains\.frontendProxy: needs domains\.frontendTarget/u,
  );
  for (const address of [
    "proxy.example.test",
    "192.0.2.10/33",
    "0.0.0.0/0",
    "::/0",
    "2001:db8::/x",
  ]) {
    assert.match(
      issues({ ...OPS.domains, frontendProxy: { trustedProxies: [address] } }).join("\n"),
      /domains\.frontendProxy\.trustedProxies\.0: must be an IPv4 or IPv6 address or CIDR/u,
      address,
    );
  }
  assert.match(
    issues({ ...OPS.domains, frontendProxy: { trustedProxies: [] } }).join("\n"),
    /domains\.frontendProxy\.trustedProxies/u,
  );
  // The in-zone checks hold behind a proxy too.
  assert.match(
    issues({ ...proxied.domains, frontendTarget: "fixture.other.test" }).join("\n"),
    /must be a hostname in example\.test/u,
  );
});

test("cloudflare custom-hostname creates the custom hostname and prints the client's records", async () => {
  const fixture = await site();
  const { fetch, state } = fakeCloudflare({ fallback: FALLBACK });

  const result = await fixture.run(["cloudflare", "custom-hostname"], { env: ENV, fetch });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(state.fallback, FALLBACK);
  assert.match(
    result.stdout,
    /✓ the zone's fallback origin is saas-fallback\.example\.test \(active\)/u,
  );
  assert.deepEqual(state.created, [
    {
      hostname: "www.client.example",
      ssl: { method: "txt", type: "dv", settings: { min_tls_version: "1.2" } },
    },
  ]);
  // A temporary token, scoped to the zone, deleted afterwards.
  assert.deepEqual(Object.keys(state.policies[0][0].resources), [
    "com.cloudflare.api.account.zone.zone-1",
  ]);
  assert.deepEqual(state.deleted, ["temporary"]);
  assert.match(
    result.stdout,
    /www\.client\.example {2}CNAME {2}fixture\.example\.test {2}\(traffic\)/u,
  );
  assert.match(
    result.stdout,
    /_cf-custom-hostname\.www\.client\.example {2}TXT {2}ownership-token {2}\(ownership\)/u,
  );
  assert.match(
    result.stdout,
    /_acme-challenge\.www\.client\.example {2}CNAME {2}www\.client\.example\.abc123\.dcv\.cloudflare\.com {2}\(certificate\)/u,
  );
  assert.match(
    result.stdout,
    /0 issue "letsencrypt\.org", 0 issue "pki\.goog", 0 issue "ssl\.com"/u,
  );
});

test("cloudflare custom-hostname keeps an existing custom hostname", async () => {
  const fixture = await site();
  const { fetch, state } = fakeCloudflare({
    fallback: FALLBACK,
    hostnames: [
      {
        hostname: "www.client.example",
        status: "active",
        ssl: { status: "active" },
        ownership_verification: OWNERSHIP,
      },
    ],
  });

  const result = await fixture.run(["cloudflare", "custom-hostname"], { env: ENV, fetch });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(state.created, []);
  assert.match(result.stdout, /✓ the custom hostname www\.client\.example exists \(active/u);
});

test("cloudflare custom-hostname never sets the zone's fallback origin, and says when it lacks one", async () => {
  const fixture = await site();
  const { fetch, state } = fakeCloudflare();

  const result = await fixture.run(["cloudflare", "custom-hostname"], { env: ENV, fetch });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(state.fallback, null);
  assert.equal(state.created.length, 1);
  assert.match(
    result.stdout,
    /! the zone has no fallback origin: set one once for the zone, by hand/u,
  );
  assert.match(result.stdout, /Next: set the zone's fallback origin; /u);
});

test("cloudflare custom-hostname warns when the fallback origin is this Site's own Frontend", async () => {
  const fixture = await site();
  const { fetch } = fakeCloudflare({
    fallback: { origin: "fixture.example.test", status: "active" },
  });

  const result = await fixture.run(["cloudflare", "custom-hostname"], { env: ENV, fetch });

  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stdout,
    /! the zone's fallback origin is fixture\.example\.test, this Site's Frontend: every custom hostname without a route would show it/u,
  );
});

test("cloudflare custom-hostname --dry-run changes nothing", async () => {
  const fixture = await site();
  const { fetch, state } = fakeCloudflare();

  const result = await fixture.run(["cloudflare", "custom-hostname", "--dry-run"], {
    env: ENV,
    fetch,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(state.created, []);
  assert.deepEqual(state.deleted, ["temporary"]);
  assert.match(result.stdout, /\+ create the custom hostname www\.client\.example/u);
  assert.match(result.stdout, /Dry run: nothing changed\./u);
});

test("cloudflare custom-hostname names the dashboard step when Cloudflare for SaaS isn't enabled", async () => {
  const fixture = await site();
  const { fetch, state } = fakeCloudflare({ saas: false });

  const result = await fixture.run(["cloudflare", "custom-hostname"], { env: ENV, fetch });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Not entitled\. Is Cloudflare for SaaS enabled on example\.test\?/u);
  assert.deepEqual(state.deleted, ["temporary"]);
});

test("cloudflare custom-hostname needs domains.frontendTarget", async () => {
  const fixture = await site({
    ...OPS,
    domains: { admin: "cms.example.test", frontend: "www.example.test" },
  });

  const result = await fixture.run(["cloudflare", "custom-hostname"], {
    env: ENV,
    fetch: recordingFetch(),
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /domains\.frontendTarget/u);
});

for (const command of [
  ["cloudflare", "custom-hostname"],
  ["cloudflare", "custom-hostname", "status"],
]) {
  test(`${command.join(" ")} refuses a Frontend behind an external proxy, asking Cloudflare nothing`, async () => {
    const fixture = await site({
      ...OPS,
      domains: { ...OPS.domains, frontendProxy: PROXY },
    });
    const fetch = recordingFetch();

    const result = await fixture.run(command, { env: ENV, fetch });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /gq\.ops\.json sets domains\.frontendProxy/u);
    assert.match(
      result.stderr,
      /https:\/\/www\.client\.example is served by a reverse proxy outside Cloudflare, which forwards to the Worker's Custom Domain fixture\.example\.test/u,
    );
    assert.match(result.stderr, /no Cloudflare for SaaS custom hostname/u);
    assert.deepEqual(fetch.requests, []);
  });
}

const ACTIVE = {
  fallback: FALLBACK,
  hostnames: [
    {
      hostname: "www.client.example",
      status: "active",
      ssl: { status: "active" },
      ownership_verification: OWNERSHIP,
    },
  ],
  routes: [{ id: "route-1", pattern: "www.client.example/*", script: "fixture-fe" }],
  dns: {
    "www.client.example CNAME": ["fixture.example.test."],
    "client.example CAA": ['0 issue "letsencrypt.org"', '0 issue "pki.goog"', '0 issue "ssl.com"'],
  },
};

test("cloudflare custom-hostname status is ready once the hostname, certificate, route and DNS are", async () => {
  const fixture = await site();
  const { fetch, state } = fakeCloudflare(ACTIVE);

  const result = await fixture.run(["cloudflare", "custom-hostname", "status", "--json"], {
    env: ENV,
    fetch,
  });

  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, true);
  assert.deepEqual(
    report.checks.map(({ name, ok }) => [name, ok]),
    [
      ["fallback-origin", true],
      ["custom-hostname", true],
      ["certificate", true],
      ["worker-route", true],
      ["dns", true],
      ["caa", true],
    ],
  );
  assert.equal(report.records.length, 3);
  // It only reads: the temporary token can't write.
  const granted = state.policies[0][0].permission_groups.map(({ id }) => id);
  assert.deepEqual(granted, ["group-0", "group-1", "group-3"]);
});

test("cloudflare custom-hostname status names what the client and the deploy still owe", async () => {
  const fixture = await site();
  const { fetch } = fakeCloudflare({
    ...ACTIVE,
    hostnames: [
      {
        hostname: "www.client.example",
        status: "pending",
        verification_errors: ["custom hostname does not CNAME to this zone."],
        ssl: { status: "pending_validation" },
        ownership_verification: OWNERSHIP,
      },
    ],
    routes: [],
    dns: { "client.example CAA": ['0 issue "harica.gr"'] },
  });

  const result = await fixture.run(["cloudflare", "custom-hostname", "status"], {
    env: ENV,
    fetch,
  });

  assert.equal(result.code, 1);
  assert.match(
    result.stdout,
    /✗ the custom hostname www\.client\.example is pending: custom hostname does not CNAME/u,
  );
  assert.match(result.stdout, /✗ its certificate is pending_validation/u);
  assert.match(
    result.stdout,
    /✗ there is no route www\.client\.example\/\*: deploy the production Frontend/u,
  );
  assert.match(
    result.stdout,
    /✗ www\.client\.example isn't a CNAME to fixture\.example\.test yet/u,
  );
  assert.match(
    result.stdout,
    /✗ client\.example's CAA records \(0 issue "harica\.gr"\) don't allow 0 issue "letsencrypt\.org", 0 issue "pki\.goog", 0 issue "ssl\.com"/u,
  );
  assert.match(result.stdout, /Not ready yet\./u);
});

test("cloudflare custom-hostname status fails while the fallback origin is this Site's own Frontend", async () => {
  const fixture = await site();
  const { fetch } = fakeCloudflare({
    ...ACTIVE,
    fallback: { origin: "fixture.example.test", status: "active" },
  });

  const result = await fixture.run(["cloudflare", "custom-hostname", "status"], {
    env: ENV,
    fetch,
  });

  assert.equal(result.code, 1);
  assert.match(
    result.stdout,
    /✗ the zone's fallback origin is fixture\.example\.test, this Site's Frontend/u,
  );
});

test("cloudflare custom-hostname status reads the CAA records closest to the hostname", async () => {
  const fixture = await site();
  const { fetch } = fakeCloudflare({
    ...ACTIVE,
    dns: {
      ...ACTIVE.dns,
      "www.client.example CAA": ['0 issue "letsencrypt.org"', '0 iodef "mailto:it@client.example"'],
    },
  });

  const result = await fixture.run(["cloudflare", "custom-hostname", "status"], {
    env: ENV,
    fetch,
  });

  assert.equal(result.code, 1);
  assert.match(
    result.stdout,
    /www\.client\.example's CAA records .* don't allow 0 issue "pki\.goog", 0 issue "ssl\.com"/u,
  );
});

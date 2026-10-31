// The GETQUICK CI token broker (src/ci/broker/, gq-platform ADR
// 0012) and the manifest flow that creates its App (src/ci/app-create.mjs),
// with a throwaway RSA key and a recording fetch standing in for GitHub.
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";

import {
  appManifest,
  convertManifestCode,
  manifestReceiver,
  newAppUrl,
} from "../../src/ci/app-create.mjs";
import {
  appJwt,
  brokerCredential,
  handleToken,
  TOKEN_PERMISSIONS,
} from "../../src/ci/broker/broker.mjs";
import worker from "../../src/ci/broker/worker.mjs";
import { APP_PERMISSIONS, pkcs8Base64 } from "../../src/ci/github-app.mjs";
import { recordingFetch } from "../support/fixture-site.mjs";

const { privateKey: PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const KEY = pkcs8Base64(PEM);
const ENV = Object.freeze({
  GITHUB_APP_ID: "4242",
  GITHUB_APP_PRIVATE_KEY: KEY,
  BROKER_KEY: "broker-key",
  ALLOWED_OWNER: "Quick-Release",
});
const REPOSITORY = "Quick-Release/bruaa";

function tokenRequest(credential, body = { repository: REPOSITORY }) {
  return new Request("https://gq-ci-broker.example.workers.dev/token", {
    method: "POST",
    headers: credential ? { Authorization: `Bearer ${credential}` } : {},
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// GitHub: the repository's installation, then a token for what was asked.
function github({ grant } = {}) {
  return recordingFetch(({ url, method, body }) => {
    if (url === `https://api.github.com/repos/${REPOSITORY}/installation`) return { id: 77 };
    if (url === "https://api.github.com/app/installations/77/access_tokens" && method === "POST") {
      const asked = JSON.parse(body);
      return new Response(
        JSON.stringify({
          token: "ghs_minted",
          expires_at: "2026-10-31T13:00:00Z",
          permissions: { ...asked.permissions, metadata: "read" },
          repositories: [{ full_name: REPOSITORY }],
          ...grant,
        }),
        { status: 201 },
      );
    }
    return new Response("{}", { status: 404 });
  });
}

test("a Site's broker credential is one repository's, whatever its case", async () => {
  const credential = await brokerCredential("broker-key", REPOSITORY);
  assert.match(credential, /^gqci1_[A-Za-z0-9_-]{43}$/u);
  assert.equal(await brokerCredential("broker-key", "quick-release/BRUAA"), credential);
  assert.notEqual(await brokerCredential("broker-key", "Quick-Release/ekis"), credential);
  assert.notEqual(await brokerCredential("other-key", REPOSITORY), credential);
  await assert.rejects(brokerCredential("broker-key", "not a repository"), /Not a repository/u);
});

test("the App JWT is RS256, signed by the App's key, and short-lived", async () => {
  const jwt = await appJwt("4242", KEY, Date.parse("2026-10-31T12:00:00Z"));
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  assert.equal(claims.iss, "4242");
  assert.ok(claims.exp - claims.iat <= 600);
  assert.ok(
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      createPublicKey(PEM),
      Buffer.from(signature, "base64url"),
    ),
  );
});

test("the broker mints a token narrowed to the caller's repository and CI's permissions", async () => {
  const fetch = github();
  const response = await handleToken(
    tokenRequest(await brokerCredential("broker-key", REPOSITORY)),
    ENV,
    fetch,
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), {
    token: "ghs_minted",
    expires_at: "2026-10-31T13:00:00Z",
  });
  const mint = fetch.requests[1];
  assert.deepEqual(JSON.parse(mint.body), {
    repositories: ["bruaa"],
    permissions: TOKEN_PERMISSIONS,
  });
  assert.deepEqual(TOKEN_PERMISSIONS, { contents: "read", statuses: "write" });
  assert.match(mint.headers.Authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/u);
});

test("the broker refuses a wrong credential, another owner and a bad body before GitHub", async () => {
  const fetch = github();
  const other = await brokerCredential("broker-key", "Quick-Release/ekis");
  const cases = [
    [tokenRequest(other), 401],
    [tokenRequest(""), 401],
    [
      tokenRequest(await brokerCredential("broker-key", "Elsewhere/bruaa"), {
        repository: "Elsewhere/bruaa",
      }),
      403,
    ],
    [tokenRequest(other, "not json"), 400],
    [tokenRequest(other, { repository: "../etc" }), 400],
  ];
  for (const [request, status] of cases) {
    assert.equal((await handleToken(request, ENV, fetch)).status, status);
  }
  assert.deepEqual(fetch.requests, []);
});

test("the broker refuses a grant GitHub widened, and an uninstalled repository", async () => {
  const credential = await brokerCredential("broker-key", REPOSITORY);
  const widened = await handleToken(
    tokenRequest(credential),
    ENV,
    github({ grant: { permissions: { contents: "write", statuses: "write", metadata: "read" } } }),
  );
  assert.equal(widened.status, 502);
  assert.doesNotMatch(await widened.text(), /ghs_minted/u);

  const otherRepository = await handleToken(
    tokenRequest(credential),
    ENV,
    github({ grant: { repositories: [{ full_name: "Quick-Release/ekis" }] } }),
  );
  assert.equal(otherRepository.status, 502);

  const uninstalled = await handleToken(
    tokenRequest(credential),
    ENV,
    recordingFetch(() => new Response("{}", { status: 404 })),
  );
  assert.equal(uninstalled.status, 403);
  assert.match((await uninstalled.json()).error, /isn't installed on this repository/u);
});

test("the broker reports whether it is configured, and refuses tokens until it is", async () => {
  const health = await worker.fetch(new Request("https://broker.test/health"), ENV);
  assert.deepEqual(await health.json(), { ok: true, configured: true });
  const unconfigured = await worker.fetch(tokenRequest("x"), { ALLOWED_OWNER: "Quick-Release" });
  assert.equal(unconfigured.status, 503);
  assert.equal((await worker.fetch(new Request("https://broker.test/"), ENV)).status, 404);
});

// --- gq github app create's manifest flow --------------------------------------

test("the App manifest asks for CI's permissions only, with no webhook or events", () => {
  const manifest = appManifest("http://127.0.0.1:5555");
  assert.equal(manifest.name, "GETQUICK CI");
  assert.equal(manifest.public, false);
  assert.deepEqual(manifest.default_permissions, {
    contents: "read",
    statuses: "write",
    metadata: "read",
  });
  assert.deepEqual(manifest.default_events, []);
  assert.equal(manifest.hook_attributes, undefined);
  assert.equal(manifest.redirect_url, "http://127.0.0.1:5555/created");
  assert.equal(manifest.setup_url, "http://127.0.0.1:5555/installed");
  assert.equal(
    newAppUrl("abc"),
    "https://github.com/organizations/Quick-Release/settings/apps/new?state=abc",
  );
});

test("the loopback page posts the manifest to GitHub and waits for its redirects", async () => {
  const receiver = await manifestReceiver({ state: "s3cret-state", timeoutMs: 5000 });
  try {
    const page = await (await fetch(`${receiver.origin}/`)).text();
    assert.match(
      page,
      /action="https:\/\/github\.com\/organizations\/Quick-Release\/settings\/apps\/new\?state=s3cret-state"/u,
    );
    assert.match(page, /name="manifest" value="\{&#34;name&#34;:&#34;GETQUICK CI&#34;/u);

    const wrongState = await fetch(`${receiver.origin}/created?code=abc&state=other`);
    assert.equal(wrongState.status, 400);
    const created = receiver.wait("created");
    await fetch(`${receiver.origin}/created?code=abc&state=s3cret-state`);
    assert.equal((await created).get("code"), "abc");
    await fetch(`${receiver.origin}/installed?installation_id=99&setup_action=install`);
    assert.equal((await receiver.wait("installed")).get("installation_id"), "99");
  } finally {
    receiver.close();
  }
});

test("converting the code checks the App and keeps only its ID, slug and key", async () => {
  const conversion = (overrides = {}) =>
    recordingFetch(
      () =>
        new Response(
          JSON.stringify({
            id: 4242,
            slug: "getquick-ci",
            owner: { login: "Quick-Release" },
            permissions: APP_PERMISSIONS,
            events: [],
            pem: PEM,
            client_secret: "client-secret",
            webhook_secret: null,
            ...overrides,
          }),
          { status: 201 },
        ),
    );
  const fetch = conversion();
  const app = await convertManifestCode(fetch, "code123");
  assert.equal(fetch.requests[0].url, "https://api.github.com/app-manifests/code123/conversions");
  assert.deepEqual(Object.keys(app).sort(), ["id", "privateKey", "slug"]);
  assert.equal(app.id, "4242");
  assert.equal(app.privateKey, KEY);

  await assert.rejects(
    convertManifestCode(conversion({ owner: { login: "someone" } }), "code123"),
    /differ from the manifest/u,
  );
  await assert.rejects(
    convertManifestCode(
      conversion({ permissions: { ...APP_PERMISSIONS, administration: "write" } }),
      "code123",
    ),
    /differ from the manifest/u,
  );
  await assert.rejects(convertManifestCode(conversion(), "bad code!"), /no App creation code/u);
});

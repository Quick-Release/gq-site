import assert from "node:assert/strict";
import test from "node:test";

import {
  agentAuthorization,
  agentClient,
  edgeCredential,
  isAgentPath,
} from "../../src/content/transport.mjs";
import { json, recordingExec, recordingFetch } from "../support/fixture-site.mjs";

const ORIGIN = "https://admin.example.test";
const AGENT = {
  GQ_CMS_AGENT_USERNAME: "agent",
  GQ_CMS_AGENT_APPLICATION_PASSWORD: "abcd efgh ijkl",
};
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";

test("allows only a page or post, its revisions and one revision", () => {
  for (const path of [
    "/wp-json/wp/v2/pages/12",
    "/wp-json/wp/v2/posts/3",
    "/wp-json/wp/v2/pages/12/revisions",
    "/wp-json/wp/v2/pages/12/revisions/40",
  ]) {
    assert.equal(isAgentPath(path), true, path);
  }
  for (const path of [
    "/wp-json/wp/v2/pages",
    "/wp-json/wp/v2/pages/0",
    "/wp-json/wp/v2/pages/12/autosaves",
    "/wp-json/wp/v2/users/1",
    "/wp-json/wp/v2/media/5",
    "/wp-json/wp/v2/pages/12/",
    "/wp/wp-admin/post.php",
    "/wp-json/wp/v2/pages/12/revisions/40/x",
  ]) {
    assert.equal(isAgentPath(path), false, path);
  }
});

test("builds Basic auth from the agent pair, keeping a password's inner spaces", () => {
  assert.equal(
    agentAuthorization(AGENT),
    `Basic ${Buffer.from("agent:abcd efgh ijkl").toString("base64")}`,
  );
  assert.throws(
    () => agentAuthorization({}),
    /GQ_CMS_AGENT_USERNAME and GQ_CMS_AGENT_APPLICATION_PASSWORD are required/u,
  );
  for (const env of [
    { ...AGENT, GQ_CMS_AGENT_USERNAME: "a:b" },
    { ...AGENT, GQ_CMS_AGENT_APPLICATION_PASSWORD: "abcd\nefgh" },
    { ...AGENT, GQ_CMS_AGENT_APPLICATION_PASSWORD: " abcd" },
  ]) {
    assert.throws(
      () => agentAuthorization(env),
      (error) => /values not shown/u.test(error.message) && !error.message.includes("abcd"),
    );
  }
});

test("prefers the agent's service token, then a cloudflared session, then none", async () => {
  const exec = recordingExec(() => ({ stdout: `${JWT}\n` }));
  const service = await edgeCredential({
    env: {
      GQ_CMS_AGENT_ACCESS_CLIENT_ID: "id.access",
      GQ_CMS_AGENT_ACCESS_CLIENT_SECRET: "s3cret",
    },
    exec,
    origin: ORIGIN,
  });
  assert.deepEqual(service, {
    kind: "service token",
    headers: { "CF-Access-Client-Id": "id.access", "CF-Access-Client-Secret": "s3cret" },
  });
  assert.equal(exec.calls.length, 0);

  const session = await edgeCredential({ env: {}, exec, origin: ORIGIN });
  assert.deepEqual(session, { kind: "cloudflared session", headers: { "cf-access-token": JWT } });
  assert.deepEqual(exec.calls[0].args, ["access", "token", `-app=${ORIGIN}`]);

  const loggedOut = recordingExec(() => ({ code: 1, stderr: "Unable to find token" }));
  assert.deepEqual(await edgeCredential({ env: {}, exec: loggedOut, origin: ORIGIN }), {
    kind: "none",
    headers: {},
  });
  const missing = async () => {
    throw new Error("spawn cloudflared ENOENT");
  };
  assert.equal((await edgeCredential({ env: {}, exec: missing, origin: ORIGIN })).kind, "none");
});

test("refuses half a service-token pair, naming it only", async () => {
  await assert.rejects(
    edgeCredential({
      env: { GQ_CMS_AGENT_ACCESS_CLIENT_ID: "only-id" },
      exec: recordingExec(),
      origin: ORIGIN,
    }),
    (error) => /must be set together/u.test(error.message) && !error.message.includes("only-id"),
  );
});

test("sends both identities to the allowed path, and never follows a redirect", async () => {
  const fetch = recordingFetch(() => json({ id: 12 }));
  const request = agentClient({
    origin: ORIGIN,
    authorization: "Basic eA==",
    edge: { kind: "cloudflared session", headers: { "cf-access-token": JWT } },
    fetch,
  });
  assert.deepEqual(
    await request("GET", "/wp-json/wp/v2/pages/12", { query: { context: "edit" } }),
    { id: 12 },
  );
  const [sent] = fetch.requests;
  assert.equal(sent.url, `${ORIGIN}/wp-json/wp/v2/pages/12?context=edit`);
  assert.equal(sent.headers.Authorization, "Basic eA==");
  assert.equal(sent.headers["cf-access-token"], JWT);

  await assert.rejects(request("GET", "/wp-json/wp/v2/users/me"), /Refusing to send/u);
  assert.equal(fetch.requests.length, 1);
  assert.throws(
    () =>
      agentClient({
        origin: "http://admin.example.test",
        authorization: "x",
        edge: { headers: {} },
        fetch,
      }),
    /HTTPS/u,
  );
});

test("explains a redirect to Access without following it or showing credentials", async () => {
  const redirect = () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" },
    });
  const request = agentClient({
    origin: ORIGIN,
    authorization: "Basic c2VjcmV0",
    edge: { kind: "none", headers: {} },
    fetch: recordingFetch(redirect),
  });
  await assert.rejects(request("GET", "/wp-json/wp/v2/pages/12"), (error) => {
    assert.match(error.message, /redirected to team\.cloudflareaccess\.com, not followed/u);
    assert.match(error.message, /cloudflared access login https:\/\/admin\.example\.test/u);
    assert.doesNotMatch(error.message, /c2VjcmV0/u);
    return true;
  });
});

test("reports WordPress's error code, and hides transport errors", async () => {
  const denied = agentClient({
    origin: ORIGIN,
    authorization: "Basic x",
    edge: { kind: "none", headers: {} },
    fetch: recordingFetch(() =>
      json(
        { code: "rest_cannot_edit", message: "Sorry, you are not allowed to edit this post." },
        403,
      ),
    ),
  });
  await assert.rejects(
    denied("POST", "/wp-json/wp/v2/pages/12", { body: {} }),
    /403: rest_cannot_edit/u,
  );
  const broken = agentClient({
    origin: ORIGIN,
    authorization: "Basic c2VjcmV0",
    edge: { kind: "none", headers: {} },
    fetch: async () => {
      throw new Error("connect ECONNREFUSED with Basic c2VjcmV0");
    },
  });
  await assert.rejects(
    broken("GET", "/wp-json/wp/v2/pages/12"),
    (error) => !error.message.includes("c2VjcmV0"),
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { cmsAccessHeaders, cmsFetch } from "../../src/cms/access.mjs";
import { secretsPayload, workerSecrets } from "../../src/ci/deploy.mjs";

const origin = "https://cms.example.test";
const env = {
  GQ_AUTH_GRAPHQL_CLIENT_ID: "graphql-id",
  GQ_AUTH_GRAPHQL_CLIENT_SECRET: "graphql-secret",
  GQ_AUTH_AUTOMATION_CLIENT_ID: "automation-id",
  GQ_AUTH_AUTOMATION_CLIENT_SECRET: "automation-secret",
};
const headers = (url, environment = env) => cmsAccessHeaders({ env: environment, origin, url });

test("GraphQL reads and automation probes use separate identities on the exact CMS origin", () => {
  for (const path of ["/graphql", "/wp/graphql?query=test"]) {
    assert.deepEqual(headers(`${origin}${path}`), {
      "CF-Access-Client-Id": env.GQ_AUTH_GRAPHQL_CLIENT_ID,
      "CF-Access-Client-Secret": env.GQ_AUTH_GRAPHQL_CLIENT_SECRET,
    });
  }
  for (const path of [
    "/",
    "/wp-login.php",
    "/wp/wp-login.php",
    "/wp-json/wp/v2/media",
    "/wp-json/wp/v2/media/123?force=true",
  ]) {
    assert.deepEqual(headers(`${origin}${path}`), {
      "CF-Access-Client-Id": env.GQ_AUTH_AUTOMATION_CLIENT_ID,
      "CF-Access-Client-Secret": env.GQ_AUTH_AUTOMATION_CLIENT_SECRET,
    });
  }
});

test("credentials never reach other origins, ports, media or unrelated CMS paths", () => {
  for (const url of [
    "https://media.example.test/graphql",
    "https://cms.example.test.evil.test/graphql",
    "https://cms.example.test:444/graphql",
    "http://cms.example.test/graphql",
    `${origin}/app/uploads/a.png`,
    `${origin}/wp-json/wp/v2/posts`,
    `${origin}/graphql/extra`,
  ])
    assert.deepEqual(headers(url), {}, url);
});

test("unset pairs are optional; partial or invalid pairs have sanitized errors", () => {
  assert.deepEqual(headers(`${origin}/graphql`, {}), {});
  for (const service of ["GRAPHQL", "AUTOMATION"]) {
    const url = `${origin}${service === "GRAPHQL" ? "/graphql" : "/"}`;
    for (const field of ["ID", "SECRET"]) {
      assert.throws(
        () => headers(url, { [`GQ_AUTH_${service}_CLIENT_${field}`]: "private-value" }),
        (error) => {
          assert.match(error.message, /must be set together/u);
          assert.ok(!error.message.includes("private-value"));
          return true;
        },
      );
    }
  }
  assert.throws(
    () =>
      headers(`${origin}/graphql`, { ...env, GQ_AUTH_GRAPHQL_CLIENT_SECRET: "secret\ninvalid" }),
    /values not shown/u,
  );
  assert.throws(
    () =>
      cmsAccessHeaders({
        env,
        origin: "http://cms.example.test",
        url: "http://cms.example.test/graphql",
      }),
    /HTTPS/u,
  );
});

test("CMS fetch retains Basic auth, refuses redirect following and sanitizes transport failures", async () => {
  const calls = [];
  const fetch = cmsFetch({
    env,
    origin,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 302, headers: { location: "https://evil.test/" } });
    },
  });
  for (const method of ["POST", "DELETE"]) {
    await fetch(`${origin}/wp-json/wp/v2/media${method === "DELETE" ? "/1?force=true" : ""}`, {
      method,
      headers: { Authorization: "Basic existing-password" },
      redirect: "follow",
    });
  }
  assert.equal(calls.length, 2);
  for (const { init } of calls) {
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers.Authorization, "Basic existing-password");
    assert.equal(init.headers["CF-Access-Client-Secret"], env.GQ_AUTH_AUTOMATION_CLIENT_SECRET);
  }
  const failing = cmsFetch({
    env,
    origin,
    fetch: async () => {
      throw new Error(Object.values(env).join(" "));
    },
  });
  await assert.rejects(failing(`${origin}/graphql`), (error) => {
    assert.ok(Object.values(env).every((value) => !String(error).includes(value)));
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("CI forwards only the complete GraphQL pair, never automation credentials", () => {
  const required = Object.fromEntries(
    Object.values(workerSecrets).map((name) => [name, "required-secret"]),
  );
  const payload = JSON.parse(secretsPayload({ ...required, ...env }, { github: false }));
  assert.equal(payload.GQ_AUTH_GRAPHQL_CLIENT_ID, env.GQ_AUTH_GRAPHQL_CLIENT_ID);
  assert.equal(payload.GQ_AUTH_GRAPHQL_CLIENT_SECRET, env.GQ_AUTH_GRAPHQL_CLIENT_SECRET);
  assert.ok(!Object.keys(payload).some((name) => name.includes("AUTOMATION")));
  assert.throws(
    () =>
      secretsPayload({ ...required, GQ_AUTH_GRAPHQL_CLIENT_ID: "private-id" }, { github: false }),
    /must be set together/u,
  );
});

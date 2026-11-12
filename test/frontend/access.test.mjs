import assert from "node:assert/strict";
import test from "node:test";

import {
  frontendAccessHeaders,
  frontendAccessHint,
  frontendFetch,
} from "../../src/frontend/access.mjs";

const origin = "https://www.example.test";
const env = {
  GQ_FRONTEND_ACCESS_CLIENT_ID: "frontend-id",
  GQ_FRONTEND_ACCESS_CLIENT_SECRET: "frontend-secret",
};
const TOKEN = {
  "CF-Access-Client-Id": env.GQ_FRONTEND_ACCESS_CLIENT_ID,
  "CF-Access-Client-Secret": env.GQ_FRONTEND_ACCESS_CLIENT_SECRET,
};
const headers = (url, environment = env) =>
  frontendAccessHeaders({ env: environment, origin, url });
const accessRedirect = () =>
  new Response(null, {
    status: 302,
    headers: {
      location:
        "https://team.cloudflareaccess.com/cdn-cgi/access/login/www.example.test?kid=1&redirect_url=%2F",
    },
  });

test("the Frontend's own pages get its service token", () => {
  for (const path of ["/", "/en/", "/about-us/", "/gqx", "/a/gq/b"]) {
    assert.deepEqual(headers(`${origin}${path}`), TOKEN, path);
  }
});

test("the token never reaches /gq/*, other origins, ports, plain HTTP or userinfo URLs", () => {
  for (const url of [
    `${origin}/gq`,
    `${origin}/gq/events`,
    `${origin}/gq/refresh`,
    `${origin}/gq/consent/settings`,
    "https://admin.example.test/",
    "https://media.example.test/",
    "https://www.example.test.evil.test/",
    "https://www.example.test:444/",
    "http://www.example.test/",
    "https://user:pass@www.example.test/",
    "https://www.googletagmanager.com/gtag/js",
  ])
    assert.deepEqual(headers(url), {}, url);
  // A local Frontend (gq site check --url http://localhost:8787) is read without it.
  assert.deepEqual(
    frontendAccessHeaders({ env, origin: "http://localhost:8787", url: "http://localhost:8787/" }),
    {},
  );
});

test("unset is optional; a partial or invalid pair fails without its values", () => {
  assert.deepEqual(headers(`${origin}/`, {}), {});
  assert.deepEqual(headers(`${origin}/`, { GQ_FRONTEND_ACCESS_CLIENT_ID: "  " }), {});
  for (const field of ["ID", "SECRET"]) {
    assert.throws(
      () => headers(`${origin}/`, { [`GQ_FRONTEND_ACCESS_CLIENT_${field}`]: "private-value" }),
      (error) => {
        assert.match(
          error.message,
          /GQ_FRONTEND_ACCESS_CLIENT_ID and GQ_FRONTEND_ACCESS_CLIENT_SECRET must be set together/u,
        );
        assert.ok(!error.message.includes("private-value"));
        return true;
      },
    );
  }
  for (const invalid of ["secret\ninvalid", "secret\u0000", "sécret\u{1F600}"]) {
    assert.throws(
      () => headers(`${origin}/`, { ...env, GQ_FRONTEND_ACCESS_CLIENT_SECRET: invalid }),
      (error) => {
        assert.match(error.message, /values not shown/u);
        assert.ok(!error.message.includes(invalid));
        assert.ok(!error.message.includes(env.GQ_FRONTEND_ACCESS_CLIENT_ID));
        return true;
      },
    );
  }
});

test("a credentialed read never follows a redirect and hides transport errors", async () => {
  const calls = [];
  const fetch = frontendFetch({
    env,
    origin,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 301, headers: { location: "https://evil.test/" } });
    },
  });
  const response = await fetch(`${origin}/`, { headers: { Accept: "text/html" } });
  assert.equal(response.status, 301);
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers.Accept, "text/html");
  assert.equal(calls[0].init.headers["CF-Access-Client-Secret"], TOKEN["CF-Access-Client-Secret"]);

  const failing = frontendFetch({
    env,
    origin,
    fetch: async () => {
      throw new Error(Object.values(env).join(" "));
    },
  });
  await assert.rejects(failing(`${origin}/`), (error) => {
    assert.match(error.message, /credentials not shown/u);
    assert.ok(Object.values(env).every((value) => !String(error).includes(value)));
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("without credentials, requests pass through untouched", async () => {
  const calls = [];
  const raw = async (url, init) => {
    calls.push({ url, init });
    throw new TypeError("fetch failed");
  };
  const init = { headers: { Accept: "text/html" } };
  for (const [environment, url] of [
    [{}, `${origin}/`],
    [env, `${origin}/gq/events`],
    [env, "https://admin.example.test/"],
  ]) {
    await assert.rejects(frontendFetch({ env: environment, origin, fetch: raw })(url, init), {
      message: "fetch failed",
    });
  }
  for (const call of calls) assert.equal(call.init, init, call.url);
});

test("an Access login redirect names the two variables and the Service Auth remedy", () => {
  const url = new URL(`${origin}/`);
  const unset = frontendAccessHint({ env: {}, url, response: accessRedirect() });
  assert.match(unset.detail, /Cloudflare Access \(team\.cloudflareaccess\.com\)/u);
  assert.match(unset.detail, /GQ_FRONTEND_ACCESS_CLIENT_ID and GQ_FRONTEND_ACCESS_CLIENT_SECRET/u);
  assert.match(unset.action, /service token admitted by a Service Auth policy/u);
  assert.match(unset.action, /GQ_FRONTEND_ACCESS_CLIENT_ID and GQ_FRONTEND_ACCESS_CLIENT_SECRET/u);
  assert.ok(!unset.detail.includes("redirect_url"), "the login URL's query isn't echoed");

  const refused = frontendAccessHint({ env, url, response: accessRedirect() });
  assert.match(refused.detail, /refused the service token/u);
  for (const value of Object.values(env)) {
    assert.ok(!`${refused.detail}${refused.action}`.includes(value));
  }

  // A followed redirect that ended on Access's login page.
  const followed = new Response("<html>Sign in</html>", { status: 200 });
  Object.defineProperties(followed, {
    redirected: { value: true },
    url: { value: "https://team.cloudflareaccess.com/cdn-cgi/access/login/www.example.test" },
  });
  assert.ok(frontendAccessHint({ env: {}, url, response: followed }));

  for (const response of [
    new Response(null, { status: 302, headers: { location: "/en/" } }),
    new Response(null, {
      status: 302,
      headers: { location: "https://cloudflareaccess.com.evil.test/" },
    }),
    new Response(null, { status: 503 }),
    new Response("<main/>", { status: 200 }),
  ]) {
    assert.equal(frontendAccessHint({ env: {}, url, response }), null);
  }
});

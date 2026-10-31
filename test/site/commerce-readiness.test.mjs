// `gq site check` on a commerce Site (ADR 0021), at the run() seam. One
// in-memory world stands in for every part behind a recording fetch: the
// commerce CMS (its REST index, Store API, active theme, GQ eCommerce's
// customer auth and GQ Config's storefront settings), the storefront's Worker
// (the storefront Runtime's cart and auth BFF, with its D1 cart sessions,
// rate limiters and proxy secret), Ploi, the media bucket and its domain.
// Nothing here reaches the network.
import assert from "node:assert/strict";
import test from "node:test";

import { COMMERCE_ROUTES } from "../../src/site/commerce-readiness.mjs";
import { createFixtureSite, recordingExec, recordingFetch } from "../support/fixture-site.mjs";

const OPS = Object.freeze({
  schemaVersion: 1,
  project: "shop",
  variant: "commerce",
  domains: { admin: "shop-cms.example.test", frontend: "shop.example.test" },
  ploi: { serverId: "12", siteId: "34", systemUser: "shop" },
  media: { bucket: "shop-media", domain: "media.example.test" },
  cloudflare: { accountId: "account-1" },
  wordpress: { plugins: ["gq-design", "woocommerce", "getquick-ecommerce", "s3-uploads"] },
});

const PROXY_SECRET = "fixture-storefront-proxy-secret-0123456789abcdef";

const SECRETS = Object.freeze({
  PLOI_API_TOKEN: "ploi-secret-token",
  S3_UPLOADS_KEY: "media-key-id",
  S3_UPLOADS_SECRET: "media-secret-value",
  CMS_CHECK_USER: "media-check",
  CMS_CHECK_APP_PASSWORD: "abcd efgh ijkl mnop",
  GETQUICK_STOREFRONT_PROXY_SECRET: PROXY_SECRET,
  TURNSTILE_SECRET: "fixture-turnstile-secret",
  TURNSTILE_EXPECTED_HOSTNAMES: "shop.example.test",
});

const CMS_ENV = [
  "S3_UPLOADS_BUCKET='shop-media'",
  "S3_UPLOADS_KEY='media-key-id'",
  "S3_UPLOADS_SECRET='media-secret-value'",
  "S3_UPLOADS_ENDPOINT='https://account-1.r2.cloudflarestorage.com'",
  "S3_UPLOADS_BUCKET_URL='https://media.example.test'",
  `GETQUICK_STOREFRONT_PROXY_SECRET='${PROXY_SECRET}'`,
].join("\n");

const CART = Object.freeze({
  items: [],
  coupons: [],
  totals: { total_price: "0", currency_code: "EUR" },
});

const problem = (status, code) =>
  new Response(JSON.stringify({ code, message: code, status, requestId: "r" }), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A commerce Site that is ready unless `overrides` say otherwise. */
function world(overrides = {}) {
  const state = {
    cms: "ready", // "down", "not-installed", "plain-permalinks", "ready"
    routes: COMMERCE_ROUTES.map(([route]) => route),
    products: 3,
    theme: { stylesheet: "getquick-theme", template: "getquick-theme" },
    cmsProxySecret: PROXY_SECRET, // the CMS's .env; null when it has none
    signIn: true, // GQ Config's customer accounts setting
    // The storefront's Worker.
    mounted: true,
    workerProxySecret: PROXY_SECRET,
    cartSessions: "bound", // "bound", "unbound" (no D1), "forgetful" (never finds a handle)
    rateLimiters: true,
    homeHeaders: {},
    homeHtml: "<main><h1>Shop</h1></main>",
    // GQ Config's storefront settings.
    analytics: false,
    legal: {
      controller: { name: "Shop, Lda.", privacyEmail: "privacy@example.test", dpoContact: null },
      languages: {
        pt: {
          roles: ["privacy_policy", "cookie_policy", "terms_of_sale"].map((role) => ({
            role,
            url: `https://shop.example.test/${role}/`,
          })),
        },
      },
      missingRequired: [],
    },
    handles: new Set(),
    bucket: new Map(),
    attachments: new Map(),
    nextId: 100,
    ...overrides,
  };

  const fetch = recordingFetch(({ method, url, headers, body }) => {
    const { hostname, pathname, search } = new URL(url);
    if (hostname === "shop-cms.example.test") {
      if (state.cms === "down") throw new TypeError("fetch failed");
      if (state.cms === "not-installed") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://shop-cms.example.test/wp/wp-admin/install.php" },
        });
      }
      if (state.cms === "plain-permalinks" && pathname.startsWith("/wp-json/")) {
        return new Response(null, {
          status: 301,
          headers: { location: `https://shop.example.test${pathname}` },
        });
      }
      if (method === "GET" && pathname === "/wp-json/") {
        return { namespaces: [], routes: Object.fromEntries(state.routes.map((r) => [r, {}])) };
      }
      if (method === "GET" && pathname === "/wp-json/wc/store/v1/products") {
        assert.equal(search, "?per_page=1");
        return new Response(JSON.stringify(state.products > 0 ? [{ id: 1 }] : []), {
          headers: { "content-type": "application/json", "x-wp-total": String(state.products) },
        });
      }
      if (method === "GET" && pathname === "/wp-json/getquick-config/v1/woocommerce/auth/health") {
        assert.equal(headers.Origin, undefined, "the probe isn't a browser request");
        if (
          headers["x-getquick-storefront-proxy"] !== state.cmsProxySecret ||
          !state.cmsProxySecret
        ) {
          return new Response(
            JSON.stringify({ code: "getquick_auth_unauthenticated", data: { status: 401 } }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }
        return state.signIn
          ? {
              status: "available",
              registration: { enabled: true, passwordMinimumLength: 12 },
            }
          : problem(503, "getquick_auth_unavailable");
      }
      if (method === "GET" && pathname === "/wp-json/getquick-config/v1/storefront") {
        return {
          schemaVersion: 1,
          googleAnalyticsEnabled: state.analytics,
          googleAnalyticsMeasurementId: state.analytics ? "G-FIXTURE" : null,
          legal: state.legal,
        };
      }
      const expected = `Basic ${btoa(`${SECRETS.CMS_CHECK_USER}:${SECRETS.CMS_CHECK_APP_PASSWORD}`)}`;
      if (pathname.startsWith("/wp-json/wp/") && headers.Authorization !== expected) {
        return new Response(JSON.stringify({ code: "rest_not_logged_in" }), { status: 401 });
      }
      if (method === "GET" && pathname === "/wp-json/wp/v2/themes") {
        assert.match(search, /status=active/u);
        return [state.theme];
      }
      if (method === "POST" && pathname === "/wp-json/wp/v2/media") {
        const id = state.nextId++;
        const path = `uploads/2026/10/${/filename="([^"]+)"/u.exec(headers["Content-Disposition"])[1]}`;
        state.bucket.set(path, body);
        state.attachments.set(id, path);
        return new Response(
          JSON.stringify({ id, source_url: `https://media.example.test/${path}` }),
          { status: 201 },
        );
      }
      const deleted = /^\/wp-json\/wp\/v2\/media\/(\d+)$/u.exec(pathname);
      if (method === "DELETE" && deleted && search === "?force=true") {
        state.bucket.delete(state.attachments.get(Number(deleted[1])));
        return { deleted: true };
      }
    }
    if (hostname === "shop.example.test") {
      for (const value of Object.values(headers)) {
        assert.notEqual(value, PROXY_SECRET, "the proxy secret only goes to the CMS");
      }
      if (method === "GET" && pathname === "/") {
        return new Response(state.homeHtml, {
          headers: { "content-type": "text/html; charset=utf-8", ...state.homeHeaders },
        });
      }
      if (!state.mounted) {
        return new Response("<html>Not found</html>", {
          status: 404,
          headers: { "content-type": "text/html" },
        });
      }
      if (method === "GET" && pathname === "/api/store/v1/cart") {
        if (state.cartSessions === "unbound") return problem(503, "getquick_cart_unavailable");
        const handle = /__Host-getquick_cart=([\w-]{43})/u.exec(headers.Cookie ?? "")?.[1];
        const headersOut = new Headers({
          "content-type": "application/json; charset=utf-8",
          "cache-control": "private, no-store",
        });
        if (!handle || !state.handles.has(handle) || state.cartSessions === "forgetful") {
          const fresh = `h${String(state.handles.size).padStart(42, "0")}`;
          state.handles.add(fresh);
          headersOut.append(
            "set-cookie",
            `__Host-getquick_cart=${fresh}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=172799`,
          );
        } else {
          // A renewed Cart-Token keeps the same handle.
          headersOut.append(
            "set-cookie",
            `__Host-getquick_cart=${handle}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=172799`,
          );
        }
        return new Response(JSON.stringify(CART), { headers: headersOut });
      }
      if (method === "GET" && pathname === "/api/auth/configuration") {
        if (!state.signIn || state.workerProxySecret !== state.cmsProxySecret) {
          return problem(503, "getquick_auth_unavailable");
        }
        return { status: "available", registration: { enabled: true, passwordMinimumLength: 12 } };
      }
      if (method === "POST" && pathname === "/api/auth/login") {
        assert.equal(headers.Origin, "https://shop.example.test");
        const probe = JSON.parse(body);
        assert.match(probe.identifier, /@example\.invalid$/u, "a made-up account");
        if (!state.rateLimiters) return problem(503, "getquick_auth_unavailable");
        return problem(422, "getquick_auth_turnstile_failed");
      }
    }
    if (hostname === "ploi.io") {
      assert.equal(headers.Authorization, `Bearer ${SECRETS.PLOI_API_TOKEN}`);
      if (method === "GET" && pathname === "/api/servers/12/sites/34/env") {
        return { data: `${CMS_ENV}\n` };
      }
    }
    if (hostname === "account-1.r2.cloudflarestorage.com") {
      if (!headers.authorization?.includes(`Credential=${SECRETS.S3_UPLOADS_KEY}/`)) {
        return new Response(null, { status: 403 });
      }
      const stored = state.bucket.get(decodeURIComponent(pathname.replace(/^\/shop-media\//u, "")));
      if (method === "HEAD") return new Response(null, { status: stored ? 200 : 404 });
      if (method === "GET") return new Response(stored ?? null, { status: stored ? 200 : 404 });
    }
    if (hostname === "media.example.test") {
      const stored = state.bucket.get(decodeURIComponent(pathname.slice(1)));
      if (method === "HEAD" || !stored) return new Response(null, { status: 404 });
      return new Response(stored, { headers: { "content-type": "image/png" } });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  return { fetch, state };
}

async function check(overrides = {}, { env = SECRETS, argv = [] } = {}) {
  const fixture = await createFixtureSite({ ops: OPS });
  const { fetch, state } = world(overrides);
  const result = await fixture.run(["site", "check", "--json", ...argv], { env, fetch });
  const report = JSON.parse(result.stdout);
  const byName = Object.fromEntries(report.checks.map((entry) => [entry.name, entry]));
  return { ...result, report, byName, fetch, state };
}

const notReady = (report) =>
  report.checks.filter(({ status }) => status === "not-ready").map(({ name }) => name);

test("a commerce Site whose CMS, storefront, legal pages and media hold is ready", async () => {
  const { code, report, byName, fetch } = await check();

  assert.equal(code, 0, JSON.stringify(notReady(report)));
  assert.equal(report.status, "ready");
  for (const name of [
    "wordpress",
    "plugins",
    "store-api",
    "theme",
    "proxy-secret",
    "homepage",
    "cart",
    "customer-auth",
    "turnstile",
    "rate-limiters",
    "legal-pages",
    "consent-runtime",
    "third-party-hosts",
    "upload",
  ]) {
    assert.equal(byName[name]?.status, "ok", `${name}: ${byName[name]?.detail}`);
  }
  assert.deepEqual(
    [...new Set(report.checks.map(({ area }) => area))],
    ["cms", "frontend", "consent", "media"],
  );
  assert.match(byName["proxy-secret"].detail, /customer sign-in is on/u);
  assert.match(byName.cart.detail, /the second found the same cart/u);
  // Nothing creates an order or a customer: no checkout, no WordPress sign-in.
  const paths = fetch.requests.map(({ method, url }) => `${method} ${new URL(url).pathname}`);
  assert.ok(!paths.some((path) => /checkout/u.test(path)), paths.join("\n"));
  assert.equal(paths.filter((path) => path === "GET /api/store/v1/cart").length, 2);
});

test("the text report names the storefront, and never shows a secret", async () => {
  const fixture = await createFixtureSite({ ops: OPS });
  const { fetch } = world();

  const result = await fixture.run(["site", "check"], { env: SECRETS, fetch });

  assert.equal(result.code, 0, result.stdout);
  for (const heading of ["CMS:", "Storefront:", "Consent and legal pages:", "Independent media:"]) {
    assert.ok(result.stdout.includes(`\n${heading}\n`), heading);
  }
  assert.match(result.stdout, /^Ready: the CMS serves WooCommerce's Store API/mu);
  assert.match(result.stdout, /Payments, shipping, tax and checkout aren't checked/u);
  for (const secret of Object.values(SECRETS)) {
    assert.ok(!result.stdout.includes(secret) || secret === "shop.example.test", secret);
  }
});

test("with customer sign-in off, the Site is ready and the Worker's proxy secret is a warning", async () => {
  const { code, byName } = await check({ signIn: false });

  assert.equal(code, 0);
  assert.equal(byName["proxy-secret"].status, "ok");
  assert.match(byName["proxy-secret"].detail, /customer sign-in is off/u);
  assert.equal(byName["customer-auth"].status, "warn");
  assert.match(byName["customer-auth"].detail, /isn't proven/u);
  assert.equal(byName.turnstile.status, "skipped");
});

test("a Worker with another proxy secret than the CMS's is not ready once sign-in is on", async () => {
  const { code, byName } = await check({
    workerProxySecret: "another-secret-of-thirty-two-characters",
  });

  assert.equal(code, 1);
  assert.equal(byName["proxy-secret"].status, "ok", "the CMS holds Sigillo's");
  assert.equal(byName["customer-auth"].status, "not-ready");
  assert.match(
    byName["customer-auth"].detail,
    /Worker's GETQUICK_STOREFRONT_PROXY_SECRET differs/u,
  );
  assert.match(byName["customer-auth"].action, /pnpm ci:deploy/u);
});

test("a CMS without Sigillo's proxy secret is not ready, and says how to give it", async () => {
  const { code, byName } = await check({ cmsProxySecret: null });

  assert.equal(code, 1);
  assert.equal(byName["proxy-secret"].status, "not-ready");
  assert.match(byName["proxy-secret"].detail, /missing or different one \(values not shown\)/u);
  assert.match(byName["proxy-secret"].action, /pnpm ploi:provision, then release the CMS/u);
  assert.equal(byName.turnstile.status, "skipped");
});

test("without Sigillo, the proxy secret and the check user are asked for", async () => {
  const { code, byName } = await check({}, { env: { PLOI_API_TOKEN: SECRETS.PLOI_API_TOKEN } });

  assert.equal(code, 1);
  for (const name of ["proxy-secret", "theme"]) {
    assert.equal(byName[name].status, "not-ready", name);
    assert.match(byName[name].action, /gq sigillo run staging \(pnpm site:check\)/u, name);
  }
});

test("a CMS that isn't installed, or serves /wp-json/ with plain permalinks, is not ready", async () => {
  const installer = await check({ cms: "not-installed" });
  assert.equal(installer.code, 1);
  assert.match(installer.byName.wordpress.detail, /WordPress isn't installed/u);
  assert.equal(installer.byName.plugins, undefined);

  const plain = await check({ cms: "plain-permalinks" });
  assert.equal(plain.byName.wordpress.status, "not-ready");
  assert.match(plain.byName.wordpress.detail, /plain permalinks/u);
  assert.match(plain.byName.wordpress.action, /pretty ones/u);

  const down = await check({ cms: "down" });
  assert.match(down.byName.wordpress.detail, /doesn't answer/u);
});

test("a CMS without GQ eCommerce or GQ Design active names each", async () => {
  const { code, byName } = await check({
    routes: ["/wc/store/v1/cart", "/getquick-config/v1/storefront"],
  });

  assert.equal(code, 1);
  assert.equal(byName.plugins.status, "not-ready");
  assert.match(byName.plugins.detail, /GQ eCommerce \(getquick-ecommerce/u);
  assert.match(byName.plugins.detail, /GQ Design \(gq-design\)/u);
});

test("another active theme than getquick-theme or its child is not ready", async () => {
  const child = await check({ theme: { stylesheet: "shop-child", template: "getquick-theme" } });
  assert.equal(child.byName.theme.status, "ok");
  assert.match(child.byName.theme.detail, /shop-child, a child of getquick-theme/u);

  const other = await check({ theme: { stylesheet: "storefront", template: "storefront" } });
  assert.equal(other.byName.theme.status, "not-ready");
  assert.match(other.byName.theme.action, /10-theme\.sh/u);
});

test("an empty catalogue only warns: catalogue delivery isn't readiness", async () => {
  const { code, byName } = await check({ products: 0 });

  assert.equal(code, 0);
  assert.equal(byName["store-api"].status, "warn");
  assert.match(byName["store-api"].detail, /publishes no product/u);
});

test("the cart round-trip names an unmounted Runtime, unbound cart sessions and a forgotten handle", async () => {
  const unmounted = await check({ mounted: false });
  assert.equal(unmounted.byName.cart.status, "not-ready");
  assert.match(unmounted.byName.cart.detail, /isn't mounted at \/api\/store/u);
  assert.equal(unmounted.byName["rate-limiters"].status, "not-ready");

  const unbound = await check({ cartSessions: "unbound" });
  assert.equal(unbound.byName.cart.status, "not-ready");
  assert.match(unbound.byName.cart.detail, /CART_SESSIONS D1 database isn't bound or migrated/u);

  const forgetful = await check({ cartSessions: "forgetful" });
  assert.equal(forgetful.byName.cart.status, "not-ready");
  assert.match(forgetful.byName.cart.detail, /given a new cart handle/u);
});

test("unbound rate limiters are not ready: the sign-in probe isn't refused at Turnstile", async () => {
  const { code, byName, fetch } = await check({ rateLimiters: false });

  assert.equal(code, 1);
  assert.equal(byName["rate-limiters"].status, "not-ready");
  assert.match(byName["rate-limiters"].action, /cloudflare\.rateLimitNamespaces/u);
  assert.ok(
    !fetch.requests.some(({ url }) => url.includes("shop-cms") && url.includes("/auth/login")),
    "the probe never reaches WordPress",
  );
});

test("sign-in on without Turnstile's pair in Sigillo is not ready", async () => {
  const env = { ...SECRETS };
  delete env.TURNSTILE_SECRET;
  const { code, byName } = await check({}, { env });

  assert.equal(code, 1);
  assert.equal(byName.turnstile.status, "not-ready");
  assert.match(byName.turnstile.detail, /no TURNSTILE_SECRET/u);
});

test("a storefront homepage Cloudflare's edge could cache is not ready", async () => {
  const edge = await check({ homeHeaders: { "cf-cache-status": "HIT" } });
  assert.equal(edge.byName.homepage.status, "not-ready");
  assert.match(edge.byName.homepage.detail, /cacheable at Cloudflare's edge/u);

  const shared = await check({ homeHeaders: { "cache-control": "public, max-age=600" } });
  assert.equal(shared.byName.homepage.status, "not-ready");

  const private_ = await check({ homeHeaders: { "cache-control": "private, no-store" } });
  assert.equal(private_.byName.homepage.status, "ok");
});

test("legal pages GQ Config doesn't assign, commerce roles included, are not ready", async () => {
  const { code, byName } = await check({
    legal: {
      controller: { name: "", privacyEmail: "", dpoContact: null },
      languages: { pt: { roles: [] } },
      missingRequired: ["terms_of_sale", "returns_policy"],
    },
  });

  assert.equal(code, 1);
  assert.equal(byName["legal-pages"].status, "not-ready");
  assert.match(byName["legal-pages"].detail, /terms_of_sale, returns_policy/u);
  assert.match(byName["legal-pages"].detail, /controller_incomplete/u);
});

test("GA4 on without the consent Runtime on the storefront is not ready", async () => {
  const { byName } = await check({ analytics: true });
  assert.equal(byName["consent-runtime"].status, "not-ready");
});

test("--url checks another storefront origin", async () => {
  const fixture = await createFixtureSite({ ops: OPS });
  const { fetch } = world();
  const result = await fixture.run(
    ["site", "check", "--json", "--url", "https://shop.example.test"],
    { env: SECRETS, fetch },
  );
  assert.equal(result.code, 0, result.stdout);
});

// --- the local CMS -------------------------------------------------------------

test("--local checks the DDEV CMS's REST API, plugins, Store API and theme, and nothing in production", async () => {
  const fixture = await createFixtureSite({
    ops: OPS,
    files: { "apps/cms/.env": "WP_HOME='https://shop-admin.ddev.site'\n" },
  });
  const exec = recordingExec(({ command, args }) => {
    if (command === "mkcert") return { code: 1 };
    if (command === "ddev" && args[0] === "describe") {
      return { stdout: JSON.stringify({ raw: { status: "running" } }) };
    }
    if (command === "ddev" && args[0] === "wp" && args[1] === "eval") {
      return { stdout: '{"stylesheet":"getquick-theme","template":"getquick-theme"}\n' };
    }
    return { code: 1, stderr: `unexpected ${command}` };
  });
  const fetch = recordingFetch(({ url }) => {
    const { origin, pathname } = new URL(url);
    assert.equal(origin, "https://shop-admin.ddev.site");
    if (pathname === "/wp-json/") {
      return { routes: Object.fromEntries(COMMERCE_ROUTES.map(([route]) => [route, {}])) };
    }
    if (pathname === "/wp-json/wc/store/v1/products") {
      return new Response("[]", {
        headers: { "content-type": "application/json", "x-wp-total": "0" },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  const result = await fixture.run(["site", "check", "--local", "--json"], {
    exec,
    fetch,
    env: SECRETS,
  });
  const report = JSON.parse(result.stdout);
  const byName = Object.fromEntries(report.checks.map((entry) => [entry.name, entry]));

  assert.equal(result.code, 0, result.stdout);
  assert.equal(report.scope, "local");
  for (const name of ["ddev", "wordpress", "plugins", "theme", "local-uploads"]) {
    assert.equal(byName[name]?.status, "ok", name);
  }
  assert.equal(byName["store-api"].status, "warn");
  assert.equal(byName["proxy-secret"], undefined, "the proxy secret is production's");
});

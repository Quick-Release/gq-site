// Whether a commerce Site is ready (ADR 0021): its CMS serves WooCommerce's
// Store API and GQ eCommerce's customer auth, its storefront's Worker carries
// a shopper's cart to WooCommerce and back, the Worker and the CMS share the
// storefront's proxy secret, and its legal pages and media hold as a content
// Site's do. Each part is checked where it can be observed, never by reading
// configuration alone:
//
//   cms       WordPress serves its REST API at /wp-json/ (installed, pretty
//             permalinks), whose index has the routes WooCommerce, GQ Config,
//             GQ eCommerce and GQ Design register; the active theme is
//             getquick-theme or a child of it (read as the CMS check user);
//             the Store API lists products; and GQ eCommerce's customer auth
//             accepts Sigillo staging's proxy secret, and says whether
//             customer sign-in is on.
//   frontend  the storefront's homepage is served by its Worker with no
//             cache that could outlive a price, stock or cart change; a cart
//             round-trips through the storefront Runtime's BFF (the first
//             request starts a WooCommerce cart and keeps its handle in
//             CART_SESSIONS, the second finds the same cart by it); with
//             sign-in on, the Worker reaches the customer auth with the CMS's
//             proxy secret and Turnstile is configured; and a sign-in probe
//             for a made-up account passes the rate limiters and is refused at
//             Turnstile, before WordPress.
//   consent   GQ Config's storefront settings: the Legal Contract names every
//             required legal page (commerce roles included) and the data
//             controller, an optional service it switches on has the consent
//             Runtime to gate it, and the homepage loads nothing from a
//             third-party host.
//   media     `gq media check --upload`, as on a content Site.
//
// Nothing creates an order, a customer or a sign-in. The cart probe leaves
// what a visitor's first cart read leaves (an empty guest cart, whose handle
// expires on its own), and the media probe deletes what it uploads. Checkout
// isn't probed: the Store API's GET /checkout creates a draft order. The
// proxy secret is only ever sent to the CMS's own origin, as the header the
// storefront sends, and never shown.

import { cmsFetch } from "../cms/access.mjs";
import { CHECK_PASSWORD, CHECK_USER, productionMediaReadiness } from "../media/readiness.mjs";
import {
  hostsCheck,
  legalCheck,
  messageOf,
  notReady,
  ok,
  publicPages,
  result,
  runtimeCheck,
  skipped,
  warn,
} from "./readiness.mjs";

const TIMEOUT = 30_000;
const PROXY_SECRET = "GETQUICK_STOREFRONT_PROXY_SECRET";
const PROXY_HEADER = "x-getquick-storefront-proxy";
const TURNSTILE = ["TURNSTILE_SECRET", "TURNSTILE_EXPECTED_HOSTNAMES"];
const THEME = "getquick-theme";
const THROUGH_SIGILLO = "run this through gq sigillo run staging (pnpm site:check)";
const RELEASE_CMS =
  "release the CMS once WordPress is installed (pnpm push fix): its deploy activates gq.ops.json wordpress.plugins and getquick-theme, and gives a site with plain permalinks pretty ones";
const DEPLOY_FRONTEND =
  "deploy the Frontend (a release, or pnpm deploy:frontend), then check again";
const BIND_SECRETS =
  "run pnpm frontend:secrets if Sigillo staging lacks one, then pnpm ci:deploy and release the Frontend (or pnpm deploy:frontend), so the Worker binds Sigillo staging's secrets";
const MOUNT_RUNTIME =
  "mount the storefront Runtime at /api/store/* and /api/auth/* (docs/guides/storefront-runtime.md), and deploy the Frontend";

/**
 * What the storefront reads on the CMS, as REST routes in WordPress's index,
 * and the plugin that registers each. GQ Config is a must-use plugin, which
 * GQ eCommerce's customer auth also needs.
 */
export const COMMERCE_ROUTES = Object.freeze([
  ["/wc/store/v1/cart", "WooCommerce (its Store API)"],
  ["/getquick-config/v1/storefront", "GQ Config (the storefront's settings and Legal Contract)"],
  [
    "/getquick-config/v1/woocommerce/auth/health",
    "GQ eCommerce (getquick-ecommerce: customer accounts)",
  ],
  ["/getquick-design/v1", "GQ Design (gq-design)"],
]);

// What a sign-in probe sends: a made-up account (example.invalid never
// resolves) and a token Turnstile can't accept, so it is refused at the
// Worker after its rate limiters and before WordPress.
const SIGN_IN_PROBE = Object.freeze({
  provider: "password",
  identifier: "gq-site-check@example.invalid",
  password: "gq-site-check: never a password",
  remember: false,
  turnstileToken: "gq-site-check.not-a-turnstile-token",
});

// --- the CMS -----------------------------------------------------------------

/**
 * The commerce CMS at `origin` (a URL): `{ checks, signIn }`, where signIn is
 * "available", "off" or "unknown", as GQ eCommerce's customer auth reports it
 * to the storefront's proxy secret. `local` skips what needs Sigillo (the
 * check user and the proxy secret): a local CMS's theme is read by wp-cli.
 */
export async function commerceCmsReadiness({ origin, env = {}, fetch, local = false }) {
  const cms = cmsFetch({ env, origin: origin.href, fetch });
  const checks = [];
  const add = (check) => checks.push({ area: "cms", ...check });
  const index = await restIndex(cms, origin);
  add(index.check);
  if (!index.routes) return { checks, signIn: "unknown" };
  add(pluginsCheck(index.routes));
  add(await storeApiCheck(cms, origin));
  if (local) return { checks, signIn: "unknown" };
  add(await restThemeCheck(cms, origin, env));
  const proxy = await proxySecretCheck(cms, origin, env);
  add(proxy.check);
  return { checks, signIn: proxy.signIn };
}

async function restIndex(fetch, origin) {
  const name = "wordpress";
  const url = new URL("/wp-json/", origin);
  let response;
  try {
    response = await get(fetch, url);
  } catch (error) {
    return {
      check: notReady(
        name,
        `${origin.origin} doesn't answer: ${messageOf(error)}`,
        "check the CMS's host, DNS and certificate (pnpm ploi:provision), or start it",
      ),
    };
  }
  const location = response.headers.get("location") ?? "";
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return {
      check: location.includes("install.php")
        ? notReady(
            name,
            `WordPress isn't installed at ${origin.origin}: it redirects to its installer`,
            `install it at ${new URL(location, url).href}, then ${RELEASE_CMS}`,
          )
        : notReady(
            name,
            `${url.href} redirects to ${location || "nowhere"} instead of serving WordPress's REST API: with plain permalinks, GQ Config's headless routing sends it to the Frontend, so the storefront's Store API and auth upstreams fail`,
            `${RELEASE_CMS} (or set Settings → Permalinks), and check that domains.admin is the CMS's own host`,
          ),
    };
  }
  const answer = await response.json().catch(() => null);
  if (!response.ok || typeof answer?.routes !== "object" || answer.routes === null) {
    return {
      check: notReady(
        name,
        `${url.href} isn't WordPress's REST index (HTTP ${response.status})`,
        "check that domains.admin is the CMS's host and that nothing (a security plugin, a cache or WAF rule) blocks /wp-json/",
      ),
    };
  }
  return {
    check: ok(name, `WordPress is installed and serves its REST API at ${url.href}`),
    routes: answer.routes,
  };
}

function pluginsCheck(routes) {
  const name = "plugins";
  const missing = COMMERCE_ROUTES.filter(([route]) => !(route in routes));
  if (missing.length > 0) {
    return notReady(
      name,
      `the REST API lacks ${missing.map(([route, plugin]) => `${route} (${plugin})`).join(", ")}: ${missing.length > 1 ? "those plugins aren't" : "that plugin isn't"} active`,
      RELEASE_CMS,
    );
  }
  return ok(
    name,
    "WooCommerce's Store API, GQ Config's storefront settings, GQ eCommerce's customer auth and GQ Design answer on the REST API",
  );
}

/** The Store API's catalogue, as the storefront reads it: anonymous, one product. */
async function storeApiCheck(fetch, origin) {
  const name = "store-api";
  const url = new URL("/wp-json/wc/store/v1/products?per_page=1", origin);
  let response;
  try {
    response = await get(fetch, url);
  } catch (error) {
    return notReady(name, `${url.href} doesn't answer: ${messageOf(error)}`, "retry");
  }
  const answer = await response.json().catch(() => null);
  if (response.status !== 200 || !Array.isArray(answer)) {
    return notReady(
      name,
      `WooCommerce's Store API answered ${url.href} with HTTP ${response.status}${answer?.code ? ` (${answer.code})` : ""}, not a product list`,
      RELEASE_CMS,
    );
  }
  const total = Number(response.headers.get("x-wp-total") ?? answer.length);
  if (total === 0) {
    return warn(
      name,
      "WooCommerce's Store API answers, but publishes no product: the shop is empty",
      "publish products in WooCommerce",
    );
  }
  return ok(
    name,
    `WooCommerce's Store API answers at ${new URL("/wp-json/wc/store/v1/", origin).href} (${total} published product${total === 1 ? "" : "s"})`,
  );
}

/** The active theme, as the CMS check user (an Author or above) can read it. */
async function restThemeCheck(fetch, origin, env) {
  const name = "theme";
  const user = env[CHECK_USER]?.trim();
  const password = env[CHECK_PASSWORD]?.trim();
  if (!user || !password) {
    return notReady(
      name,
      `${CHECK_USER} and ${CHECK_PASSWORD} are missing here, so the active theme can't be read`,
      `${THROUGH_SIGILLO}; the media upload probe needs the same check user`,
    );
  }
  const url = new URL("/wp-json/wp/v2/themes?status=active&_fields=stylesheet,template", origin);
  let response;
  try {
    response = await get(fetch, url, { Authorization: `Basic ${btoa(`${user}:${password}`)}` });
  } catch (error) {
    return notReady(name, `the active theme couldn't be read: ${messageOf(error)}`, "retry");
  }
  const answer = await response.json().catch(() => null);
  if (response.status === 401 || response.status === 403) {
    return notReady(
      name,
      `the CMS check user can't read the active theme (HTTP ${response.status}${answer?.code ? `, ${answer.code}` : ""})`,
      `give ${CHECK_USER} an Author's role or above and a current application password in Sigillo staging (${CHECK_PASSWORD})`,
    );
  }
  if (!response.ok || !Array.isArray(answer) || !answer[0]) {
    return notReady(name, `the active theme couldn't be read (HTTP ${response.status})`, "retry");
  }
  return themeCheck(answer[0]);
}

/** Whether the active theme (its `stylesheet`, and `template`, its parent's) is getquick-theme or a child of it. */
export function themeCheck({ stylesheet, template }) {
  const name = "theme";
  if (template === THEME) {
    return ok(
      name,
      stylesheet === THEME
        ? `${THEME} is the active theme`
        : `${stylesheet}, a child of ${THEME}, is the active theme`,
    );
  }
  return notReady(
    name,
    `the active theme is ${stylesheet || "unknown"}, not ${THEME} or a child of it`,
    `release the CMS (pnpm push fix): deploy/ploi/admin.d/10-theme.sh activates ${THEME}`,
  );
}

/**
 * GQ eCommerce's customer auth, asked for its health with Sigillo staging's
 * proxy secret, as the storefront asks: it checks the secret before
 * anything else, so any answer but 401 proves the CMS holds the same one.
 */
async function proxySecretCheck(fetch, origin, env) {
  const name = "proxy-secret";
  const secret = env[PROXY_SECRET]?.trim();
  if (!secret) {
    return {
      signIn: "unknown",
      check: notReady(
        name,
        `${PROXY_SECRET} is missing here`,
        `${THROUGH_SIGILLO}; if Sigillo staging lacks it, run pnpm frontend:secrets, then pnpm ploi:provision and release the CMS`,
      ),
    };
  }
  const url = new URL("/wp-json/getquick-config/v1/woocommerce/auth/health", origin);
  let response;
  try {
    response = await get(fetch, url, { [PROXY_HEADER]: secret });
  } catch (error) {
    return {
      signIn: "unknown",
      check: notReady(name, `${url.href} doesn't answer: ${messageOf(error)}`, "retry"),
    };
  }
  const answer = await response.json().catch(() => null);
  const holds = `the CMS holds Sigillo staging's ${PROXY_SECRET} (GQ eCommerce compared it; values not shown)`;
  if (response.status === 200 && answer?.status === "available") {
    return {
      signIn: "available",
      check: ok(
        name,
        `${holds}, and customer sign-in is on (registration ${answer.registration?.enabled ? "open" : "closed"})`,
      ),
    };
  }
  if (response.status === 503 && answer?.code === "getquick_auth_unavailable") {
    return {
      signIn: "off",
      check: ok(
        name,
        `${holds}; customer sign-in is off (GQ Config's customer accounts setting), so shoppers check out as guests`,
      ),
    };
  }
  if (response.status === 401) {
    return {
      signIn: "unknown",
      check: notReady(
        name,
        `the CMS refuses Sigillo staging's ${PROXY_SECRET}: its .env has a missing or different one (values not shown), so signed-in shoppers can't use the storefront`,
        "run pnpm ploi:provision, then release the CMS (pnpm push fix)",
      ),
    };
  }
  return {
    signIn: "unknown",
    check: notReady(
      name,
      `GQ eCommerce's customer auth answered ${url.href} with HTTP ${response.status}${answer?.code ? ` (${answer.code})` : ""}`,
      RELEASE_CMS,
    ),
  };
}

// --- the storefront --------------------------------------------------------------

/**
 * The deployed storefront at `origin` (a URL). `signIn` is what the CMS
 * reported (commerceCmsReadiness); `env` holds Sigillo staging's names.
 */
export async function storefrontReadiness({ origin, env = {}, fetch, signIn = "unknown" }) {
  const checks = [];
  const add = (check) => checks.push({ area: "frontend", ...check });
  add(await homepageCheck(fetch, origin));
  add(await cartCheck(fetch, origin));
  add(await customerAuthCheck(fetch, origin, signIn));
  add(turnstileCheck(env, signIn));
  add(await rateLimitersCheck(fetch, origin));
  return checks;
}

// Statuses Cloudflare gives a response its edge cache could hold.
const EDGE_CACHED = /^(hit|miss|expired|stale|updating|revalidated)$/iu;

/** The homepage is the Worker's own render, with nothing caching it. */
async function homepageCheck(fetch, origin) {
  const name = "homepage";
  const url = new URL("/", origin);
  let response;
  try {
    response = await get(fetch, url, { Accept: "text/html" });
    await response.body?.cancel();
  } catch (error) {
    return notReady(name, `${url.href} doesn't answer: ${messageOf(error)}`, DEPLOY_FRONTEND);
  }
  if (response.status !== 200) {
    return notReady(name, `${url.href} answers HTTP ${response.status}`, DEPLOY_FRONTEND);
  }
  const cacheControl = response.headers.get("cache-control") ?? "";
  const edge = response.headers.get("cf-cache-status") ?? "";
  const shared =
    /\b(public|s-maxage)\b/iu.test(cacheControl) && !/\b(private|no-store)\b/iu.test(cacheControl);
  if (EDGE_CACHED.test(edge) || shared) {
    return notReady(
      name,
      `${url.href} is ${EDGE_CACHED.test(edge) ? `cacheable at Cloudflare's edge (cf-cache-status: ${edge})` : `shared-cacheable (Cache-Control: ${cacheControl})`}, so a cached page could outlive a price, stock or cart change`,
      "remove any cache rule for the storefront's host, and send no public or s-maxage Cache-Control from its pages",
    );
  }
  return ok(
    name,
    `${url.href} answers HTTP 200 from the Worker, uncached (Cache-Control: ${cacheControl || "none"})`,
  );
}

// The cart handle's cookie: __Host-getquick_cart over HTTPS, another name on
// a loopback origin. A handle is 32 random bytes, base64url.
const CART_COOKIE = /(^|[\s,;])([\w-]*getquick_cart)=([A-Za-z0-9_-]{43})(?=;|$)/u;

/**
 * A cart, round-tripped through the storefront Runtime's BFF: the first read
 * starts a WooCommerce cart and keeps its handle in CART_SESSIONS (a cookie),
 * and a second read with the cookie finds the same cart instead of starting
 * another. Proves the Store API through the Worker, the D1 binding and its
 * migrations, both keyrings and the Store API URL.
 */
async function cartCheck(fetch, origin) {
  const name = "cart";
  const url = new URL("/api/store/v1/cart", origin);
  let first;
  try {
    first = await readJson(fetch, url);
  } catch (error) {
    return notReady(name, `${url.href} doesn't answer: ${messageOf(error)}`, DEPLOY_FRONTEND);
  }
  if (!isCart(first)) return storeProblem(name, url, first, "the first cart read");
  const handle = cartHandle(first.headers);
  if (!handle) {
    return notReady(
      name,
      `${url.href} answered a cart but kept no handle for it (no getquick_cart cookie), so each request starts a new cart`,
      "update @quick-release/storefront and deploy the Frontend",
    );
  }
  let second;
  try {
    second = await readJson(fetch, url, { Cookie: `${handle.cookie}=${handle.value}` });
  } catch (error) {
    return notReady(name, `${url.href} doesn't answer: ${messageOf(error)}`, DEPLOY_FRONTEND);
  }
  if (!isCart(second))
    return storeProblem(name, url, second, "the second cart read, with the handle");
  const renewed = cartHandle(second.headers);
  if (renewed && renewed.value !== handle.value) {
    return notReady(
      name,
      "the second cart read was given a new cart handle: the Worker didn't find the first in CART_SESSIONS, so every request starts a new cart",
      "check the Worker's CART_SESSIONS binding and its D1 database in the Cloudflare dashboard, then deploy the Frontend",
    );
  }
  const currency = first.body.totals?.currency_code;
  return ok(
    name,
    `${url.href} carries a WooCommerce cart${currency ? ` (${currency})` : ""} through the Worker: the first read started it and kept its handle in CART_SESSIONS (${handle.cookie}, HttpOnly), and the second found the same cart by it`,
  );
}

function isCart({ status, body }) {
  return status === 200 && Array.isArray(body?.items);
}

function cartHandle(headers) {
  const cookies = headers.getSetCookie?.() ?? [headers.get("set-cookie") ?? ""];
  for (const cookie of cookies) {
    const match = CART_COOKIE.exec(cookie);
    if (match) return { cookie: match[2], value: match[3] };
  }
  return null;
}

// A Store API BFF answer that isn't a cart, by the Runtime's own codes.
function storeProblem(name, url, { status, body, json }, which) {
  if (!json) {
    return notReady(
      name,
      `${url.href} answers HTTP ${status} without JSON: the storefront Runtime isn't mounted at /api/store/*`,
      MOUNT_RUNTIME,
    );
  }
  const code = body?.code;
  if (code === "getquick_cart_unavailable") {
    return notReady(
      name,
      `${which} answered HTTP ${status} (${code}): the Worker can't read or write its cart sessions, so the CART_SESSIONS D1 database isn't bound or migrated, or GETQUICK_CART_SESSION_SECRET changed since its carts were kept`,
      "deploy the Frontend: it binds CART_SESSIONS and applies its migrations first; the Cloudflare dashboard shows the database",
    );
  }
  if (code === "getquick_store_unavailable") {
    return notReady(
      name,
      `${which} answered HTTP ${status} (${code}): a storefront secret (${PROXY_SECRET}, GETQUICK_AUTH_COOKIE_SECRET or GETQUICK_CART_SESSION_SECRET), GETQUICK_ENVIRONMENT or CART_SESSIONS isn't bound or valid, or WooCommerce didn't start a cart`,
      `${BIND_SECRETS}; the CMS checks above say whether WooCommerce answers`,
    );
  }
  return notReady(
    name,
    `${which} answered HTTP ${status}${code ? ` (${code})` : ""}, not a cart`,
    status === 404 ? MOUNT_RUNTIME : DEPLOY_FRONTEND,
  );
}

/**
 * The Worker's customer auth: its configuration read is the only one that
 * reaches GQ eCommerce without a customer, and answers only when the Worker
 * sends the proxy secret the CMS holds. With sign-in off, the CMS answers it
 * as unavailable after accepting the secret, and storefront 0.2.2 relays a
 * refused secret the same way, so the Worker's secret can't be proven.
 */
async function customerAuthCheck(fetch, origin, signIn) {
  const name = "customer-auth";
  const url = new URL("/api/auth/configuration", origin);
  let answer;
  try {
    answer = await readJson(fetch, url);
  } catch (error) {
    return notReady(name, `${url.href} doesn't answer: ${messageOf(error)}`, DEPLOY_FRONTEND);
  }
  const { status, body, json } = answer;
  if (status === 200 && body?.status === "available") {
    return ok(
      name,
      `the Worker reaches GQ eCommerce's customer auth (GETQUICK_AUTH_UPSTREAM_URL) with the proxy secret the CMS holds: sign-in is available`,
    );
  }
  if (!json) {
    return notReady(
      name,
      `${url.href} answers HTTP ${status} without JSON: the storefront Runtime isn't mounted at /api/auth/*`,
      MOUNT_RUNTIME,
    );
  }
  const answered = `${url.href} answers HTTP ${status}${body?.code ? ` (${body.code})` : ""}`;
  if (signIn === "off") {
    return warn(
      name,
      `${answered}, as it must while customer sign-in is off; so the Worker's ${PROXY_SECRET} isn't proven: @quick-release/storefront 0.2.2 answers a secret the CMS refuses the same way`,
      "nothing to do while sign-in stays off; once it is on, check again before shoppers sign in",
    );
  }
  if (signIn === "available") {
    return notReady(
      name,
      `the CMS has customer sign-in on and holds Sigillo staging's ${PROXY_SECRET}, but ${answered}: the Worker's ${PROXY_SECRET} differs, or GETQUICK_AUTH_UPSTREAM_URL, GETQUICK_AUTH_COOKIE_SECRET or Turnstile's pair isn't bound`,
      BIND_SECRETS,
    );
  }
  return skipped(
    name,
    `${answered}; unknown until the CMS's customer auth answers Sigillo staging's ${PROXY_SECRET}`,
  );
}

/**
 * Turnstile, which sign-in, registration and recovery need when sign-in is
 * on. Only a browser solving a challenge proves the Worker's secret, so this
 * is Sigillo staging's configuration, which the Frontend's deploy binds.
 */
function turnstileCheck(env, signIn) {
  const name = "turnstile";
  if (signIn === "off") {
    return skipped(name, "customer sign-in is off, so no Turnstile challenge is needed");
  }
  if (signIn !== "available") {
    return skipped(name, "unknown until the CMS says whether customer sign-in is on");
  }
  const missing = TURNSTILE.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    return notReady(
      name,
      `customer sign-in is on, but Sigillo staging has no ${missing.join(" or ")}: the Worker refuses every sign-in, registration and recovery`,
      "create a Turnstile widget for the storefront's host in Cloudflare, store TURNSTILE_SECRET and TURNSTILE_EXPECTED_HOSTNAMES in Sigillo staging, then pnpm ci:deploy and release the Frontend",
    );
  }
  return ok(
    name,
    `Sigillo staging has ${TURNSTILE.join(" and ")}, which the Frontend's deploy binds (only a solved challenge proves the Worker's)`,
  );
}

/**
 * The three rate limiters, which the Worker checks before Turnstile on every
 * sign-in: a probe for a made-up account with a token Turnstile refuses is
 * answered 422 only once all three are bound, and never reaches WordPress.
 */
async function rateLimitersCheck(fetch, origin) {
  const name = "rate-limiters";
  const url = new URL("/api/auth/login", origin);
  let answer;
  try {
    answer = await readJson(fetch, url, {
      Origin: origin.origin,
      "Content-Type": "application/json",
      method: "POST",
      body: JSON.stringify(SIGN_IN_PROBE),
    });
  } catch (error) {
    return notReady(name, `${url.href} doesn't answer: ${messageOf(error)}`, DEPLOY_FRONTEND);
  }
  const { status, body, json } = answer;
  const limiters =
    "AUTH_IDENTIFIER_RATE_LIMITER, AUTH_IP_RATE_LIMITER and AUTH_PENALTY_RATE_LIMITER";
  if (status === 422 && body?.code === "getquick_auth_turnstile_failed") {
    return ok(
      name,
      `${limiters} are bound: a sign-in probe for a made-up account passed them and was refused at Turnstile, before WordPress`,
    );
  }
  if (status === 429) {
    return ok(name, `${limiters} are bound and counting: they rate-limited the sign-in probe`);
  }
  if (!json) {
    return notReady(
      name,
      `${url.href} answers HTTP ${status} without JSON: the storefront Runtime isn't mounted at /api/auth/*`,
      MOUNT_RUNTIME,
    );
  }
  return notReady(
    name,
    `a sign-in probe for a made-up account was answered HTTP ${status}${body?.code ? ` (${body.code})` : ""}, not refused at Turnstile: a rate limiter, or GETQUICK_AUTH_UPSTREAM_URL, isn't bound`,
    "record the Site's cloudflare.rateLimitNamespaces (docs/guides/commerce-sites.md#rate-limit-namespaces), then deploy the Frontend",
  );
}

// --- consent and legal pages ---------------------------------------------------

/**
 * CONSENT-1 and LEGAL-1 on a commerce Site: GQ Config's storefront settings
 * (the REST read the storefront Runtime's consent adapter makes) give the GA4
 * toggle and the Legal Contract, commerce roles included; the homepage is
 * scanned as a content Site's is.
 */
export async function commerceConsentReadiness({ ops, env = {}, fetch, origin, cmsOrigin }) {
  const settings = await storefrontSettings(
    cmsFetch({ env, origin: cmsOrigin.href, fetch }),
    cmsOrigin,
  );
  const pages = await publicPages({ origin, fetch, languages: [] });
  return [
    legalCheck(settings, []),
    runtimeCheck(settings, pages),
    hostsCheck(pages, ops, origin),
  ].map((check) => ({ area: "consent", ...check }));
}

async function storefrontSettings(fetch, origin) {
  const url = new URL("/wp-json/getquick-config/v1/storefront", origin);
  try {
    const response = await get(fetch, url);
    const answer = await response.json().catch(() => null);
    if (response.status === 404) return { outdated: `${url.pathname} answers HTTP 404` };
    if (!response.ok || !answer) return { error: `${url.href} answered HTTP ${response.status}` };
    if (!answer.legal) return { outdated: "its storefront settings have no Legal Contract" };
    const [language] = Object.values(answer.legal.languages ?? {});
    return {
      data: {
        googleAnalytics: {
          enabled: Boolean(answer.googleAnalyticsEnabled),
          measurementId: answer.googleAnalyticsMeasurementId ?? null,
        },
        legal: {
          controller: answer.legal.controller,
          roles: language?.roles ?? [],
          missingRequired: answer.legal.missingRequired ?? [],
        },
      },
    };
  } catch (error) {
    return { error: messageOf(error) };
  }
}

// --- the Site ------------------------------------------------------------------

/**
 * The production readiness of the commerce Site gq.ops.json describes.
 * `origin` is the storefront's (a URL; default https://<domains.frontend>).
 * `upload` runs the media upload probe, which readiness requires.
 */
export async function commerceSiteReadiness({
  ops,
  env,
  fetch,
  origin,
  upload = true,
  now = Date.now,
}) {
  const missing = [
    !ops.project && "project",
    !ops.domains?.admin && "domains.admin",
    !ops.domains?.frontend && !origin && "domains.frontend",
  ].filter(Boolean);
  if (missing.length > 0) {
    return result([
      {
        area: "cms",
        ...notReady(
          "config",
          `gq.ops.json lacks ${missing.join(", ")}`,
          "fill them in (docs/guides/provisioning.md), then gq sync",
        ),
      },
    ]);
  }
  const storefront = origin ?? new URL(`https://${ops.domains.frontend}`);
  const cmsOrigin = new URL(`https://${ops.domains.admin}`);
  const cms = await commerceCmsReadiness({ origin: cmsOrigin, env, fetch });
  const checks = [
    ...cms.checks,
    ...(await storefrontReadiness({ origin: storefront, env, fetch, signIn: cms.signIn })),
    ...(await commerceConsentReadiness({ ops, env, fetch, origin: storefront, cmsOrigin })),
  ];
  const media = await productionMediaReadiness({ ops, env, fetch, upload, now });
  return result([...checks, ...media.checks.map((check) => ({ area: "media", ...check }))]);
}

// --- requests ------------------------------------------------------------------

function get(fetch, url, headers = {}) {
  return fetch(url.href, {
    headers: { Accept: "application/json", ...headers },
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT),
  });
}

/** A request's status, headers and JSON body (json: false when it had none). */
async function readJson(fetch, url, { method = "GET", body, ...headers } = {}) {
  const response = await fetch(url.href, {
    method,
    headers: { Accept: "application/json", ...headers },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const type = response.headers.get("content-type") ?? "";
  const text = await response.text();
  let parsed;
  try {
    parsed = /json/iu.test(type) ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return {
    status: response.status,
    headers: response.headers,
    body: parsed,
    json: parsed !== undefined,
  };
}

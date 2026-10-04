// Test-side tools for the cart identity proof: the disposable store, a shopper's
// browser, and a tap that captures the upstream bearers an attacker might steal.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = import.meta.dirname;
const PROJECT = "gq-cart-identity-proof";

export function proofEnv() {
  const dir = process.env.GQ_PROOF_DIR ?? join(process.env.TMPDIR ?? tmpdir(), PROJECT);
  const run = (...args) =>
    execFileSync(join(HERE, "env.sh"), args, {
      encoding: "utf8",
      env: { ...process.env, GQ_PROOF_DIR: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
  return {
    url: `https://${PROJECT}.ddev.site`,
    customerPassword: () => readFileSync(join(dir, ".proof/customer-password"), "utf8").trim(),
    otherPassword: () => readFileSync(join(dir, ".proof/other-password"), "utf8").trim(),
    proxySecret: () => readFileSync(join(dir, ".proof/proxy-secret"), "utf8").trim(),
    reset: () => JSON.parse(run("reset").trim().split("\n").at(-1)),
    // Installs GQ eCommerce from the baseline ref or the candidate working tree.
    ecommerce: (version) => run("ecommerce", version),
    fault: (name) => run("fault", name),
    versions: () => JSON.parse(run("versions").trim().split("\n").at(-1)),
  };
}

// A browser: one cookie jar, same-origin JSON requests, and a transcript of everything
// the Frontend sent back so tests can prove no credential reached it.
export class Browser {
  constructor(origin) {
    this.origin = origin;
    this.cookies = new Map();
    this.transcript = [];
  }

  async request(method, path, body) {
    const headers = { Origin: this.origin };
    if (this.cookies.size) {
      headers.Cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    }
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(new URL(path, this.origin), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split(";");
      const [name, value] = pair.split("=");
      const expired = attributes.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (expired || value === "") this.cookies.delete(name.trim());
      else this.cookies.set(name.trim(), value.trim());
    }
    const text = await response.text();
    this.transcript.push({ headers: [...response.headers].map((h) => h.join(": ")), text });
    const json = response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null;
    return { status: response.status, headers: response.headers, json, text };
  }

  get(path) {
    return this.request("GET", path);
  }

  post(path, body = {}) {
    return this.request("POST", path, body);
  }

  everythingReceived() {
    return this.transcript.map((r) => `${r.headers.join("\n")}\n\n${r.text}`).join("\n");
  }
}

// Wraps the Frontend's upstream fetch and records every credential it exchanges
// with WordPress, in order, so a probe can reuse them as a thief would.
export function upstreamTap() {
  const exchanges = [];
  return {
    exchanges,
    async fetch(input, init = {}) {
      const request = new Request(input, init);
      const response = await fetch(request);
      exchanges.push({
        method: request.method,
        path: new URL(request.url).pathname,
        sentToken: request.headers.get("cart-token"),
        sentProxy: request.headers.get("x-getquick-storefront-proxy"),
        sentSession: request.headers.get("x-getquick-upstream-session"),
        receivedToken: response.headers.get("cart-token"),
        receivedSession: response.headers.get("x-getquick-upstream-session"),
      });
      return response;
    },
    // The last bearer WordPress issued to the Frontend: what an attacker holding a copy
    // of the Frontend's current credential would have.
    lastBearer() {
      return exchanges.findLast((e) => e.receivedToken)?.receivedToken;
    },
    // The customer's upstream session the Frontend currently forwards.
    lastLogin() {
      const e = exchanges.findLast((x) => x.sentSession);
      return e && { credential: e.sentSession };
    },
    secrets() {
      const values = new Set();
      for (const e of exchanges) {
        for (const value of [
          e.sentToken,
          e.sentProxy,
          e.sentSession,
          e.receivedToken,
          e.receivedSession,
        ]) {
          if (value) values.add(value);
        }
      }
      return [...values];
    },
  };
}

// Every URL form WordPress routes to a Store API endpoint. Routes match
// case-insensitively, and `rest_route` overrides the permalink path.
export const URL_FORMS = {
  pretty: (upstream, route) => `${upstream}/wp-json${route}`,
  query: (upstream, route) => `${upstream}/?rest_route=${encodeURIComponent(route)}`,
  upper: (upstream, route) => `${upstream}/wp-json${route.replace("/wc/store/", "/WC/Store/")}`,
  "query-upper": (upstream, route) =>
    `${upstream}/wp-json${route}?rest_route=${encodeURIComponent(route.toUpperCase())}`,
};

// The headers the storefront BFF sends to act as a signed-in customer.
function asCustomer(proxySecret, login) {
  return {
    "X-GetQuick-Storefront-Proxy": proxySecret,
    "X-GetQuick-Upstream-Session": login.credential,
  };
}

// Direct Store API access with a captured bearer and, by default, neither the proxy
// secret nor a customer session: the probe the spec requires alongside the
// shopper-facing seam. `login` presents a session as the BFF itself would.
export function storeApi(upstream, proxySecret) {
  const call = async (bearer, method, path, body, { form = "pretty", login } = {}) => {
    const headers = {};
    if (bearer) headers["Cart-Token"] = bearer;
    if (login) Object.assign(headers, asCustomer(proxySecret, login));
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(URL_FORMS[form](upstream, `/wc/store/v1${path}`), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => null);
    return { status: response.status, json, token: response.headers.get("cart-token") };
  };
  return {
    // Woo mints a bearer keyed by the customer's user ID for any logged-in Store API
    // request that carries no Cart-Token.
    mintNativeBearer: (login) => call(null, "GET", "/cart", undefined, { login }),
    cart: (bearer, options) => call(bearer, "GET", "/cart", undefined, options),
    addItem: (bearer, id, options) =>
      call(bearer, "POST", "/cart/add-item", { id, quantity: 1 }, options),
    updateItem: (bearer, key, quantity, options) =>
      call(bearer, "POST", "/cart/update-item", { key, quantity }, options),
    removeItem: (bearer, key, options) =>
      call(bearer, "POST", "/cart/remove-item", { key }, options),
    batch: (bearer, requests) => call(bearer, "POST", "/batch", { requests }),
  };
}

// GQ eCommerce's sign-in, called as the BFF would, presenting a guest bearer.
export async function signIn(upstream, proxySecret, bearer, identifier, password) {
  const response = await fetch(`${upstream}/wp-json/getquick-config/v1/woocommerce/auth/login`, {
    method: "POST",
    headers: {
      "X-GetQuick-Storefront-Proxy": proxySecret,
      "Content-Type": "application/json",
      ...(bearer ? { "Cart-Token": bearer } : {}),
    },
    body: JSON.stringify({ identifier, password, remember: false }),
  });
  return { status: response.status, token: response.headers.get("cart-token") };
}

// A shopper signed in on the WordPress site itself: native login cookies plus the REST
// nonce WordPress hands a signed-in browser.
export async function cookieLogin(upstream, username, password) {
  const login = await fetch(`${upstream}/wp-login.php`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: "wordpress_test_cookie=WP%20Cookie%20check",
    },
    body: new URLSearchParams({ log: username, pwd: password, testcookie: "1" }),
    redirect: "manual",
  });
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((pair) => /^wordpress_(sec_|logged_in_)?[0-9a-f]{32}=/.test(pair))
    .join("; ");
  const nonce = await fetch(`${upstream}/wp-admin/admin-ajax.php?action=rest-nonce`, {
    headers: { Cookie: cookie },
  });
  return { cookie, nonce: (await nonce.text()).trim() };
}

// Whether WordPress still accepts a customer's upstream session.
export async function stillSignedIn(upstream, proxySecret, login) {
  const response = await fetch(`${upstream}/wp-json/getquick-config/v1/woocommerce/auth/session`, {
    headers: asCustomer(proxySecret, login),
  });
  return response.ok && (await response.json()).status === "authenticated";
}

// The session key a Woo Cart-Token points to (its payload is unencrypted JSON).
export function sessionKey(bearer) {
  return JSON.parse(Buffer.from(bearer.split(".")[1], "base64url").toString()).user_id;
}

export function lines(cart) {
  return Object.fromEntries((cart?.items ?? []).map((item) => [item.name, item.quantity]));
}

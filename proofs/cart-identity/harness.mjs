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
    reset: () => JSON.parse(run("reset").trim().split("\n").at(-1)),
    extension: (state) => run("extension", state),
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
// with Woo, in order, so a probe can reuse them as a stolen bearer would be.
export function upstreamTap() {
  const exchanges = [];
  return {
    exchanges,
    async fetch(input, init = {}) {
      const request = new Request(input, init);
      const response = await fetch(request);
      exchanges.push({
        method: request.method,
        path: new URL(request.url).pathname + new URL(request.url).search,
        sentToken: request.headers.get("cart-token"),
        sentCookie: request.headers.get("cookie"),
        sentNonce: request.headers.get("x-wp-nonce"),
        receivedToken: response.headers.get("cart-token"),
        receivedCookies: response.headers.getSetCookie(),
      });
      return response;
    },
    // The last bearer Woo issued to the Frontend: what an attacker holding a copy of
    // the Frontend's current credential would have.
    lastBearer() {
      return exchanges.findLast((e) => e.receivedToken)?.receivedToken;
    },
    // The WordPress login the Frontend currently forwards, for minting a native bearer.
    lastLogin() {
      const e = exchanges.findLast((x) => x.sentNonce);
      return e && { cookie: e.sentCookie, nonce: e.sentNonce };
    },
    secrets() {
      const values = new Set();
      for (const e of exchanges) {
        for (const v of [e.sentToken, e.sentNonce, e.receivedToken]) if (v) values.add(v);
        for (const pair of (e.sentCookie ?? "").split(";")) {
          const value = pair.split("=").slice(1).join("=").trim();
          if (value.length > 16) values.add(value);
        }
        for (const cookie of e.receivedCookies) {
          const value = cookie.split(";")[0].split("=").slice(1).join("=");
          if (value.length > 16) values.add(value);
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

// Direct Store API access with a captured bearer, and by default no WordPress cookie:
// the probe the spec requires alongside the shopper-facing seam.
export function storeApi(upstream) {
  const call = async (bearer, method, path, body, { form = "pretty", login } = {}) => {
    const headers = {};
    if (bearer) headers["Cart-Token"] = bearer;
    if (login) Object.assign(headers, { Cookie: login.cookie, "X-WP-Nonce": login.nonce });
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

// The extension's sign-in endpoint, called as the Frontend would.
export async function signIn(upstream, bearer, login) {
  const response = await fetch(`${upstream}/wp-json/gq-cart-identity/v1/sign-in`, {
    method: "POST",
    headers: { "Cart-Token": bearer, Cookie: login.cookie, "X-WP-Nonce": login.nonce },
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

// Whether a forwarded WordPress login cookie still authenticates (via the fixture bridge).
export async function stillSignedIn(upstream, { cookie }) {
  const response = await fetch(`${upstream}/?gq-proof-auth=rest-nonce`, {
    headers: { Cookie: cookie },
  });
  return response.status === 200;
}

// The session key a Woo Cart-Token points to (its payload is unencrypted JSON).
export function sessionKey(bearer) {
  return JSON.parse(Buffer.from(bearer.split(".")[1], "base64url").toString()).user_id;
}

export function lines(cart) {
  return Object.fromEntries((cart?.items ?? []).map((item) => [item.name, item.quantity]));
}

// Disposable shopper-facing Frontend for the cart identity proof.
//
// It speaks the storefront BFF contract GQ eCommerce serves: every upstream call carries
// the proxy secret, signed-in Store API calls carry the customer's upstream session, and
// sign-in and sign-out go through GETQUICK Config's customer accounts API.
//
// The browser holds only an opaque HttpOnly handle. Woo cart bearers, upstream sessions
// and the proxy secret stay in this server's memory and never appear in a response.
// This is a proof harness, not the #54 credential store: the mapping is in memory and
// unencrypted, and there is no epoch, coordination or recovery machinery.
import { createHash, randomBytes } from "node:crypto";

const HANDLE = "__Host-gq-cart";
const MAX_BODY = 4096;
const PROXY_HEADER = "X-GetQuick-Storefront-Proxy";
const SESSION_HEADER = "X-GetQuick-Upstream-Session";

export function createFrontend({ upstream, proxySecret, fetch: upstreamFetch = fetch }) {
  const sessions = new Map();

  const hash = (handle) => createHash("sha256").update(handle).digest("base64url");

  function open(request) {
    const handle = cookie(request, HANDLE);
    const existing = handle && sessions.get(hash(handle));
    if (existing) return { session: existing, setCookie: null };
    return issue();
  }

  function issue() {
    const handle = randomBytes(32).toString("base64url");
    const session = { cartToken: null, credential: null };
    sessions.set(hash(handle), session);
    return { session, setCookie: `${HANDLE}=${handle}; Path=/; HttpOnly; Secure; SameSite=Lax` };
  }

  function upstreamHeaders(session) {
    const headers = { Accept: "application/json", [PROXY_HEADER]: proxySecret };
    if (session.cartToken) headers["Cart-Token"] = session.cartToken;
    if (session.credential) headers[SESSION_HEADER] = session.credential;
    return headers;
  }

  async function callStore(session, method, path, body) {
    const headers = upstreamHeaders(session);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await upstreamFetch(`${upstream}/wp-json/wc/store/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const token = response.headers.get("cart-token");
    if (response.ok && token) session.cartToken = token;
    return { status: response.status, json: await response.json().catch(() => null) };
  }

  function callAuth(session, method, path, body) {
    const headers = upstreamHeaders(session);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return upstreamFetch(`${upstream}/wp-json/getquick-config/v1/woocommerce/auth/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  function view(session, cart) {
    return {
      identity: session.credential ? "customer" : "guest",
      items: (cart?.items ?? []).map((item) => ({ name: item.name, quantity: item.quantity })),
    };
  }

  async function readCart(session, extra = {}) {
    const result = await callStore(session, "GET", "/cart");
    if (result.status !== 200) return unavailable();
    return json(200, { ...view(session, result.json), ...extra });
  }

  async function addItem(session, input) {
    if (!Number.isInteger(input?.productId) || !Number.isInteger(input?.quantity)) {
      return json(400, { error: "invalid_item" });
    }
    if (!session.cartToken) await callStore(session, "GET", "/cart");
    const result = await callStore(session, "POST", "/cart/add-item", {
      id: input.productId,
      quantity: input.quantity,
    });
    if (result.status !== 201 && result.status !== 200) return unavailable();
    return json(200, view(session, result.json));
  }

  async function login(session, input) {
    if (typeof input?.username !== "string" || typeof input?.password !== "string") {
      return json(400, { error: "invalid_credentials" });
    }
    // The guest bearer goes along so GQ eCommerce can move this cart to the customer.
    const response = await callAuth(session, "POST", "login", {
      identifier: input.username,
      password: input.password,
      remember: false,
    });
    // Nothing upstream has changed identity yet, so the guest cart stays as it was.
    if (response.status === 401) return json(401, { error: "login_failed" });
    const credential = response.headers.get(SESSION_HEADER);
    if (!response.ok || !credential) return json(503, { error: "login_unavailable" });
    session.credential = credential;
    // A GQ eCommerce without bearer isolation answers without one, and this browser keeps
    // using its guest bearer: the flow #50 found to leak.
    const customerBearer = response.headers.get("cart-token");
    if (customerBearer) session.cartToken = customerBearer;
    return readCart(session);
  }

  // Local isolation always completes; native sign-out is reported as confirmed only when
  // WordPress no longer accepts the old upstream session.
  async function logout(session) {
    let confirmed = false;
    if (session.credential) {
      await callAuth(session, "POST", "logout");
      const check = await callAuth({ credential: session.credential }, "GET", "session");
      confirmed = check.ok && (await check.json()).status === "anonymous";
    }
    session.credential = null;
    session.cartToken = null;
    // A new handle and a fresh anonymous cart: nothing of the customer's survives here.
    sessions.forEach((value, key) => value === session && sessions.delete(key));
    const fresh = issue();
    const nativeSignOut = confirmed ? "confirmed" : "pending";
    return {
      response: await readCart(fresh.session, { nativeSignOut }),
      setCookie: fresh.setCookie,
    };
  }

  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "POST" && request.headers.get("origin") !== url.origin) {
        return json(403, { error: "cross_origin" });
      }
      const input = request.method === "POST" ? await body(request) : undefined;
      if (input === INVALID) return json(400, { error: "invalid_body" });

      let { session, setCookie } = open(request);
      let response;
      if (request.method === "GET" && url.pathname === "/api/cart") {
        response = await readCart(session);
      } else if (request.method === "POST" && url.pathname === "/api/cart/items") {
        response = await addItem(session, input);
      } else if (request.method === "POST" && url.pathname === "/api/login") {
        response = await login(session, input);
      } else if (request.method === "POST" && url.pathname === "/api/logout") {
        ({ response, setCookie } = await logout(session));
      } else {
        response = json(404, { error: "not_found" });
      }
      if (setCookie) response.headers.append("Set-Cookie", setCookie);
      return response;
    },
  };
}

const INVALID = Symbol("invalid");

async function body(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) return INVALID;
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return INVALID;
  }
}

function cookie(request, name) {
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = pair.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });
}

function unavailable() {
  return json(503, { error: "cart_unavailable" });
}

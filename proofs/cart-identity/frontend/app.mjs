// Disposable shopper-facing Frontend for the cart identity proof.
//
// The browser holds only an opaque HttpOnly handle. Woo cart bearers, WordPress login
// cookies and REST nonces stay in this server's memory and never appear in a response.
// This is a proof harness, not the #54 credential store: the mapping is in memory and
// unencrypted, and there is no epoch, coordination or recovery machinery.
import { createHash, randomBytes } from "node:crypto";

const HANDLE = "__Host-gq-cart";
const MAX_BODY = 4096;

export function createFrontend({ upstream, isolation, fetch: upstreamFetch = fetch }) {
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
    const session = { cartToken: null, wp: null };
    sessions.set(hash(handle), session);
    return { session, setCookie: `${HANDLE}=${handle}; Path=/; HttpOnly; Secure; SameSite=Lax` };
  }

  async function callStore(session, method, path, body) {
    const headers = { Accept: "application/json" };
    if (session.cartToken) headers["Cart-Token"] = session.cartToken;
    if (session.wp)
      Object.assign(headers, { Cookie: session.wp.cookie, "X-WP-Nonce": session.wp.nonce });
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

  function view(session, cart) {
    return {
      identity: session.wp ? "customer" : "guest",
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

  // Native WordPress login: the same form a shopper would submit, then a REST nonce
  // so the forwarded login cookie authenticates Store API requests.
  async function wpLogin(username, password) {
    const response = await upstreamFetch(`${upstream}/wp-login.php`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: "wordpress_test_cookie=WP%20Cookie%20check",
      },
      body: new URLSearchParams({
        log: username,
        pwd: password,
        testcookie: "1",
        redirect_to: `${upstream}/wp-admin/`,
      }),
      redirect: "manual",
    });
    const cookies = response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .filter((pair) => /^wordpress_(sec_|logged_in_)?[0-9a-f]{32}=/.test(pair));
    if (!cookies.some((pair) => pair.startsWith("wordpress_logged_in_"))) return null;
    const cookie = cookies.join("; ");
    const nonce = await upstreamFetch(`${upstream}/?gq-proof-auth=rest-nonce`, {
      headers: { Cookie: cookie },
    });
    if (!nonce.ok) return null;
    return { cookie, nonce: (await nonce.text()).trim() };
  }

  // Native WordPress logout for this browser's login only.
  async function wpLogout(wp) {
    const confirm = await upstreamFetch(`${upstream}/wp-login.php?action=logout`, {
      headers: { Cookie: wp.cookie },
      redirect: "manual",
    });
    const nonce = (await confirm.text()).match(/action=logout&(?:amp;)?_wpnonce=([0-9a-f]+)/)?.[1];
    if (!nonce) return false;
    const response = await upstreamFetch(
      `${upstream}/wp-login.php?action=logout&_wpnonce=${nonce}`,
      { headers: { Cookie: wp.cookie }, redirect: "manual" },
    );
    return response.status === 302;
  }

  // gq-cart-identity: identity changes go through the Woo extension, which retires the
  // bearer the browser held before the change.
  async function changeIdentity(session, action) {
    const headers = { Cookie: session.wp.cookie, "X-WP-Nonce": session.wp.nonce };
    if (session.cartToken) headers["Cart-Token"] = session.cartToken;
    const response = await upstreamFetch(`${upstream}/wp-json/gq-cart-identity/v1/${action}`, {
      method: "POST",
      headers,
    });
    return response.ok ? response.json() : null;
  }

  async function login(session, input) {
    if (typeof input?.username !== "string" || typeof input?.password !== "string") {
      return json(400, { error: "invalid_credentials" });
    }
    const wp = await wpLogin(input.username, input.password);
    // Nothing upstream has changed identity yet, so the guest cart stays as it was.
    if (!wp) return json(401, { error: "login_failed" });
    session.wp = wp;
    if (isolation === "gq-cart-identity") {
      const signedIn = await changeIdentity(session, "sign-in");
      // The guest identity may already have changed upstream: show no cart rather than
      // fall back to the guest bearer.
      session.cartToken = signedIn?.cart_token ?? null;
      if (!session.cartToken) return json(503, { error: "transition_pending" });
    }
    return readCart(session);
  }

  // Local isolation always completes; native sign-out (and, with the extension, bearer
  // retirement) is reported as confirmed only when WordPress confirmed it.
  async function logout(session) {
    let confirmed = false;
    if (session.wp && isolation === "gq-cart-identity") {
      confirmed = (await changeIdentity(session, "sign-out"))?.cart_retired === true;
    } else if (session.wp) {
      confirmed = await wpLogout(session.wp);
    }
    session.wp = null;
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

// Live proof against the disposable store (see README.md). Not part of `pnpm test`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { createFrontend } from "./frontend/app.mjs";
import { serve } from "./frontend/serve.mjs";
import {
  Browser,
  URL_FORMS,
  cookieLogin,
  lines,
  proofEnv,
  sessionKey,
  signIn,
  stillSignedIn,
  storeApi,
  upstreamTap,
} from "./harness.mjs";

const env = proofEnv();
const proxySecret = env.proxySecret();
const woo = storeApi(env.url, proxySecret);
const FORMS = Object.keys(URL_FORMS);
const MERGED = { "GQ Proof Alpha": 1, "GQ Proof Beta": 2 };

// A shopper's browser on a fresh disposable Frontend, with its upstream traffic tapped.
async function shopper() {
  const tap = upstreamTap();
  const server = await serve(createFrontend({ upstream: env.url, proxySecret, fetch: tap.fetch }));
  const browser = new Browser(server.url);
  return {
    tap,
    browser,
    close: () => server.close(),
    login: (username, password) => browser.post("/api/login", { username, password }),
    addItem: (productId) => browser.post("/api/cart/items", { productId, quantity: 1 }),
  };
}

function assertNoCredentialReachedTheBrowser(shop) {
  const secrets = shop.tap.secrets();
  assert.ok(secrets.length > 0, "the Frontend exchanged credentials with Woo");
  const received = shop.browser.everythingReceived();
  for (const secret of secrets) assert.ok(!received.includes(secret), "credential leaked");
}

describe("a guest shopper", () => {
  let fixture, shop;
  before(async () => {
    fixture = env.reset();
    shop = await shopper();
  });
  after(() => shop.close());

  test("adds an item and reads the cart without receiving any upstream credential", async () => {
    assert.equal((await shop.addItem(fixture.products.alpha)).status, 200);

    const cart = await shop.browser.get("/api/cart");
    assert.equal(cart.status, 200);
    assert.equal(cart.json.identity, "guest");
    assert.deepEqual(lines(cart.json), { "GQ Proof Alpha": 1 });
    assertNoCredentialReachedTheBrowser(shop);
  });
});

describe("GQ eCommerce without bearer isolation (baseline) reproduces the #50 findings", () => {
  let fixture, shop, guestBearer, authenticatedBearer, nativeBearer, login;
  before(async () => {
    env.ecommerce("baseline");
    fixture = env.reset();
    shop = await shopper();
    await shop.addItem(fixture.products.alpha);
    guestBearer = shop.tap.lastBearer();
  });
  after(() => shop.close());

  test("login shows Woo's merged cart: guest quantity wins, saved-only lines added", async () => {
    const response = await shop.login(fixture.customer, env.customerPassword());
    assert.equal(response.status, 200);
    assert.equal(response.json.identity, "customer");
    assert.deepEqual(lines(response.json), MERGED);
    authenticatedBearer = shop.tap.lastBearer();
    login = shop.tap.lastLogin();
    nativeBearer = (await woo.mintNativeBearer(login)).token;
  });

  test("the pre-login guest bearer reads the merged customer cart without a WP cookie", async () => {
    const read = await woo.cart(guestBearer);
    assert.equal(read.status, 200);
    assert.deepEqual(lines(read.json), MERGED);
  });

  test("a native user-keyed bearer reads the signed-in customer's cart without a WP cookie", async () => {
    const read = await woo.cart(nativeBearer);
    assert.equal(read.status, 200);
    assert.equal(lines(read.json)["GQ Proof Beta"], 2);
  });

  test("logout gives the browser a fresh empty guest cart and ends the WP session", async () => {
    const logout = await shop.browser.post("/api/logout");
    assert.equal(logout.status, 200);
    assert.equal(logout.json.identity, "guest");
    assert.equal(logout.json.nativeSignOut, "confirmed");
    assert.deepEqual(lines(logout.json), {});
    assert.equal(await stillSignedIn(env.url, proxySecret, login), false);
  });

  test("the Frontend's authenticated-cart bearer still reads the customer cart after logout", async () => {
    const read = await woo.cart(authenticatedBearer);
    assert.equal(read.status, 200);
    assert.deepEqual(lines(read.json), MERGED);
  });

  // The BFF signs out over REST, where Woo has no session loaded, so Woo's logout hook
  // never deletes the user-keyed session row.
  test("a native user-keyed bearer still reads the customer cart after logout", async () => {
    const read = await woo.cart(nativeBearer);
    assert.equal(read.status, 200);
    assert.deepEqual(lines(read.json), MERGED);
  });

  test("the pre-login guest bearer can still change the customer cart", async () => {
    const added = await woo.addItem(guestBearer, fixture.products.gamma);
    assert.equal(added.status, 201);
    assert.equal(lines(added.json)["GQ Proof Gamma"], 1);
    assert.equal(lines(added.json)["GQ Proof Beta"], 2);
  });
});

describe("GQ eCommerce with bearer isolation (candidate): retired bearers cannot reach the customer cart", () => {
  let fixture, shop, guestBearer, authenticatedBearer, nativeBearer, login;
  const others = [];
  const refused =
    (code, status = 401) =>
    (result) =>
      assert.deepEqual([result.status, result.json?.code], [status, code]);
  const retired = refused("getquick_cart_bearer_retired");
  const needsLogin = refused("getquick_cart_identity_required");
  // Woo's cart item key for a simple product.
  const lineKey = (productId) => createHash("md5").update(String(productId)).digest("hex");

  before(async () => {
    env.ecommerce("candidate");
    fixture = env.reset();
    shop = await shopper();
    await shop.addItem(fixture.products.alpha);
    guestBearer = shop.tap.lastBearer();
  });
  after(() => shop.close());

  test("login shows Woo's merged cart under a fresh cart identity", async () => {
    const response = await shop.login(fixture.customer, env.customerPassword());
    assert.equal(response.status, 200);
    assert.equal(response.json.identity, "customer");
    assert.deepEqual(lines(response.json), MERGED);
    authenticatedBearer = shop.tap.lastBearer();
    login = shop.tap.lastLogin();
    nativeBearer = (await woo.mintNativeBearer(login)).token;
    assert.notEqual(sessionKey(authenticatedBearer), sessionKey(guestBearer));
  });

  test("the pre-login guest bearer is retired: it can neither read nor change any cart", async () => {
    for (const form of FORMS) {
      retired(await woo.cart(guestBearer, { form }));
      retired(await woo.addItem(guestBearer, fixture.products.gamma, { form }));
    }
    retired(await woo.batch(guestBearer, [{ method: "GET", path: "/wc/store/v1/cart" }]));
    retired(await woo.cart(guestBearer, { login }));
  });

  test("signing in again with the retired guest bearer returns the same fresh identity", async () => {
    const repeat = await signIn(
      env.url,
      proxySecret,
      guestBearer,
      fixture.customer,
      env.customerPassword(),
    );
    assert.equal(repeat.status, 200);
    assert.equal(sessionKey(repeat.token), sessionKey(authenticatedBearer));
  });

  test("customer bearers need that customer's own login, on every URL form", async () => {
    for (const form of FORMS) {
      needsLogin(await woo.cart(nativeBearer, { form }));
      needsLogin(await woo.cart(authenticatedBearer, { form }));
      needsLogin(await woo.addItem(authenticatedBearer, fixture.products.gamma, { form }));
    }
    const cart = await shop.browser.get("/api/cart");
    assert.equal(cart.status, 200);
    assert.deepEqual(lines(cart.json), MERGED, "the refused add-items changed nothing");
  });

  test("another customer's login cannot use this customer's bearers", async () => {
    const other = await shopper();
    others.push(other);
    try {
      assert.equal((await other.login(fixture.other, env.otherPassword())).status, 200);
      const otherLogin = other.tap.lastLogin();
      needsLogin(await woo.cart(authenticatedBearer, { login: otherLogin }));
      needsLogin(await woo.cart(nativeBearer, { login: otherLogin }));
      // Signing in with this customer's bearer starts the other customer afresh.
      const switched = await signIn(
        env.url,
        proxySecret,
        nativeBearer,
        fixture.other,
        env.otherPassword(),
      );
      assert.equal(switched.status, 200);
      assert.notEqual(sessionKey(switched.token), sessionKey(nativeBearer));
      // The other customer has no saved cart, so their fresh cart is empty.
      const theirs = await woo.cart(switched.token, { login: otherLogin });
      assert.equal(theirs.status, 200);
      assert.deepEqual(lines(theirs.json), {});
      await other.browser.post("/api/logout");
    } finally {
      await other.close();
    }
  });

  test("a guest bearer presented with the customer's login is refused and not merged", async () => {
    const stranger = (await woo.cart(null)).token;
    refused("getquick_cart_transition_required", 409)(await woo.cart(stranger, { login }));
    const afterwards = await woo.cart(stranger);
    assert.equal(afterwards.status, 200);
    assert.deepEqual(lines(afterwards.json), {});
  });

  test("logout gives a fresh empty guest cart and confirms native sign-out", async () => {
    const response = await shop.browser.post("/api/logout");
    assert.equal(response.status, 200);
    assert.equal(response.json.identity, "guest");
    assert.equal(response.json.nativeSignOut, "confirmed");
    assert.deepEqual(lines(response.json), {});
    assert.equal(await stillSignedIn(env.url, proxySecret, login), false);
  });

  test("bearers issued while signed in can neither read nor change the customer cart", async () => {
    for (const form of FORMS) {
      retired(await woo.cart(authenticatedBearer, { form }));
      retired(await woo.addItem(authenticatedBearer, fixture.products.gamma, { form }));
      retired(
        await woo.updateItem(authenticatedBearer, lineKey(fixture.products.beta), 9, { form }),
      );
      retired(await woo.removeItem(authenticatedBearer, lineKey(fixture.products.alpha), { form }));
      needsLogin(await woo.cart(nativeBearer, { form }));
      needsLogin(await woo.updateItem(nativeBearer, lineKey(fixture.products.beta), 9, { form }));
    }
    retired(await woo.batch(authenticatedBearer, [{ method: "GET", path: "/wc/store/v1/cart" }]));
  });

  test("a retired bearer is refused even with the customer's fresh login", async () => {
    assert.equal((await shop.login(fixture.customer, env.customerPassword())).status, 200);
    retired(await woo.cart(authenticatedBearer, { login: shop.tap.lastLogin() }));
    await shop.browser.post("/api/logout");
  });

  // Woo writes the saved cart only for a signed-in customer, so this shows saved state
  // surviving logout; isolation itself is shown by the refusals above.
  test("the saved cart survives logout and returns on the next sign-in", async () => {
    const response = await shop.login(fixture.customer, env.customerPassword());
    assert.equal(response.status, 200);
    assert.deepEqual(lines(response.json), MERGED);
  });

  test("logout still retires the bearer when the customer's session already ended", async () => {
    assert.equal((await shop.login(fixture.customer, env.customerPassword())).status, 200);
    const bearer = shop.tap.lastBearer();
    env.fault("end-sessions");
    assert.equal((await shop.browser.post("/api/logout")).status, 200);
    retired(await woo.cart(bearer));
  });

  test("a customer bearer stays refused if the bearer registry is lost", async () => {
    assert.equal((await shop.login(fixture.customer, env.customerPassword())).status, 200);
    const bearer = shop.tap.lastBearer();
    env.fault("drop-registry");
    const read = await woo.cart(bearer);
    assert.ok(read.status >= 400, `expected a refusal, got ${read.status}`);
    assert.equal(lines(read.json)["GQ Proof Beta"], undefined);
  });

  test("a shopper signed in with WordPress cookies keeps their identity on the Store API", async () => {
    const native = await cookieLogin(env.url, fixture.customer, env.customerPassword());
    const response = await fetch(`${env.url}/wp-json/wc/store/v1/cart`, {
      headers: { Cookie: native.cookie, "X-WP-Nonce": native.nonce },
    });
    assert.equal(response.status, 200);
    assert.notEqual(response.headers.get("user-id"), "0");
  });

  test("no upstream credential reached any browser", () => {
    for (const browser of [shop, ...others]) assertNoCredentialReachedTheBrowser(browser);
  });
});

# ADR 0021: Declare a commerce Site ready through the same gate

- Status: Accepted; amends [ADR 0017](0017-generate-commerce-sites-from-the-variant-alone.md)
  (its "No commerce readiness yet")
- Date: 2026-10-31

## Context

[ADR 0017](0017-generate-commerce-sites-from-the-variant-alone.md) made
`gq site check` refuse a commerce Site until
[#26](https://github.com/Quick-Release/gq-site/issues/26) said what makes one
healthy. [ADR 0010](0010-declare-a-new-content-site-ready-through-one-readiness-gate.md)
answered it for content: one gate, each part observed where it can be, with
failures and warnings. Its checks don't transfer. A commerce CMS has no
WPGraphQL, and its storefront has no publication store, events or
reconciliation.

Bruaa is the first commerce Site deployed: a staging CMS (WooCommerce,
GQ eCommerce 0.4.3, GQ Config) and a storefront Worker with
`@quick-release/storefront` 0.2.2 mounted at `/api/store/*` and
`/api/auth/*`. What those two packages expose decides what can be observed:

- **The Store API BFF proxies only what a shopper's cart needs.** It allows
  `GET /cart`, the cart's `POST` changes, `/checkout` and `GET /order/<id>`,
  and answers anything else 404 `getquick_store_invalid_request`, so
  `/api/store/v1/products` is a 404 by design. Catalogue reads are the
  Site's, from the Store API directly. A first `GET /cart` asks WooCommerce
  for a cart, keeps its `Cart-Token` encrypted in the `CART_SESSIONS` D1
  database and gives the browser only a random handle
  (`__Host-getquick_cart`). A request with the handle finds that row and
  keeps the handle. On Bruaa the second read kept the first's handle and
  answered the same empty cart.
- **The auth BFF has eight routes.** Only `GET /configuration` reaches
  GQ eCommerce without a customer: it calls `…/woocommerce/auth/health`
  with the proxy secret. `/api/auth/me` and `/api/auth/csrf` aren't routes,
  so a bare GET answers 400 whatever the configuration.
- **GQ eCommerce checks the proxy secret before anything else.** Its customer
  auth answers 401 to a missing or different secret, then 503
  `getquick_auth_unavailable` while GQ Config's customer accounts are off,
  then 200 with the registration settings. On the Store API the secret only
  admits a customer's session: a guest's cart works with any secret, or
  none. So a cart round-trip doesn't prove the secret.
- **The storefront relays both refusals the same way.** It passes GQ
  eCommerce's 503 problem through, and turns its 401 (a `WP_Error`, not the
  auth contract's problem shape) into its own 503 `getquick_auth_unavailable`.
  With sign-in off, the Worker's own secret can't be told apart from a wrong
  one. Bruaa has sign-in off: its CMS accepted Sigillo staging's secret and
  answered 503.
- **The rate limiters run before Turnstile.** On a sign-in, registration or
  recovery, the Worker answers 503 unless all three limiters are bound, then
  checks the Turnstile token, and only then calls WordPress. A sign-in for a
  made-up account with a token Turnstile can't accept gets 422
  `getquick_auth_turnstile_failed` from a Worker with all three bound, and
  never reaches WordPress.
- **The active theme is readable by an Author.** `wp/v2/themes?status=active`
  needs `edit_posts`, which the CMS check user (an Author, used by the media
  upload probe) has. Anonymously it is a 401.
- **GQ Config's storefront settings carry the Legal Contract** at
  `getquick-config/v1/storefront`, commerce roles included (terms of sale,
  returns, shipping), with `missingRequired`. It is the REST read the
  storefront's consent adapter makes.

Signals that look like readiness and aren't: the Worker or homepage
answering, the Store API answering on the CMS (it says nothing about the
Worker's bindings), a secret present in Sigillo (it isn't one bound to the
Worker), and `pnpm verify`.

## Decision

- **`gq site check` is a commerce Site's gate too.** It is the same command,
  run through `gq sigillo run staging` (`pnpm site:check`). It exits 1 until
  nothing is not-ready, uses the same statuses and reports what to run for
  each check that fails. Warnings never block, as in ADR 0010. Checks:
  - **CMS:**
    - `wordpress`: `https://<domains.admin>/wp-json/` serves WordPress's REST
      index. A redirect to `install.php` is "not installed". Any other
      redirect is plain permalinks, which GQ Config's headless routing sends
      to the Frontend, breaking the storefront's upstreams.
    - `plugins`: the index has the routes WooCommerce
      (`/wc/store/v1/cart`), GQ Config (`/getquick-config/v1/storefront`),
      GQ eCommerce (`…/woocommerce/auth/health`) and GQ Design
      (`/getquick-design/v1`) register. Each missing one is named.
    - `theme`: `getquick-theme`, or a child of it, is active, read as the
      CMS check user.
    - `store-api`: the Store API lists products anonymously. An empty
      catalogue only warns.
    - `proxy-secret`: GQ eCommerce's health, asked with Sigillo staging's
      `GETQUICK_STOREFRONT_PROXY_SECRET`, isn't a 401. That proves the CMS
      holds the same secret, without reading the CMS's `.env`. Its answer
      also tells whether customer sign-in is on.
  - **Storefront:**
    - `homepage`: answers 200 from the Worker. Not ready if Cloudflare's
      edge could hold it (`cf-cache-status` HIT, MISS, EXPIRED, STALE,
      UPDATING or REVALIDATED) or it is shared-cacheable (`public` or
      `s-maxage` without `private` or `no-store`), since a cached page could
      outlive a price, stock or cart change.
    - `cart`: a cart round-trips through the Worker. The first
      `GET /api/store/v1/cart` must answer a WooCommerce cart and a cart
      handle cookie, and the second, with the cookie, the same cart without
      a new handle. This proves the Store API through the Worker, the
      `CART_SESSIONS` binding and its migrations, both keyrings, the proxy
      secret's length and the Store API URL's origin. The Runtime's codes
      name the fault: `getquick_cart_unavailable` is D1,
      `getquick_store_unavailable` a secret or variable, and HTML means the
      Runtime isn't mounted.
    - `customer-auth`: with sign-in on, `GET /api/auth/configuration` must
      answer `available`. That proves the Worker's proxy secret is the CMS's,
      and that `GETQUICK_AUTH_UPSTREAM_URL` and the session keyring are
      bound. With sign-in off it only warns: the Worker's secret can't be
      proven (see Context), and nothing a shopper does depends on it until
      sign-in is turned on.
    - `turnstile`: with sign-in on, Sigillo staging has `TURNSTILE_SECRET`
      and `TURNSTILE_EXPECTED_HOSTNAMES`, which the deploy binds. Only a
      browser solving a challenge proves the Worker's, so this one check is
      configuration. Skipped while sign-in is off.
    - `rate-limiters`: a sign-in probe for `gq-site-check@example.invalid`,
      with a token Turnstile refuses, answers 422 (or 429: the limiters are
      counting).
  - **Consent and legal pages:** ADR 0019's three checks, from GQ Config's
    storefront settings instead of WPGraphQL. The Legal Contract names every
    required page, commerce roles included, and the data controller. GA4
    switched on needs the consent Runtime on the homepage. The homepage
    loads nothing from a third-party host.
  - **Independent media:** `gq media check --upload`, unchanged.
- **Nothing creates an order, a customer or a sign-in.** Every check reads,
  except three. The media probe deletes what it uploads. The cart probe
  leaves what a visitor's first cart read leaves: an empty guest cart, whose
  handle expires on its own (the Runtime has no way to delete one). The
  sign-in probe stops at the Worker's Turnstile check, and counts once
  against the limiters for a made-up account and the operator's IP. The
  proxy secret goes only to the CMS's own HTTPS origin, in the header the
  storefront sends, and is never shown.
- **Out of scope, said so in the gate's summary:** payments and payment
  gateways; checkout (the Store API's `GET /checkout` creates a draft order);
  shipping and tax configuration; orders and order lookup; customer sign-in
  end to end (it needs a customer and a solved challenge); catalogue
  delivery and product presentation (CATALOG-GUARANTEE); multilingual
  commerce (refused by ADR 0017); and the deploy's post-switch health check
  that gates automatic rollback ([ADR 0016](0016-activate-cms-releases-from-kept-builds-and-roll-back-code-only.md)).
  "Ready" means the shop's parts are wired. A Site still tests an order
  before taking real ones.
- **Local readiness.** `gq site check --local` on a commerce Site checks the
  DDEV CMS's REST index, plugins, Store API and theme (by wp-cli), and local
  media. The storefront isn't checked locally: `vp dev` has no Worker
  bindings, so the Runtime answers 503 there by design.
- **`gq new --variant commerce`** prints `media:check:upload` and then
  `site:check`, as content does.

## Considered options

- **Read the Worker's bindings through Cloudflare's API.** It needs a token
  with Workers read in Sigillo, and a binding present isn't a binding that
  works (a D1 database without its migrations is bound). The cart
  round-trip observes the same, from outside.
- **Compare the CMS's `.env` through Ploi**, as content's `cms-events`
  does. GQ eCommerce's own comparison is closer to the truth, since it reads
  the secret as WordPress loaded it, and needs no Ploi token.
- **Fail while sign-in is off, because the Worker's secret is unproven.**
  That would make every guest-checkout shop permanently not ready over a
  secret nothing uses yet. The warning names the gap, and the check becomes a
  failure as soon as sign-in is on.
- **Probe the rate limiters through `password/validate`.** It needs no
  Turnstile token, but it reaches WordPress with a made-up reset key. The
  sign-in probe proves the same without leaving the Worker.
- **Probe checkout.** `GET /checkout` creates a draft order in WooCommerce,
  and anything further takes payment. Neither belongs in a gate that runs
  against production.

## Consequences

- Bruaa's first run (2026-10-31) is not ready only on `legal-pages`: none of
  the five required legal pages is assigned, nor the data controller. Its
  `customer-auth` warns, since sign-in is off.
- To prove the Worker's proxy secret with sign-in off, gq-storefront would
  have to tell the two refusals apart in `/api/auth/configuration`: relay GQ
  eCommerce's 401 (or a distinct code) instead of its own 503, or report
  "sign-in off" as a success shape of the auth contract, such as
  `{ status: "disabled" }`. The second needs GQ eCommerce and the auth
  contract to change too. Once one is released, `customer-auth` can fail on
  a mismatch whatever sign-in's state.
- The gate's `--json` output is the per-Site result a fleet controller can
  read. The release record and which checks gate a CMS rollback stay with
  ADR 0016 and [#27](https://github.com/Quick-Release/gq-site/issues/27).
- A Site without the CMS check user's application password in Sigillo can't
  be ready on either variant: the media probe and the theme both need it.

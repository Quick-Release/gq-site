# Upstream cart bearer isolation across native identity changes

> **Status: isolation demonstrated locally for the tested scenarios; not a production or security approval.** Issue #57, under the #54 contract. A disposable loopback store with pinned WordPress 7.1.2 and WooCommerce 11.1.2 reproduced #50's bearer failures. A narrow Woo extension, `gq-cart-identity`, then stopped every captured guest and authenticated-cart bearer from reading or changing the customer's cart, with no WP cookie and even with one. The #54 deployed-Worker gate, security review and production transitions are still outstanding. Nothing here is enabled for any Site.

Code: [`proofs/cart-identity/`](../../proofs/cart-identity/). Prior evidence: [the #50 commerce research](cloudflare-tanstack-commerce-architecture.md#one-live-proof-executed-with-failures).

## Findings in brief

- **Root cause (Woo 11.1.2 source).** A Store API `Cart-Token` is a signed `{user_id: <session key>, exp}` pointer, signed with `wp_salt()`. Woo has no revocation and doesn't check the key against a login. Three bearer kinds expose customer state:
  - **Guest bearer.** Woo merges the saved cart into whichever session the next logged-in cart load uses. With a guest Cart-Token, that is the _guest_ key, so the pre-login bearer then holds the merged customer cart.
  - **Authenticated-cart bearer.** In the same flow, the bearer the Frontend holds while signed in still points at that guest key, which logout leaves alone.
  - **Native user-keyed bearer.** Any logged-in Store API request without a token gets a token keyed by the customer's user ID. It reads the customer's cookie session with no login.
- **Reproduced:** all #50 findings, with distinguishable synthetic carts. Saved cart: Alpha ×3 plus the saved-only Beta ×2. Guest cart: Alpha ×1. Login merged to Alpha ×1, Beta ×2.
  - The original guest bearer read _and changed_ the merged cart without a WP cookie.
  - The authenticated-cart bearer still read it after native logout.
  - Woo's user-keyed bearer read the signed-in customer's cart without a cookie.
- **New finding:** Woo's merge flag is one-shot and is consumed by **any** Woo frontend or ajax request after `wp_login`, because every such request loads a cart. So which session receives the merged cart depends on request order, not on the login. A design must not rely on the flag surviving until the first Store API read.
- **Fix:** `gq-cart-identity`. Sign-in moves the guest cart to a **fresh session key registered to the customer**, retires the guest key and re-arms Woo's native merge for the fresh key. Sign-out retires the current key and ends this browser's native session. A request guard enforces retirement and ownership for every Store API route. Mapping rotation and WP logout alone were not counted as the fix (the baseline suite rotates the browser handle and performs native logout, and still leaks).
- **Result:** the baseline suite (extension off) and the isolated suite (extension on) both pass, which shows the failures and their fix in the same environment. A mutation check (guard disabled) failed six of the isolated suite's eleven tests. The five that survive don't depend on the guard: sign-in, logout, saved-cart survival, repeat sign-in and the credential scan.
- **A bypass found in review, and fixed.** The first guard compared the requested route case-sensitively. But WordPress matches routes case-insensitively, and Woo's cart routes load the Cart-Token session whatever the casing. So `/wp-json/WC/Store/v1/cart` let the customer's authenticated bearer read their cart with no cookie (observed: 200). The guard now decides by the handler WordPress actually matched, and the tests probe four URL forms for every rule.

## Environment

Executed **2026-10-04T15:39Z (final run; earlier iterations the same day)** on one developer machine, loopback only. User authorization covered exactly: one uniquely named local DDEV project, synthetic data, no tunnel, no Cloudflare deployment, no Sigillo access, no change to Ekis or any other repository, and verified teardown.

| Component   | Version / configuration                                                                                                                                                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store       | DDEV **v1.25.4**, Docker **29.4.0**, PHP **8.4.24**, MariaDB **11.8.9**, WordPress **7.1.2**, WooCommerce **11.1.2**, all read back by `env.sh versions`. HTTPS through DDEV's local mkcert CA.                                                                  |
| Fixtures    | Three synthetic simple products (Alpha $10, Beta $20, Gamma $30) and two synthetic customers (the second is for account switching). Reset before each suite: all Woo sessions and registry rows deleted, saved carts restored, customers' WP sessions destroyed. |
| Frontend    | Disposable Node 24 fetch-style app on 127.0.0.1. The browser gets only a random 256-bit `__Host-` HttpOnly handle. Woo bearers, WP cookies and REST nonces are held in server memory. Native `wp-login.php` login and logout.                                    |
| Auth bridge | Proof-only mu-plugin returning a `wp_rest` nonce for the native login cookie, exiting at `plugins_loaded` before Woo initialises. A stand-in for a BFF's native auth bridge, **not** Ekis's bridge.                                                              |
| Probe       | Node `fetch` straight to the Store API with a captured bearer and **no** WP cookie (and, where stated, with one). Bearers were captured by tapping the Frontend's upstream traffic, as a thief of the server-side credential would have them.                    |

## Reproduced failures: extension off

The disposable Frontend drove each shopper step over HTTP. The probe then reused the captured bearers.

| Scenario                                                | Observed                                                                                                   | Verdict                                                                                                                                                       |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guest adds Alpha ×1 through the Frontend                | 200; no Woo token, WP cookie or nonce anywhere in browser responses                                        | Credential placement holds                                                                                                                                    |
| Login through the Frontend                              | 200, `customer`, Alpha ×1 + Beta ×2                                                                        | Native merge: guest quantity wins, saved-only line added                                                                                                      |
| Original guest bearer, no WP cookie, GET cart           | **200, Alpha ×1 + Beta ×2**                                                                                | **Failure reproduced**                                                                                                                                        |
| Native user-keyed bearer, no WP cookie, while signed in | **200, includes Beta ×2**                                                                                  | **Failure reproduced**                                                                                                                                        |
| Logout through the Frontend                             | 200, fresh empty guest cart, new handle, `nativeSignOut: confirmed`; old WP cookie no longer authenticates | Local isolation and native revocation                                                                                                                         |
| Authenticated-cart bearer, no WP cookie, after logout   | **200, Alpha ×1 + Beta ×2**                                                                                | **Failure reproduced**                                                                                                                                        |
| Native user-keyed bearer after this logout              | 200, empty                                                                                                 | Observation only: Woo's logout deleted the user-keyed session row. That row comes back whenever the customer is signed in anywhere, so this is not isolation. |
| Original guest bearer, no WP cookie, add Gamma          | **201, Gamma added beside Beta ×2**                                                                        | **Failure reproduced: change, not just read**                                                                                                                 |

## The mechanism: `gq-cart-identity`

A WordPress mu-plugin of about 280 lines, with one registry table of session key, owner, state (`owned` or `retired`), successor key and timestamp. It changes no Woo code, cart engine, merge rule or pricing.

**Guard.** It runs on `rest_request_before_callbacks`, after WordPress has matched the route and before any permission check or callback. It applies to every request matched to a Store API handler that presents a valid Cart-Token, whatever the URL's casing or form, and to each batch sub-request. Its refusal replaces any earlier validation error.

1. A **retired** key is refused, `401 gq_cart_bearer_retired`, whoever presents it, even with the customer's own login.
2. A **customer's key** (registered to them, or Woo's numeric user-ID key) is honoured only when the native WP login is that customer. Otherwise `401 gq_cart_identity_required`, including when another customer's login presents the bearer (account switching).
3. A **guest key presented with a WP login** is refused, `409 gq_cart_transition_required`. Woo therefore can never merge a saved cart into a key a guest bearer still points at.

**Sign-in** (`POST /wp-json/gq-cart-identity/v1/sign-in`, native login and REST nonce required, presenting the guest bearer):

1. Atomically retires the guest key, recording the fresh successor key. A unique insert prevents a concurrent or repeated sign-in from copying it twice.
2. Copies the guest session to a fresh random key registered to the customer, then deletes the guest row.
3. Re-arms Woo's one-shot `_woocommerce_load_saved_cart_after_login` flag, so Woo's own merge runs into the fresh key on the next cart read.
4. Returns a bearer for the fresh key, server-to-server only.

A repeated sign-in, for example after a lost response, returns the same successor without another copy or merge. Woo's user-ID key is never claimed or retired (the customer's cookie sessions share it), and a user-ID key belonging to another customer is refused.

**Sign-out** (`POST .../sign-out`) retires the presented key if it belongs to the signed-in customer and deletes its row. It then calls `wp_logout()`, which ends only this browser's WP session token. Woo's saved cart (user meta, kept current by Woo on every signed-in cart change) is untouched.

The Frontend calls sign-in right after native login and sign-out in place of native logout. If sign-in fails it shows no cart (`503 transition_pending`) rather than falling back to the guest bearer. Logout always completes locally (fresh handle, fresh guest cart). It reports `nativeSignOut: confirmed` only when the extension confirms retirement and sign-out, and `pending` otherwise.

## Isolation results: extension on

"Every URL form" means four forms: `/wp-json/wc/store/…`, `?rest_route=/wc/store/…`, `/wp-json/WC/Store/…`, and a pretty path with an upper-case `rest_route` override.

| Scenario                                                                                                                                                   | Observed                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login through the Frontend                                                                                                                                 | 200, Alpha ×1 + Beta ×2; the Frontend's bearer points at a new key                                                                                              |
| Original guest bearer, no WP cookie: GET and add-item on every URL form, plus batch; GET **with** the customer's login                                     | all `401 gq_cart_bearer_retired`                                                                                                                                |
| Repeat sign-in with the original guest bearer                                                                                                              | 200, same fresh key; no second copy                                                                                                                             |
| While the customer is signed in, no WP cookie: native user-keyed bearer (GET) and the Frontend's authenticated-cart bearer (GET, add-item), every URL form | all `401 gq_cart_identity_required`                                                                                                                             |
| A second synthetic customer, signed in, presents the first customer's authenticated-cart and user-keyed bearers; signs in with the user-keyed bearer       | `401 gq_cart_identity_required`; sign-in `403`                                                                                                                  |
| New guest bearer presented with the customer's login                                                                                                       | `409 gq_cart_transition_required`; the guest cart is still empty afterwards (no merge)                                                                          |
| Logout through the Frontend                                                                                                                                | 200, fresh empty guest cart, `nativeSignOut: confirmed`; old WP cookie no longer authenticates                                                                  |
| After logout, every URL form: authenticated-cart bearer (GET, add-item, update-item, remove-item) and native bearer (GET, update-item); batch              | all `401 gq_cart_bearer_retired` / `401 gq_cart_identity_required`                                                                                              |
| Authenticated-cart bearer presented with a fresh login of the same customer                                                                                | `401 gq_cart_bearer_retired`                                                                                                                                    |
| Sign in again through the Frontend                                                                                                                         | 200, **Alpha ×1 + Beta ×2**: the saved cart survived logout. Woo writes the saved cart only for a signed-in customer, so this shows preservation, not isolation |
| Every browser response in the run                                                                                                                          | contains none of the Woo tokens, WP cookie values or nonces exchanged upstream                                                                                  |

Final run: **19 tests in 3 suites, 19 passed, 0 failed, 0 cancelled (2026-10-04T15:39Z, after the review fixes). Every assertion is listed in `proofs/cart-identity/isolation.test.mjs`**.

## Threat model

**Protected:** the customer's cart state behind a native identity: saved-cart lines, the merged cart and the right to change either.

**Adversary:** holds a copy of a Woo Cart-Token issued to the shopper's browser session, but not the customer's WP login cookie. Ways to get one include browser-held tokens in Ekis's current transport, a shared device, logs or traces, or anything between the BFF and Woo.

**Mitigated:**

- the pre-login guest bearer after sign-in
- any bearer issued while signed in, after sign-out
- Woo's user-ID bearer without that customer's login
- a bearer of one customer presented with another customer's login
- guest-key merges triggered by presenting a login

The guard applies to every request WordPress matches to a Store API handler, whatever the URL form or casing, including batch sub-requests. The tests exercise cart read, add-item, update-item, remove-item and batch. Outside the Store API (pages, `wc-ajax`), Woo 11.1.2 doesn't load a session from Cart-Token at all.

**Not mitigated / residual:**

- **Before sign-in, a guest bearer is a guest bearer.** Whoever holds it can change the guest cart, and those lines are then merged into the customer's cart (cart injection, not disclosure).
- **Work admitted before retirement.** A Store API request that passed the guard just before sign-in or sign-out can still finish. Its write lands on the retired key, which no one can reach again, but the shopper's fresh cart can miss that change (lost update). #54's per-cart coordination in the BFF has to serialize this. No atomicity across the copy, retire and delete steps is claimed.
- **Re-armed merge flag.** Re-arming has the same order dependence as the native flag. A Woo page or ajax request with the customer's cookie between sign-in and the first cart read consumes it into the customer's user-keyed session. The fresh cart then shows only the guest lines until the next sign-in. That is a correctness gap, not a disclosure: the user-keyed session is the customer's own and still needs their login. A production design should perform the merge inside sign-in, or have the BFF read the cart before anything else.
- **Signing secret.** Anyone with `wp_salt()` can forge tokens for any key. Owned keys still require the customer's login, but unowned guest keys are open. Treat the salt as a cart-wide secret.
- **Out of scope:** account compromise (the attacker has the WP cookie) and database access. Sign-out-everywhere is not provided: sign-out retires only this browser's key, and other devices keep theirs.

## Limits

- **Local, not deployed.** Loopback DDEV and a Node Frontend. This proves Woo-side isolation, not the #54 deployed-Worker gate, D1 mapping, encryption, epochs, cross-tab behaviour, recovery screen or browser automation. No browser was driven; the "browser" is an HTTP client with a cookie jar.
- **Not tested here:**
  - customization merge cases and coupons
  - expiry and Woo's HTTP-200 reset
  - concurrent mutations racing sign-in or sign-out
  - outages
  - plugins that change Woo sessions
- **One pinned version.** Behaviour depends on Woo 11.1.2 internals: the token format, `woocommerce_sessions`, the merge flag and session-handler selection. Re-run the baseline and isolated suites on every Woo upgrade; the baseline is there to show whether the failure still exists.
- **Registry growth.** Registry rows are never purged in the proof. Production needs a purge that keeps a retired row until the last token for its key has expired: `changed_at` plus the session lifetime, since every Store API response re-mints a token with a fresh `exp`.
- **Fixture-only parts.** The auth bridge is a fixture, and the fixture seeds the saved cart directly in user meta. Sign-ins that present no guest bearer still mint a fresh key and registry row.

## Security review required before any production use

1. Review the guard's coverage against the exact Woo version deployed: every route under `/wc/store/`, batch, any non-REST path that might select the token session handler, and third-party extensions that read `Cart-Token` themselves.
2. Review sign-in under concurrency: claim, copy and delete with a request admitted mid-transition. Decide whether the BFF serializes per cart or the extension takes a row lock.
3. Review the registry: retention and purge, backup and restore (a restored registry must not un-retire keys; see #54 Q17), and multisite prefixes.
4. Review the merge-flag re-arm: Woo's merge must stay Woo's, including customization cases.
5. Replace the fixture auth bridge with the real BFF bridge and re-run both suites against a deployed Worker with synthetic data, as #54 requires.

## Safety record

- **Deviation, corrected.** The first `env.sh up` used WP-CLI's `--prompt=admin_password` over stdin, and WP-CLI echoed the resulting command, synthetic admin password included, into a local log in the session scratchpad. Nothing left the machine and no real credential was involved. The log was deleted, the admin password rotated from a fresh mode-0600 file, and `env.sh` changed to discard install output and set passwords from files with `wp_set_password`. The customer password was never echoed.
- **Teardown:** `env.sh down` at 2026-10-04T15:39:29Z ran `ddev delete --omit-snapshot -y` on `gq-cart-identity-proof` only, then removed its working directory. Verified afterwards: no DDEV project of that name; zero containers, volumes and networks carrying its name or label; the working directory and its mode-0600 synthetic password files gone; the hostname answering 404 from the shared DDEV router. The shared router and other projects were not touched. The downloaded Woo source used for reading was deleted. No tunnel, Cloudflare resource, Sigillo secret or other repository was involved. Run logs were checked and contain none of the synthetic passwords or any Cart-Token.

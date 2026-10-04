# Upstream cart bearer isolation across native identity changes

> **Status: isolation demonstrated locally for the tested scenarios; not a production or security approval.** Issue #57, under the #54 contract. A disposable loopback store with pinned WordPress 7.1.2, WooCommerce 11.1.2 and the real GETQUICK plugins reproduced #50's bearer failures through GQ eCommerce's storefront BFF contract. The new `CartBearerIsolation` in [GQ eCommerce](https://github.com/Quick-Release/gq-ecommerce) then stopped every captured guest and authenticated-cart bearer from reading or changing the customer's cart. It shipped as GQ eCommerce **0.3.0**, and Ekis adopted the contract (see [Deployed](#deployed)). The deployed acceptance gate (#65) and the security review are still outstanding.

Code: GQ eCommerce 0.3.0 (`src/CustomerAccounts/CartBearerIsolation.php`, wired into the customer accounts `Controller`; [gq-ecommerce#1](https://github.com/Quick-Release/gq-ecommerce/pull/1)), and the proof in [`proofs/cart-identity/`](../../proofs/cart-identity/). Prior evidence: [the #50 commerce research](cloudflare-tanstack-commerce-architecture.md#one-live-proof-executed-with-failures).

## Findings in brief

- **Root cause (Woo 11.1.2 source).** A Store API `Cart-Token` is a signed `{user_id: <session key>, exp}` pointer, signed with `wp_salt()`. Woo has no revocation and doesn't check the key against a login. Three bearer kinds expose customer state:
  - **Guest bearer.** Woo merges the saved cart into whichever session the next signed-in cart load uses. Through the BFF that is the _guest_ key, so the pre-login bearer then holds the merged customer cart.
  - **Authenticated-cart bearer.** In the same flow, the bearer the BFF holds while signed in still points at that guest key, which logout leaves alone.
  - **Native user-keyed bearer.** Any signed-in Store API request without a token gets a token keyed by the customer's user ID.
- **Reproduced through the real BFF contract** (GQ eCommerce without isolation), with distinguishable synthetic carts. Saved cart: Alpha ×3 plus the saved-only Beta ×2. Guest cart: Alpha ×1. Login merged to Alpha ×1, Beta ×2.
  - The original guest bearer read _and changed_ the merged cart with no proxy secret and no customer session.
  - The authenticated-cart bearer read it after logout.
  - The native user-keyed bearer read it both while the customer was signed in and **after logout**. The BFF signs out over REST, where Woo has no session loaded, so Woo's logout hook never deletes the user-keyed session row.
- **Pre-existing GQ eCommerce bug, fixed first.** `StoreApiProxyAuthentication` set the customer on `determine_current_user` at priority 5. Core's `wp_validate_auth_cookie()` runs at 10, reads that user ID as a cookie, fails to parse it, and resets the user to `false`. So every proxied Store API request ran anonymously (observed: user 2 at priority 6, `NULL` at 11, `User-ID: 0` on the response). Under the BFF contract the signed-in cart, merge included, could not work at all. The fix (commit `0220d8c`, which the baseline suite runs on) moves the filter to priority 30. It also leaves alone whoever core's cookie or application-password validators signed in when a request isn't from the proxy. Without that second part (found in review), on-site shoppers signed in with WordPress cookies became anonymous on the Store API; a test now covers it.
- **Woo's merge flag is one-shot.** Any Woo frontend or ajax request after `wp_login` consumes it, because every such request loads a cart. Which session receives the merged cart therefore depends on request order, not on the login.
- **Fix, in GQ eCommerce: `CartBearerIsolation`.**
  - **Sign-in:** `login`/`register` move the BFF's guest cart to a **fresh session key registered to the customer**, retire the guest key, re-arm Woo's native merge for the fresh key and return the fresh `Cart-Token`.
  - **Sign-out:** `logout` retires the BFF's current key.
  - **Guard:** enforces retirement and ownership on every Store API route.

  Mapping rotation and native logout alone were not counted as the fix: the baseline suite rotates the browser handle and performs native logout, and still leaks.

- **Always on, by the user's decision.** The spec said "without production enablement"; the user chose to have the isolation active as soon as this GQ eCommerce version is deployed. The storefront BFF therefore had to adopt the new contract first: send the guest `Cart-Token` on login and logout, and use the returned one. Otherwise a guest bearer sent with a customer session gets `409 getquick_cart_transition_required`. Ekis did, before 0.3.0 was released (see [Deployed](#deployed)). Customer-cart transitions still need the #54 gate.
- **Result:** both suites pass: baseline (GQ eCommerce `0220d8c`, no isolation) and candidate (`0c4a1ac`). A mutation check (guard disabled) failed eight of the candidate suite's fourteen tests. The six that survive don't depend on the guard: sign-in, repeat sign-in, logout, saved-cart survival, the cookie-user check and the credential scan.
- **A bypass found in review, and fixed.** The first guard compared the requested route case-sensitively. But WordPress matches routes case-insensitively, and Woo's cart routes load the Cart-Token session whatever the casing. So `/wp-json/WC/Store/v1/cart` let the customer's own bearer read their cart with no login (observed: 200). The guard now decides by the handler WordPress actually matched, and the tests probe four URL forms for every rule.
- **Second review round, each fixed test-first:**
  - **Registry fail-open.** A lost registry table let a customer bearer read the cart (observed: 200). The guard now answers 503 when the registry can't be read, and never treats a key it minted (`c_…`) as a guest's.
  - **Logout skipped retirement** when the customer's upstream session had already ended. It now retires the presented customer key anyway; only the proxy can call it.
  - **Sign-in ordering.** Sign-in now decides what can be carried over first, copies the guest cart before claiming its key (so a failure leaves the guest cart usable), and hands a concurrent loser the winner's successor. Failed writes now raise errors instead of passing silently, and a sign-in that can't issue a bearer ends the session it just created.

## Environment

Executed **2026-10-04T16:17Z (final run; earlier iterations the same day)** on one developer machine, loopback only. User authorization covered exactly: a uniquely named local DDEV project, synthetic data, no tunnel, no Cloudflare deployment, no Sigillo access, no change to Ekis, and verified teardown. Changes to GQ eCommerce were requested by the user ("you can add the functionality there"); they were made in a separate git worktree and branch, and released later (see [Deployed](#deployed)).

| Component | Version / configuration                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store     | DDEV **v1.25.4**, Docker **29.4.0**, PHP **8.4.24**, MariaDB **11.8.9**, WordPress **7.1.2**, WooCommerce **11.1.2**, all read back by `env.sh versions`. HTTPS through DDEV's local mkcert CA; `opcache.revalidate_freq=0` so swapped plugin code is never served stale.                                                                                                                                                          |
| Plugins   | GETQUICK Config **0.3.5** (`7a9a0d9`, as a must-use plugin), GQ Design **0.3.1** (`927d759`, installed under its pre-rename slug `getquick-design`, which GQ eCommerce's `Requires Plugins` still names), GQ eCommerce **0.2.0**: baseline `0220d8c`, candidate `0c4a1ac` (clean tree). Installed from `git archive` of the local clones; versions and commits read back by `env.sh versions`.                                     |
| Fixtures  | Three synthetic simple products (Alpha $10, Beta $20, Gamma $30) and two synthetic customers (the second is for account switching). Customer accounts enabled through GETQUICK Config's settings. Reset before each suite: all Woo sessions and the bearer registry deleted, saved carts restored, customers' WP sessions destroyed, GQ eCommerce's sign-in throttle (30 per identifier per 10 minutes, observed working) cleared. |
| Frontend  | Disposable Node 24 fetch-style app on 127.0.0.1 speaking the storefront BFF contract: `X-GetQuick-Storefront-Proxy` on every call, `X-GetQuick-Upstream-Session` once signed in, sign-in and sign-out through `getquick-config/v1/woocommerce/auth/*`. The browser gets only a random 256-bit `__Host-` HttpOnly handle; bearers, upstream sessions and the proxy secret stay in server memory.                                    |
| Runtime   | A fixture mu-plugin provides what a Site's Bedrock does: PSR-4 autoloading for the plugins and `GETQUICK_STOREFRONT_PROXY_SECRET` from a mode-0600 file.                                                                                                                                                                                                                                                                           |
| Probe     | Node `fetch` straight to the Store API with a captured bearer and **neither** the proxy secret nor a customer session. Where stated, it adds a proxy secret and session, as a compromised BFF would. Bearers were captured by tapping the Frontend's upstream traffic, as a thief of the server-side credential would have them.                                                                                                   |

## Reproduced failures: GQ eCommerce without isolation (`0220d8c`)

The disposable Frontend drove each shopper step over HTTP. The probe then reused the captured bearers.

| Scenario                                                       | Observed                                                                                                              | Verdict                                                                         |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Guest adds Alpha ×1 through the Frontend                       | 200; no bearer, upstream session or proxy secret anywhere in browser responses                                        | Credential placement holds                                                      |
| Login through the Frontend                                     | 200, `customer`, Alpha ×1 + Beta ×2                                                                                   | Native merge: guest quantity wins, saved-only line added                        |
| Original guest bearer, no proxy or session, GET cart           | **200, Alpha ×1 + Beta ×2**                                                                                           | **Failure reproduced**                                                          |
| Native user-keyed bearer, no proxy or session, while signed in | **200, includes Beta ×2**                                                                                             | **Failure reproduced**                                                          |
| Logout through the Frontend                                    | 200, fresh empty guest cart, new handle, `nativeSignOut: confirmed`; the old upstream session no longer authenticates | Local isolation and native revocation                                           |
| Authenticated-cart bearer after logout                         | **200, Alpha ×1 + Beta ×2**                                                                                           | **Failure reproduced**                                                          |
| Native user-keyed bearer after logout                          | **200, Alpha ×1 + Beta ×2**                                                                                           | **Failure reproduced**; Woo's logout hook doesn't run for the BFF's REST logout |
| Original guest bearer, add Gamma                               | **201, Gamma added beside Beta ×2**                                                                                   | **Failure reproduced: change, not just read**                                   |

## The mechanism: GQ eCommerce `CartBearerIsolation`

One class of about 400 lines plus a few lines in the customer accounts `Controller` and `Plugin` boot. It keeps one registry table, `getquick_ecommerce_cart_bearers`, of session key, owner, state (`owned` or `retired`), successor key and timestamp. It uses only Store API utilities present in WooCommerce 10.9 (the plugin's minimum). It changes no Woo code, cart engine, merge rule or pricing.

**Guard.** It runs on `rest_request_before_callbacks`, after WordPress has matched the route and before any permission check or callback. It applies to every request matched to a Store API handler, whatever the URL's casing or form, and to each batch sub-request. It checks the outer `Cart-Token` (the one Woo loads, also for batch sub-requests) and a sub-request's own. Its refusal replaces any earlier validation error. If the registry can't be read it answers `503 getquick_cart_bearer_unavailable`, and a key it minted (`c_…`) that the registry doesn't know is never treated as a guest's.

1. A **retired** key is refused, `401 getquick_cart_bearer_retired`, whoever presents it, even with the customer's own session.
2. A **customer's key** (registered to them, or Woo's numeric user-ID key) is honoured only when the request's customer, as `StoreApiProxyAuthentication` resolves it, is that customer. Otherwise `401 getquick_cart_identity_required`, including when another customer's session presents the bearer (account switching).
3. A **guest key presented with a customer session** is refused, `409 getquick_cart_transition_required`. Woo therefore can never merge a saved cart into a key a guest bearer still points at.

**Sign-in** (`login` and `register`, which already require the proxy secret). After the native `wp_signon` succeeds:

1. Decides whether the presented key can be carried over: an unregistered guest key, or the customer's own key.
2. Registers a fresh random key to the customer and copies the guest session to it. A failure here leaves the guest cart untouched.
3. Claims the guest key, recording the fresh key as its successor, then deletes the guest row. A unique insert means only one sign-in can claim it; a concurrent loser discards its copy and gets the winner's successor if it is the same customer.
4. Re-arms Woo's one-shot `_woocommerce_load_saved_cart_after_login` flag, so Woo's own merge runs into the fresh key on the next cart read.
5. Returns the fresh bearer in the response's `Cart-Token` header, beside the upstream session. If no bearer can be issued, the sign-in fails and the session it just created is ended.

A repeated sign-in with the same guest bearer, for example after a lost response, returns the same successor key. A bearer that can't be carried over (Woo's user-ID key, or a key owned by someone else) starts the customer afresh. Woo's user-ID key is never claimed or retired, because the customer's cookie sessions share it.

**Sign-out** (`logout`). It retires the presented key if it belongs to the customer whose upstream session is ending, and deletes its row. If that session has already ended, it retires any presented customer key; only the proxy can call it. Then the existing native logout runs, even if retirement fails; it ends only this browser's session. Woo's saved cart (user meta, kept current by Woo on every signed-in cart change) is untouched.

The proof Frontend sends its guest bearer on login and uses the returned bearer. Logout always completes locally (fresh handle, fresh guest cart). It reports `nativeSignOut: confirmed` only when GETQUICK Config's `session` endpoint no longer accepts the old upstream session, and `pending` otherwise.

## Isolation results: GQ eCommerce `cart-identity`

"Every URL form" means four forms: `/wp-json/wc/store/…`, `?rest_route=/wc/store/…`, `/wp-json/WC/Store/…`, and a pretty path with an upper-case `rest_route` override.

| Scenario                                                                                                                                                          | Observed                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login through the Frontend                                                                                                                                        | 200, Alpha ×1 + Beta ×2; the Frontend's bearer points at a new key                                                                                              |
| Original guest bearer, no proxy or session: GET and add-item on every URL form, plus batch; GET **with** the customer's session                                   | all `401 getquick_cart_bearer_retired`                                                                                                                          |
| Sign in again with the original guest bearer                                                                                                                      | 200, same fresh key                                                                                                                                             |
| While the customer is signed in, no proxy or session: native user-keyed bearer (GET) and the Frontend's authenticated-cart bearer (GET, add-item), every URL form | all `401 getquick_cart_identity_required`; the customer's cart, read through the Frontend afterwards, is unchanged                                              |
| A second synthetic customer's session presents the first customer's authenticated-cart and user-keyed bearers                                                     | `401 getquick_cart_identity_required`                                                                                                                           |
| The second customer signs in with the first customer's user-keyed bearer                                                                                          | 200 and a fresh key of their own; reading it gives 200 and an empty cart                                                                                        |
| New guest bearer presented with the customer's session                                                                                                            | `409 getquick_cart_transition_required`; the guest cart is still empty afterwards (no merge)                                                                    |
| Logout through the Frontend                                                                                                                                       | 200, fresh empty guest cart, `nativeSignOut: confirmed`; the old upstream session no longer authenticates                                                       |
| After logout, every URL form: authenticated-cart bearer (GET, add-item, update-item, remove-item) and native bearer (GET, update-item); batch                     | all `401 getquick_cart_bearer_retired` / `401 getquick_cart_identity_required`                                                                                  |
| Authenticated-cart bearer presented with a fresh session of the same customer                                                                                     | `401 getquick_cart_bearer_retired`                                                                                                                              |
| Sign in again through the Frontend                                                                                                                                | 200, **Alpha ×1 + Beta ×2**: the saved cart survived logout. Woo writes the saved cart only for a signed-in customer, so this shows preservation, not isolation |
| Logout after the customer's sessions were ended out of band                                                                                                       | 200; the bearer is `401 getquick_cart_bearer_retired`                                                                                                           |
| The registry table is dropped (its schema option kept, as a restore might), then the customer's bearer is used                                                    | refused (503), no cart lines                                                                                                                                    |
| A shopper signed in on the WordPress site with native cookies and a REST nonce reads the Store API                                                                | 200, as that customer (`User-ID` not 0)                                                                                                                         |
| Every browser response in the run, both shoppers                                                                                                                  | contains none of the bearers, upstream sessions or proxy secret exchanged upstream                                                                              |

Final run: **22 tests in 3 suites, 22 passed, 0 failed, 0 cancelled (2026-10-04T16:17Z, GQ eCommerce baseline `0220d8c`, candidate `0c4a1ac` clean). Every assertion is listed in `proofs/cart-identity/isolation.test.mjs`**.

## Threat model

**Protected:** the customer's cart state behind a native identity: saved-cart lines, the merged cart and the right to change either.

**Adversary:** holds a copy of a Woo Cart-Token issued to the shopper's browser session, but not the proxy secret or the customer's upstream session. Ways to get one include browser-held tokens in Ekis's current transport, a shared device, logs or traces, or anything between the BFF and WordPress.

**Mitigated:**

- the pre-login guest bearer after sign-in
- any bearer the BFF held while signed in, after sign-out
- Woo's user-ID bearer without that customer's session
- one customer's bearer presented with another customer's session
- guest-key merges triggered by presenting a customer session

The guard applies to every request WordPress matches to a Store API handler, whatever the URL form or casing, including batch sub-requests. The tests exercise cart read, add-item, update-item, remove-item and batch. Outside the Store API (pages, `wc-ajax`), Woo 11.1.2 doesn't load a session from Cart-Token at all.

**Not mitigated / residual:**

- **Before sign-in, a guest bearer is a guest bearer.** Whoever holds it can change the guest cart, and those lines are then merged into the customer's cart (cart injection, not disclosure).
- **Work admitted before retirement.** A Store API request that passed the guard just before sign-in or sign-out can still finish. Its write lands on the retired key, which no one can reach again, but the shopper's fresh cart can miss that change (lost update). #54's per-cart coordination in the BFF has to serialize this. No atomicity across the copy, retire and delete steps is claimed.
- **Re-armed merge flag.** Re-arming has the same order dependence as the native flag. A Woo page or ajax request with the customer's login between sign-in and the first cart read consumes it into the customer's user-keyed session. The fresh cart then shows only the guest lines until the next sign-in. That is a correctness gap, not a disclosure.
- **A compromised BFF.** Anyone holding the proxy secret and a customer's upstream session can act as that customer, by design.
- **Signing secret.** Anyone with `wp_salt()` can forge tokens for any key. Owned keys still require the customer's session, but unowned guest keys are open.
- **Out of scope:** account compromise and database access. Sign-out-everywhere is not provided: sign-out retires only this browser's key, and other devices keep theirs.

## Limits

- **Local, not deployed.** Loopback DDEV and a Node Frontend. This proves the WordPress-side isolation through the BFF contract. It does not prove:
  - the #54 deployed-Worker gate
  - Ekis's real BFF against a deployed store with a signed-in customer (it adopted the contract in ekis#48, but that path is untested live; see [Deployed](#deployed))
  - the D1 mapping, encryption, epochs or cross-tab behaviour
  - the recovery screen or browser automation

  The "browser" is an HTTP client with a cookie jar.

- **Not tested here:**
  - customization merge cases and coupons
  - expiry and Woo's HTTP-200 reset
  - concurrent mutations racing sign-in or sign-out
  - outages
  - plugins that change Woo sessions
- **Not run:** GQ eCommerce's Pest suites, which live in Ekis's CMS (`tests/Feature/GetQuick*Test.php`), so running them would mean changing the Ekis repo, which wasn't authorized. A unit test that asserts `StoreApiProxyAuthentication`'s filter priority would need updating.
- **One pinned version.** Behaviour depends on Woo 11.1.2 internals: the token format, `woocommerce_sessions`, the merge flag and session-handler selection. Re-run both suites on every Woo upgrade; the baseline shows whether the failure still exists.
- **Registry growth.** Registry rows are never purged. Production needs a purge that keeps a retired row until the last token for its key has expired: `changed_at` plus the session lifetime, since every Store API response re-mints a token with a fresh `exp`. Every sign-in mints a fresh key and row.
- **Text domain.** The four new messages use the branch's text domain, `getquick-ecommerce`, and were added to its canonical `.pot`. Uncommitted work on the plugin's main checkout renames that domain to `gq-ecommerce`, so merging will need the four strings carried over.

## Security review required before any production use

1. Review the guard's coverage against the exact Woo version deployed: every route under `/wc/store/`, batch, any non-REST path that might select the token session handler, and third-party extensions that read `Cart-Token` themselves.
2. Review sign-in under concurrency: claim, copy and delete with a request admitted mid-transition. Decide whether the BFF serializes per cart or the extension takes a row lock.
3. Review the registry: retention and purge, backup and restore (a restored registry must not un-retire keys; see #54 Q17), and multisite prefixes.
4. Review the merge-flag re-arm: Woo's merge must stay Woo's, including customization cases.
5. Review the `determine_current_user` priority change against every request path `StoreApiProxyAuthentication` serves (proxy, cookie, application password), and update its Pest test.
6. Re-run both suites against the deployed Worker with synthetic data, as #54 requires (#65). Ekis's BFF has adopted the contract.

## Deployed

On 2026-10-04 the change shipped in the agreed order, so that no storefront ever met a store it couldn't talk to:

1. **Ekis storefront, [ekis#48](https://github.com/Quick-Release/ekis/pull/48)** (merged `9c9caef`, deployed). The Worker holds the cart bearer behind its cart handle (#56) and hands it over on sign-in, registration and sign-out. It keeps the returned customer bearer with a conditional D1 write on a per-handle generation, drops refused bearers, and doesn't sign customers out for them. This session reviewed it against the contract and ran its tests (232 passing). It superseded a browser-held version, [ekis#47](https://github.com/Quick-Release/ekis/pull/47), which was closed. That PR's late-response race fix and 401 exemption carried over.
2. **GQ eCommerce 0.3.0, [gq-ecommerce#1](https://github.com/Quick-Release/gq-ecommerce/pull/1)** (merged `804fedb`, tag `v0.3.0`). It was a minor version so that `^0.2` storefronts couldn't pick it up early.
3. **Ekis CMS on `^0.3.0`, [ekis#49](https://github.com/Quick-Release/ekis/pull/49)** (merged `c8c7d49`, deployed to `ekis-admin.bnq.pt`).

Afterwards, read-only: the storefront answers 200, and `/api/auth/session` is anonymous. **Not proven live:** the handoff and guard with a signed-in customer on the deployed store. The staging store has no purchasable product and no synthetic customer, so that remains the #65 gate. GQ eCommerce's Pest suites in Ekis's CMS haven't been run against 0.3.

## Safety record

- **Deviation, corrected.** The first `env.sh up` used WP-CLI's `--prompt=admin_password` over stdin, and WP-CLI echoed the resulting command, synthetic admin password included, into a local log in the session scratchpad. Nothing left the machine and no real credential was involved. The log was deleted, the admin password rotated, and `env.sh` changed to discard install output and set passwords from files with `wp_set_password`.
- **Teardown:** both provisioned stores were torn down with `env.sh down`, the second at 2026-10-04T16:17:53Z: `ddev delete --omit-snapshot -y` on `gq-cart-identity-proof` only, then its working directory removed. Verified afterwards: no DDEV project of that name; zero containers, volumes and networks carrying its name or label; the working directory and its mode-0600 synthetic passwords and proxy secret gone; the hostname answering 404 from the shared DDEV router. The shared router and other projects were not touched. The GETQUICK plugin clones were only read (`git archive`); GQ eCommerce changes are on its `cart-identity` worktree branch, unpushed, and its main checkout was left as it was. No tunnel, Cloudflare resource, Sigillo secret or Ekis change was involved. Run logs contain none of the synthetic passwords, the proxy secret or any Cart-Token.

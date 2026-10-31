# Commerce sites

[Documentation](../README.md)

A commerce site is a WooCommerce shop: its CMS is the only commerce authority,
and its Frontend is its storefront, a TanStack Start app on Cloudflare Workers
([ADR 0017](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0017-generate-commerce-sites-from-the-variant-alone.md)).
The variant alone decides what the blueprint gives it, and it never changes
after `gq new`.

```sh
gq new shop --project shop --variant commerce [--locale pt_PT_ao90]
```

Like a content site, it is generated offline and without secrets, passes
`pnpm verify` once installed, and is in sync straight away (`gq sync --check`
exits 0). It prints its provisioning sequence and runs none of it.

## What differs from a content site

| Part                   | Commerce site                                                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wordpress.plugins`    | `gq-design`, `woocommerce`, `getquick-ecommerce`, `gq-support`, `s3-uploads`, `simple-history`, `cimo-image-optimizer`, `safe-svg`, in that order. No WPGraphQL.        |
| CMS skeleton           | Bedrock with WooCommerce and GQ eCommerce; no content API or publication-event mu-plugins. Its `.env.production.example` has `GETQUICK_STOREFRONT_PROXY_SECRET`.        |
| `deploy/ploi/admin.sh` | The same script; after activating the plugins it runs WooCommerce's database update (`wp wc update`), and it skips the content CMS's wpgraphql-blocks dependency patch. |
| Frontend skeleton      | A minimal TanStack Start app (`apps/frontend`) on Vite+ with the storefront Runtime mounted: `vp dev` at <http://localhost:3000>, `vp build`, `vp test`, a type check.  |
| Frontend deploy        | `infra/frontend.run.ts` deploys it with Alchemy's `Cloudflare.Website.Vite`; `infra/storefront-bindings.ts` applies what the storefront Runtime declares.               |
| `.npmrc`               | Names GitHub Packages for `@quick-release/*`, without a token.                                                                                                          |
| Default checks         | Content's, plus `pnpm run build`. Required files: `apps/frontend/{package.json,vite.config.ts}` instead of `astro.config.mjs`.                                          |
| Content delivery       | None: no publication store, publication or settings events, reconciliation or refresh, and no gq-content consent wiring.                                                |
| Languages              | `wordpress.locale` only; `wordpress.languages` is refused until multilingual commerce is decided.                                                                       |

## Readiness

`pnpm site:check` (`gq site check` under Sigillo staging) is a commerce
site's only "ready", as it is a content site's
([ADR 0021](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0021-declare-a-commerce-site-ready-through-the-same-gate.md)).
`pnpm verify`, formatting and manifest validation never are. It exits 1 until
no check is ✗, and says what to run for each that fails. Warnings (⚠) don't
block.

| Check               | Not ready when                                                                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wordpress`         | `https://<domains.admin>/wp-json/` doesn't answer, redirects to the installer, or redirects anywhere else (plain permalinks: GQ Config sends `/wp-json/` to the Frontend)              |
| `plugins`           | the REST API lacks a route WooCommerce, GQ Config, GQ eCommerce or GQ Design registers (each named)                                                                                    |
| `theme`             | the active theme isn't `getquick-theme` or a child of it (read as the CMS check user)                                                                                                  |
| `store-api`         | the Store API doesn't list products (an empty catalogue only warns)                                                                                                                    |
| `proxy-secret`      | GQ eCommerce's customer auth refuses Sigillo staging's `GETQUICK_STOREFRONT_PROXY_SECRET`: the CMS's `.env` lacks it or has another                                                    |
| `homepage`          | the storefront's homepage isn't a 200, or Cloudflare's edge or a shared cache could hold it                                                                                            |
| `cart`              | a cart doesn't round-trip through the Worker: the Runtime isn't mounted, `CART_SESSIONS` isn't bound or migrated, a secret is missing, or the second read gets a new cart              |
| `customer-auth`     | with sign-in on, the Worker's `/api/auth/configuration` isn't `available`: its proxy secret isn't the CMS's, or the auth upstream isn't bound (with sign-in off: a warning, see below) |
| `turnstile`         | with sign-in on, Sigillo staging lacks `TURNSTILE_SECRET` or `TURNSTILE_EXPECTED_HOSTNAMES`                                                                                            |
| `rate-limiters`     | a sign-in probe for a made-up account isn't refused at Turnstile: a rate limiter isn't bound                                                                                           |
| `legal-pages`       | GQ Config's Legal Contract lacks a required page (terms of sale, returns and shipping included) or the data controller                                                                 |
| `consent-runtime`   | GQ Config's GA4 toggle is on and the homepage has no consent Runtime                                                                                                                   |
| `third-party-hosts` | the homepage loads from a host outside the site before consent                                                                                                                         |
| media checks        | `gq media check --upload` isn't ready                                                                                                                                                  |

The proxy secret is proven twice: `proxy-secret` asks the CMS with Sigillo
staging's, and `customer-auth` has the Worker ask with its own. With customer
sign-in off (GQ Config's customer accounts setting), the CMS answers the
Worker "unavailable" either way, and storefront 0.2.2 can't tell that from a
refused secret. So `customer-auth` only warns until sign-in is on. Turn sign-in
on, then check again before shoppers sign in.

The checks read, except three probes. The media upload deletes what it
uploads. The cart round-trip leaves an empty guest cart, as a visitor's first
cart read does. A sign-in attempt for `gq-site-check@example.invalid` is
refused at the Worker's Turnstile check, before WordPress. Nothing creates an
order or a customer.

Payments, checkout, shipping, tax, orders, end-to-end sign-in, catalogue
delivery and multilingual commerce aren't checked: test an order before taking
real ones.

`pnpm site:check:local` checks the DDEV CMS's REST API, plugins, Store API,
theme and local uploads. The storefront isn't checked locally: `vp dev` has no
Worker bindings, so the Runtime answers 503 there.

`gq media check` applies to both variants.

`gq frontend refresh`, `gq frontend events check` and `gq ploi events` are
content-only: a commerce site has no publication store or publication events,
and each refuses there, saying why.

## Provisioning

`gq new` prints the sequence. It differs from a content site's in three ways:

- `pnpm frontend:secrets` runs first. On a commerce site it generates the
  storefront Runtime's secrets into Sigillo staging: the proxy secret it shares
  with GQ eCommerce, and the session and cart-handle keyrings. Turnstile's
  secret comes from Cloudflare, not from gq.
- `pnpm ploi:provision` gives the CMS's `.env` the proxy secret
  (`GETQUICK_STOREFRONT_PROXY_SECRET`). It shows the step, never the value, and
  warns until the secret is in Sigillo.
- There is no `ploi:events` or `frontend:refresh`. It ends with
  `media:check:upload` and `site:check`, as a content site's does, with the
  checks in [Readiness](#readiness).

`pnpm ci:deploy` gives the CI Worker the storefront's secrets and the fleet's
`GITHUB_PACKAGES_TOKEN`, which `gq sigillo run` reads from GQ Platform `ops`
([secrets](secrets.md#gq-platform-ops-the-registry-credentials)); on a
commerce Site it refuses without the token. CI's install step writes the
token to the container's user-level npm config, so pnpm can install the
`@quick-release` packages, and refuses without it; the release step hands the
storefront's secrets to the Frontend's deploy. Nothing is copied into the
Site's Sigillo: a new commerce Site needs only read access to GQ Platform
`ops` for whoever runs these commands.

## Local data

`pnpm db:sync` stays live-to-local only. On a commerce site it anonymises the
copy straight after importing it, before WordPress reads it:

- **Customers:** every user whose only role is customer gets
  `customer-<ID>@example.invalid` and no password.
- **Saved addresses:** cleared on every account.
- **Orders:** billing and shipping data, notes, IP addresses and user agents
  are blanked, in both the HPOS tables and the legacy order meta.
- **Everything else personal:** the customer lookup, review and order-note
  authors, and download logs are anonymised, and carts (WooCommerce sessions)
  are emptied.

Store staff keep their accounts. Its local check reads the Store API, since a
commerce CMS has no WPGraphQL.

## Rate-limit namespaces

The storefront Runtime's rate limiters need a namespace ID each. IDs are per
Cloudflare account, and two sites sharing one share its counters, so each
site records its own in `gq.ops.json`:

```json
"cloudflare": {
  "rateLimitNamespaces": {
    "AUTH_IDENTIFIER_RATE_LIMITER": 1004,
    "AUTH_IP_RATE_LIMITER": 1005,
    "AUTH_PENALTY_RATE_LIMITER": 1006
  }
}
```

These are the IDs reserved for documentation (1004–1006): don't deploy them.
Take unused IDs in the Site's account from the fleet's
[register of rate-limit namespaces](../reference/rate-limit-namespaces.md),
and add the Site's to it. `gq doctor` warns when a Site's IDs are another
Site's, reserved, or not in the register. Once the Frontend depends on the
Runtime, the deploy refuses to run without them and names each missing one.

## Private packages

`@quick-release/*` packages come from GitHub Packages, and a commerce
Frontend depends on two: the storefront Runtime and its auth contract. So,
unlike a content site, installing a commerce site needs a GitHub token with
`read:packages` that can read them; generating one doesn't. It is the
fleet's `GITHUB_PACKAGES_TOKEN`, a classic token from a Quick-Release machine
account kept once in GQ Platform `ops` and read at use
([secrets](secrets.md#gq-platform-ops-the-registry-credentials),
[gq-platform ADR 0013](https://github.com/Quick-Release/gq-platform/blob/main/docs/adr/0013-fleet-registry-credentials-read-at-use-from-gq-platform-ops.md)).

- **Locally:** `gq setup` installs with it, and so does anything run through
  `gq sigillo run` (`gq sigillo run local -- pnpm install`): pnpm gets it in
  its environment, never a file. A plain `pnpm install` uses your user-level
  `~/.npmrc` (`//npm.pkg.github.com/:_authToken=…`), if you keep a token
  there; pnpm ignores tokens in a repository's `.npmrc`, and the generated one
  never holds one.
- **Cloudflare CI:** given to the CI Worker by `pnpm ci:deploy` (see above).
  After the token is rotated in GQ Platform `ops`, run `pnpm ci:deploy`
  again.
- **GitHub Actions in the site's own repository:** the workflow's
  `GITHUB_TOKEN` with `packages: read` reads a package only once that
  package grants the repository Actions access (the package's settings,
  _Manage Actions access_, by an organization admin); otherwise use a
  `read:packages` token as a repository secret.

## The storefront Runtime

The catalog, cart, checkout and sign-in come from the storefront Runtime,
`@quick-release/storefront`, mounted behind the Frontend's own Worker at
`/api/store/*` and `/api/auth/*` (a same-origin BFF). The skeleton depends on
it and on its auth contract, `@quick-release/auth-contract`, both pinned
exactly; `src/storefront.server.ts` configures it from `gq.ops.json`, two
server routes mount it, and the router gives every route its Query client.
The app stays the site's own: `gq sync` never rewrites it.

The managed deploy finds the installed Runtime and declares what its
`infra.json` lists: the cart-session D1 database (retained in production,
migrations applied before the Worker), its rate limiters, and its secrets and
variables, and refuses a deploy missing any, naming each. A site generated
before 0.29.0 adds the Runtime itself: see
[Add the storefront Runtime](storefront-runtime.md).

## Adopting from a gated foundation

A site started as a gated foundation (root tooling, `gq.ops.json` and an
always-failing check, like FPA Shop and Bruaa) adopts the commerce variant in
its own repository:

1. Remove the root files the blueprint now manages or creates:
   `vite.config.ts`, `.vite-hooks/` and `pnpm-workspace.yaml`, and the
   `engines` key of `package.json`.
2. Set `wordpress.plugins` to the list above and remove the blocked check
   from `verify.checks`.
3. Bump `@getquick/site` and install it (`pnpm install`), so the new `gq`
   runs. With no `pnpm-workspace.yaml`, pnpm writes one of its own (its
   `allowBuilds`, no `packages`), and `gq sync` keeps a create-once file it
   finds.
4. Run `pnpm exec gq sync --recreate pnpm-workspace.yaml --recreate package.json`.
   It creates `apps/cms` and `apps/frontend` (neither exists yet), with the
   storefront Runtime mounted, and the managed files; it replaces pnpm's
   workspace file with the blueprint's; and it adds to the existing root
   `package.json` the keys a new Site's starts with, which only a
   `package.json` gq creates gets: the `dev`, `frontend:dev`, `build`,
   `check`, `lint`, `format` and `test` scripts (`gq verify` runs `check`,
   `lint`, `test` and `build`) and the `sigillo`, `vite` and `vite-plus`
   devDependencies. It changes no key the file has. A plain `gq sync` warns
   about both instead, naming the `--recreate` that fixes each, and
   `gq doctor` fails on them.
5. Run `pnpm install` with a `read:packages` token in your user-level npm
   config (see [Private packages](#private-packages)), commit the lockfile,
   and run `pnpm verify`.

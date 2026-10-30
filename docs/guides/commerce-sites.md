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

## No readiness yet

A commerce site has no readiness check: which health checks make one ready is
[#26](https://github.com/Quick-Release/gq-site/issues/26)'s decision. Until
then nothing it passes, `pnpm verify`, formatting or manifest validation
included, makes it ready, and `gq site check` refuses to run. `gq media check`
applies to both variants.

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
- There is no `ploi:events`, `frontend:refresh` or `site:check`.

`pnpm ci:deploy` gives the CI Worker the storefront's secrets and a
`GITHUB_PACKAGES_TOKEN` when Sigillo staging has them. CI's install step
writes the token to the container's user-level npm config, so pnpm can
install the `@quick-release` packages, and refuses without it; the release
step hands the storefront's secrets to the Frontend's deploy.

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

Pick unused IDs from the fleet's register of the account and add the site's
to it. Once the Frontend depends on the Runtime, the deploy refuses to run
without them and names each missing one.

## Private packages

`@quick-release/*` packages come from GitHub Packages, and a commerce
Frontend depends on two: the storefront Runtime and its auth contract. So,
unlike a content site, installing a commerce site needs a GitHub token with
`read:packages` that can read them; generating one doesn't.

- **Locally:** keep the token in your user-level `~/.npmrc`
  (`//npm.pkg.github.com/:_authToken=…`): pnpm ignores tokens in a
  repository's `.npmrc`, and the generated one never holds one.
- **Cloudflare CI:** `GITHUB_PACKAGES_TOKEN` in Sigillo staging, given to the
  CI Worker by `pnpm ci:deploy` (see above).
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
3. Bump `@getquick/site` and run `gq sync`. It creates `apps/cms` and
   `apps/frontend` (neither exists yet), with the storefront Runtime mounted,
   and the managed files.
4. Run `pnpm install` with a `read:packages` token in your user-level npm
   config (see [Private packages](#private-packages)), commit the lockfile,
   and run `pnpm verify`.

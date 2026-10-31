# {{Project}} storefront

{{Project}}'s Frontend: a [TanStack Start](https://tanstack.com/start) app
(React, TanStack Router), built with Vite+ and deployed to Cloudflare Workers
by `infra/frontend.run.ts`. WooCommerce, in the CMS (`apps/cms`), is the only
commerce authority: the storefront keeps no catalog, price or order of its
own.

Everything in this directory is the Site's own: `gq sync` never rewrites it.

## Local development

From the repository root:

```sh
pnpm dev            # vp dev, at http://localhost:3000
pnpm check          # type check
pnpm test           # vp test
pnpm build          # vp build
```

Routes live in `src/routes` (file-based); `src/routeTree.gen.ts` is generated
from them by the TanStack Start plugin on `vp dev` and `vp build`. Commit it,
so the type check doesn't need a build first.

## The storefront Runtime

The catalog, cart, checkout and sign-in come from the GETQUICK storefront
Runtime, `@quick-release/storefront`, mounted behind this Worker (a
same-origin BFF): `src/routes/api.store.$.ts` serves `/api/store/*` and
`src/routes/api.auth.$.ts` serves `/api/auth/*`, both through
`src/storefront.server.ts`. The router gives every route the Runtime's Query
client (`src/router.tsx`); `@quick-release/storefront/client` has the cart,
checkout and auth calls and hooks to build pages with.

The managed deploy (`infra/frontend.run.ts`) declares the bindings the
Runtime's `infra.json` lists: its cart-session database, rate limiters,
secrets and variables. Under `vp dev` and in tests there are none, so
`/api/store/*` and `/api/auth/*` answer 503 there.

`@quick-release/*` packages come from GitHub Packages: installing needs the
fleet's `read:packages` token, which `gq setup` and `gq sigillo run local --
pnpm install` read from GQ Platform `ops` (or one in your user-level
`~/.npmrc`, `//npm.pkg.github.com/:_authToken=…`), never in this repository.

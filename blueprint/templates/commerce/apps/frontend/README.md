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
Runtime, `@quick-release/storefront`, mounted at `/api/store/*` and
`/api/auth/*` behind this Worker (a same-origin BFF). It isn't installed yet:
see the `@getquick/site` guide on adding the storefront Runtime. Once it is a
dependency here, the managed deploy declares the Cloudflare bindings it needs
(its cart-session database, rate limiters, secrets and variables).

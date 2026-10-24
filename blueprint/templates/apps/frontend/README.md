# {{Project}} Frontend

Astro, server-rendered on Cloudflare Workers, reading published content from
the CMS (`../cms`) through WPGraphQL. Its Worker is declared in
`../../infra/frontend.run.ts` and deployed by Alchemy, not Wrangler.

## Development

From the workspace root:

```sh
pnpm install
cp apps/frontend/.env.example apps/frontend/.env   # or: pnpm setup
pnpm dev
```

`PUBLIC_WORDPRESS_GRAPHQL_URL` in `.env` points at the CMS's GraphQL endpoint
(`https://{{project}}-admin.ddev.site/wp/graphql` with `pnpm cms:dev`). With no
CMS running, `pnpm dev` renders a placeholder front page, so the Frontend can be
built before the CMS exists.

## The content runtime

Delivery is `@getquick/content`'s, pinned in `package.json` together with the
CMS's `getquick/gq-content` plugin; `gq sync` keeps both pins at one version.
The package's README documents its configuration and exports. This app
configures it and composes the pages:

- `src/lib/content.ts` (this Site's) makes the runtime for each request from
  `gq.ops.json` (the Site's identity, `project`, and its languages), the build
  environment (`PUBLIC_WORDPRESS_GRAPHQL_URL`) and the Worker's bindings.
  Only `pnpm dev` reads the CMS live without a store.
- `src/pages/gq/events.ts` and `src/pages/gq/refresh.ts` are managed by
  `gq sync`: they hand the CMS's signed events and the trusted refresh
  (`pnpm frontend:refresh`) to the runtime. `src/pages/gq/consent.ts` and
  `src/pages/gq/consent/[...rest].ts`, also managed, hand visitors' consent
  decisions and the CMS's authenticated reads of them to the package's
  consent server. `/gq/` is reserved for them.
- Consent (CONSENT-1, LEGAL-1): `src/lib/content.ts` turns on the runtime's
  `consent` option (third-party embeds become placeholders at delivery; GQ
  Config's legal pages and GA4 toggle reach the chrome) and lists the catalog
  services the Site embeds. `src/layouts/Layout.astro` renders the consent
  banner, the legal links and the "Cookie settings" control on every page.
- Header and footer: `src/layouts/Layout.astro` renders the patterns editors
  select in GQ Design's Header & Footer (`chrome.header`, `chrome.footer`;
  GQ Design 0.4.1 or newer) with `renderDesignPattern`, and its own header
  when there is none. A Site block without saved HTML renders only through a
  renderer passed in `blocks` (`@getquick/content`'s README, "Header and
  footer patterns").
- `src/pages/index.astro`, `src/pages/[...slug].astro`,
  `src/components/Home.astro` and `src/layouts/Layout.astro` render what the
  runtime delivers, with the status it answers: 200, 404 when WordPress
  confirms nothing is published there, 503 when the CMS or the store fails,
  and a 301 for a moved entry. Pages answer with `Cache-Control: no-cache`;
  don't put a cache in front of the store that could outlive a withdrawal.

## Durable published content

The deployed Frontend serves the front page, the entries (published pages and
posts) and the site chrome (menu, logo, icon, site identity, design presets,
selected header and footer)
from its publication store, a D1 database bound as `PUBLICATION_DB`
(`../../infra/frontend.run.ts`). The store's migrations ship in
`@getquick/content` (`@getquick/content/migrations`), and the deploy applies
them: installing the package is what gives the Frontend a store. Pages are
a 503 until `pnpm frontend:refresh` has stored the front page and the chrome.
The CMS keeps the store current with signed events, retries them on the
server's cron (`pnpm ploi:events` installs it) and reconciles every minute.

## Languages

A bilingual Site lists its other languages in `gq.ops.json`
(`wordpress.languages`, beside the default `wordpress.locale`), and its CMS
runs Polylang with GQ Polylang for WPGraphQL. `src/lib/content.ts` gives them
to the runtime when the Frontend is built. A route's language is its first
segment when that is another language's slug (`/en/about/` is English), and
the default language otherwise; `/en/` is English's home, served by
`src/pages/[...slug].astro` as `/` is by `index.astro`
(`src/components/Home.astro`). Each page has its language's `<html lang>`,
chrome and home link, `<link rel="alternate" hreflang>` to each published
translation (plus `x-default`, the default language's), and a language
switcher. The Frontend's own words (the 404, "Temporarily unavailable", the
placeholders) are in `src/lib/copy.ts`, in English and Portuguese. A route
with no entry in its language is a 404: there is no fallback across
languages.

## Blocks

`@getquick/content` renders the GETQUICK Design blocks WPGraphQL Blocks
returns. The layout installs its shared `presentationStyleSheet` for content
and selected header/footer patterns, including settings authored after the
Frontend was built. Its scoped `designThemeStyleSheet` applies Preflight and
resolved theme variables to `.gqd-content`; both stylesheets use the delivered
theme, so refreshed spacing and breakpoints update together without rebuilding.
`blockPresetStyles` supplies the CMS's spacing and color presets. Presentation
values follow Base and upward breakpoint overrides.

Container sizing applies Tailwind's width caps without centering or padding.
Authors set margins and padding explicitly. The skeleton no longer imposes
article widths, sibling spacing, legacy device visibility or constrained-parent
Container styles on published content. Existing designs can change appearance.
Keep Site shell styling in `src/styles/global.css` from overriding authored
presentation. The layout, pages and styles are Site-owned after generation;
`gq sync` does not replace them automatically.

Video Hero uses the package's `videoHeroStyleSheet` and browser-only
`mountVideoHero`. The initializer handles decorative player sizing, reduced
motion and media replacement; the Site supplies no second media observer.
Sizing and foreground alignment stay authored independently. Consent still
controls whether optional third-party media can load.

Carousel uses `designCarouselStyle` and the browser `mountDesignCarousels` from
the same package. Shared runtime code owns slides, accessible controls and
motion preferences. Selected chrome Query patterns preload producer-selected
standard Post/Page URIs through `runtime.preloadDesignQueryPosts`; rendering
uses its synchronous `resolvePost` callback. The Site does not select items
again or fetch from inside the renderer. Other post types require a separately
authorized loader.

## Checks

`pnpm check` (`astro check`), `pnpm lint` (`vp lint`) and `pnpm test`
(`vp test`) run from the workspace root, and in `pnpm verify`. `src/routes.test.ts`
renders the pages through Astro's Container API against a stubbed CMS
(`vitest.config.ts` gives Vitest Astro's Vite config): what this Site
composes from what the runtime delivers. The runtime's own tests are
`@getquick/content`'s.

## Deploys

Releases deploy the Frontend from the `v*` tag in Cloudflare CI
(`infra/ci`). Deploys build with `PUBLIC_WORDPRESS_GRAPHQL_URL` set to
`https://<domains.admin><wordpress.graphqlPath>` from `gq.ops.json` (the path
defaults to `/wp/graphql`; `/graphql` is also supported). An explicit process
`PUBLIC_WORDPRESS_GRAPHQL_URL` still overrides that default. Production Alchemy
wiring passes the public URL into Astro's build environment; local DDEV keeps
its `/wp/graphql` env template. `pnpm deploy:frontend` redeploys by hand with
the token in Sigillo `staging`.

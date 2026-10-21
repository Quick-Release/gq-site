# Frontend starting points and metadata candidate proofs

Both variants start with semantic header/main/footer landmarks, a keyboard skip
link, visible focus, logical layout properties, system Light/Dark starting
colours, reduced-motion and forced-colour CSS. Their shared source is
`blueprint/templates/shared/frontend/site.css`. The generated stylesheet and
shell are Site-owned: `gq sync` preserves customizations and does not retrofit
existing Sites.

Astro's `vp run check` retains `astro check`. `vp run build` now performs a real
local Astro SSR build through the already-installed Alchemy Node integration.
It does not provision anything. Production remains built by the existing
Alchemy configuration in `infra/frontend.run.ts`; the local Node build has no
production D1 bindings and therefore serves the existing unavailable state.
TanStack retains its framework build and typecheck.

## Explicit metadata candidate gate

The new metadata exports are not an ordinarily installable registry release.
Default generation has no content metadata dependency and uses a dependency-free
document-head stub. Do not replace it with a guessed public version.

Use this branch’s checkout CLI for an explicitly configured, local candidate proof;
the generated ordinary registry CLI does not acquire these unreleased features:

```sh
node bin/gq.mjs new /tmp/orbit --project orbit --variant content \
  --metadata-candidate /absolute/getquick-content-candidate.tgz
```

Use `--variant commerce` for TanStack. The gate records the exact artifact path
and SHA-256 in `gq.metadata-candidate.json`. Sync verifies the artifact bytes,
manages the single `@getquick/content` dependency key as a local `file:` reference,
and manages the thin projection. It refuses changed/missing artifacts and edited
managed wiring. There is no registry fallback. This file is a local candidate
input, not a published Platform release record or deployment instruction.

`apps/frontend/src/site-metadata.ts` remains Site-owned. Supply a reviewed public
origin, default language, description and genuine image facts before claiming
Open Graph readiness. No share image is invented. An incomplete public graph
retains valid document basics and reports provider diagnostics with `ready: false`;
it does not silently substitute another page's graph. Error/private routes use
explicit safe titles and noindex with no successful graph. Indexing metadata is
not authentication.

Astro projects the provider's safely serialized descriptors. TanStack selects
only the current route's `loaderData.documentMetadata`, then renders its ordered
descriptors directly in the document head. This preserves repeated image groups:
the native TanStack head manager deduplicates meta tags by `name`/`property`.
The root's native manager handles charset, viewport and assets. A route must not
also emit competing title/description/canonical/Open Graph tags. Public commerce
fact mapping still belongs to storefront when its actual Runtime is mounted;
this gate does not add a storefront, auth, BFF or catalog dependency.

Ordinary activation still requires the real coordinated content plugin/npm
release, a tested compatibility record and an approved managed pin/wiring switch.
That follow-up is tracked in [#103](https://github.com/Quick-Release/gq-site/issues/103).
This candidate gate does not complete content extraction (#77/#101), change the
copied content runtime, or establish registry availability. Existing Sites need
their own adoption work.

## Reproduce the framework proof

```sh
vp run proof:frontend /absolute/getquick-content-candidate.tgz
```

The proof generates fresh ordinary and candidate apps with the actual CLI,
installs their real dependencies, retains both frameworks' tests/checks, builds
them, starts local HTTP handlers around the built frameworks and inspects final
HTML against independent expectations using the installed provider assertions.
Controlled public content and SQL-binding fixtures are confined to the disposable
generated apps. The package is installed from its archive, never source-aliased.
Public asset signatures/dimensions and the candidate's start/end hash are checked.
Output logs, HTML, package versions and results stay in the reported temporary
directory. `--keep` keeps the servers running for browser checks;
`--directory=/tmp/fresh-evidence` selects a fresh evidence directory.

This evidence is a candidate integration proof, not a deployment, fleet
adoption, measured production Core Web Vitals or WCAG conformance claim.
ADR 0006's maintained preference asset, palette/editor providers, supported
browser matrix and human visual approval remain separate prerequisites. The
starting CSS does not copy the System/Light/Dark preference algorithm.

## Loader error boundary

TanStack's installed Router serializes `Error.message` into the hydration stream;
a safe visual error component alone does not prevent that disclosure. The Site's
root and index routes therefore use the supported `onError: publicRouteError`
hook. It logs the original loader failure on the server and throws a new generic
public error without a cause. Native `redirect()` and `notFound()` outcomes are
handled before this hook, preserving their routing semantics. Future Site-owned
loaders use the same explicit boundary; arbitrary future loaders and rendering
errors are not automatically sanitized.

The installed `load-server`/`load-client` implementations explicitly replace the
error with one thrown by `onError`. See the official
[route error handling guide](https://tanstack.com/router/latest/docs/guide/data-loading#handling-errors-with-routeoptionsonerror).
Start's outer handler does not catch errors already handled by Router's route
components, as documented in its
[server entry error handling guide](https://tanstack.com/start/latest/docs/framework/react/guide/server-entry-point#error-handling).
The HTTP fixture deliberately throws a private marker and checks the entire raw
HTML, including hydration scripts, for its absence.

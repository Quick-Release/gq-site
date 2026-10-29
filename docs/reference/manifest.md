# Site manifest and environment

[Documentation](../README.md)

`gq` walks up from the current directory to the nearest `gq.ops.json`,
stopping at the enclosing Git repository, and treats that directory as the
site root. Every site-relative path resolves from there. `--project <dir>` or
`--config <file>` selects a site explicitly.

```json
{
  "$schema": "./node_modules/@getquick/site/schema/gq.ops.schema.json",
  "schemaVersion": 1,
  "project": "example-site",
  "variant": "content",
  "domains": { "admin": "example-site-cms.bnq.pt", "frontend": "example-site-fe.bnq.pt" },
  "ploi": { "serverId": "12345", "siteId": "67890" },
  "cloudflare": {
    "accountId": "0123456789abcdef0123456789abcdef",
    "zoneId": "abcdef0123456789abcdef0123456789",
    "zoneName": "example.com"
  },
  "github": { "repository": "Quick-Release/example-site" }
}
```

`gq.ops.json` is validated against schema v1 before any command runs
([ADR 0002](https://github.com/Quick-Release/gq-site/blob/main/docs/adr/0002-generate-sites-from-a-versioned-manifest.md)):
`schemaVersion`, `project` and `variant` (`content` or `commerce`) are
required, `domains` has the roles `admin` and `frontend`, an optional
`docs`, and an optional `frontendTarget` (and `frontendProxy`) for a
Frontend on the client's own domain (see below), and an unknown or misspelt key fails by its path. The blocks each
command reads (`ploi`, `cloudflare`, `releases`, `media`, `backups`, `local`,
`artifacts`, `ci`, `github`, `sigillo`, `consent`, `forms`, `wordpress.plugins`,
`wordpress.graphqlPath`, `wordpress.locale`, `wordpress.languages`) are optional; a command names
the keys it needs. `artifacts.jurisdiction` is where `gq cloudflare ci`
creates the Artifacts namespace: `eu` (the default when it's left out),
`us`, or `unrestricted` to opt out; see
[Cloudflare provisioning and CI](../guides/provisioning.md#cloudflare-provisioning-and-ci). `wordpress.locale` is the site's main language as a
WordPress locale (`en_US`, `pt_PT`, `pt_PT_ao90`); see
[The site's language](../guides/sites.md#the-sites-language).
`wordpress.languages` lists a bilingual site's other languages, each a
`locale` and the `slug` of its URL directory; see
[More languages](../guides/sites.md#more-languages).
`contentRuntime` is `"package"` on a Site that runs the Content Runtime from
the pinned `getquick/gq-content` and `@getquick/content` pair, whose pins and
`/gq` routes `gq sync` then manages; `gq new` writes it. Left out, the Site
keeps the runtime an earlier blueprint copied into it; see
[The content runtime](../guides/sites.md#the-content-runtime).
`consent.retentionDays` is how many days a consent record is kept after its
decision stops being in force: a whole number from 1 to 1826. Left out, the
consent Runtime's default (1826, 5 years) applies. The Frontend's deploy reads
it and binds it as `CONSENT_RETENTION_DAYS` to the Frontend and the purge
Worker; see [The Site's retention](../guides/consent.md#the-sites-retention).
`domains.frontend` is the production Frontend's public hostname. When it is
outside the Cloudflare zone (the client's own DNS), `domains.frontendTarget`
names the Frontend's hostname in `cloudflare.zoneName`. That hostname is the
Worker's Custom Domain and the CNAME target of the public one, which is served as a Cloudflare for SaaS custom hostname. It
must be in the zone, and `domains.frontend` must not be. See
[A Frontend on the client's own domain](../guides/provisioning.md#a-frontend-on-the-clients-own-domain).
`domains.frontendProxy` changes how the public hostname is served: a reverse
proxy we run outside Cloudflare serves it, with its own certificate, and
forwards to `frontendTarget` with `Host` and SNI `frontendTarget`. It needs
`frontendTarget`. The Worker then gets no route, and there is no custom
hostname. `frontendProxy.trustedProxies` lists the addresses (IPv4 or IPv6,
or CIDRs, never a `/0`) the proxy reaches Cloudflare from. It is bound to the
production Worker as `GQ_TRUSTED_PROXIES`, so the form and consent endpoints
believe its `X-Forwarded-For`. See
[A Frontend behind an external proxy](../guides/provisioning.md#a-frontend-behind-an-external-proxy).
`forms` turns on headless Gravity Forms: `provider` is `"gravityforms"`, and
`spam` lists the spam controls the Site relies on, `"honeypot"` and/or
`"turnstile"`, each at most once. It needs `contentRuntime: "package"` and
`gravityforms` in `wordpress.plugins`. With it, `gq sync` manages the
Frontend's `/gq/forms/` route, and `gq doctor` and `gq site check` check the
Site's forms; without it, `gq sync` writes no form route. See
[Headless Gravity Forms](../guides/forms.md).
`wordpress.graphqlPath` is an optional exact enum: `/graphql` or `/wp/graphql`
(the default when omitted). It selects production CMS readiness and the
Frontend deploy's default public URL, not local DDEV's endpoint; see
[The CMS GraphQL endpoint](../guides/sites.md#the-cms-graphql-endpoint).
`offboarded` (`at`, `phase`, and `cut`,
what the cut changed, which `--restore` brings back) is written by
`gq offboard` and turns on the guards of an
[offboarded Site](../guides/offboarding.md); `gq offboard --archive` adds
`offboarded.archive` (`bucket`, `prefix`, `manifestSha256`) once the archive
is verified. `$schema` points editors at the JSON
Schema generated from it ([schema/gq.ops.schema.json](../../schema/gq.ops.schema.json)).

A manifest without `schemaVersion` is v0, the unversioned shape. Every
command refuses it, and one newer than the installed `gq` reads, with the
step to take. `gq sync` migrates it:

```sh
gq sync --manifest --variant content   # v0 → v1, written back
gq sync --manifest --check             # report pending migrations, exit 1, write nothing
```

v0 never recorded the variant, so the v0 → v1 migration takes it from
`--variant` rather than guessing. It drops the keys of flows `gq` doesn't
have (`credentials`, `github.environment`, `github.secrets`,
`github.variables`) and names each one. `gq sync` needs no network access
and no secrets.

Provider IDs are safe to commit; tokens are not. `gq` reads `PLOI_API_TOKEN`,
`CLOUDFLARE_API_TOKEN` and optional ID overrides (`PLOI_SERVER_ID`,
`PLOI_SITE_ID`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`,
`CLOUDFLARE_ZONE_NAME`) from, in increasing precedence:

1. `${XDG_CONFIG_HOME:-$HOME/.config}/gq/ops.env`
2. the site's `.env`
3. the process environment, which is where a secret manager such as Sigillo
   injects them per command
4. flags (`--server`, `--site`, `--account`, `--zone`)

## Related references

The [release and version reference](release.md) describes variant defaults
and the `release`, `verify` and `doctor` additions. Provider-specific settings
are documented with [provisioning](../guides/provisioning.md), and Sigillo
settings with [secrets](../guides/secrets.md). For managed-file ownership and
adoption, see [Generate and sync a site](../guides/sites.md).

### Draft preview bindings

Optional `preview` config opts a Site into the server-only draft preview
bindings used by its Site-owned `/gq/preview` route:

```json
{
  "preview": {
    "cmsUrl": "https://cms.example.com",
    "audience": "https://www.example.com/gq/preview"
  }
}
```

`preview.cmsUrl` maps to `GQ_PREVIEW_CMS_URL`: an exact HTTPS CMS origin,
without a trailing slash, path, query, fragment or userinfo.
`preview.audience` maps to `GQ_PREVIEW_AUDIENCE`: the exact full HTTPS
Frontend URL ending in `/gq/preview`, without query, fragment or userinfo.
Both fields are required when the block exists. These are plain configuration,
not secrets. Neither uses a `PUBLIC_` variable.

Operators may supply the paired `GQ_PREVIEW_ACCESS_CLIENT_ID` and
`GQ_PREVIEW_ACCESS_CLIENT_SECRET` through the existing Sigillo staging /
CI-injected deployment environment. Both must be nonempty and supplied together,
with preview config. The managed deploy binds them as Redacted Worker secrets;
never put their values in the manifest, source, logs or frontend build variables.
Use a dedicated Cloudflare Access service identity, restricted to POST on only
`/wp-json/getquick-design/v1/page-previews/redeem` and
`/wp-json/getquick-design/v1/page-previews/render` on the configured CMS.
Arrange that restriction at the gateway/origin (including method enforcement);
this plumbing does not provision Access applications or policies.
Access is an additional gateway check, not the Design trust identity.

When `preview` exists, `GQ_PREVIEW_CMS_USERNAME` and
`GQ_PREVIEW_CMS_APPLICATION_PASSWORD` are required together, nonempty, and bound
as Redacted Worker secrets after Website initialization. Username cannot contain
`:`; neither value can contain CR/LF or surrounding whitespace. Values are
never trimmed; internal application-password spaces are preserved. These
authenticate a dedicated trusted Site CMS identity using Basic Authorization on both redeem and render POSTs.
Use a dedicated subscriber with no agent-authoring grant, `edit_pages`, or
super-admin rights. Never reuse the agent's application password, GraphQL or
other automation credentials. Configure the CMS option
`getquick_design_preview_server` with that account's integer `userId` and the
application password UUID as `credential`; the option holds identities, never
the password. The CMS validates identity, role and revocation on every request;
blueprint validation checks presence/shape and cannot establish those rights.

Inject both values through the private Sigillo staging / CI deployment
environment, just like the optional Access pair. Never put credentials in
`gq.ops.json`, explicit `Website.env`, `PUBLIC_` variables, client imports, serialized
HTML, logs, or agent handoffs. The manifest rejects credential fields. The Site
reads these bindings only in server routes and sends the Basic header only to
the configured CMS's two preview endpoints, alongside Access headers if used.
Do not follow redirects carrying credentials or forward either header to the
browser. See [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

For rotation, an authorized operator creates a replacement dedicated application
password, privately stages the replacement pair in Sigillo, updates the
configured CMS UUID (and userId if changed), updates the CI Worker secrets via
`pnpm ci:deploy`, and deploys the matching Site secrets in a separately
authorized maintenance window. Confirm both Sigillo and CI use the replacement
before revoking the old password. Expect fail-closed preview downtime while identities differ. Rotating the configured identity
invalidates prior handoffs and reviews: issue a fresh preview and inspect again.
Do not restore old receipts or roll back to a revoked credential.

Without the preview block and any preview secrets, no preview bindings are
added and existing deployments keep their behavior. Partial or malformed
configuration fails before Alchemy deploys. With preview configured, frontend
plan commands also require the Sigillo credentials; run them through the same
private staging injection as deployment. When disabling preview, remove its
secrets from Sigillo and clear stale CI Worker secrets before the next release;
remaining preview secrets fail closed without the manifest block.

Bindings are attached after Website initialization, outside explicit
`Website.env`. This is not build-process isolation: installed Alchemy beta.79
merges bindings before building, Astro `resolveBuildEnv` unwraps Redacted values,
and `BuildChild` inherits the process environment. Preview credentials are visible
to the build process. Build plugins and the dependency supply chain are part of
the trusted boundary. This wiring does not write credentials to generated files
or expose them as `PUBLIC_` values; build code must not serialize or log them.

The Site must read credentials exclusively from server-side Worker bindings,
never `import.meta.env`, fallback credentials, or hardcoded bundle values.
Local `import.meta.env` fallback is permitted only for the nonsecret CMS URL
and audience. Any development loopback exception belongs to the Site;
the managed production config accepts HTTPS only.

Adoption: release a blueprint version containing this change, update the Site's
`@getquick/site` pin (Cooldown Gaming currently uses 0.18.3), install it and
run `gq sync` to regenerate managed infra. Review the upgrade's other managed
changes before adoption. Add the Site-owned route/helper and optional manifest
block, then arrange the dedicated CMS identity, required secrets and optional Access pair before a
separately authorized deploy. Do not hand-edit fully generated infra files.

### Cooldown Gaming adoption handoff (pending release and acceptance)

This integrates the provider plumbing from `feat/agent-preview-bindings` commit
`6a6b6733813ed1ffca5c573457b71a55e91bd419` with attribution. That branch/worktree
is preserved. It follows Design PR 70's hardened `docs/authoring-preview.md`
contract (original head `ba41d27`, final notification fix pending at handoff).
No consumer release containing this plumbing is available yet. Do not pin a
branch, local tarball, or invented release for production adoption. Design
issues [66](https://github.com/Quick-Release/gq-design/issues/66) and
[67](https://github.com/Quick-Release/gq-design/issues/67) remain open.

After independent reviewed releases, the Cooldown Gaming owner must:

1. Update `@getquick/site` to the actual published version containing this PR,
   install, run `gq sync`, and review all generated changes. Adopt the released
   Design contract through the normal CMS release process. This PR changes no pins.
2. Adapt `feat/gq-design-agent-preview` (`046d859`): its server-only helper reads
   `GQ_PREVIEW_CMS_USERNAME` / `GQ_PREVIEW_CMS_APPLICATION_PASSWORD` exclusively
   from Worker bindings, never `import.meta.env`, credential fallbacks or
   hardcoded bundle values. Only the nonsecret CMS URL and audience may fall
   back to `import.meta.env`. The helper sends Basic
   auth on both `/wp-json/getquick-design/v1/page-previews/redeem` and `/render`.
   Preserve optional Access headers, immediate bootstrap fragment removal,
   same-origin checks, private cookies, no-store/no-referrer responses and clean
   `/gq/preview/view` rendering. Never use a public draft fallback.
3. Set `preview.cmsUrl` to the exact HTTPS CMS origin and `preview.audience` to
   `https://cooldowngaming.com/gq/preview` only if that is the configured exact
   frontend host. Match `getquick_design_preview_url` byte-for-byte. Arrange the
   dedicated low-privilege CMS identity and private secret injection through an
   authorized operator. No configuration or secret writes are performed here.
4. Provide the human review UI/handoff in an authenticated WordPress admin
   browser: POST `/wp-json/getquick-design/v1/page-previews/review` with its own
   admin cookie, `X-WP-Nonce` for `wp_rest`, `manage_options`, page edit permission,
   and `{pageId, expectedVersion, previewId, reviewerKind: "human", evidence}`.
   Evidence is closed: `inspected: true`, substantive `summary`, `viewports`,
   `references`. Never proxy this route with Site or agent application passwords
   or send runtime credentials to the browser. Agent MCP review remains agent-only.
5. After separately authorized deployment, repeat real Claude/Codex and Site
   acceptance: inspect Container/Grid/text and image/button previews at 1280,
   900 and 390px; deny token-only, agent, revoked/replaced/overprivileged Site
   identities; exercise rotation and stale saved versions; record actual admin
   cookie+nonce review; reject unverified publication; explicitly publish only
   authorized disposable content and verify public headless delivery. Record
   evidence against the released versions. Earlier screenshots do not prove this
   hardened trust integration. Refs Design 66/67; no acceptance or closure claim.

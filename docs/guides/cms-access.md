# Optional Cloudflare Access for the CMS

[Documentation](../README.md)

Access protects the CMS edge, including its API; do not bypass Access for
GraphQL or REST. WordPress authorization remains a separate layer. A company
`gq-auth` MU plugin and the Access policies (Google accounts at `tipme.to`,
read-only GraphQL service, separate automation service) are configured outside
this package. This integration neither installs that plugin nor changes policies.

Keep these optional pairs in the Site's Sigillo **production** environment:

| Identity              | Secret names                                                       | Consumers                                                                            |
| --------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Public-content reader | `GQ_AUTH_GRAPHQL_CLIENT_ID`, `GQ_AUTH_GRAPHQL_CLIENT_SECRET`       | Frontend server publication reads; CLI `/graphql` and `/wp/graphql` readiness probes |
| Automation            | `GQ_AUTH_AUTOMATION_CLIENT_ID`, `GQ_AUTH_AUTOMATION_CLIENT_SECRET` | CLI REST media POST/delete probes; CMS root/login probes                             |

They become `CF-Access-Client-Id` and `CF-Access-Client-Secret` HTTP headers,
never WordPress login credentials. Reads remain anonymous to WordPress: the
GraphQL service must only permit published-content queries, not mutations,
private content or editor access. Automation media probes still require
`CMS_CHECK_USER` / `CMS_CHECK_APP_PASSWORD` Basic authentication in addition to
Access. The identities must not be interchangeable at either authorization layer.

Both absent preserves Sites without Access. A partial pair fails with the names
only, never its values. The CLI selector allows only the configured CMS's exact
origin and these paths: `/graphql`, `/wp/graphql`, `/`, `/wp-login.php`,
`/wp/wp-login.php`, and `/wp-json/wp/v2/media` (including numeric attachment IDs).
The existing CLI readiness flow does not add root/login probes. DDEV local
readiness does not receive production credentials when its origin differs from
`domains.admin`. Provider APIs, unrelated CMS paths, third-party requests and
media assets receive neither pair. Credentialed CMS calls never follow redirects;
fix the configured endpoint instead. Transport failures do not expose raw errors.

## Frontend and release wiring

The content Frontend skeleton reads only the GraphQL pair from private Worker
bindings (`src/lib/runtime.ts`), only on the server, and sends it only to the
configured `PUBLIC_WORDPRESS_GRAPHQL_URL`, restricted to `/graphql` or
`/wp/graphql` on the exact HTTPS origin named by `domains.admin` when credentials
are present. An override to another host, port or path fails before sending.
That public variable is a URL, **not a place for credentials**. Never use
`PUBLIC_*` / `VITE_*` credential variables or spread the secret environment into
bindings. `infra/frontend.run.ts` declares
the pair as `Redacted` secrets; it never binds automation credentials. CI's
explicit allowlist forwards only the GraphQL pair to the Frontend deploy.

Production secrets are not automatically available through the Blueprint's
existing staging scripts. An operator must choose the production Sigillo mapping
and inject the pairs into the relevant commands, for example:

```sh
gq sigillo run production -- gq site check --json
gq sigillo run production -- gq media check --upload --json
```

The upload checks create and delete a probe image; these are operator actions,
not part of implementing this integration. Before an Access gate is enabled,
arrange the Frontend's private bindings and CI secrets from the appropriate
Sigillo environment, then verify publication reads and readiness. No secret
values belong in repository files or command arguments.

Existing Frontend source files are **Site-owned**: syncing the managed infra
files alone does not adopt these reads. Copy the relevant `runtime.ts` and
`wordpress.ts` changes deliberately, including redirect handling. No Site's
managed output is edited by this change. Commerce reads in **gq-storefront** are
a separate server-only integration boundary; this package does not modify it.
Its CMS transport needs the same exact-origin GraphQL identity and no redirects,
without exporting credentials to the browser. Deployment remains blocked until
that consumer (if used), the company MU plugin and Access policies are ready.

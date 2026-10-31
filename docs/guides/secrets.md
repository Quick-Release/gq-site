# Sigillo secrets

[Documentation](../README.md)

`gq sigillo` runs the [Sigillo](https://www.npmjs.com/package/sigillo) CLI
against the project and environments in the site's `gq.ops.json`, so the
project ID lives in one place:

```json
{
  "sigillo": {
    "apiUrl": "https://secrets.example.com",
    "projectId": "01ABCDEFGHJKMNPQRSTVWXYZ00",
    "environments": { "local": "dev", "staging": "staging" }
  }
}
```

`environments` maps the names scripts use to Sigillo environments.
`gq sigillo run <environment> -- <command>` runs one command with that
environment's secrets: `sigillo run` starts `gq` again, which drops Sigillo's
own bootstrap variables (`SIGILLO_TOKEN`, `SIGILLO_API_URL`,
`SIGILLO_PROJECT`, `SIGILLO_ENVIRONMENT`) before running the command in the
site root. The inner step runs only when `SIGILLO=1` and the wrapper's guard
variable, `GQ_SIGILLO_REENTRY=1`, are both set. Everything after `--` is
passed on as-is, never through a shell.

Secrets are only ever injected per command: the wrapper never passes
`--mount`, and `setup`/`secrets` refuse `download` and `--mount`. `login` is
per checkout (`--scope .`). The site's installed `sigillo` bin is used, or
before the first install, the version the site pins in `devDependencies`, via
`npx`. Each of these commands hands the terminal to the child and exits with
its code.

```json
{
  "scripts": {
    "deploy": "gq sigillo run staging -- node ./scripts/deploy.mjs",
    "sigillo:login": "gq sigillo login"
  }
}
```

For provider token precedence, see the [manifest and environment reference](../reference/manifest.md).
For the optional, separate CMS GraphQL and automation identities, see
[Cloudflare Access for the CMS](cms-access.md). A Site with headless forms
that chose Turnstile keeps `TURNSTILE_SECRET_KEY` and `TURNSTILE_SITE_KEY` in
staging; see [Headless Gravity Forms](forms.md#turnstile).

## GQ Platform `ops`: the GETQUICK CI App

The GETQUICK CI GitHub App and its token broker
([gq-platform ADR 0012](https://github.com/Quick-Release/gq-platform/blob/main/docs/adr/0012-fleet-ci-credentials-through-a-github-app-and-token-broker.md))
are fleet-wide, so their secrets live in the GQ Platform Sigillo project
(`01M5Z0QYDH1PPN7N3C4A7KZAXJ`), environment `ops`, not in any Site:

| Secret                                              | Written by                              | Read by                                        |
| --------------------------------------------------- | --------------------------------------- | ---------------------------------------------- |
| `GQ_CI_GITHUB_APP_ID`, `GQ_CI_GITHUB_APP_SLUG`      | `gq github app create`                  | `gq ci broker deploy`                          |
| `GQ_CI_GITHUB_APP_PRIVATE_KEY` (PKCS#8, base64 DER) | `gq github app create`                  | `gq ci broker deploy` (into the broker only)   |
| `GQ_CI_GITHUB_APP_INSTALLATION_ID`                  | `gq github app create`                  | `gq github setup --app`, `gq ci broker deploy` |
| `GQ_CI_BROKER_KEY`                                  | `gq github app create` (generated once) | `gq ci broker deploy`, `gq github setup --app` |

`gq` reads them per command through the Site's Sigillo CLI on the same
server (`sigillo.apiUrl`), so the person running the command needs access to
the GQ Platform project as well as the Site's. A Site's staging holds only
its own `GQ_CI_BROKER_TOKEN` (good for its repository alone) and
`GQ_CI_BROKER_URL`. Never copy the App key or the broker key into a Site.

A commerce Site's `GITHUB_PACKAGES_TOKEN` stays a classic personal token with
only `read:packages`: GitHub App tokens don't authenticate to the npm
registry. The ADR makes it one shared token from a machine account, kept in
GQ Platform `ops` as `GITHUB_PACKAGES_TOKEN`, and copied into the staging of
the Sites that need it; no client gets its own.

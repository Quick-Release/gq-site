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

| Secret                                              | Written by                              | Read by                                                                                                |
| --------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GQ_CI_GITHUB_APP_ID`                               | `gq github app create`                  | `gq ci broker deploy`, `gq github setup --app`                                                         |
| `GQ_CI_GITHUB_APP_SLUG`                             | `gq github app create`                  | `gq ci broker deploy`                                                                                  |
| `GQ_CI_GITHUB_APP_PRIVATE_KEY` (PKCS#8, base64 DER) | `gq github app create`                  | `gq ci broker deploy` (into the broker), `gq github setup --app` (in memory, to read the installation) |
| `GQ_CI_GITHUB_APP_INSTALLATION_ID`                  | `gq github app create`                  | `gq github setup --app`, `gq ci broker deploy`                                                         |
| `GQ_CI_BROKER_KEY`                                  | `gq github app create` (generated once) | `gq ci broker deploy`, `gq github setup --app`                                                         |

`gq` reads them per command through the Site's Sigillo CLI on the same
server (`sigillo.apiUrl`), so the person running the command needs access to
the GQ Platform project as well as the Site's. A Site's staging holds only
its own `GQ_CI_BROKER_TOKEN` (good for its repository alone) and
`GQ_CI_BROKER_URL`. Never copy the App key or the broker key into a Site.

## GQ Platform `ops`: the registry credentials

Every Site installs from the same two private registries, so their logins are
the fleet's, not a Site's
([gq-platform ADR 0013](https://github.com/Quick-Release/gq-platform/blob/main/docs/adr/0013-fleet-registry-credentials-read-at-use-from-gq-platform-ops.md)).
They live once in GQ Platform `ops`, beside the App:

| Secret                  | What it is                                                                                                                                               | Read by                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `COMPOSER_AUTH`         | Composer's JSON login (`http-basic`) for the GETQUICK registry, `proxy.composer.getquick.io`                                                             | every `gq sigillo run`                                                               |
| `GITHUB_PACKAGES_TOKEN` | a classic personal token with only `read:packages`, from a Quick-Release machine account, for GitHub Packages (`npm.pkg.github.com`, `@quick-release/*`) | every `gq sigillo run`, and `gq setup`'s install on a Site that uses GitHub Packages |

GitHub App tokens don't authenticate to GitHub Packages' npm registry, so the
packages token stays a classic personal token.

`gq sigillo run <environment>` reads both from GQ Platform `ops` before it
starts the command, with your own Sigillo login, and puts them in the
command's environment. pnpm also gets the packages token as
`npm_config_//npm.pkg.github.com/:_authToken`, so
`gq sigillo run local -- pnpm install` needs no `~/.npmrc` token. Everything
that needs them gets them there: `pnpm cms:composer`, `pnpm db:sync`,
`pnpm ploi:release` and `pnpm release:package` (the Ploi deploy's
`composer_auth`), `pnpm ci:deploy` (into the CI Worker's secrets), package
discovery and `pnpm site:check`. `gq setup` installs a Site whose `.npmrc`
names `npm.pkg.github.com` (a commerce Site) with the packages token in pnpm's
environment, never a file. In CI the Worker holds what `pnpm ci:deploy` gave
it.

**Precedence:** GQ Platform `ops` wins. A Site's own copy (in its Sigillo
environment, or your shell) is used only while GQ Platform `ops` can't be
read or doesn't hold the name, and `gq sigillo run` then warns on stderr,
naming the secret, never its value. So a Site that still holds copies keeps
working while its operators get access.

**Rotating** either one is one change in GQ Platform `ops`: local commands
use the new value at once, and each Site's CI after its next
`pnpm ci:deploy`.

**Access.** You need read access to GQ Platform `ops` on the Site's Sigillo
server. Without it a command that needs a registry login says so: `gq`
names the project and the remedy (ask a GQ Platform admin, then check with
`npx sigillo secrets --project 01M5Z0QYDH1PPN7N3C4A7KZAXJ --env ops`).
`gq doctor` reports it, a name GQ Platform `ops` lacks, and every copy a
Site's own environments still hold, with the command that deletes it:

```sh
gq sigillo secrets staging delete COMPOSER_AUTH
gq sigillo secrets staging delete GITHUB_PACKAGES_TOKEN
gq sigillo secrets local delete COMPOSER_AUTH
```

Never copy either into a Site's Sigillo, `.env` or `~/.config/gq/ops.env`.

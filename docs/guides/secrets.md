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
[Cloudflare Access for the CMS](cms-access.md).

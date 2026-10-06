# ADR 0014: Keep a Site's code in the EU unless it opts out

- Status: Accepted
- Date: 2026-10-04

## Context

An Artifacts namespace created without a jurisdiction is unrestricted, so a
Site's code can be stored anywhere. Cloudflare can't change a namespace's
jurisdiction once it exists
([data localization](https://developers.cloudflare.com/artifacts/guides/data-localization/)).
The only way to move one is to delete it, create it again under the same name
and push the code again, so the jurisdiction has to be right when
`gq cloudflare ci` creates the namespace.

## Decision

- **The EU by default.** `gq.ops.json` `artifacts.jurisdiction` is `eu`,
  `us` or `unrestricted`. When it's left out, the Site's namespace is in the
  EU. `unrestricted` is the explicit opt-out. `gq new` leaves the key out.
- **A config key, not a flag.** The choice is recorded with the Site, so
  every later `gq cloudflare ci` and `gq doctor` run checks the namespace
  against it.
- **A mismatch stops, never carries on.** `gq cloudflare ci` creates a
  missing namespace in the configured jurisdiction. It stops at an existing
  namespace in another one, naming both jurisdictions and the ways out, and
  `gq doctor` fails on it.
- **No migration.** A v1 manifest without `artifacts.jurisdiction` means
  `eu`, so a Site whose namespace is unrestricted and whose manifest leaves
  the key out fails both checks. ADR 0002 would put such a change through a
  `gq sync` migration, but there is none and the schema stays v1. Each such
  Site must decide on purpose: set
  `"jurisdiction": "unrestricted"` to keep its namespace where it is, or
  delete the namespace, recreate it in the EU and push the code again.

## Considered options

- **A migration that writes `"jurisdiction": "unrestricted"` into existing
  manifests.** It would keep existing Sites passing, but it would record an
  opt-out nobody chose, and those Sites would never move to the EU.
  Rejected: the opt-out has to be a decision about each Site.
- **A migration that infers the key from the namespace's jurisdiction.**
  Rejected: migrations are pure functions of the manifest (ADR 0002), and
  this one would need the Cloudflare API and an Artifacts token.

## Consequences

- `gq cloudflare ci` and `gq doctor` fail for a Site with an unrestricted
  namespace and no `artifacts.jurisdiction` until someone decides.
- Recreating a namespace keeps CI working without a redeploy: the CI
  Worker's `cf.artifacts.repo.pushed` filter matches the namespace and
  repository by name. The repository's history has to be pushed again.
- Deleting a namespace (`DELETE /accounts/<account>/artifacts/namespaces/<namespace>`)
  is undocumented. It returned 204 and freed the name on 2026-10-04, when
  CESAM's namespace was recreated in the EU.

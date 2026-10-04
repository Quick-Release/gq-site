# Cart identity proof (#57)

Live proof that retired Woo Store API cart bearers can't read or change a customer's
cart after native login and logout. The findings, threat model and limits are in
[the research write-up](../../docs/research/cart-bearer-isolation.md).

None of this is part of the published package or `pnpm test`, and nothing here is
enabled for any Site.

| Path                                 | Role                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `woo-extension/gq-cart-identity.php` | The narrow Woo extension (mu-plugin) that retires bearers across identity changes                           |
| `frontend/`                          | Disposable shopper-facing Frontend: opaque HttpOnly handle, server-held bearers, native WP login and logout |
| `fixture/gq-proof-auth.php`          | Proof-only auth bridge: a REST nonce for the native login, issued before Woo loads a cart                   |
| `env.sh`, `env/seed.php`             | Disposable loopback DDEV store with pinned WordPress/Woo and synthetic fixtures                             |
| `isolation.test.mjs`, `harness.mjs`  | The proof: shopper flows through the Frontend, then direct reuse of captured bearers without a WP cookie    |

## Run

Needs DDEV, Docker and mkcert. Provisioning a store needs scoped authorization (see the
issue); everything stays on loopback.

```sh
export GQ_PROOF_DIR="$TMPDIR/gq-cart-identity-proof"   # outside the repository
proofs/cart-identity/env.sh up        # create the project, install WP 7.1.2 + Woo 11.1.2
proofs/cart-identity/run.sh           # baseline (no extension) and isolated suites
proofs/cart-identity/env.sh down      # delete the project and verify nothing remains
```

The baseline suite asserts the #50 failures still reproduce with the extension off;
the isolated suite asserts they don't with it on. Each suite resets the fixtures first.
Synthetic passwords live in mode-0600 files under `$GQ_PROOF_DIR/.proof`, outside the
docroot, and never appear in command arguments.

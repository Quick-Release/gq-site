# Cart identity proof (#57)

Live proof that retired Woo Store API cart bearers can't read or change a customer's
cart after native login and logout. The isolation itself lives in
[GQ eCommerce](https://github.com/Quick-Release/gq-ecommerce)
(`src/CustomerAccounts/CartBearerIsolation.php`). The findings, threat model and limits
are in [the research write-up](../../docs/research/cart-bearer-isolation.md).

None of this is part of the published package or `pnpm test`.

| Path                                | Role                                                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `frontend/`                         | Disposable shopper-facing Frontend speaking GQ eCommerce's storefront BFF contract (proxy secret, upstream session, customer accounts API), opaque HttpOnly handle |
| `fixture/gq-proof-runtime.php`      | What a Site's Bedrock provides: PSR-4 autoloading for the GETQUICK plugins and the storefront proxy secret                                                         |
| `env.sh`, `env/seed.php`            | Disposable loopback DDEV store: pinned WordPress/Woo, GETQUICK Config, GQ Design and GQ eCommerce from local clones, synthetic fixtures                            |
| `isolation.test.mjs`, `harness.mjs` | The proof: shopper flows through the Frontend, then direct reuse of captured bearers                                                                               |

## Run

Needs DDEV, Docker, mkcert and local clones of the three GETQUICK plugins (read only).
Provisioning a store needs scoped authorization (see the issue); everything stays on
loopback.

```sh
export GQ_PROOF_DIR="$TMPDIR/gq-cart-identity-proof"   # outside the repository
export GQ_CONFIG_REPO=…/getquick-config GQ_DESIGN_REPO=…/gq-design
export GQ_ECOMMERCE_REPO=…/gq-ecommerce                 # baseline comes from here
export GQ_ECOMMERCE_BASELINE=<ref>                      # GQ eCommerce without isolation (default main)
export GQ_ECOMMERCE_CANDIDATE=…/gq-ecommerce-worktree   # the working tree under test
proofs/cart-identity/env.sh up        # create the project, install WP 7.1.2 + Woo 11.1.2 + plugins
proofs/cart-identity/run.sh           # baseline and candidate suites
proofs/cart-identity/env.sh down      # delete the project and verify nothing remains
```

The baseline suite installs `GQ_ECOMMERCE_BASELINE` and asserts the #50 failures still
reproduce. The candidate suite installs `GQ_ECOMMERCE_CANDIDATE` and asserts they don't.
Each suite resets the fixtures first. Synthetic passwords and the proxy secret live in
mode-0600 files under `$GQ_PROOF_DIR/.proof`, outside the docroot, and never appear in
command arguments.

# Rate-limit namespaces

[Documentation](../README.md)

The storefront Runtime's rate limiters each bind a Cloudflare rate-limit
namespace by its ID. IDs are per Cloudflare account, and every Worker that
binds an ID in the account shares its counters, so each commerce Site takes
IDs of its own and records them in `gq.ops.json`
`cloudflare.rateLimitNamespaces` ([Commerce sites](../guides/commerce-sites.md#rate-limit-namespaces)).

This is the fleet's register of them. Its source is
[`blueprint/rate-limit-namespaces.json`](https://github.com/Quick-Release/gq-site/blob/main/blueprint/rate-limit-namespaces.json),
which ships with `@getquick/site`; this table follows it, and the package
suite fails when they differ.

| Account                            | Site     | IDs       |
| ---------------------------------- | -------- | --------- |
| any                                | reserved | 1004–1006 |
| `8f38791a8c37b182239af2a385ab3c31` | ekis     | 1001–1003 |
| `8f38791a8c37b182239af2a385ab3c31` | bruaa    | 1007–1009 |

Each Site's three IDs are, in order, `AUTH_IDENTIFIER_RATE_LIMITER`,
`AUTH_IP_RATE_LIMITER` and `AUTH_PENALTY_RATE_LIMITER`.

1004–1006 are reserved for documentation and tests, in every account: the
commerce sites guide's example and the package suite use them, so a Site that
copies the example collides with no other Site. Never deploy them.

## Taking IDs

1. Take the next unused IDs in the Site's account, after the highest one the
   register lists there (1010–1012 in `8f38791a8c37b182239af2a385ab3c31`),
   one per limiter the storefront Runtime declares.
2. Add the Site to the register, in `gq-site`: its entry in
   `blueprint/rate-limit-namespaces.json` under its account and a row here,
   released with `@getquick/site`.
3. Record them in the Site's `gq.ops.json`:

   ```json
   "cloudflare": {
     "rateLimitNamespaces": {
       "AUTH_IDENTIFIER_RATE_LIMITER": 1004,
       "AUTH_IP_RATE_LIMITER": 1005,
       "AUTH_PENALTY_RATE_LIMITER": 1006
     }
   }
   ```

   (the reserved example IDs: use the Site's own).

`gq doctor` checks a Site's IDs against the register it ships with, and
warns, naming each, about an ID another Site holds in the same account, a
reserved ID, an ID two of the Site's limiters share, and IDs the register
doesn't list for the Site yet.

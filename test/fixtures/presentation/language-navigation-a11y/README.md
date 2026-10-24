# Real Polylang null-flag capture after native accessible-name fallback

Captured by the guarded existing Polylang runner against the owned disposable
WordPress site, with Polylang Free 3.8.10 active, multilingual support enabled and
the real `polylang/language-switcher` registered. `provenance.json` records source
commit, versions, enabled conditions, registered options, requests and command.

For each of `en` and `fr`:

- `*-layout.json` is the anonymous public language-resolved layout response.
- `*-nodes.json` filters its three switcher nodes without rewriting any values.
- `*-public-rest.json` is the anonymous public translated-page REST response.
- `*-post-nodes.json` preserves that response's ordinary `getquickBlocks` separately.
- `*-saved.html` is the actual published page's saved block comments.
- `*-rendered.html` is that page response's exact `content.rendered`.

The authored modes are names+flags list, flags-only list and dropdown. They use
real resolved English/French home URLs (`force_home:true`), current-language
metadata, flags and labels. The dropdown authors `hide_current:true` but retains
the selected option, matching the real integration. The layouts explicitly
resolve EN/FR current state. Ordinary post REST serialization does not supply
that explicit layout language context; its observed metadata is captured rather
than asserted equal. Treat the neutral and HTML deliveries independently.

`manifest.json` captures the actual enabled conditions; `SHA256SUMS` verifies all
captured payloads. The fixture's existing cleanup removes the owned pages and
restores header content/options/languages; loopback URLs are not persistent.
No Pro plugin or licensed feature was used. These inputs support consumer tests;
they do not themselves establish consumer keyboard or rendering acceptance.

This future capture follows runtime fix `e2cc4dc`: a specific registered-block
render filter uses the existing conditional registry and resolved language
labels. WordPress's HTML tag processor adds `aria-label` only for flags-only,
non-dropdown links with no resolved flag URL and no existing ARIA name.
It changes no URLs, options, current state or visible content. The old `e1984c7`
and flag-bearing `ed0afd9` captures remain unchanged.

The public-render assertion failed before the fix and passed afterward for both
EN and FR. Full real Polylang run: 10,873 assertions passed; fixture restored.
This establishes the native HTML naming fallback, not full consumer acceptance.

Exact capture command, from this worktree:

```sh
GETQUICK_CMS_DIR="$PWD/.ci/wordpress" GETQUICK_WP_CLI="$PWD/.ci/wp" GETQUICK_POLYLANG_CAPTURE_A11Y=1 GETQUICK_POLYLANG_CAPTURE_DIR="$PWD/tests/fixtures/producer/language-navigation-a11y" node scripts/polylang-test.mjs
```

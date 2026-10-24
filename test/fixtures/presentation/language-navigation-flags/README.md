# Real Polylang Free language navigation with native flags

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

This separate capture explicitly configures native language flag codes `gb` and
`fr` through Polylang's supported `add_language` API for newly owned languages.
It does not alter borrowed language records or rewrite public links. The earlier
`e1984c7` null-flag capture remains immutable and covers accessible fallback.

`flag-gb.png` and `flag-fr.png` are exact binary HTTP captures from the resolved
`flagUrl` values. `provenance.json.flagAssets` maps each original URL to its file,
HTTP 200, PNG content type, byte length and SHA-256. All assets are included in
`SHA256SUMS`. Consumers may replay those exact bytes at the captured URLs in the
test transport, without modifying the DTO. Capturing bytes proves delivery;
consumer image decoding, visual layout and accessibility remain separate gates.

The exact command enables `GETQUICK_POLYLANG_CAPTURE_FLAGS=1` and uses this
folder as `GETQUICK_POLYLANG_CAPTURE_DIR`; the runner's existing cleanup restores
the disposable site. See `UPSTREAM-NOTICE.txt` for captured PNG provenance.

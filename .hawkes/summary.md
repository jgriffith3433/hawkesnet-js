# Demo visual identity: beta build

**What was wrong:** nothing in the code. Beta's build stopped with "playtest.run needs 6 and 1 is left": Studio is out of credits. It was not a compile or test failure.

**What is already on beta (kept):** the dark theme, a distinct colour and short fading trail per player, a side list with each player's connection kind (relay or peer to peer), and AA contrast. The `smoke` scenario shows each as a check: "Each player has a distinct colour and a short trail", "The side list shows every player and how they are connected", "Text and dots on the page have AA contrast".

**Checked (green):** `node --check` on both SDK files, `node tools/demo.mjs` (makes dist/ and the 1.3.0 tarball), `npm test` (7 pass).

**Changed:** only `.hawkes/scenario.txt`, which now names `smoke`. No SDK or demo code changed.

**For J:** the build goes green once credits are added in Settings → Plan and credits. No GPU work, so no estimate.

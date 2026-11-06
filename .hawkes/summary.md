# Docs site with recipes: beta build

**What was wrong:** nothing in the code. Beta's last build stopped with "playtest.run needs 6 and 1 is left", which means Studio ran out of credits. It was not a compile or test failure. Two earlier attempts reached the same conclusion and committed nothing, so beta never got a playtest scenario named for these criteria.

**What I checked (all green):**
- `node --check hawkes-net.mjs` and `node --check hawkes-net-core.mjs`
- `node tools/demo.mjs` makes `dist/` with `recipes.html`, the four recipes and the tarball.
- `npm test` passes 7 tests: the four recipes (chat, cursors, shared state, password room) and the README chat snippet, all run against `test/fake-net.mjs`.

**What I changed:** only `.hawkes/scenario.txt`, which now names the `recipes` scenario. Beta's playtest will play it. It checks that the demo links to all four recipes, shows their code, and runs each live with a second player. No SDK or demo code changed.

**For J:** the build can only go green after credits are added in Settings → Plan and credits. No GPU work was involved, so there is no estimate.

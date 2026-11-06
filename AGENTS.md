# hawkesnet-js — agent guide

The public home of Hawkes Net's JavaScript SDK, `@hawkesgen/net` (MIT). **Don't edit the SDK files here:** they are a copy
of `sdk/js` in the private hawkesnet repo (the relay nodes run its core), published with `node tools/release-js.mjs --push`
there, which commits and tags `v<version>`. Games depend on a tag:
`"@hawkesgen/net": "https://github.com/jgriffith3433/hawkesnet-js/archive/refs/tags/v1.2.1.tar.gz"` (npm once it is published).

**Demo site:** `example/` and `tools/demo.mjs` belong to this repo (the release copies only the SDK files and package.json, so
they stay). `node tools/demo.mjs` makes `dist/`: the demo page beside the SDK files, `release.json` and the tarball. Hawkes
Studio (project hawkes-net-js) builds it on every beta push, publishes it as the beta site and playtests it there; Studio's
beta pages name beta Hawkes Net (`HAWKES_NET_ENDPOINT`), so it plays on beta Net's free test rooms (project `netdemo`).
The page has Studio's playtest bot (`example/net-playtest.mjs`, `window.hawkesPlaytest`): `smoke` opens a second player
in the same page and checks the room, poses both ways (the dot moved by real pointer input), messages both ways and
leaving; `two-players` is for Studio's peers playtest (real browsers on one `?room=`). Each check shows on the page and
in the report. The same file lives in hawkesnet (`public/demo-playtest.mjs`) and hawkesnet-babylon: change all three.

**Recipes:** the four recipes (chat, cursors, shared state, a room with a password) are files in `recipes/`. The README, the
demo's `recipes.html` page and `npm test` (`test/`, which swaps only the import for `test/fake-net.mjs`) all use those exact
files. To add one: put the file in `recipes/`, list it in `RECIPES` in `example/recipes.mjs`, and it is tested, linked and
played by the `recipes` playtest scenario (`example/recipes-playtest.mjs`, passed to `net-playtest.mjs` as `scenarios`).
Example files import `'../hawkes-net.mjs'`; `tools/demo.mjs` rewrites that for `dist/`, so a new example page or module
must be copied there too. A "room with a password" is a room name made from the password, not access control (tickets are).

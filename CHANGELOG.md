# Changelog

## 1.4.0

The SDK itself is unchanged; this release adds a demo site, recipes and a test suite around it.

- **Demo site** (`example/`, built by `node tools/demo.mjs`): players as dots in a shared test room. It shows the SDK version and the endpoint it plays on, a connection-state banner with a quickstart, a player count, readable overlapping labels, distinct colours with short trails, and smooth remote movement (interpolation that holds up under simulated latency).
- **Playtest bot** (`example/net-playtest.mjs`, `window.hawkesPlaytest`): `smoke` (a second player in the same page: poses, messages and leaving, both ways) and `two-players` (real browsers in one `?room=`, which keep moving until the run ends).
- **Recipes** (`recipes/`): chat, cursors, shared state and a room with a password, with a docs page (`example/recipes.html`) and tests (`npm test`).
- Fixed: the header player count stayed at "1 here" with two players in the room; the quickstart panel covered the player list; the remote player's dot teleported under 150 ms latency.
- README: install from the `v1.4.0` tag.

## 1.3.0

Previous release.

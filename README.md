# @hawkesgen/net

Multiplayer for web games on [Hawkes Net](https://net.hawkesgen.ai): rooms on our relay (or peer to peer where your
project allows it), messages that arrive once and in order, avatars, synced state, express frames for what can't wait
(a fighting game's inputs), a shared clock, and games that keep going when a player's tab is in the background.

```bash
npm install @hawkesgen/net
```

```js
import { join } from '@hawkesgen/net';

const net = await join('lobby-1', { project: 'my-game', name: 'Ada' }); // your project from net.hawkesgen.ai
net.on('chat', (text, from) => console.log(from.name, text));
net.send('chat', 'hi');
net.pose([x, y, z], yaw);                                                // your avatar
net.onPose((id, state) => moveAvatar(id, state.p, state.y));
```

## Recipes

Things most games need, each a short file you can paste, run live on the demo site's **Recipes** page and tested
by `npm test` (the tests run the files exactly as written):

| Recipe | What it shows | Code |
|---|---|---|
| Chat | `send` and `on`, joins and leaves | [`recipes/chat.mjs`](recipes/chat.mjs) |
| Cursors | `pose` and `onPose`: every player's pointer, seen by the others | [`recipes/cursors.mjs`](recipes/cursors.mjs) |
| Shared state | `sync.state` and `sync.action`: one score, the host holds the truth | [`recipes/shared-state.mjs`](recipes/shared-state.mjs) |
| A room with a password | a room name made from the password, and what that does and doesn't protect | [`recipes/password-room.mjs`](recipes/password-room.mjs) |
| Tag | a tiny game on those APIs: shared `It`, tag actions, host-owned rounds | [`recipes/tag.mjs`](recipes/tag.mjs) · full sample [`example/tag.mjs`](example/tag.mjs) |

Chat in full:

```js
import { lobby } from '@hawkesgen/net';

const net = lobby({ project: 'netdemo', name: 'Ada' }); // netdemo is the free test project
net.on('chat', (text, from) => console.log(`${from.name}: ${text}`));
net.join('recipe-chat');
net.when('status', ({ status }) => { if (status === 'online') net.send('chat', 'hi, anyone here?'); });
```

A room with a password keeps friends together; it does not keep out someone who learns the room's name. For real access
control your server hands out tickets (see `ticket` in the types).

## Build a game: Tag

The demo plays Tag. The readable sample is [`example/tag.mjs`](example/tag.mjs) (wired into `example/index.html`); the
pasteable core is [`recipes/tag.mjs`](recipes/tag.mjs). On the Recipes page, **Run it here** on Tag opens the demo so two
tabs can chase.

Three SDK pieces do the work:

**1. Shared state for who is It.** The host's copy of `{ it, since, immuneUntil, timeAsIt, seq }` goes to every peer and
to late joiners:

```js
room.sync.state('tag', {
  get: () => ({ it, since, immuneUntil, timeAsIt, seq }),
  set: (s) => apply(s),
});
```

**2. Actions for tags.** A touch is one `sync.action` so every screen applies the new It in the same flush (not on the
next state tick):

```js
room.sync.action('tag:touch', (data, { authoritative }) => {
  if (!authoritative) return;          // host decides
  // …distance check, then:
  room.sync.action('tag:state', apply)({ it: data.to, immuneUntil: at + 1000, seq: seq + 1, /* … */ });
});
```

**3. Host for rounds.** Only the host picks the first It, accepts tags, and re-picks when It leaves. Time spent as It is
banked per player id (`timeAsIt`); the player with the least time wins a round when you add a timer (the sample tracks
the times; the demo draws the glow and the `It` label).

Movement is ordinary `pose` / `onPose`. Open the demo twice to play; `npm test` runs the tag rules against
`test/fake-net.mjs`.

## More

- **Projects and tickets:** make an account and a project at [net.hawkesgen.ai](https://net.hawkesgen.ai). A page on one
  of your project's sites joins with no key; servers, bots and tests use your API key.
- **The standard layer:** `lobby({ project, liveHosts })` keeps a shared room per area, with live and test rooms, shards
  when one is full, and rejoining by itself.
- **In the background:** `background(fn)` keeps your game's step running while the page has no animation frames, and the
  room marks a hidden player `away` (`peer:away`); an away host hands the room to a present player.
- **Staging:** a join with no `endpoint` goes to `globalThis.HAWKES_NET_ENDPOINT` when the page sets it (an origin), else
  to net.hawkesgen.ai. Set it on your staging site to point the whole game at another Hawkes Net, with no code change.
- **Types:** `hawkes-net.d.ts` ships with the package.
- **No dependencies.** Install it from npm, or from GitHub with a version tag
  (`"@hawkesgen/net": "https://github.com/jgriffith3433/hawkesnet-js/archive/refs/tags/v1.4.0.tar.gz"`). It also loads straight from
  `https://net.hawkesgen.ai/sdk/hawkes-net@1.mjs`.

Docs: [net.hawkesgen.ai](https://net.hawkesgen.ai) > Docs. License: MIT.

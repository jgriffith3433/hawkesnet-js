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

**Getting started:** [`example/start.html`](example/start.html) walks through five numbered steps from installing the GitHub tag tarball to two tabs in one room, with the console output you should see after each step (backed by [`example/start.mjs`](example/start.mjs)).

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
banked per player id (`timeAsIt`). The demo runs **60-second rounds** owned by the host in shared state: a timer at the
top of the play area (pulses in the last 10 s); at 0 the least time-as-It wins (confetti, scoreboard for 3 s, then a new
round with a random It). Use `?round=8` for an 8-second round when playtesting.

Movement is ordinary `pose` / `onPose`. Open the demo twice to play; `npm test` runs the tag rules against
`test/fake-net.mjs`.

## Handling drops

When the socket drops, the SDK sets `status` to `reconnecting`, retries with a backoff, and goes back to `online`. Three
events tell your game: `status` (`{ status }`: `online`, `reconnecting`, ...), `ready` (fires again after every return;
`resumed: true` means the same seat came back on its resume token) and `peer:away` (`{ peer, away }`: the room marks a
dropped player `away` for a 15 s grace, so ghost them, don't remove them; `peer:leave` comes only when the grace ends).

- **Resume:** a drop shorter than the grace comes back on the resume token: same peer id, same ownership, queued
  reliable messages replayed (`resumed: true`), usually well under 2 s once the network is back.
- **Fresh ticket:** after a node restart, a longer outage, or a refused token, the SDK asks for a new ticket
  (`resumed: false`): you are a new seat in the room, so rebuild your avatar from your own memory (the demo keeps name and
  colour in `sessionStorage`) and re-send your pose.

```js
import { join } from '@hawkesgen/net';

const net = await join('drops-demo', { project: 'netdemo', name: 'Ada' });
const me = { x: 0.5, y: 0.5 }; // your own memory: it survives a drop, and rebuilds a fresh seat
net.when('status', ({ status }) => {
  console.log(status); // online | reconnecting (then online again)
});
net.when('ready', ({ resumed }) => {
  console.log(resumed ? 'resumed: same seat' : 'fresh ticket: new seat');
  net.pose([me.x, me.y, 0], 0); // either way, say where you are again
});
net.when('peer:away', ({ peer, away }) => {
  console.log(peer.name, away ? 'away: draw at 40%' : 'back: draw in full'); // not removed
});
net.when('peer:leave', ({ peer }) => console.log(peer.name, 'left for good (grace over)'));
```

The demo's daily two-players playtest runs this: one player goes offline for 5 s, and it logs `recovery_ms` (must be under
2000), whether name, colour and spot match, and that the other tab drew the player as `away`.

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

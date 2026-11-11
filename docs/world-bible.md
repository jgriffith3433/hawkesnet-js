# Hawkes Net JS demo: world bible

## Areas

**The shop-window room** — the demo page’s play area (`example/index.html`): a dark spotlit floor with a dotted grid, soft blobs for every player, a side list of who is here, and Tag on the shared room `js-demo`. Mood: a live multiplayer lab you can open twice and see yourself. Entry is a ticket into netdemo’s free test rooms; leave is closing the tab or the SDK’s leave.

## Landmarks

**The connection banner** — fixed at the top of the play area; the only place the link state is spoken in plain words (Connecting, Connected, Reconnecting, Back in the room).

**The round clock** — at the top of the play area for host-owned Tag rounds; pulses in the last ten seconds.

## Who lives here

**You** — amber (or the colour remembered in this tab’s sessionStorage), labelled with your name and “(you)”. While the socket is down your blob freezes in place under Reconnecting….

**Other players** — palette-coloured soft blobs with short trails. When their socket drops (or they are marked away), they stay drawn ghosted at 40% opacity with “away” under the name until the server’s 15 s grace ends; then they leave the room.

**Filler bots** — host-local shared-state bots labelled “Bot” when you are alone, so the room never feels empty.

## What happens

Interactions: move (pointer / touch), Tag handoffs, mute, recipes links, quickstart paste-run.

Events on their own: fireflies, join ripples, blob breath/blink, Tag ring bursts and winner confetti/fanfare.

Ambient: grid floor, soft light, player trails; reconnect and away are shown through the banner and ghosted blobs, not through a text dump.

## Story beats

1. **Join the room** — banner goes Connecting → Connected; your blob and the player list appear.
2. **Meet someone** — a second tab or the smoke bot joins; colours, trails and Tag play between you.
3. **Drop and hold** — a lost socket freezes your blob under Reconnecting… (spotlight dims, fireflies hush, a soft down-tone); when the link returns the banner says Back in the room for two seconds with a recovery chime, then Connected. A peer who drops stays ghosted with “away” and a slow pulse at their last spot (fireflies slow) for the grace, then is gone or back as themselves (same name and colour from this tab’s memory).
4. **Poke the floor** — a tap or click on the canvas rings the grid (local ripple), a second verb beside Tag chase.

// Cursors: every player's pointer, seen by everyone else, as a position from 0 to 1 so screens of any size agree.
import { lobby } from '@hawkesgen/net';

const net = lobby({ project: 'netdemo', name: 'Ada' });
const cursors = new Map(); // player id -> [x, y]

net.onPose((id, state) => {                      // someone else moved
  cursors.set(id, [state.p[0], state.p[1]]);
  const who = net.peers.get(id)?.name ?? id;
  console.log(`${who} is at ${state.p[0].toFixed(2)}, ${state.p[1].toFixed(2)}`);
});
net.when('peer:leave', ({ peer }) => cursors.delete(peer.id)); // forget them when they go

// Say where you are whenever you move. pose() is cheap to call as often as you like: the newest position goes out
// with each send, the rest are dropped.
addEventListener('pointermove', (e) => net.pose([e.clientX / innerWidth, e.clientY / innerHeight, 0]));

net.join('recipe-cursors');
// Draw `cursors` however your game does: a dot per entry. The demo page does it with a canvas and smooths the
// movement with Track (see example/index.html).

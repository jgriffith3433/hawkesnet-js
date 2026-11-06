// Shared state: one score everyone sees. The host holds the truth; anyone can ask to change it.
import { lobby } from '@hawkesgen/net';

const net = lobby({ project: 'netdemo', name: 'Ada' });
let score = 0;
let addPoints = () => {};

net.when('joined', (room) => {                    // each time you are in a room (again, after a reconnect)
  // The state: the host's copy goes to every player, and to anyone who joins later.
  room.sync.state('scoreboard', {
    get: () => ({ score }),                       // read on the host
    set: (copy) => { score = copy.score; console.log(`score: ${score}`); }, // applied everywhere else
  });
  // The action: "add points" runs once for everyone, decided by the host.
  addPoints = room.sync.action('addPoints', (n) => { score += n; console.log(`score: ${score}`); });
  addPoints(1);                                   // one point for arriving
});

net.join('recipe-state');
// Later, from your game: addPoints(10);

// A room with a password: the room's name comes from the password, so only people who know it land in the same room.
import { lobby } from '@hawkesgen/net';

const password = 'swordfish';                     // what your players type in
const bytes = new TextEncoder().encode(`my-game/${password}`);
const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
const code = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);

const net = lobby({ project: 'netdemo', name: 'Ada' });
net.on('chat', (text, from) => console.log(`${from.name}: ${text}`));
net.when('status', ({ status }) => { if (status === 'online') net.send('chat', 'we have the right password'); });

net.join(`vault-${code}`);                        // a different password is a different room: nobody to meet
// This keeps friends together; it does not keep strangers out of a room whose name they guess or learn. For real
// access control, have your server hand out tickets (join's `ticket` option) only to the players you let in.

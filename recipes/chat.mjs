// Chat: everyone in the room sees what anyone sends, once and in order.
import { lobby } from '@hawkesgen/net';

const net = lobby({ project: 'netdemo', name: 'Ada' }); // your project from net.hawkesgen.ai

net.on('chat', (text, from) => console.log(`${from.name}: ${text}`));          // what others say
net.when('peer:join', ({ peer }) => console.log(`${peer.name} joined`));
net.when('peer:leave', ({ peer }) => console.log(`${peer.name} left`));

const say = (text) => { console.log(`you: ${text}`); net.send('chat', text); }; // your own line, then everyone else's

let greeted = false;
net.when('status', ({ status }) => {
  if (status === 'online' && !greeted) { greeted = true; say('hi, anyone here?'); }
});
net.join('recipe-chat'); // one shared room per area; a full room moves on to 'recipe-chat.2' by itself

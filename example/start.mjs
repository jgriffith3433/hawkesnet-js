import { lobby } from '@hawkesgen/net';

const net = lobby({ project: 'netdemo', name: 'Ada' }); // netdemo is the free test project
net.when('status', ({ status }) => console.log('status:', status));

net.when('peer:join', (peer) => console.log(`${peer.name} joined`));
net.when('peer:leave', ({ peer }) => console.log(`${peer.name} left`));

net.on('chat', (text, from) => console.log(`${from.name}: ${text}`));
net.onPose((id, state) => {
  const who = net.peers.get(id)?.name ?? id;
  console.log(`${who} is at ${state.p[0].toFixed(2)}, ${state.p[1].toFixed(2)}`);
});

let greeted = false;
net.when('status', ({ status }) => {
  if (status === 'online' && !greeted) { greeted = true; console.log('you: hi, anyone here?'); net.send('chat', 'hi, anyone here?'); }
});
if (typeof addEventListener === 'function') {
  addEventListener('pointermove', (e) => net.pose([e.clientX / innerWidth, e.clientY / innerHeight, 0]));
}
net.join('getting-started');

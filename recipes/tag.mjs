// Tag: the host keeps who is It in shared state; a tag action passes It with 1 s of immunity.
// The full game (movement, glow, time as It) lives in example/tag.mjs; this file is the pasteable core.
import { lobby } from '@hawkesgen/net';

const TAG_RADIUS = 0.036; // ~1.5 dots on the 0..1 play area
const IMMUNE_MS = 1000;

const net = lobby({ project: 'netdemo', name: 'Ada' });
let it = null, since = 0, immuneUntil = 0, timeAsIt = {}, seq = 0;
const pos = new Map();
let commit = () => {}, askTag = () => {};

const now = () => Date.now();
const bank = (at) => {
  if (it && since && at > since) {
    timeAsIt[it] = Math.round((timeAsIt[it] || 0) + (at - since));
    since = at;
  }
};
const show = () => {
  const times = Object.entries(timeAsIt).map(([id, ms]) => `${id}:${ms}ms`).join(' ') || 'none';
  console.log(`It: ${it || 'nobody'} · immune ${Math.max(0, immuneUntil - now())}ms · timeAsIt ${times}`);
};
const apply = (s) => {
  if (!s) return;
  const n = Number(s.seq) || 0;
  if (n < seq) return;
  if (n === seq && it === (s.it || null)) return;
  seq = n;
  it = s.it || null;
  since = Number.isFinite(s.since) ? s.since : now();
  immuneUntil = Number.isFinite(s.immuneUntil) ? s.immuneUntil : 0;
  if (s.timeAsIt && typeof s.timeAsIt === 'object') timeAsIt = { ...s.timeAsIt };
  show();
};
const payload = () => ({ it, since, immuneUntil, timeAsIt: { ...timeAsIt }, seq });

net.when('joined', (room) => {
  // Shared state: every peer (and late joiners) see the same It.
  room.sync.state('tag', { get: () => payload(), set: apply });
  // Actions: one send applies the new It on every peer in the same flush.
  commit = room.sync.action('tag:state', apply);
  askTag = room.sync.action('tag:touch', (data, { authoritative } = {}) => {
    if (!authoritative || !data || !room.isHost) return;
    if (!it || data.from !== it || !data.to || data.to === it) return;
    const at = now();
    if (at < immuneUntil) return; // 1 s of tag-back immunity
    const a = pos.get(data.from), b = pos.get(data.to);
    if (!a || !b || Math.hypot(a.x - b.x, a.y - b.y) > TAG_RADIUS * 1.05) return;
    bank(at);
    timeAsIt[data.to] = timeAsIt[data.to] || 0;
    const next = { it: data.to, since: at, immuneUntil: at + IMMUNE_MS, timeAsIt: { ...timeAsIt }, seq: seq + 1 };
    apply(next);
    commit(next);
  });

  const ensureIt = () => {
    if (!room.isHost) return;
    if (it && (it === room.id || room.peers.has(it))) return;
    const at = now();
    bank(at);
    const pick = [...room.peers.keys()][0] || room.id;
    timeAsIt[pick] = timeAsIt[pick] || 0;
    const next = { it: pick, since: at, immuneUntil: 0, timeAsIt: { ...timeAsIt }, seq: seq + 1 };
    apply(next);
    commit(next);
  };

  room.when('peer:join', ensureIt);
  room.when('peer:leave', ({ peer }) => { pos.delete(peer?.id); ensureIt(); });
  ensureIt();
});

net.onPose((id, s) => {
  if (!Array.isArray(s?.p)) return;
  pos.set(id, { x: s.p[0], y: s.p[1] });
  if (it !== net.id || now() < immuneUntil) return;
  const me = pos.get(it);
  if (!me) return;
  for (const [oid, p] of pos) {
    if (oid === it) continue;
    if (Math.hypot(me.x - p.x, me.y - p.y) <= TAG_RADIUS) {
      askTag({ from: it, to: oid, by: net.id, x: me.x, y: me.y });
      break;
    }
  }
});

if (typeof addEventListener === 'function') {
  addEventListener('pointermove', (e) => {
    const x = e.clientX / innerWidth, y = e.clientY / innerHeight;
    pos.set(net.id, { x, y });
    net.pose([x, y, 0]);
  });
}

net.join('recipe-tag');
console.log('Tag room open — Run opens the demo for a playable two-player game.');

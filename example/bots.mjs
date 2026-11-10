// Host-local Tag filler bots for the demo: simulated players in shared state (not real lobby peers).
// Alone for ALONE_MS → host fills to TARGET_TOTAL with bots labelled "Bot". They wander, flee when It is
// near, and chase when they are It. As real players join, bots leave one by one (keep at least TARGET_TOTAL
// while any bots remain). A peer named like a Studio playtest bot clears them so they never block smoke.

export const ALONE_MS = 3000;
export const TARGET_TOTAL = 4;
export const BOT_COLORS = ['#5ec8ff', '#ff7eb6', '#9fe870'];
export const FLEE_RADIUS = 0.22;
export const BOT_SPEED = 0.28; // screen widths per second

const PLAYTEST_NAME = /playtest/i;

export function createBots(net, options = {}) {
  if (!net) throw new Error('bots: createBots(net) needs a Hawkes Net lobby or room');
  const tag = options.tag || null;
  const aloneMs = Number.isFinite(options.aloneMs) ? options.aloneMs : ALONE_MS;
  const targetTotal = Number.isFinite(options.targetTotal) ? options.targetTotal : TARGET_TOTAL;
  const onChange = typeof options.onChange === 'function' ? options.onChange : null;
  const colors = options.colors || BOT_COLORS;

  let currentRoom = null;
  let stateHandle = null;
  let roomCleanups = [];
  let aloneSince = 0;
  let seq = 0;
  let lastTick = 0;
  /** @type {{ id: string, name: string, color: string, x: number, y: number, vx: number, vy: number, wanderT: number }[]} */
  let bots = [];
  let suspended = false; // playtest asked them off

  const clock = () => {
    if (typeof options.now === 'function') return options.now();
    if (currentRoom && typeof currentRoom.now === 'function') return currentRoom.now();
    if (typeof net.now === 'function') return net.now();
    return Date.now();
  };

  const myId = () => currentRoom?.id ?? net?.id ?? null;
  const isHost = () => Boolean(currentRoom ? currentRoom.isHost : net?.isHost);
  const peersMap = () => currentRoom?.peers ?? net?.peers ?? new Map();
  const realCount = () => {
    const me = myId();
    let n = me ? 1 : 0;
    for (const id of peersMap().keys()) if (id !== me) n++;
    return n;
  };
  const hasPlaytestPeer = () => {
    for (const p of peersMap().values()) if (PLAYTEST_NAME.test(p?.name || '')) return true;
    return false;
  };

  function notify() {
    if (onChange) { try { onChange(snapshot()); } catch { /* ignore */ } }
  }

  function payload() {
    return {
      seq,
      bots: bots.map(({ id, name, color, x, y }) => ({ id, name, color, x, y })),
    };
  }

  function applyRemote(s) {
    if (!s || typeof s !== 'object') return false;
    const nextSeq = Number(s.seq) || 0;
    if (nextSeq < seq && bots.length) return false;
    seq = nextSeq;
    const list = Array.isArray(s.bots) ? s.bots : [];
    bots = list.map((b, i) => ({
      id: typeof b.id === 'string' && b.id ? b.id : `bot-${i}`,
      name: typeof b.name === 'string' && b.name ? b.name : 'Bot',
      color: typeof b.color === 'string' && b.color ? b.color : colors[i % colors.length],
      x: Number.isFinite(b.x) ? b.x : 0.5,
      y: Number.isFinite(b.y) ? b.y : 0.5,
      vx: 0,
      vy: 0,
      wanderT: 0,
    }));
    syncTagExtras();
    notify();
    return true;
  }

  function publish() {
    seq += 1;
    syncTagExtras();
    if (stateHandle?.resend) {
      try { stateHandle.resend(); } catch { /* offline */ }
    }
    notify();
  }

  function syncTagExtras() {
    if (!tag) return;
    const live = new Set(bots.map((b) => b.id));
    for (const id of tag.extraIds?.() || []) if (!live.has(id)) tag.removeExtra(id);
    for (const b of bots) tag.setExtra(b.id, b.x, b.y);
  }

  function clearBots(reason = 'clear') {
    if (!bots.length) return;
    bots = [];
    if (tag?.clearExtras) tag.clearExtras();
    if (isHost()) publish();
    else notify();
    void reason;
  }

  function wantedBotCount() {
    if (suspended || hasPlaytestPeer()) return 0;
    const real = realCount();
    if (real <= 0) return 0;
    return Math.max(0, targetTotal - real);
  }

  function spawnOne(i) {
    const ang = (i * 2.1) + clock() / 5000;
    return {
      id: `bot-${clock().toString(36)}-${i}-${Math.random().toString(36).slice(2, 6)}`,
      name: 'Bot',
      color: colors[i % colors.length],
      x: 0.5 + 0.28 * Math.cos(ang),
      y: 0.5 + 0.28 * Math.sin(ang),
      vx: 0,
      vy: 0,
      wanderT: 0,
    };
  }

  function resizeToWanted() {
    if (!isHost()) return false;
    const want = wantedBotCount();
    if (want === bots.length) return false;
    if (want === 0) {
      clearBots('empty');
      return true;
    }
    while (bots.length > want) bots.pop();
    while (bots.length < want) bots.push(spawnOne(bots.length));
    // Keep distinct colours for the live set.
    bots.forEach((b, i) => { b.color = colors[i % colors.length]; });
    publish();
    return true;
  }

  function itPos() {
    if (!tag?.it) return null;
    if (tag.it === myId() && typeof options.myPos === 'function') {
      const p = options.myPos();
      if (p) return { x: p[0] ?? p.x, y: p[1] ?? p.y };
    }
    for (const b of bots) if (b.id === tag.it) return { x: b.x, y: b.y };
    if (typeof options.posOf === 'function') {
      const p = options.posOf(tag.it);
      if (p) return { x: p.x ?? p[0], y: p.y ?? p[1] };
    }
    return null;
  }

  function nearestOther(fromId, fx, fy) {
    let best = null, bestD = Infinity;
    const consider = (id, x, y) => {
      if (!id || id === fromId || !Number.isFinite(x) || !Number.isFinite(y)) return;
      const d = Math.hypot(x - fx, y - fy);
      if (d < bestD) { bestD = d; best = { id, x, y, d }; }
    };
    if (typeof options.myPos === 'function') {
      const p = options.myPos();
      if (p) consider(myId(), p[0] ?? p.x, p[1] ?? p.y);
    }
    if (typeof options.eachReal === 'function') {
      options.eachReal((id, x, y) => consider(id, x, y));
    }
    for (const b of bots) consider(b.id, b.x, b.y);
    return best;
  }

  function steer(b, tx, ty, speed, dt) {
    const dx = tx - b.x, dy = ty - b.y;
    const len = Math.hypot(dx, dy) || 1;
    const step = Math.min(len, speed * dt);
    b.x = Math.max(0.04, Math.min(0.96, b.x + (dx / len) * step));
    b.y = Math.max(0.04, Math.min(0.96, b.y + (dy / len) * step));
  }

  function tickHost(dt) {
    const it = tag?.it || null;
    const threat = itPos();
    for (const b of bots) {
      b.wanderT -= dt;
      if (it === b.id) {
        const prey = nearestOther(b.id, b.x, b.y);
        if (prey) steer(b, prey.x, prey.y, BOT_SPEED * 1.25, dt);
      } else if (threat && it && Math.hypot(threat.x - b.x, threat.y - b.y) < FLEE_RADIUS) {
        const dx = b.x - threat.x, dy = b.y - threat.y;
        const len = Math.hypot(dx, dy) || 1;
        steer(b, b.x + dx / len, b.y + dy / len, BOT_SPEED * 1.15, dt);
      } else {
        if (b.wanderT <= 0) {
          const ang = Math.random() * Math.PI * 2;
          b.vx = Math.cos(ang);
          b.vy = Math.sin(ang);
          b.wanderT = 0.6 + Math.random() * 1.4;
        }
        steer(b, b.x + b.vx, b.y + b.vy, BOT_SPEED * 0.55, dt);
      }
      if (tag) tag.setExtra(b.id, b.x, b.y);
    }
    // Positions ride the sync.state rate tick via get(); roster changes call publish().
    notify();
  }

  function hostUpkeep() {
    if (!isHost() || !currentRoom) return;
    if (suspended || hasPlaytestPeer()) {
      if (bots.length) clearBots('playtest');
      aloneSince = 0;
      return;
    }
    const real = realCount();
    const want = wantedBotCount();
    if (real > 1) {
      aloneSince = 0;
      if (bots.length !== want) resizeToWanted();
      return;
    }
    // Alone (only the host): start / keep the alone timer, then fill.
    if (!aloneSince) aloneSince = clock();
    if (bots.length) {
      if (bots.length !== want) resizeToWanted();
      return;
    }
    if (clock() - aloneSince >= aloneMs) resizeToWanted();
  }

  function attach(room) {
    if (!room || !room.sync || currentRoom === room) return;
    for (const off of roomCleanups.splice(0)) { try { off?.(); } catch { /* gone */ } }
    currentRoom = room;
    bots = [];
    seq = 0;
    aloneSince = 0;
    lastTick = 0;
    if (tag?.clearExtras) tag.clearExtras();

    stateHandle = room.sync.state('bots', {
      get: () => payload(),
      set: (s) => {
        if (isHost()) return; // host owns the list
        applyRemote(s);
      },
      rate: 12,
    });
    roomCleanups.push(() => stateHandle?.remove?.());

    if (typeof room.when === 'function') {
      roomCleanups.push(room.when('peer:join', () => { hostUpkeep(); }));
      roomCleanups.push(room.when('peer:leave', () => {
        aloneSince = 0;
        hostUpkeep();
      }));
      roomCleanups.push(room.when('host', () => { hostUpkeep(); }));
      roomCleanups.push(room.when('status', ({ status } = {}) => {
        if (status === 'online') {
          aloneSince = clock();
          hostUpkeep();
        }
      }));
    }
    if (typeof room.sync.onHost === 'function') {
      roomCleanups.push(room.sync.onHost(() => { hostUpkeep(); }));
    }
    aloneSince = clock();
    hostUpkeep();
  }

  if (typeof net.when === 'function') {
    net.when('joined', (room) => attach(room || net.room || net));
  }
  if (net.room?.sync) attach(net.room);
  else if (net.sync && (net.status === 'online' || net.ready)) attach(net);

  function snapshot() {
    return {
      count: bots.length,
      aloneMs,
      targetTotal,
      suspended,
      bots: bots.map(({ id, name, color, x, y }) => ({ id, name, color, x, y })),
    };
  }

  return {
    ALONE_MS: aloneMs,
    TARGET_TOTAL: targetTotal,
    get count() { return bots.length; },
    list: () => bots.map(({ id, name, color, x, y }) => ({ id, name, color, x, y })),
    snapshot,
    suspend() { suspended = true; clearBots('suspend'); },
    resume() { suspended = false; aloneSince = clock(); hostUpkeep(); },
    /** Drive host AI + alone/fill upkeep. Call from the demo frame / pose tick. */
    tick(now = clock()) {
      hostUpkeep();
      if (!isHost() || !bots.length) { lastTick = now; return; }
      const dt = lastTick ? Math.max(0.001, Math.min(0.1, (now - lastTick) / 1000)) : 0.05;
      lastTick = now;
      tickHost(dt);
    },
  };
}

export default createBots;

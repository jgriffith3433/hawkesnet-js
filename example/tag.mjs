// Tag on @hawkesgen/net: built only on the public SDK (sync.state, sync.action, and pose/onPose for movement).
// The room's host picks who is It and keeps it in shared state; when It's dot touches another dot (radius ~1.5 dots),
// the tagged player becomes It with 1 s of tag-back immunity, and time spent as It is tracked per player id.

export const DOT_RADIUS = 0.024;
export const TAG_RADIUS = DOT_RADIUS * 1.5; // 0.036 (~1.5 dots across the 0..1 play area)
export const IMMUNE_MS = 1000;

export function createTag(net, options = {}) {
  if (!net) throw new Error('tag: createTag(net) needs a Hawkes Net lobby or room');
  const radius = Number.isFinite(options.radius) ? options.radius : TAG_RADIUS;
  const immuneMs = Number.isFinite(options.immuneMs) ? options.immuneMs : IMMUNE_MS;
  const onChange = typeof options.onChange === 'function' ? options.onChange : null;

  let currentRoom = null;
  let stateHandle = null;
  let commitAction = null;
  let touchAction = null;
  let sentTouchKey = '';
  let sentTouchAt = 0;
  let roomCleanups = [];

  const game = {
    it: null,
    since: 0,
    immuneUntil: 0,
    immuneFrom: null,
    timeAsIt: {},
    seq: 0,
  };
  const positions = new Map(); // player id -> { x, y }
  const peerAck = new Map();   // peer id -> { it, seq }
  const localPos = { x: 0.5, y: 0.5, known: false };

  const clock = () => {
    if (typeof options.now === 'function') return options.now();
    if (currentRoom && typeof currentRoom.now === 'function') return currentRoom.now();
    if (typeof net.now === 'function') return net.now();
    return Date.now();
  };

  const myId = () => currentRoom?.id ?? net?.id ?? null;
  const isHost = () => Boolean(currentRoom ? currentRoom.isHost : net?.isHost);
  const peersMap = () => currentRoom?.peers ?? net?.peers ?? new Map();
  const isPresent = (id) => Boolean(id && (id === myId() || peersMap().has(id)));
  const presentIds = () => {
    const me = myId();
    const ids = [...peersMap().keys()];
    if (me && !ids.includes(me)) ids.unshift(me);
    return ids.filter(Boolean).sort();
  };

  // Folds the current It player's elapsed stint into game.timeAsIt up to `at`.
  function bankTime(at) {
    if (game.it && game.since > 0 && at > game.since) {
      game.timeAsIt[game.it] = Math.round((game.timeAsIt[game.it] || 0) + (at - game.since));
      game.since = at;
    }
  }

  function timeMs(id = myId(), at = clock()) {
    if (!id) return 0;
    const base = Number(game.timeAsIt[id]) || 0;
    const live = game.it === id && game.since > 0 ? Math.max(0, at - game.since) : 0;
    return base + live;
  }

  function allTimes(at = clock()) {
    const out = {};
    const ids = new Set([...Object.keys(game.timeAsIt), ...presentIds(), ...(game.it ? [game.it] : [])]);
    for (const id of ids) if (id) out[id] = Math.round(timeMs(id, at));
    return out;
  }

  function getStatePayload() {
    return {
      it: game.it,
      since: game.since,
      immuneUntil: game.immuneUntil,
      immuneFrom: game.immuneFrom,
      timeAsIt: { ...game.timeAsIt },
      seq: game.seq,
    };
  }

  function sendAck() {
    if (!currentRoom || !game.it) return;
    const me = myId();
    if (me) peerAck.set(me, { it: game.it, seq: game.seq });
    try { currentRoom.send('tag:ack', { it: game.it, seq: game.seq }); } catch { /* offline */ }
  }

  function snapshot(at = clock()) {
    return {
      it: game.it,
      since: game.since,
      immuneUntil: game.immuneUntil,
      immuneFrom: game.immuneFrom,
      immune: Boolean(game.it && at < game.immuneUntil),
      timeAsIt: allTimes(at),
      seq: game.seq,
    };
  }

  function applyState(s) {
    if (!s || typeof s !== 'object') return false;
    const seq = Number(s.seq) || 0;
    if (seq < game.seq) return false;
    if (seq === game.seq && game.it !== null && s.it === game.it) return false;
    game.seq = seq;
    game.it = typeof s.it === 'string' && s.it ? s.it : null;
    game.since = Number.isFinite(s.since) ? s.since : clock();
    game.immuneUntil = Number.isFinite(s.immuneUntil) ? s.immuneUntil : 0;
    game.immuneFrom = typeof s.immuneFrom === 'string' && s.immuneFrom ? s.immuneFrom : null;
    if (s.timeAsIt && typeof s.timeAsIt === 'object') {
      const next = {};
      for (const [k, v] of Object.entries(s.timeAsIt)) if (Number.isFinite(v)) next[k] = Math.round(v);
      game.timeAsIt = next;
    }
    sentTouchKey = '';
    sendAck();
    if (onChange) { try { onChange(snapshot()); } catch { /* ignore */ } }
    return true;
  }

  function broadcastState(next) {
    applyState(next);
    stateHandle?.resend?.();
    if (commitAction) commitAction(next);
  }

  function ensureIt() {
    if (!isHost()) return;
    const me = myId();
    if (!me) return;
    if (game.it && isPresent(game.it)) return;
    const at = clock();
    bankTime(at);
    const candidates = presentIds();
    const pick = candidates[0] || me;
    game.timeAsIt[pick] = game.timeAsIt[pick] || 0;
    broadcastState({
      it: pick,
      since: at,
      immuneUntil: 0,
      immuneFrom: null,
      timeAsIt: { ...game.timeAsIt },
      seq: game.seq + 1,
    });
  }

  function tryTag(fromId, toId) {
    if (!isHost()) return false;
    if (!game.it || fromId !== game.it) return false;
    if (!toId || toId === game.it || !isPresent(toId)) return false;
    const at = clock();
    if (at < game.immuneUntil) return false; // 1 s of tag-back immunity
    const a = positions.get(fromId), b = positions.get(toId);
    if (!a || !b) return false;
    if (Math.hypot(a.x - b.x, a.y - b.y) > radius * 1.05) return false;
    bankTime(at);
    game.timeAsIt[toId] = game.timeAsIt[toId] || 0;
    broadcastState({
      it: toId,
      since: at,
      immuneUntil: at + immuneMs,
      immuneFrom: fromId,
      timeAsIt: { ...game.timeAsIt },
      seq: game.seq + 1,
    });
    return true;
  }

  function checkTouch() {
    const me = myId();
    if (!currentRoom || !me) return;
    if (localPos.known) positions.set(me, { x: localPos.x, y: localPos.y });
    if (!game.it) {
      if (isHost()) ensureIt();
      return;
    }
    const at = clock();
    if (at < game.immuneUntil) return;
    const itPos = positions.get(game.it);
    if (!itPos) return;

    if (isHost()) {
      for (const id of presentIds()) {
        if (id === game.it) continue;
        const p = positions.get(id);
        if (p && Math.hypot(itPos.x - p.x, itPos.y - p.y) <= radius) {
          if (tryTag(game.it, id)) return;
        }
      }
      return;
    }

    // Non-host: if I am It and touch a peer, or if It touches me, ask the host to commit the tag.
    if (!touchAction) return;
    let targetId = null;
    if (game.it === me) {
      for (const id of peersMap().keys()) {
        const p = positions.get(id);
        if (p && Math.hypot(itPos.x - p.x, itPos.y - p.y) <= radius) { targetId = id; break; }
      }
    } else {
      const myP = positions.get(me);
      if (myP && Math.hypot(itPos.x - myP.x, itPos.y - myP.y) <= radius) targetId = me;
    }
    if (!targetId) return;
    const key = `${game.seq}:${game.it}->${targetId}`;
    if (sentTouchKey === key && at - sentTouchAt < 150) return;
    sentTouchKey = key;
    sentTouchAt = at;
    const myP = positions.get(me);
    touchAction({ from: game.it, to: targetId, seq: game.seq, by: me, x: myP?.x, y: myP?.y });
  }

  function wrapPose(target) {
    if (!target || typeof target.pose !== 'function' || target.__tagPoseWrapped) return;
    const orig = target.pose.bind(target);
    target.__tagPoseWrapped = true;
    target.pose = (p, yaw, extra) => {
      if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
        localPos.x = p[0];
        localPos.y = p[1];
        localPos.known = true;
        const me = myId();
        if (me) positions.set(me, { x: p[0], y: p[1] });
      }
      const res = orig(p, yaw, extra);
      checkTouch();
      return res;
    };
  }

  function attach(room) {
    if (!room || !room.sync || currentRoom === room) return;
    for (const off of roomCleanups.splice(0)) { try { off?.(); } catch { /* gone */ } }
    currentRoom = room;
    game.it = null;
    game.since = 0;
    game.immuneUntil = 0;
    game.immuneFrom = null;
    game.timeAsIt = {};
    game.seq = 0;
    positions.clear();
    peerAck.clear();
    sentTouchKey = '';
    if (localPos.known && room.id) positions.set(room.id, { x: localPos.x, y: localPos.y });

    wrapPose(room);

    stateHandle = room.sync.state('tag', {
      get: () => getStatePayload(),
      set: (s) => applyState(s),
      rate: 10,
    });
    roomCleanups.push(() => stateHandle?.remove?.());

    // Host invokes tag:state so every peer (including a non-host caller of tag:touch) applies it in one send.
    commitAction = room.sync.action('tag:state', (data) => {
      applyState(data);
    });

    touchAction = room.sync.action('tag:touch', (data, { authoritative, from } = {}) => {
      if (!authoritative || !data) return;
      const caller = from?.id || data.by;
      if (caller && Number.isFinite(data.x) && Number.isFinite(data.y)) {
        positions.set(caller, { x: data.x, y: data.y });
      }
      tryTag(data.from, data.to);
    });

    if (typeof room.on === 'function') {
      roomCleanups.push(room.on('tag:ack', (d, from) => {
        if (from?.id && d?.it) peerAck.set(from.id, { it: d.it, seq: Number(d.seq) || 0 });
      }));
      roomCleanups.push(room.on('tag:hello', () => {
        if (isHost()) {
          ensureIt();
          if (game.it) {
            stateHandle?.resend?.();
            commitAction?.(getStatePayload());
          }
        }
        sendAck();
      }));
    }

    if (typeof room.when === 'function') {
      roomCleanups.push(room.when('peer:join', () => {
        if (isHost()) {
          ensureIt();
          if (game.it) {
            stateHandle?.resend?.();
            commitAction?.(getStatePayload());
          }
        }
        sendAck();
      }));
      roomCleanups.push(room.when('peer:leave', (ev) => {
        const id = ev?.peer?.id ?? ev?.id ?? ev?.c;
        if (id) {
          positions.delete(id);
          peerAck.delete(id);
        }
        if (isHost()) ensureIt();
      }));
      roomCleanups.push(room.when('host', () => {
        if (isHost()) ensureIt();
      }));
      roomCleanups.push(room.when('status', ({ status } = {}) => {
        if (status === 'online') {
          if (isHost()) ensureIt();
          sendAck();
          try { room.send('tag:hello', { id: room.id }); } catch { /* offline */ }
        }
      }));
    }
    if (typeof room.sync.onHost === 'function') {
      roomCleanups.push(room.sync.onHost(() => {
        if (isHost()) ensureIt();
      }));
    }

    if (isHost()) ensureIt();
    try { room.send('tag:hello', { id: room.id }); } catch { /* offline */ }
  }

  wrapPose(net);
  if (typeof net.onPose === 'function') {
    net.onPose((id, s) => {
      if (!id || !Array.isArray(s?.p)) return;
      positions.set(id, { x: s.p[0], y: s.p[1] });
      checkTouch();
    });
  }
  if (typeof net.when === 'function') {
    net.when('joined', (room) => attach(room || net.room || net));
  }
  if (net.room?.sync) attach(net.room);
  else if (net.sync && (net.status === 'online' || net.ready)) attach(net);

  const api = {
    DOT_RADIUS,
    RADIUS: radius,
    IMMUNE_MS: immuneMs,
    get it() { return game.it; },
    get since() { return game.since; },
    get immuneUntil() { return game.immuneUntil; },
    get immuneFrom() { return game.immuneFrom; },
    get seq() { return game.seq; },
    isIt: (id = myId()) => Boolean(id && game.it === id),
    isImmune: (at = clock()) => Boolean(game.it && at < game.immuneUntil),
    timeMs: (id = myId(), at = clock()) => timeMs(id, at),
    labelFor: (id, baseName = '') => (id && game.it === id ? 'It' : baseName),
    peerIt: (id) => peerAck.get(id)?.it ?? null,
    agreedWith: (id) => Boolean(game.it && peerAck.get(id)?.it === game.it && peerAck.get(id)?.seq === game.seq),
    distanceTo: (id) => {
      const me = myId();
      const a = (me && positions.get(me)) || (localPos.known ? localPos : null);
      const b = positions.get(id);
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : Infinity;
    },
    move(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      localPos.x = x;
      localPos.y = y;
      localPos.known = true;
      const me = myId();
      if (me) positions.set(me, { x, y });
      const prevSeq = game.seq;
      const prevTouch = sentTouchKey;
      checkTouch();
      // When a move triggers or requests a tag, send the pose at once so the room has the contact spot in the same bundle.
      if ((game.seq !== prevSeq || sentTouchKey !== prevTouch) && typeof net.pose === 'function') {
        net.pose([x, y, 0]);
      }
    },
    snapshot: (at = clock()) => snapshot(at),
  };

  return api;
}

export default createTag;

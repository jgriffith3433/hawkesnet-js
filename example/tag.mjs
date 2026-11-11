// Tag on @hawkesgen/net: built only on the public SDK (sync.state, sync.action, and pose/onPose for movement).
// The room's host picks who is It and keeps it in shared state; when It's dot touches another dot (radius ~1.5 dots),
// the tagged player becomes It with 1 s of tag-back immunity, and time spent as It is tracked per player id.
// Host-owned rounds: a timer in shared state; at 0 the least time-as-It wins, a short results beat, then a new round.

export const DOT_RADIUS = 0.024;
export const TAG_RADIUS = DOT_RADIUS * 1.5; // 0.036 (~1.5 dots across the 0..1 play area)
export const IMMUNE_MS = 1000;
export const ROUND_MS = 60_000;
export const RESULTS_MS = 3_000;

export function createTag(net, options = {}) {
  if (!net) throw new Error('tag: createTag(net) needs a Hawkes Net lobby or room');
  const radius = Number.isFinite(options.radius) ? options.radius : TAG_RADIUS;
  const immuneMs = Number.isFinite(options.immuneMs) ? options.immuneMs : IMMUNE_MS;
  let roundMs = Number.isFinite(options.roundMs) && options.roundMs > 0 ? Math.round(options.roundMs) : ROUND_MS;
  const resultsMs = Number.isFinite(options.resultsMs) && options.resultsMs > 0 ? Math.round(options.resultsMs) : RESULTS_MS;
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
    round: 0,
    roundMs,
    roundEndsAt: 0,
    phase: 'play', // 'play' | 'results'
    winner: null,
    resultsUntil: 0,
    scoreboard: [], // [{ id, ms }] frozen at round end, least time first
  };
  const positions = new Map(); // player id -> { x, y }
  const extras = new Map();    // local/simulated players (e.g. host bots) id -> { x, y }
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
  const isPresent = (id) => Boolean(id && (id === myId() || peersMap().has(id) || extras.has(id)));
  const presentIds = () => {
    const me = myId();
    const ids = [...peersMap().keys()];
    if (me && !ids.includes(me)) ids.unshift(me);
    for (const id of extras.keys()) if (id && !ids.includes(id)) ids.push(id);
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
    if (game.phase === 'results') return base;
    const live = game.it === id && game.since > 0 ? Math.max(0, at - game.since) : 0;
    return base + live;
  }

  function allTimes(at = clock()) {
    const out = {};
    const ids = new Set([...Object.keys(game.timeAsIt), ...presentIds(), ...(game.it ? [game.it] : [])]);
    for (const id of ids) if (id) out[id] = Math.round(timeMs(id, at));
    return out;
  }

  function remainingMs(at = clock()) {
    if (game.phase === 'results') return 0;
    if (!game.roundEndsAt) return game.roundMs;
    return Math.max(0, Math.round(game.roundEndsAt - at));
  }

  function pickWinner(at = clock()) {
    const times = allTimes(at);
    const ids = presentIds().filter((id) => id in times || true);
    if (!ids.length) return null;
    ids.sort((a, b) => {
      const d = (times[a] || 0) - (times[b] || 0);
      return d !== 0 ? d : a.localeCompare(b);
    });
    return ids[0];
  }

  function scoreboardOf(at = clock()) {
    const times = allTimes(at);
    return presentIds()
      .map((id) => ({ id, ms: Math.round(times[id] || 0) }))
      .sort((a, b) => (a.ms - b.ms) || a.id.localeCompare(b.id));
  }

  function pickRandomIt(avoid = null) {
    const ids = presentIds();
    if (!ids.length) return myId();
    const pool = avoid && ids.length > 1 ? ids.filter((id) => id !== avoid) : ids;
    return pool[Math.floor(Math.random() * pool.length)] || ids[0];
  }

  function getStatePayload() {
    return {
      it: game.it,
      since: game.since,
      immuneUntil: game.immuneUntil,
      immuneFrom: game.immuneFrom,
      timeAsIt: { ...game.timeAsIt },
      seq: game.seq,
      round: game.round,
      roundMs: game.roundMs,
      roundEndsAt: game.roundEndsAt,
      phase: game.phase,
      winner: game.winner,
      resultsUntil: game.resultsUntil,
      scoreboard: game.scoreboard.map((r) => ({ id: r.id, ms: r.ms })),
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
      round: game.round,
      roundMs: game.roundMs,
      roundEndsAt: game.roundEndsAt,
      phase: game.phase,
      winner: game.winner,
      resultsUntil: game.resultsUntil,
      scoreboard: game.scoreboard.map((r) => ({ id: r.id, ms: r.ms })),
      remainingMs: remainingMs(at),
    };
  }

  function applyState(s) {
    if (!s || typeof s !== 'object') return false;
    const seq = Number(s.seq) || 0;
    if (seq < game.seq) return false;
    if (seq === game.seq && game.it !== null && s.it === game.it
      && (s.phase || 'play') === game.phase
      && Number(s.roundEndsAt) === game.roundEndsAt
      && (s.winner || null) === game.winner) return false;
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
    if (Number.isFinite(s.round)) game.round = Math.max(0, Math.round(s.round));
    if (Number.isFinite(s.roundMs) && s.roundMs > 0) game.roundMs = Math.round(s.roundMs);
    if (Number.isFinite(s.roundEndsAt)) game.roundEndsAt = s.roundEndsAt;
    if (s.phase === 'results' || s.phase === 'play') game.phase = s.phase;
    game.winner = typeof s.winner === 'string' && s.winner ? s.winner : null;
    if (Number.isFinite(s.resultsUntil)) game.resultsUntil = s.resultsUntil;
    if (Array.isArray(s.scoreboard)) {
      game.scoreboard = s.scoreboard
        .filter((r) => r && typeof r.id === 'string')
        .map((r) => ({ id: r.id, ms: Math.round(Number(r.ms) || 0) }));
    }
    sentTouchKey = '';
    sendAck();
    if (onChange) { try { onChange(snapshot()); } catch { /* ignore */ } }
    return true;
  }

  function broadcastState(next) {
    // Apply on this screen immediately, then one tag:state action to the room (not a
    // second _s resend — that added another wait on the state tick / relay path).
    applyState(next);
    // Peers apply the same `_a` in this send; don't wait for their tag:ack echo before
    // treating the handoff as shown on both sides (ack still arrives and confirms).
    if (next?.it != null && Number.isFinite(next.seq)) {
      for (const id of peersMap().keys()) peerAck.set(id, { it: next.it, seq: next.seq });
    }
    if (commitAction) commitAction(next);
  }

  function endRound(at = clock()) {
    if (!isHost() || game.phase === 'results') return false;
    bankTime(at);
    const board = scoreboardOf(at);
    const winner = board[0]?.id || pickWinner(at);
    const frozen = {};
    for (const row of board) frozen[row.id] = row.ms;
    broadcastState({
      it: game.it,
      since: at,
      immuneUntil: game.immuneUntil,
      immuneFrom: game.immuneFrom,
      timeAsIt: frozen,
      seq: game.seq + 1,
      round: game.round,
      roundMs: game.roundMs,
      roundEndsAt: game.roundEndsAt,
      phase: 'results',
      winner,
      resultsUntil: at + resultsMs,
      scoreboard: board,
    });
    return true;
  }

  function startRound(at = clock(), opts = {}) {
    if (!isHost()) return false;
    const ms = Number.isFinite(opts.roundMs) && opts.roundMs > 0 ? Math.round(opts.roundMs) : game.roundMs;
    game.roundMs = ms;
    roundMs = ms;
    const pick = opts.it || pickRandomIt(opts.avoid || null);
    if (!pick) return false;
    const nextRound = (game.round || 0) + 1;
    broadcastState({
      it: pick,
      since: at,
      immuneUntil: 0,
      immuneFrom: null,
      timeAsIt: Object.fromEntries(presentIds().map((id) => [id, 0])),
      seq: game.seq + 1,
      round: nextRound,
      roundMs: ms,
      roundEndsAt: at + ms,
      phase: 'play',
      winner: null,
      resultsUntil: 0,
      scoreboard: [],
    });
    return true;
  }

  function ensureIt() {
    if (!isHost()) return;
    const me = myId();
    if (!me) return;
    const at = clock();
    if (game.phase === 'results') return;
    if (!game.round) {
      startRound(at);
      return;
    }
    if (game.it && isPresent(game.it)) return;
    bankTime(at);
    const candidates = presentIds();
    const pick = candidates[0] || me;
    game.timeAsIt[pick] = game.timeAsIt[pick] || 0;
    broadcastState({
      ...getStatePayload(),
      it: pick,
      since: at,
      immuneUntil: 0,
      immuneFrom: null,
      timeAsIt: { ...game.timeAsIt },
      seq: game.seq + 1,
    });
  }

  function tickRound() {
    if (!isHost() || !currentRoom) return;
    const at = clock();
    if (!game.round) {
      ensureIt();
      return;
    }
    if (game.phase === 'play' && game.roundEndsAt > 0 && at >= game.roundEndsAt) {
      endRound(at);
      return;
    }
    if (game.phase === 'results' && game.resultsUntil > 0 && at >= game.resultsUntil) {
      startRound(at);
    }
  }

  function tryTag(fromId, toId) {
    if (!isHost()) return false;
    if (game.phase === 'results') return false;
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
      round: game.round,
      roundMs: game.roundMs,
      roundEndsAt: game.roundEndsAt,
      phase: game.phase,
      winner: null,
      resultsUntil: 0,
      scoreboard: [],
    });
    return true;
  }

  function checkTouch() {
    const me = myId();
    if (!currentRoom || !me) return;
    if (localPos.known) positions.set(me, { x: localPos.x, y: localPos.y });
    tickRound();
    if (game.phase === 'results') return;
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

    // Non-host: if I am It and touch a peer, or if It touches me, show the handoff here at once
    // (don't wait for the host's tag:state echo), then ask the host to commit in one action.
    if (!touchAction) return;
    let targetId = null;
    if (game.it === me) {
      for (const id of presentIds()) {
        if (id === me) continue;
        const p = positions.get(id);
        if (p && Math.hypot(itPos.x - p.x, itPos.y - p.y) <= radius) { targetId = id; break; }
      }
    } else {
      const myP = positions.get(me);
      if (myP && Math.hypot(itPos.x - myP.x, itPos.y - myP.y) <= radius) targetId = me;
    }
    if (!targetId) return;
    const fromId = game.it;
    const key = `${game.seq}:${fromId}->${targetId}`;
    if (sentTouchKey === key && at - sentTouchAt < 150) return;
    bankTime(at);
    game.timeAsIt[targetId] = game.timeAsIt[targetId] || 0;
    const preSeq = game.seq;
    applyState({
      it: targetId,
      since: at,
      immuneUntil: at + immuneMs,
      immuneFrom: fromId,
      timeAsIt: { ...game.timeAsIt },
      seq: preSeq + 1,
      round: game.round,
      roundMs: game.roundMs,
      roundEndsAt: game.roundEndsAt,
      phase: game.phase,
      winner: null,
      resultsUntil: 0,
      scoreboard: [],
    });
    // applyState clears sentTouchKey; re-arm so we don't spam touch while the host commits.
    sentTouchKey = key;
    sentTouchAt = at;
    const myP = positions.get(me);
    touchAction({ from: fromId, to: targetId, seq: preSeq, by: me, x: myP?.x, y: myP?.y });
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
    game.round = 0;
    game.roundMs = roundMs;
    game.roundEndsAt = 0;
    game.phase = 'play';
    game.winner = null;
    game.resultsUntil = 0;
    game.scoreboard = [];
    positions.clear();
    extras.clear();
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
      // Host commits with one tag:state action. If the touch is rejected and the caller still
      // thinks they handed off (optimistic seq), push the host's truth so they roll back.
      if (tryTag(data.from, data.to)) return;
      if (game.it && data.to && data.to !== game.it && Number(data.seq) === game.seq) {
        broadcastState({ ...getStatePayload(), seq: game.seq + 1 });
      }
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
    get ROUND_MS() { return game.roundMs; },
    RESULTS_MS: resultsMs,
    get it() { return game.it; },
    get since() { return game.since; },
    get immuneUntil() { return game.immuneUntil; },
    get immuneFrom() { return game.immuneFrom; },
    get seq() { return game.seq; },
    get round() { return game.round; },
    get phase() { return game.phase; },
    get winner() { return game.winner; },
    get roundEndsAt() { return game.roundEndsAt; },
    get resultsUntil() { return game.resultsUntil; },
    get scoreboard() { return game.scoreboard.map((r) => ({ id: r.id, ms: r.ms })); },
    isIt: (id = myId()) => Boolean(id && game.it === id),
    isImmune: (at = clock()) => Boolean(game.it && at < game.immuneUntil),
    timeMs: (id = myId(), at = clock()) => timeMs(id, at),
    remainingMs: (at = clock()) => remainingMs(at),
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
    // Host (or any peer calling into the host path) advances round phase off the page's pose/tick loop — no timers in this module.
    tick() { tickRound(); },
    // Named setup: start a fresh round of `ms` (e.g. ?round=8 → 8000). Host only.
    beginRound(ms) {
      if (!isHost()) return false;
      const at = clock();
      return startRound(at, { roundMs: Number.isFinite(ms) && ms > 0 ? ms : game.roundMs });
    },
    setRoundMs(ms) {
      if (!(Number.isFinite(ms) && ms > 0)) return;
      roundMs = Math.round(ms);
      game.roundMs = roundMs;
    },
    snapshot: (at = clock()) => snapshot(at),
    // Host-local extras (filler bots): same Tag rules, not real peers. Positions feed touch checks.
    setExtra(id, x, y) {
      if (!id || !Number.isFinite(x) || !Number.isFinite(y)) return;
      extras.set(id, { x, y });
      positions.set(id, { x, y });
      checkTouch();
    },
    removeExtra(id) {
      if (!id || !extras.has(id)) return;
      extras.delete(id);
      positions.delete(id);
      if (isHost()) ensureIt();
    },
    clearExtras() {
      for (const id of extras.keys()) positions.delete(id);
      extras.clear();
      if (isHost()) ensureIt();
    },
    hasExtra: (id) => extras.has(id),
    extraIds: () => [...extras.keys()],
  };

  return api;
}

export default createTag;

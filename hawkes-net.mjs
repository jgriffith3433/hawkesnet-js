// Hawkes Net: multiplayer for web games (docs/net.md). One call joins a room; Hawkes Net carries it peer to peer
// (WebRTC, one host forwarding for everyone) while the room is small, and on a Hawkes relay when it grows, when the
// host leaves or when players can't link, without the game noticing.
//
//   import { join } from './hawkes-net.mjs';
//   const net = await join('lobby', { project: 'mygame', name: 'Ada' });     // a ticket from Gen (or pass your own)
//   net.on('chat', (text, from) => show(from.name, text));
//   net.send('chat', 'hello');                                              // reliable: once, in order
//   net.pose([x, y, z], yaw);                                                // your avatar, ~15 a second
//   net.onPose((peer, state) => moveAvatar(peer, state.p, state.y));
//   net.sync.push('crate-3', [x, y, z, rx, ry, rz, vx, vy, vz]);              // things you simulate
//   net.sync.onThing((id, at, values, from) => tracks.get(id).push(at, values, from));
//
// Needs hawkes-net-core.mjs next to it. Works in browsers and in Node 24 (bots: transport 'relay', or 'p2p' with an
// RTCPeerConnection passed as `rtc`). No module-wide singleton: a page can join several rooms or run bot peers.
import * as core from './hawkes-net-core.mjs';

export const VERSION = core.VERSION;
export const protocols = Object.freeze([3]);
export const Track = core.Track;
export const Links = core.Links;
/** The Hawkes Net service a join uses when it names none: https://net.hawkesgen.ai, or the one the page names in
 *  globalThis.HAWKES_NET_ENDPOINT (an origin, e.g. https://hawkesnet.hawkesgen.ai: Hawkes Studio sets it on its beta
 *  sites, so a game's beta plays on beta Hawkes Net and its live site on the real one, with no change to the game). */
export function defaultEndpoint() {
  const asked = typeof globalThis !== 'undefined' ? globalThis.HAWKES_NET_ENDPOINT : undefined;
  return typeof asked === 'string' && /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(asked) ? asked : 'https://net.hawkesgen.ai';
}
const DEFAULT_ICE = [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
const PING_MS = 5000;
const SEND_MS = 33;
const LINK_WAIT_MS = 8000;
const SLEEP_GRACE_MS = 15_000;
/** After a move to the relay, how long a player missing from the new list has to arrive before they count as gone. */
const MOVE_GRACE_MS = 5000;
const RELIABLE_KEEP = 2000;
const SLOW_BUDGET = 6 * 1024;
const IMPORTANT = 1 << 12;

const now = () => Date.now();
const wall = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const isNode = typeof window === 'undefined';
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => { const t = atob(s); const u = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) u[i] = t.charCodeAt(i); return u; };
const rid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Math.random()}${Math.random()}`).replace(/[^a-z0-9]/gi, '').slice(0, 24);
function stableSub() {
  try {
    const k = 'hawkesNet.sub';
    let v = localStorage.getItem(k);
    if (!v) { v = rid(); localStorage.setItem(k, v); }
    return v;
  } catch { return rid(); }
}
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;

// ================================================================ the background clock (docs/net.md "In the background")
// A hidden tab, a minimised window or a window covered by another gets no animation frames, and its timers slow to once
// a second (once a minute after five minutes). So the SDK's own upkeep, sending and a p2p host's bundling run on a
// worker's timer, which browsers don't slow: a page in the background keeps its room as it was. Where there is no
// Worker (Node, a strict content policy) it falls back to ordinary timers.
const CLOCK_MS = 8;
const AWAY_AFTER_MS = 2000;
const hasPage = !isNode && typeof document !== 'undefined';
const clock = { jobs: new Set(), worker: null, timer: null };
let frameAt = 0;
let watchingFrames = false;
function watchFrames() {
  if (watchingFrames || !hasPage || typeof requestAnimationFrame !== 'function') return;
  watchingFrames = true;
  frameAt = wall();
  const f = () => { frameAt = wall(); requestAnimationFrame(f); };
  requestAnimationFrame(f);
}
function clockTick() {
  const t = wall();
  for (const j of [...clock.jobs]) {
    if (t < j.due) continue;
    // On the beat (a tick a little late is made up on the next ones); a page that was asleep starts over, no burst.
    j.due += j.ms;
    if (t - j.due > 250) j.due = t + j.ms;
    try { j.fn(); } catch (e) { console.error('[hawkes-net] background clock:', e); }
  }
}
function startClock() {
  if (clock.worker || clock.timer) return;
  if (hasPage && typeof Worker === 'function' && typeof Blob === 'function' && typeof URL !== 'undefined' && URL.createObjectURL) {
    try {
      const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${CLOCK_MS});`], { type: 'text/javascript' }));
      clock.worker = new Worker(url);
      URL.revokeObjectURL(url);
      clock.worker.onmessage = clockTick;
      return;
    } catch { clock.worker = null; }
  }
  clock.timer = setInterval(clockTick, CLOCK_MS);
}
function stopClock() {
  if (clock.jobs.size) return;
  if (clock.worker) { clock.worker.terminate(); clock.worker = null; }
  if (clock.timer) { clearInterval(clock.timer); clock.timer = null; }
}
/** fn every `ms` on the background clock. Returns stop(). */
function every(ms, fn) {
  const job = { ms, fn, due: wall() + ms };
  clock.jobs.add(job);
  startClock();
  return () => { clock.jobs.delete(job); stopClock(); };
}
/** True while this page is in the background: hidden, or no animation frame for `ms` (a window covered by another). */
export function inBackground(ms = 1000) {
  if (!hasPage) return false;
  watchFrames();
  return Boolean(document.hidden) || wall() - frameAt > ms;
}
/**
 * Keeps a game going while its page is in the background (docs/net.md "In the background"): fn() about `hz` times a
 * second (default 60), only while the page gets no animation frames (a hidden tab, a minimised or covered window), so
 * a rollback fight, a turn timer or a host's simulation doesn't stop for the other players. Run your game's step in it,
 * not its drawing. o: { hz, afterMs (no frames for this long first, default 100) }. Returns stop().
 */
export function background(fn, o = {}) {
  watchFrames();
  const after = Number.isFinite(o.afterMs) ? o.afterMs : 100;
  const ms = Math.max(CLOCK_MS, Math.round(1000 / (o.hz || 60)));
  return every(ms, () => { if (!hasPage || wall() - frameAt > after) fn(); });
}

class Emitter {
  constructor() { this.h = new Map(); }
  on(k, f) { let s = this.h.get(k); if (!s) this.h.set(k, (s = new Set())); s.add(f); return () => s.delete(f); }
  emit(k, ...a) { for (const f of [...(this.h.get(k) || [])]) { try { f(...a); } catch (e) { console.error(`[hawkes-net] handler for "${k}":`, e); } } }
}

/**
 * Joins a room. Resolves when the room's state has arrived (`ready`), rejects when the join is refused.
 * o: { project, transport: 'relay' (default) | 'auto' | 'p2p', ticket (a string, or a function returning Gen's ticket answer),
 *      endpoint (the Hawkes Net service, default defaultEndpoint(): https://net.hawkesgen.ai or the page's HAWKES_NET_ENDPOINT), key (a Gen API key: servers and bots only), name, sub, role,
 *      config (the room's shape if this join creates it), leaveOnHide (default true), away (default true: tell the room
 *      when this page is in the background, docs/net.md "Away"), rtc ({ RTCPeerConnection } in Node),
 *      WebSocket (a WebSocket class, default the global one), log (false to silence),
 *      onRaw (an engine with its own multiplayer logic: every room message in the core's shapes, see `raw` below) }
 */
export async function join(room, o = {}) {
  const r = new Room(room, o);
  await r._start();
  return r;
}

class Room {
  constructor(room, o) {
    if (!o.project && !o.ticket) throw new Error('hawkes-net: join(room, { project }) (or a ticket)');
    this.room = room;
    this.project = o.project || '';
    // The relay by default: peer to peer ('auto') only where the game asks and its project allows it.
    this.o = { transport: 'relay', endpoint: defaultEndpoint(), leaveOnHide: true, role: 'player', ...o };
    this.ev = new Emitter();
    this.msgs = new Emitter();
    this.id = null; this.ord = 0; this.host = null; this.status = 'connecting'; this.transport = 'p2p'; this.config = null; this.name = null; this.color = null;
    this.peers = new Map();
    this.owners = new Map(); this.locks = new Map();
    this.offset = 0; this.offsetTarget = null; this.offsets = []; this.rtt = null;
    this.links = new core.Links(() => this.now());
    this.seq = 0; this.sentRel = []; // reliable messages sent, kept a while for a resend after a reconnect or a move
    this.seenFrom = new Map(); // peer -> highest reliable seq applied (exactly once)
    this.q = { rel: [], me: null, xf: new Map(), unrel: new Map(), ping: 0, rawXf: [] };
    this.onRaw = typeof o.onRaw === 'function' ? o.onRaw : null;
    this.things = new Map(); // id -> the newest 12 values (deltas applied)
    this.pushed = new Map(); // id -> what I last sent of a thing
    this.states = new Map(); this.actions = new Map(); this.hostHandlers = new Set();
    this.st = { up: 0, down: 0, upMsgs: 0, downMsgs: 0, migrations: 0, linkRetries: 0, reconnects: 0, expressUp: 0, expressDown: 0, since: wall() };
    this.ws = null; this.wsCodec = null; this.resume = null; this.relayUrl = null; this.ice = DEFAULT_ICE;
    this.p2p = null;
    this.closed = false; this.lastBeat = wall(); this.sleptUntil = 0; this.retry = 0; this.pingAt = 0;
    this.timers = []; // stop() functions of background clock jobs
    this.away = false; this._hiddenSince = 0; this._autoAway = false;
    this.sub = o.sub || stableSub();
  }

  // ================================================================ the public API
  get isHost() { return this.host !== null && this.host === this.id; }
  /** Players whose page is in the background right now (their `away` is true; event 'peer:away'). */
  get awayPeers() { return [...this.peers.values()].filter((p) => p.away); }
  /** Says this player is away (or back) now: for bots, tests, and engines that know better than the page (a game
   *  paused in its own menu). In a browser the page's own state takes over again the next time it changes. */
  setAway(on) { if (!this.closed && Boolean(on) !== this.away) this._setAway(Boolean(on)); }
  /** The shared clock (ms): the room node's. It never jumps: a correction is eased in. */
  now() { return now() + this.offset; }
  /** Sends a message to the room. `kind` is the game's name for it; `data` is JSON-able (or Uint8Array).
   *  opt: { reliable (default true: once, in order), to (one peer), self (me too, in order), key (unreliable: the newest wins) } */
  send(kind, data = null, opt = {}) {
    const m = { t: 'ev', name: String(kind).slice(0, 64), data };
    if (opt.to) m.to = opt.to;
    if (opt.self) m.self = true;
    if (opt.reliable !== false) {
      m.seq = ++this.seq;
      this.sentRel.push({ m, at: wall() });
      if (this.sentRel.length > RELIABLE_KEEP) this.sentRel.shift();
      this.q.rel.push(m);
    } else this.q.unrel.set(opt.key || m.name, m);
  }
  /** fn(data, from, meta) for messages of a kind ('*' for every kind). Returns off(). */
  on(kind, fn) { return this.msgs.on(kind, fn); }
  /**
   * The game's own bytes, now (docs/net.md "Express"): for what can't wait for the next send (a fighting game's inputs).
   * Sent the moment it's called, forwarded by the relay or the host the moment it arrives, never queued or sent again;
   * between peers on an unordered, no-retransmit channel. May be lost or come out of order: carry your own frame numbers
   * (and repeat what wasn't acknowledged). bytes: a Uint8Array (or any ArrayBuffer view), at most 1200 bytes. opt: { to }.
   * Returns false when there is no way out right now.
   */
  express(bytes, opt = {}) {
    if (this.closed) return false;
    const payload = bytes instanceof Uint8Array ? bytes : ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null;
    if (!payload) throw new TypeError('hawkes-net: express(bytes): a Uint8Array');
    if (payload.length > core.EXPRESS_MAX) throw new RangeError(`hawkes-net: express is at most ${core.EXPRESS_MAX} bytes`);
    const f = core.expressFrame(payload, opt.to ? { to: opt.to } : {});
    this.st.up += f.length; this.st.upMsgs++; this.st.expressUp++;
    if (this.transport === 'relay') {
      if (!this.ws || this.ws.readyState !== 1) return false;
      this.ws.send(f);
      return true;
    }
    const p = this.p2p;
    if (!p) return false;
    if (p.hostRoom) { core.receive(p.hostRoom, p.self, f, this.now()); return true; }
    if (p.chX && p.chX.readyState === 'open') { try { p.chX.send(f); return true; } catch {} }
    if (p.carrier === 'channel') { if (p.channel && p.channel.readyState === 'open') { p.channel.send(f); return true; } return false; }
    this._control({ c: 'sig', to: p.host, kind: 'data', body: b64(f) });
    return true;
  }
  /** fn(bytes: Uint8Array, from: peer id) for every express from another player. Returns off(). */
  onExpress(fn) { return this.ev.on('express', fn); }
  _expressIn(u8) {
    const x = core.readExpress(u8);
    if (!x || !x.from || x.from === this.id) return;
    this.st.expressDown++;
    this.ev.emit('express', x.payload, x.from);
  }
  /** Connection events: status, ready, peer:join, peer:leave, peer:away ({ peer, away }), away ({ away }: this page),
   *  host ({ host, previous, reason: 'first' | 'host left' | 'host away' }), transport, problem. Returns off(). */
  when(event, fn) { return this.ev.on(event, fn); }
  /** My avatar: a position, a heading and any small extra values (flags, what I hold). The newest goes each send. */
  pose(p, yaw = 0, extra = null) { this.q.me = { t: 'me', at: this.now(), s: { ...(extra || {}), p: [r3(p[0]), r3(p[1]), r3(p[2])], y: r2(yaw) } }; }
  /** Other players' avatars: fn(peerId, state { p, y, ...extra }, at). Returns off(). */
  onPose(fn) { return this.ev.on('pose', fn); }
  /** State sync, ownership and snapshot buffers (the portal's H.sync). */
  get sync() { return this._sync || (this._sync = this._makeSync()); }
  /**
   * For an engine with its own multiplayer logic (hawkesgen.ai's play/net.js): it gets every room message through
   * `onRaw` (join option) in the core's shapes ({ t: 'hello' | 'join' | 'leave' | 'host' | 'me' | 'xf' | 'own' | 'ops' | 'ev' | 'clear' }),
   * and sends its own here: { t: 'me', at, s }, { t: 'xf', at, x: [[id, mask, ...values]] }, { t: 'own', id, on, lock },
   * { t: 'ev', name, data, self?, to?, reliable? }, { t: 'clear' }. Hawkes Net still does the rest: the transport, moving the
   * room, reconnecting, exactly-once reliable messages and the clock.
   */
  get raw() {
    return {
      send: (m) => {
        if (!m || typeof m !== 'object') return;
        switch (m.t) {
          case 'ev': return this.send(m.name, m.data ?? null, { reliable: m.reliable !== false, self: Boolean(m.self), to: m.to, key: m.key });
          case 'me': this.q.me = m; return;
          case 'xf': if (Array.isArray(m.x) && m.x.length) this.q.rawXf.push({ t: 'xf', at: Number.isFinite(m.at) ? m.at : this.now(), x: m.x }); return;
          case 'own': case 'clear': this.q.rel.push(m); return;
          default: return; // pings and hellos are Hawkes Net's own
        }
      },
    };
  }
  _raw(m) { if (this.onRaw) { try { this.onRaw(m); } catch (e) { console.error('[hawkes-net] onRaw:', e); } } }
  stats() {
    return { transport: this.transport, protocol: 3, seconds: (wall() - this.st.since) / 1000, upBytes: this.st.up, downBytes: this.st.down, upMsgs: this.st.upMsgs, downMsgs: this.st.downMsgs, expressUp: this.st.expressUp, expressDown: this.st.expressDown, rttMs: this.rtt, clockOffsetMs: Math.round(this.offset), migrations: this.st.migrations, linkRetries: this.st.linkRetries, reconnects: this.st.reconnects };
  }
  /** Asks to move the room to the relay (a game that knows it will grow). */
  migrate(why = 'game asked') { this._control({ c: 'migrate', step: 'propose', why }); }
  async leave(reason = 'left') {
    if (this.closed) return;
    this._flush();
    this.closed = true;
    try { this._control({ c: 'bye', why: reason }); } catch {}
    this._teardownP2p();
    for (const stop of this.timers) stop();
    if (this._vis && typeof removeEventListener === 'function') removeEventListener('visibilitychange', this._vis);
    if (this.arriving) { for (const t of this.arriving.values()) clearTimeout(t); this.arriving.clear(); }
    if (this._hide && typeof removeEventListener === 'function') removeEventListener('pagehide', this._hide);
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onclose = null; ws.onmessage = null; setTimeout(() => { try { ws.close(1000, reason); } catch {} }, 30); }
    this._status('closed');
  }

  // ================================================================ joining and reconnecting
  async _start() {
    const ready = new Promise((res, rej) => { this._ready = res; this._refused = rej; });
    ready.catch(() => {});
    const t = await this._ticket();
    this._useTicket(t);
    this._connect(`t=${encodeURIComponent(t.ticket)}&want=${this.o.transport}`);
    this.timers.push(every(1000, () => this._tick()));
    this.timers.push(every(SEND_MS, () => this._flush()));
    if (!isNode && this.o.leaveOnHide && typeof addEventListener === 'function') {
      this._hide = (e) => { if (!e.persisted) void this.leave('left'); };
      addEventListener('pagehide', this._hide);
      for (const name of ['visibilitychange', 'pageshow', 'online']) addEventListener(name, () => this._wake());
    }
    if (hasPage && this.o.away !== false && typeof addEventListener === 'function') {
      watchFrames();
      // Back at once (the timer would be a second late); away is decided in the upkeep, after AWAY_AFTER_MS.
      this._vis = () => this._checkAway();
      addEventListener('visibilitychange', this._vis);
    }
    const timeout = setTimeout(() => this._refused(new Error('hawkes-net: the room did not answer in 20 s')), 20_000);
    try { await ready; } catch (e) { void this.leave('refused'); throw e; } finally { clearTimeout(timeout); }
  }
  async _ticket() {
    const o = this.o;
    if (typeof o.ticket === 'string') return { ticket: o.ticket, relayUrl: o.url || null };
    if (typeof o.ticket === 'function') return o.ticket();
    const headers = { 'Content-Type': 'application/json', 'X-Hawkes-Client': `net/${VERSION}` };
    if (o.key) headers.Authorization = `Bearer ${o.key}`;
    const body = { project: this.project, room: this.room, role: o.role, name: o.name, sub: this.sub, transport: o.transport, config: o.config, client: { sdk: VERSION, protocols: [3] } };
    const r = await fetch(`${String(o.endpoint).replace(/\/+$/, '')}/v1/net/ticket`, { method: 'POST', headers, body: JSON.stringify(body), credentials: 'omit' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(`hawkes-net: ticket refused (${r.status}): ${j.error || 'no reason'}`);
      e.status = r.status;
      this._problem(r.status === 429 ? 'capped' : r.status === 426 ? 'reload' : 'ticket', j.error || String(r.status));
      throw e;
    }
    return j;
  }
  _useTicket(t) {
    this.relayUrl = t.relayUrl || t.signalUrl;
    if (!this.relayUrl) throw new Error('hawkes-net: the ticket names no node (pass `url` with a ticket string)');
    if (Array.isArray(t.ice) && t.ice.length) this.ice = t.ice;
    if (t.config) this.config = t.config;
  }
  _connect(query) {
    const WS = this.o.WebSocket || globalThis.WebSocket;
    const url = `${this.relayUrl}${this.relayUrl.includes('?') ? '&' : '?'}${query}`;
    let ws;
    try { ws = new WS(url, ['hawkes-net.v3']); } catch (e) { return this._lost(0, String(e?.message || e)); }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.wsCodec = { in: new core.Codec(), out: new core.Codec() };
    ws.onmessage = (e) => { if (this.ws === ws) this._fromSocket(e.data); };
    ws.onclose = (e) => { if (this.ws === ws) { this.ws = null; this._lost(e.code, e.reason); } };
    ws.onerror = () => {};
  }
  /** The socket closed under us: come back with the resume token, else with a new ticket (a new place in the room). */
  _lost(code, reason) {
    if (this.closed) return;
    if (code === 4009) { this._problem('full', reason || 'room full'); this._refused?.(Object.assign(new Error('hawkes-net: the room is full'), { code })); return void this.leave('full'); }
    if (code === 4003) { this._problem('refused', 'removed from the room'); return void this.leave('kicked'); }
    if (!this._wasReady) {
      if (this.retry++ < 2) return void setTimeout(() => void this._rejoin(), 600);
      this._problem('refused', reason || `closed ${code}`);
      this._refused?.(Object.assign(new Error(`hawkes-net: could not join (${code}${reason ? ` ${reason}` : ''})`), { code }));
      return;
    }
    this._status('reconnecting');
    this.st.reconnects++;
    this._teardownP2p();
    const wait = Math.min(15_000, 500 * 2 ** Math.min(5, this.retry++));
    setTimeout(() => {
      if (this.closed || this.ws) return;
      if (this.resume && this.retry <= 4) this._connect(`r=${encodeURIComponent(this.resume)}`);
      else void this._rejoin();
    }, wait);
  }
  async _rejoin() {
    if (this.closed) return;
    try {
      const t = await this._ticket();
      this._useTicket(t);
      this.resume = null;
      this._connect(`t=${encodeURIComponent(t.ticket)}&want=${this.o.transport}`);
    } catch (e) {
      if (!this._wasReady) return this._refused?.(e);
      // A real no (the game's server or Gen refused this player: removed, closed, expired): stop, don't ask forever.
      const st = Number(e?.status) || 0;
      if (st >= 400 && st < 500 && st !== 408 && st !== 429) { this._problem('refused', e?.message || String(st)); return void this.leave('refused'); }
      setTimeout(() => void this._rejoin(), 5000);
    }
  }

  // ================================================================ the socket: relay bundles, hellos, control
  _fromSocket(data) {
    if (typeof data === 'string') return;
    const u8 = new Uint8Array(data);
    this.st.down += u8.length; this.st.downMsgs++;
    if (u8[0] === core.FRAME.express) return this._expressIn(u8);
    const p = core.peek(u8);
    if (p.kind === 'bundle') {
      if (this.transport !== 'relay') return;
      let msgs;
      try { msgs = this.wsCodec.in.read(u8, true).msgs; } catch (e) { console.error('[hawkes-net] bad bundle from the relay:', e); return; }
      for (const m of msgs) this._fromRoom(m);
      return;
    }
    if (p.kind === 'hello') return this._hello(p.value);
    if (p.kind === 'control') return this._controlIn(p.value);
  }

  _hello(h) {
    this.retry = 0;
    if (h.resume) this.resume = h.resume;
    if (h.cfg) this.config = h.cfg;
    const resumed = Boolean(h.resumed);
    if (h.mode === 'relay') {
      const was = this.transport;
      this.transport = 'relay';
      if (h.migrated) {
        this._movedAt = wall();
        // Moved to the relay on the same socket: a new stream both ways (fresh dictionaries and baselines).
        this.wsCodec = { in: new core.Codec(), out: new core.Codec() };
        this._teardownP2p();
        if (this._wasReady && was === 'p2p') { this.st.migrations++; this.ev.emit('transport', { from: 'p2p', to: 'relay', why: h.why || 'room grew' }); }
      }
      this._worldHello(h);
      this._resendAfter(h.lastSeq);
      this._ping();
      this._readyNow(resumed);
      return;
    }
    // p2p: the socket is the signal route; the world comes from the host (or, if I host, from the room in this page).
    this.transport = 'p2p';
    this.id = h.you; this.name = h.name; this.color = h.color;
    this.ord = (h.peers || []).find((pr) => pr.c === h.you)?.ord ?? this.ord;
    if (typeof h.now === 'number' && !this.offsets.length) this._setOffset(h.now - now(), true);
    this._syncPeers(h.peers || []);
    this._ping();
    this._p2pHost(h.host, null, true);
  }
  /** A hello from a room (the relay, or the p2p host): who is here, who hosts, who owns what. */
  _worldHello(h) {
    this.id = h.you; this.name = h.name; this.color = h.color;
    this.ord = (h.peers || []).find((pr) => pr.c === h.you)?.ord ?? this.ord;
    const prevHost = this.host;
    this.host = h.host;
    this.owners.clear(); this.locks.clear();
    for (const [k, v] of Object.entries(h.owners || {})) this.owners.set(k, v);
    for (const [k, v] of Object.entries(h.locks || {})) this.locks.set(k, v);
    if (typeof h.now === 'number' && !this.offsets.length) this._setOffset(h.now - now(), true);
    if (this.transport === 'relay') this._syncPeers(h.peers || []);
    else for (const pr of h.peers || []) this._addPeer(pr);
    // The room has nothing of mine on a new stream: my things and states go again.
    this.pushed.clear();
    for (const st of this.states.values()) st.sent = null;
    if (prevHost !== this.host) this._hostChanged(this.host, prevHost, prevHost ? 'host left' : 'first');
  }
  _syncPeers(list) {
    const ids = new Set(list.map((pr) => pr.c));
    for (const id of [...this.peers.keys()]) {
      if (ids.has(id)) continue;
      // Just moved to the relay: everyone comes over on their own socket, so a player not here yet gets a moment to
      // arrive (their join clears it) before they count as gone. Without it, a pair room's two players each saw the
      // other leave the moment the room moved.
      if (this._movedAt && wall() - this._movedAt < MOVE_GRACE_MS) { this._awaitPeer(id); continue; }
      this._dropPeer(id, 'lost');
    }
    for (const pr of list) this._addPeer(pr);
  }
  _awaitPeer(id) {
    if (!this.arriving) this.arriving = new Map();
    if (this.arriving.has(id)) return;
    this.arriving.set(id, setTimeout(() => { this.arriving.delete(id); this._dropPeer(id, 'lost'); }, MOVE_GRACE_MS));
  }
  /** Reliable messages the room may not have had: everything after the last it saw from me (a reconnect, a move). */
  _resendAfter(lastSeq) {
    const last = Number(lastSeq) || 0;
    const queued = new Set(this.q.rel);
    const again = this.sentRel.filter((x) => x.m.seq > last && !queued.has(x.m)).map((x) => x.m);
    if (again.length) this.q.rel = [...again, ...this.q.rel.filter((m) => !m.seq || m.seq > last)].sort((a, b) => (a.seq || Infinity) - (b.seq || Infinity));
  }
  _readyNow(resumed) {
    this._status('online');
    // An engine on raw messages starts over from this: who is here, who hosts, who owns what.
    if (this.onRaw) this._raw({ t: 'hello', you: this.id, name: this.name, color: this.color, host: this.host, peers: [...this.peers.values()].map((p) => ({ c: p.id, name: p.name, color: p.color, ord: p.ord, away: p.away })), owners: Object.fromEntries(this.owners), locks: Object.fromEntries(this.locks), now: this.now(), transport: this.transport });
    const first = !this._wasReady;
    this._wasReady = true;
    if (first) this._ready?.();
    this.ev.emit('ready', { peers: [...this.peers.values()], host: this.host, resumed: resumed && !first });
  }

  _controlIn(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.c) {
      case 'pong': return this._pong(m.at, m.now);
      case 'peer': {
        if (m.ev === 'join') { this._addPeer(m.peer); if (this.p2p?.hostRoom) this._hostAddPeer(m.peer); }
        else if (m.ev === 'leave') { if (this.p2p?.hostRoom) this._hostDropPeer(m.peer.c); this._dropPeer(m.peer.c, m.why || 'left'); }
        return;
      }
      case 'host': if (this.transport === 'p2p') this._p2pHost(m.host, m.previous, false); return;
      case 'sig': return void this._sig(m);
      case 'migrate':
        // The node asks the host for its copy of the world: the relay takes over from it.
        if (m.step === 'seed' && this.p2p?.hostRoom) this._control({ c: 'seed', epoch: m.epoch, snap: core.snapshot(this.p2p.hostRoom) });
        return;
      case 'server':
        // A server's world edit or event in a p2p room: the host applies it to its room, which forwards it to everyone.
        if (this.p2p?.hostRoom) {
          if (Array.isArray(m.ops) && m.ops.length) core.ops(this.p2p.hostRoom, m.ops, m.by, m.fx, m.except || undefined);
          if (m.event) core.event(this.p2p.hostRoom, m.event.name, m.event.data);
        }
        return;
      case 'move': this.resume = null; return void this._rejoin();
    }
  }

  // ================================================================ messages from the room (the relay, or the host)
  _fromRoom(m) {
    // (Joins, leaves and host changes reach onRaw once, from _addPeer/_dropPeer/_hostChanged, whichever route told us.)
    if (this.onRaw && m.t !== 'hello' && m.t !== 'pong' && m.t !== 'join' && m.t !== 'leave' && m.t !== 'host') this._raw(m);
    switch (m.t) {
      case 'hello': this._worldHello(m); if (this.away) this.q.rel.push({ t: 'away', on: true }); this._readyNow(false); return;
      case 'pong': return this._pong(m.at, m.now);
      case 'join': this._addPeer(m); return;
      case 'leave': return this._dropPeer(m.c, m.why || 'left');
      case 'host': { const was = this.host; this.host = m.c; return this._hostChanged(m.c, was, this.peers.get(was)?.away || (was === this.id && this.away) ? 'host away' : 'host left'); }
      case 'away': {
        const pr = this.peers.get(m.c);
        if (!pr || pr.away === Boolean(m.on)) return;
        pr.away = Boolean(m.on);
        return this.ev.emit('peer:away', { peer: pr, away: pr.away });
      }
      case 'me': {
        const pr = this.peers.get(m.c);
        if (!pr) return;
        pr.seenAt = this.now();
        pr.pose = { ...(pr.pose || {}), ...m.s };
        return this.ev.emit('pose', m.c, pr.pose, m.at);
      }
      case 'xf': {
        for (const x of m.x || []) {
          const id = x[0];
          const o = this.owners.get(id);
          if (o ? o !== m.c : m.c !== this.host) continue; // only the one simulating it says where it is
          let v = this.things.get(id);
          if (!v) { v = new Array(12).fill(0); this.things.set(id, v); }
          let k = 2;
          for (let i = 0; i < 12; i++) if (x[1] & (1 << i)) v[i] = x[k++];
          this.ev.emit('thing', id, m.at, v, m.c, Boolean(x[1] & IMPORTANT), x[1]);
        }
        return;
      }
      case 'own': {
        if (m.c) this.owners.set(m.id, m.c); else this.owners.delete(m.id);
        if (m.c && m.lock) this.locks.set(m.id, m.c); else this.locks.delete(m.id);
        return this.ev.emit('own', m.id, m.c || null, Boolean(m.lock));
      }
      case 'ops': return this.ev.emit('ops', m.ops || [], { by: m.by, fx: m.fx, from: m.c });
      case 'clear': this.things.clear(); return this.ev.emit('clear');
      case 'ev': return this._deliver(m);
    }
  }
  _deliver(m) {
    if (m.seq && m.c) {
      const last = this.seenFrom.get(m.c) || 0;
      if (m.seq <= last) return; // had it (sent again after a reconnect or a move)
      this.seenFrom.set(m.c, m.seq);
    }
    const from = m.c ? (m.c === this.id ? this._me() : this.peers.get(m.c) || { id: m.c, name: null }) : null;
    if (m.name === '_s' || m.name === '_a' || m.name === '_ar') return this._onSync(m.name, m.data || {}, from);
    const meta = { at: this.now(), reliable: Boolean(m.seq), kind: m.name };
    this.msgs.emit(m.name, m.data, from, meta);
    this.msgs.emit('*', m.data, from, meta);
  }
  _me() { return { id: this.id, name: this.name, color: this.color, ord: this.ord, role: this.o.role, route: 'self', rttMs: 0, seenAt: this.now() }; }

  // ================================================================ peers and the host
  _addPeer(pr) {
    const id = pr.c ?? pr.id;
    if (!id || id === this.id) return;
    const wait = this.arriving?.get(id);
    if (wait) { clearTimeout(wait); this.arriving.delete(id); }
    const had = this.peers.get(id);
    if (had) {
      had.name = pr.name ?? had.name; had.ord = pr.ord ?? had.ord; if (this.transport === 'relay') had.route = 'relay';
      if (pr.away !== undefined && Boolean(pr.away) !== had.away) { had.away = Boolean(pr.away); this.ev.emit('peer:away', { peer: had, away: had.away }); }
      return;
    }
    const info = { id, name: pr.name ?? null, color: pr.color ?? null, ord: pr.ord ?? 0, role: pr.role || 'player', route: this.transport === 'relay' ? 'relay' : 'host', rttMs: null, seenAt: this.now(), pose: null, away: Boolean(pr.away) };
    this.peers.set(id, info);
    this.ev.emit('peer:join', info);
    if (this._wasReady) this._raw({ t: 'join', c: id, name: info.name, color: info.color, ord: info.ord });
  }
  _dropPeer(id, reason) {
    const wait = this.arriving?.get(id);
    if (wait) { clearTimeout(wait); this.arriving.delete(id); }
    const pr = this.peers.get(id);
    if (!pr) return;
    this.peers.delete(id);
    this.links.delete(id);
    for (const [k, v] of this.owners) if (v === id) this.owners.delete(k);
    for (const [k, v] of this.locks) if (v === id) this.locks.delete(k);
    this.ev.emit('peer:leave', { peer: pr, reason });
    this._raw({ t: 'leave', c: id, why: reason });
  }
  _hostChanged(host, previous, reason) {
    if (host === previous) return;
    if (host === this.id) for (const st of this.states.values()) st.sent = null; // the new host sends its states
    this.ev.emit('host', { host, previous, reason });
    if (this._wasReady) this._raw({ t: 'host', c: host });
    for (const f of this.hostHandlers) { try { f(host, previous); } catch (e) { console.error('[hawkes-net] onHost:', e); } }
  }

  // ================================================================ sending (one bundle per 33 ms)
  _carrierUp() {
    if (this.transport === 'relay') return Boolean(this.ws && this.ws.readyState === 1 && this._wasReady);
    const p = this.p2p;
    if (!p) return false;
    if (p.hostRoom) return true;
    return p.carrier === 'channel' ? Boolean(p.channel && p.channel.readyState === 'open') : Boolean(this.ws && this.ws.readyState === 1);
  }
  _flush() {
    const q = this.q;
    if (!q.rel.length && !q.me && !q.xf.size && !q.unrel.size && !q.ping && !q.rawXf.length) return;
    if (!this._carrierUp()) return; // kept until there is a way out
    const out = [];
    if (q.ping) { out.push({ t: 'ping', at: q.ping }); q.ping = 0; }
    out.push(...q.rel); q.rel = [];
    if (q.me) { out.push(q.me); q.me = null; }
    out.push(...q.unrel.values()); q.unrel.clear();
    if (q.xf.size) { out.push({ t: 'xf', at: this.now(), x: [...q.xf.values()].map((e) => e.entry) }); q.xf.clear(); }
    if (q.rawXf.length) { out.push(...q.rawXf); q.rawXf = []; }
    this._sendRoom(out);
  }
  _sendRoom(msgs) {
    if (!msgs.length) return;
    if (this.transport === 'relay') {
      const f = this.wsCodec.out.bundle(msgs, now(), true);
      this.st.up += f.length; this.st.upMsgs++;
      this.ws.send(f);
      return;
    }
    const p = this.p2p;
    if (p.hostRoom) { core.receive(p.hostRoom, p.self, JSON.stringify({ t: 'b', m: msgs }), this.now()); return; }
    const f = p.out.bundle(msgs, now(), true);
    this.st.up += f.length; this.st.upMsgs++;
    // One stream, one carrier: the link once it's open, the signal route until then.
    if (p.carrier === 'channel') { if (p.channel && p.channel.readyState === 'open') p.channel.send(f); }
    else this._control({ c: 'sig', to: p.host, kind: 'data', body: b64(f) });
  }
  _control(m) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return;
    const f = core.jsonFrame(core.FRAME.control, m);
    this.st.up += f.length; this.st.upMsgs++;
    ws.send(f);
  }

  // ================================================================ the clock (the node's, through the relay or the host)
  _ping() {
    const at = now();
    if (this.transport === 'relay' || (this.p2p && !this.p2p.hostRoom)) this.q.ping = at;
    else this._control({ c: 'ping', at });
  }
  _pong(at, theirs) {
    const rtt = now() - at;
    if (!(rtt >= 0 && rtt < 30_000) || typeof theirs !== 'number') return;
    this.rtt = rtt;
    this.offsets.push({ rtt, off: theirs + rtt / 2 - now() });
    if (this.offsets.length > 10) this.offsets.shift();
    const best = this.offsets.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this._setOffset(best.off, this.offsets.length === 1);
    if (this.offsets.length < 5) setTimeout(() => this._ping(), 1000);
  }
  _setOffset(off, first) { if (first || Math.abs(off - this.offset) > 5000) { this.offset = off; this.offsetTarget = null; } else this.offsetTarget = off; }

  // ================================================================ upkeep (once a second)
  _tick() {
    const t = wall();
    // Late by more than 4 s: this page was asleep (a phone locked, a hidden tab). Nobody is judged lost for a while.
    if (t - this.lastBeat > 4000) this.sleptUntil = t + SLEEP_GRACE_MS;
    this.lastBeat = t;
    if (this.offsetTarget !== null) {
      // Ease the clock to its newest estimate: at most 10 ms a second.
      const d = this.offsetTarget - this.offset;
      this.offset += Math.max(-10, Math.min(10, d));
      if (Math.abs(d) <= 10) this.offsetTarget = null;
    }
    if (t - this.pingAt > PING_MS) { this.pingAt = t; this._ping(); }
    this._checkAway();
    this._syncStates();
    while (this.sentRel.length && t - this.sentRel[0].at > 30_000) this.sentRel.shift();
    if (this.p2p) this._p2pTick(t);
  }
  _wake() { this.lastBeat = wall(); this.sleptUntil = wall() + SLEEP_GRACE_MS; }
  /** Away after AWAY_AFTER_MS in the background, back the moment the page is seen again. */
  _checkAway() {
    if (!hasPage || this.o.away === false || this.closed) return;
    const bg = inBackground(1000);
    if (bg && !this._hiddenSince) this._hiddenSince = wall();
    if (!bg) this._hiddenSince = 0;
    const want = bg && wall() - this._hiddenSince >= AWAY_AFTER_MS;
    // Acts when the page's state changes (a game's own setAway stands until then).
    if (want === this._autoAway) return;
    this._autoAway = want;
    if (want !== this.away) this._setAway(want);
  }
  _setAway(on) {
    this.away = on;
    this.q.rel.push({ t: 'away', on });
    this.ev.emit('away', { away: on });
  }
  _status(s) { if (this.status === s) return; this.status = s; this.ev.emit('status', { status: s, peers: this.peers.size, transport: this.transport }); }
  _problem(code, detail) {
    if (code === 'relay-lost' && wall() < this.sleptUntil) return;
    this.ev.emit('problem', { code, detail });
    if (this.o.log !== false && code !== 'full') console.error(`[hawkes-net] ${code}: ${detail}`);
  }

  // ================================================================ p2p: the host-star
  /** Who hosts the p2p room: me (I run the room here and players link to me) or someone else (I link to them). */
  _p2pHost(host, previous, fromHello) {
    const was = this.host;
    if (host === this.id) {
      this.host = host;
      if (!this.p2p?.hostRoom) {
        this._teardownP2p();
        // I run the room. My own view of it is a protocol 2 connection in this page; its clock is mine (synced to the node).
        const cfg = this.config || {};
        const hostRoom = core.newRoom({ key: `${this.project}/${this.room}`, project: this.project, interest: cfg.interest === null ? null : cfg.interest || undefined, quant: cfg.quant });
        const seedFrom = this._mirror();
        if (seedFrom) core.seed(hostRoom, seedFrom);
        const self = core.newConn(hostRoom, { id: this.id, ord: this.ord, name: this.name, color: this.color, role: this.o.role, v: 2, now: this.now(), send: (text) => this._fromHostRoom(text) });
        self.sendX = (f) => this._expressIn(f);
        this.p2p = { hostRoom, self, links: new Map(), flushAt: 0, timer: null };
        hostRoom.host = this.id;
        core.join(hostRoom, self, this.now(), { keepHost: true });
        for (const pr of this.peers.values()) this._hostAddPeer(pr);
      }
      this._readyNow(false);
    } else if (host) {
      if (!(this.p2p && !this.p2p.hostRoom && this.p2p.host === host)) {
        this._teardownP2p();
        this.p2p = { host, out: new core.Codec(), in: new core.Codec(), pc: null, channel: null, carrier: 'sig', since: wall(), proposed: false, iceWait: null };
        this.host = host;
        this._linkToHost();
      }
    }
    if (was !== this.host && !fromHello) this._hostChanged(this.host, was, previous ? 'host left' : 'first');
    else if (was !== this.host && fromHello && this.host === this.id) this._hostChanged(this.host, was, 'first');
  }
  /** What I know of the world (a new host starts from it). */
  _mirror() {
    if (!this.things.size && !this.owners.size) return null;
    return { owners: Object.fromEntries(this.owners), locks: Object.fromEntries(this.locks), things: [...this.things].map(([id, v]) => [id, this.owners.get(id) || this.id, this.now(), false, ...v]), states: [], recent: [] };
  }
  _fromHostRoom(text) {
    // The room in my page sends me what others did, the same as the relay would.
    let m; try { m = JSON.parse(text); } catch { return; }
    const list = m.t === 'b' ? m.m : [m];
    for (const x of list) { if (x.t === 'hello') { this._worldHello(x); continue; } this._fromRoom(x); }
  }

  // ------------------------------------------------------------ the host's side of each player's stream
  // A player's stream (its codec state) is bound to one carrier: the signal route until its WebRTC link opens, then the
  // link. The first frame of a stream is a 'hi', which starts it over: a new hello carrying the last reliable sequence
  // the room has from that player, so nothing reliable is lost in between. The old carrier's tail is ignored.
  _hostAddPeer(pr) {
    const p = this.p2p;
    if (!p?.hostRoom) return;
    const id = pr.c ?? pr.id;
    if (!id || id === this.id || p.links.has(id)) return;
    const link = { id, pc: null, channel: null, conn: null, iceWait: null };
    p.links.set(id, link);
    this._hostStream(link, 'sig');
  }
  _hostStream(link, carrier) {
    const p = this.p2p;
    const pr = this.peers.get(link.id) || {};
    const old = link.conn;
    const conn = core.newConn(p.hostRoom, { id: link.id, ord: pr.ord ?? 0, name: pr.name, color: pr.color, role: pr.role, v: 3, now: this.now(), budget: carrier === 'sig' ? SLOW_BUDGET : undefined, send: (f) => this._hostSend(link, conn, f) });
    conn.carrier = carrier;
    conn.slow = carrier === 'sig';
    conn.sendX = (f) => this._hostSendX(link, conn, f);
    if (old) conn.out.rel.push(...old.out.rel);
    link.conn = conn;
    core.join(p.hostRoom, conn, this.now(), { keepHost: true });
  }
  _hostDropPeer(id) {
    const p = this.p2p;
    const link = p?.links.get(id);
    if (!link) return;
    p.links.delete(id);
    try { link.chX?.close(); link.channel?.close(); link.pc?.close(); } catch {}
    if (link.conn) core.leave(p.hostRoom, link.conn, 'left');
  }
  _hostSend(link, conn, f) {
    if (link.conn !== conn) return;
    if (conn.carrier === 'channel') { if (link.channel && link.channel.readyState === 'open') { try { link.channel.send(f); } catch {} } return; }
    this._control({ c: 'sig', to: link.id, kind: 'data', body: b64(f) });
  }
  /** Express to a player: its unordered channel, else its stream's carrier. */
  _hostSendX(link, conn, f) {
    if (link.conn !== conn) return;
    if (link.chX && link.chX.readyState === 'open') { try { link.chX.send(f); return; } catch {} }
    this._hostSend(link, conn, f);
  }
  _hostReceive(link, carrier, u8) {
    const p = this.p2p;
    if (u8[0] === core.FRAME.express) { if (p?.hostRoom && link.conn) core.receive(p.hostRoom, link.conn, u8, this.now()); return; }
    if (!p?.hostRoom || !link.conn || link.conn.carrier !== carrier) return; // the old carrier's tail: that stream is over
    core.receive(p.hostRoom, link.conn, u8, this.now());
  }
  _p2pTick(t) {
    const p = this.p2p;
    if (p.hostRoom) {
      if (!p.timer) {
        // On the background clock: a host whose page is hidden still sends everyone their bundles on time.
        p.timer = every(core.FLUSH_MS, () => {
          if (this.p2p !== p) return;
          const n = this.now();
          core.flush(p.hostRoom, n);
          // Players on the slow route get a bundle 4 times a second.
          if (n - p.flushAt > 250) { p.flushAt = n; for (const l of p.links.values()) if (l.conn?.slow) core.flushConn(p.hostRoom, l.conn, n); }
        });
      }
      return;
    }
    // A player with no link to the host after a while: the room should move to the relay (the node decides).
    if (p.carrier !== 'channel' && !p.proposed && t - p.since > LINK_WAIT_MS) { p.proposed = true; this.migrate('links failed'); }
  }
  _teardownP2p() {
    const p = this.p2p;
    if (!p) return;
    this.p2p = null;
    if (p.timer) p.timer();
    try { p.chX?.close(); p.channel?.close(); p.pc?.close(); } catch {}
    if (p.links) for (const l of p.links.values()) { try { l.chX?.close(); l.channel?.close(); l.pc?.close(); } catch {} }
  }

  // ------------------------------------------------------------ the player's side: a link to the host
  _rtc() { return (this.o.rtc && this.o.rtc.RTCPeerConnection) || globalThis.RTCPeerConnection || null; }
  _linkToHost() {
    const p = this.p2p;
    // Meanwhile (and if WebRTC can't link at all), the signal route carries my stream to the host and back.
    this._control({ c: 'sig', to: p.host, kind: 'hi', body: '' });
    const PC = this._rtc();
    if (!PC || this.o.direct === false) return;
    const pc = new PC({ iceServers: this.ice });
    p.pc = pc;
    const ch = pc.createDataChannel('hn', { ordered: true });
    ch.binaryType = 'arraybuffer';
    p.channel = ch;
    // Express rides its own channel: unordered and never retransmitted, so a lost input never holds up the next one.
    const chX = pc.createDataChannel('hx', { ordered: false, maxRetransmits: 0 });
    chX.binaryType = 'arraybuffer';
    p.chX = chX;
    chX.onmessage = (e) => { const u8 = new Uint8Array(e.data); if (this.p2p === p && u8[0] === core.FRAME.express) this._expressIn(u8); };
    ch.onopen = () => {
      if (this.p2p !== p) return;
      // A new stream on the link: fresh codecs both ways, starting with 'hi' (the host answers with a new hello).
      p.carrier = 'channel'; p.in = new core.Codec(); p.out = new core.Codec();
      try { ch.send(core.jsonFrame(core.FRAME.control, { c: 'hi' })); } catch {}
      this._route(p.host, 'direct');
    };
    ch.onclose = () => {
      if (this.p2p !== p || p.carrier !== 'channel') return;
      p.carrier = 'sig'; p.in = new core.Codec(); p.out = new core.Codec(); p.since = wall(); p.proposed = false;
      this.st.linkRetries++;
      this._control({ c: 'sig', to: p.host, kind: 'hi', body: '' });
      this._route(p.host, 'signal');
    };
    ch.onmessage = (e) => this._fromHost(new Uint8Array(e.data), 'channel');
    pc.onicecandidate = (e) => { if (e.candidate) this._sendIce(p.host, e.candidate); };
    void (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this._control({ c: 'sig', to: p.host, kind: 'offer', body: JSON.stringify(pc.localDescription) });
      } catch (e) { console.warn('[hawkes-net] link offer failed:', e?.message || e); }
    })();
  }
  _sendIce(to, c) {
    const j = typeof c.toJSON === 'function' ? c.toJSON() : c;
    this._control({ c: 'sig', to, kind: 'ice', body: JSON.stringify(j) });
    // Same-device tabs: browsers hide host addresses behind mDNS names a second tab can't resolve; a 127.0.0.1 copy links them.
    if (j && typeof j.candidate === 'string' && / [0-9a-f-]+\.local /i.test(j.candidate)) this._control({ c: 'sig', to, kind: 'ice', body: JSON.stringify({ ...j, candidate: j.candidate.replace(/ [0-9a-f-]+\.local /i, ' 127.0.0.1 ') }) });
  }
  _route(id, route) { const pr = this.peers.get(id); if (pr) pr.route = route; }
  _fromHost(u8, carrier) {
    const p = this.p2p;
    if (!p || p.hostRoom) return;
    if (u8[0] === core.FRAME.express) { this.st.down += u8.length; return this._expressIn(u8); }
    if (p.carrier !== carrier) return; // the old carrier's tail
    this.st.down += u8.length; this.st.downMsgs++;
    const k = core.peek(u8);
    if (k.kind === 'hello') { p.in = new core.Codec(); this._worldHello(k.value); this._resendAfter(k.value.lastSeq); this._readyNow(false); return; }
    if (k.kind === 'control') return this._controlIn(k.value);
    if (k.kind !== 'bundle') return;
    let msgs;
    try { msgs = p.in.read(u8, true).msgs; } catch (e) { console.error('[hawkes-net] bad bundle from the host:', e); return; }
    for (const m of msgs) this._fromRoom(m);
  }

  /** Signalling from the node: offers and ICE for links, 'hi' (a stream starts over) and the slow data carrier. */
  async _sig(m) {
    const p = this.p2p;
    if (!p) return;
    if (p.hostRoom) {
      let link = p.links.get(m.from);
      if (!link && this.peers.has(m.from)) { this._hostAddPeer(this.peers.get(m.from)); link = p.links.get(m.from); }
      if (!link) return;
      if (m.kind === 'data') { let u8; try { u8 = unb64(m.body); } catch { return; } return this._hostReceive(link, 'sig', u8); }
      if (m.kind === 'hi') return this._hostStream(link, 'sig');
      const PC = this._rtc();
      if (!PC) return;
      if (m.kind === 'offer') {
        try { link.pc?.close(); } catch {}
        const pc = new PC({ iceServers: this.ice });
        link.pc = pc;
        pc.onicecandidate = (e) => { if (e.candidate) this._sendIce(link.id, e.candidate); };
        pc.ondatachannel = (e) => {
          const ch = e.channel;
          ch.binaryType = 'arraybuffer';
          // The player's unordered channel: express only.
          if (ch.label === 'hx') {
            link.chX = ch;
            ch.onmessage = (ev) => { const u8 = new Uint8Array(ev.data); if (u8[0] === core.FRAME.express && link.conn && this.p2p === p) core.receive(p.hostRoom, link.conn, u8, this.now()); };
            return;
          }
          link.channel = ch;
          ch.onmessage = (ev) => {
            const u8 = new Uint8Array(ev.data);
            const k = core.peek(u8);
            if (k.kind === 'control' && k.value?.c === 'hi') { this._hostStream(link, 'channel'); this._route(link.id, 'direct'); return; }
            this._hostReceive(link, 'channel', u8);
          };
          ch.onclose = () => { if (link.conn?.carrier === 'channel') this._route(link.id, 'signal'); };
        };
        try {
          await pc.setRemoteDescription(JSON.parse(m.body));
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          this._control({ c: 'sig', to: link.id, kind: 'answer', body: JSON.stringify(pc.localDescription) });
          for (const c of link.iceWait || []) await pc.addIceCandidate(c).catch(() => {});
          link.iceWait = null;
        } catch (e) { console.warn('[hawkes-net] link answer failed:', e?.message || e); }
      } else if (m.kind === 'ice') {
        let c; try { c = JSON.parse(m.body); } catch { return; }
        if (link.pc && link.pc.remoteDescription) await link.pc.addIceCandidate(c).catch(() => {});
        else (link.iceWait || (link.iceWait = [])).push(c);
      }
      return;
    }
    // I'm a player: the host's answer, ICE, or data on the slow route.
    if (m.from !== p.host) return;
    if (m.kind === 'data') { let u8; try { u8 = unb64(m.body); } catch { return; } return this._fromHost(u8, 'sig'); }
    const pc = p.pc;
    if (!pc) return;
    if (m.kind === 'answer') {
      try { await pc.setRemoteDescription(JSON.parse(m.body)); for (const c of p.iceWait || []) await pc.addIceCandidate(c).catch(() => {}); p.iceWait = null; } catch (e) { console.warn('[hawkes-net] link answer not taken:', e?.message || e); }
    } else if (m.kind === 'ice') {
      let c; try { c = JSON.parse(m.body); } catch { return; }
      if (pc.remoteDescription) await pc.addIceCandidate(c).catch(() => {});
      else (p.iceWait || (p.iceWait = [])).push(c);
    }
  }

  // ================================================================ state sync (the portal's H.sync, lifted out)
  _makeSync() {
    const self = this;
    return {
      /** name, { get, set, rate, owner: 'host' | 'everyone' | () => bool, where, important }. */
      state(name, def) {
        if (!def || typeof def.get !== 'function' || typeof def.set !== 'function') throw new Error('hawkes-net: sync.state(name, { get, set })');
        self.states.set(String(name), { def, sent: null, copy: {}, t: 0, full: 0 });
        return { remove: () => self.states.delete(String(name)), resend: () => { const st = self.states.get(String(name)); if (st) st.sent = null; } };
      },
      /** Something that must happen once for everyone, decided by the host. Returns invoke(data). */
      action(name, run) {
        const n = String(name);
        self.actions.set(n, run);
        return (data) => {
          if (!self._online() || self.isHost) { run(data, { authoritative: true, from: null }); if (self._online()) self.send('_a', { n, d: data, by: self.id }); }
          else { run(data, { authoritative: false, from: null }); self.send('_ar', { n, d: data }); }
        };
      },
      track: (o) => new core.Track(o, { clock: () => self.now(), links: self.links }),
      /** values: [x, y, z, rx, ry, rz, vx, vy, vz, spin x, y, z] (a prefix is fine). Unchanged values aren't sent;
       *  everything goes again every 5 s so nothing drifts. o.important: driven or held (sent first and more often). */
      push(id, values, o = {}) {
        if (!self.sync.mine(id)) return;
        const before = self.pushed.get(id);
        const t = wall();
        const full = !before || t - before.full > 5000;
        let mask = 0;
        for (let i = 0; i < Math.min(12, values.length); i++) {
          const v = values[i];
          if (typeof v !== 'number' || !Number.isFinite(v)) continue;
          if (full || before.v[i] === undefined || Math.abs(v - before.v[i]) > (i < 6 ? 0.002 : i < 9 ? 0.05 : 1)) mask |= 1 << i;
        }
        if (!mask) return;
        const v = before ? before.v.slice() : [];
        for (let i = 0; i < 12; i++) if (mask & (1 << i)) v[i] = values[i];
        self.pushed.set(id, { v, full: full ? t : before.full });
        // Two pushes in one send interval go as one entry: the union of what changed, the newest values.
        const prev = self.q.xf.get(id);
        const all = prev ? prev.mask | mask : mask;
        const vals = [];
        for (let i = 0; i < 12; i++) if (all & (1 << i)) vals.push(mask & (1 << i) ? values[i] : prev.vals[i]);
        const keep = prev ? prev.vals.slice() : new Array(12);
        for (let i = 0; i < 12; i++) if (mask & (1 << i)) keep[i] = values[i];
        self.q.xf.set(id, { mask: all, vals: keep, entry: [id, all | (o.important ? IMPORTANT : 0), ...vals] });
      },
      /** fn(id, at, values, from, important): where things others simulate are (the 12 values, newest). */
      onThing: (fn) => self.ev.on('thing', fn),
      /** The newest values the room has sent of a thing (or null). */
      thing: (id) => self.things.get(id)?.slice() ?? null,
      /** fn(ops, { by, fx, from }): world edits a server saved. */
      onOps: (fn) => self.ev.on('ops', fn),
      /** fn(id, owner, held): ownership changes. */
      onOwner: (fn) => self.ev.on('own', fn),
      /** Take over simulating a thing. o.hold: nobody takes it by bumping into it until release. False if someone holds it. */
      claim(id, o = {}) {
        if (!self._online()) return false;
        const l = self.locks.get(id);
        if (l && l !== self.id && self.peers.has(l) && !o.force) return false;
        const hold = Boolean(o.hold);
        if (self.owners.get(id) === self.id && (!hold || self.locks.get(id) === self.id)) return true;
        self.owners.set(id, self.id);
        if (hold) self.locks.set(id, self.id);
        self.q.rel.push({ t: 'own', id, on: true, lock: self.locks.get(id) === self.id ? 1 : 0 });
        return true;
      },
      /** Hold on (or let go) of a thing I own without giving it up. */
      hold(id, on = true) {
        if (!self._online() || self.owners.get(id) !== self.id || (self.locks.get(id) === self.id) === Boolean(on)) return;
        if (on) self.locks.set(id, self.id); else self.locks.delete(id);
        self.q.rel.push({ t: 'own', id, on: true, lock: on ? 1 : 0 });
      },
      release(id) {
        if (!self._online() || self.owners.get(id) !== self.id) return;
        self.owners.delete(id); self.locks.delete(id);
        self.q.rel.push({ t: 'own', id, on: false });
      },
      mine: (id) => { if (!self._online()) return true; const o = self.owners.get(id); return o ? o === self.id : self.isHost; },
      holder: (id) => self.locks.get(id) || null,
      owner: (id) => self.owners.get(id) || null,
      /** The host put the world back (a reset, a rewind): the room forgets the poses it kept. */
      clear() { if (self._online() && self.isHost) { self.q.rel.push({ t: 'clear' }); self.things.clear(); } },
      onClear: (fn) => self.ev.on('clear', fn),
      onHost(fn) { self.hostHandlers.add(fn); return () => self.hostHandlers.delete(fn); },
      now: () => self.now(),
    };
  }
  _online() { return this.status === 'online' && this.id !== null; }
  _syncStates() {
    if (!this._online()) return;
    const t = wall();
    for (const [name, st] of this.states) {
      const def = st.def;
      if (!this._ownsState(def) || t - st.t < 1000 / Math.max(0.2, def.rate || 10)) continue;
      st.t = t;
      let snap;
      try { snap = def.get(); } catch (e) { console.error(`[hawkes-net] sync ${name}:`, e); continue; }
      if (!snap || typeof snap !== 'object') continue;
      const full = !st.sent || t - st.full > 10_000;
      const d = {};
      let any = false;
      const js = {};
      for (const [k, v] of Object.entries(snap)) { const j = JSON.stringify(v ?? null); js[k] = j; if (full || st.sent[k] !== j) { d[k] = v; any = true; } }
      if (!any) continue;
      st.sent = js;
      if (full) st.full = t;
      const data = { n: name, d, f: full ? 1 : 0, at: this.now() };
      if (typeof def.where === 'function') { try { const p = def.where(); if (p) data.w = [r2(p[0]), r2(p[2] ?? p[1])]; } catch {} }
      if (def.important) data.i = 1;
      this.q.rel.push({ t: 'ev', name: '_s', data });
    }
  }
  /** Ticks the sync of states now (a game that just changed one and wants it out this send, not within the second). */
  _ownsState(def) { return typeof def.owner === 'function' ? Boolean(def.owner()) : def.owner === 'everyone' ? true : this.isHost; }
  _onSync(kind, data, from) {
    if (kind === '_s') {
      const st = this.states.get(data.n);
      if (!st || !data.d || this._ownsState(st.def)) return;
      st.copy = { ...(data.f ? {} : st.copy), ...data.d };
      try { st.def.set(st.copy, Object.keys(data.d), from, { at: Number.isFinite(data.at) ? data.at : this.now(), from: from && from.id }); } catch (e) { console.error(`[hawkes-net] sync ${data.n}:`, e); }
      return;
    }
    const run = this.actions.get(data.n);
    if (!run) return;
    if (kind === '_ar') {
      if (!this.isHost) return;
      try { run(data.d, { authoritative: true, from }); } catch (e) { console.error(`[hawkes-net] action ${data.n}:`, e); }
      this.send('_a', { n: data.n, d: data.d, by: from && from.id });
    } else if (data.by !== this.id) {
      try { run(data.d, { authoritative: false, from }); } catch (e) { console.error(`[hawkes-net] action ${data.n}:`, e); }
    }
  }
}

// ================================================================ the standard layer: shared rooms by area
/**
 * The standard way a game puts its players together (docs/net.md "The standard layer"; Unity's HawkesNetLobby is the
 * same): one shared room per area ("lobby", "level-1"), everyone in it, kept joined. It names the room for where the page
 * runs, moves to the next shard when a room is full, joins again by itself when the connection is lost or refused, and
 * gives one status. Its handlers stay subscribed across rejoins and shards, so a game subscribes once.
 *
 *   const lob = lobby({ project: 'mygame', liveHosts: ['mygame.com', 'www.mygame.com'], name: 'Ada' });
 *   lob.on('chat', (text, from) => show(from.name, text));
 *   lob.onPose((peer, state) => moveAvatar(peer, state.p, state.y));
 *   lob.when('status', ({ status }) => hud(status));   // off, connecting, online, reconnecting, offline, full
 *   lob.join('level-1');
 *   lob.send('chat', 'hi'); lob.pose([x, y, z], yaw);  // dropped while not in a room
 *
 * Room names (the project's test prefix "t-" keeps beta and playtests apart from live, free and out of the counts):
 *   live hosts:  "level-1", then "level-1.2", "level-1.3"... when full
 *   elsewhere:   "t-level-1"                   (beta sites, localhost)
 *   playtest:    "t-<id>/level-1"              (?room=<id> on the page: Gen's playtest.run with peers)
 * o: join's options (project or ticket, name, transport...) plus liveHosts (the game's own host names), prefix (before
 * every area: "p1/" for a protocol version), maxShards (20), url (the page's address, for names: default location.href).
 */
export function lobby(o = {}) { return new Lobby(o); }

const TEST_ROOM = /^[A-Za-z0-9_.-]{1,24}$/;
class Lobby {
  constructor(o) {
    const { liveHosts = [], prefix = '', maxShards = 20, url, ...join } = o;
    this.o = { liveHosts: liveHosts.map((h) => String(h).toLowerCase()), prefix, maxShards, url };
    this.joinOptions = join;
    this.ev = new Emitter();
    this.msgs = new Emitter();
    this.area = ''; this.shard = 1; this.roomName = ''; this.status = 'off'; this.lastProblem = ''; this.room = null;
    this._explicit = false; this._backoff = 0; this._retry = null; this._gen = 0; this._off = [];
  }
  get ready() { return Boolean(this.room && this.room.status === 'online'); }
  get peers() { return this.room ? this.room.peers : new Map(); }
  get host() { return this.room ? this.room.host : null; }
  get id() { return this.room ? this.room.id : null; }
  now() { return this.room ? this.room.now() : Date.now(); }

  /** The page's address, host and query (empty in Node unless `url` was given). */
  get url() { return this.o.url ?? (typeof location !== 'undefined' ? location.href : ''); }
  get pageHost() { try { return new URL(this.url).hostname.toLowerCase(); } catch { return ''; } }
  query(name) { try { return new URL(this.url).searchParams.get(name) ?? ''; } catch { return ''; } }
  get isLive() { return this.o.liveHosts.includes(this.pageHost); }
  get testRoom() { const id = this.query('room'); return TEST_ROOM.test(id) ? id : ''; }
  /** The full room name for an area and shard here (see above). */
  nameFor(area, shard = 1) {
    const name = `${this.o.prefix}${area}${shard > 1 ? `.${shard}` : ''}`;
    const test = this.testRoom;
    if (test) return `t-${test}/${name}`;
    return this.isLive ? name : `t-${name}`;
  }

  /** Joins an area's shared room (the first shard with room, or this shard). The area you are in does nothing; another
   *  one leaves this first. */
  join(area, shard = 0) {
    if (!area) return this.leave();
    if (area === this.area && (!shard || shard === this.shard) && (this.room || this.status === 'connecting')) return;
    this._close();
    this.area = area;
    this._explicit = shard > 0;
    this.shard = Math.max(1, shard);
    this._backoff = 0;
    void this._open();
  }
  /** Leaves and stays out (no rejoining) until the next join. */
  leave() {
    this.area = '';
    this._close();
    this._setStatus('off');
  }

  // The current room's, while in one (dropped otherwise, as a game's per-frame sends should be).
  send(kind, data, opt) { if (this.ready) this.room.send(kind, data, opt); }
  express(bytes, opt) { return this.ready ? this.room.express(bytes, opt) : false; }
  onExpress(fn) { return this.ev.on('express', fn); }
  pose(p, yaw, extra) { if (this.ready) this.room.pose(p, yaw, extra); }
  /** fn(data, from, meta) for messages of a kind ('*' for all), from whichever room the lobby is in. Returns off(). */
  on(kind, fn) { return this.msgs.on(kind, fn); }
  /** fn(peerId, state, at) for other players' avatars. Returns off(). */
  onPose(fn) { return this.ev.on('pose', fn); }
  /** status ({ status }), joined (room), left (room), peer:join, peer:leave, peer:away, away, host, transport, problem. Returns off(). */
  when(event, fn) { return this.ev.on(event, fn); }

  async _open() {
    const gen = ++this._gen;
    this.roomName = this.nameFor(this.area, this.shard);
    this._setStatus('connecting');
    let room;
    try {
      room = await join(this.roomName, { ...this.joinOptions, onRaw: undefined });
    } catch (e) {
      if (gen !== this._gen) return;
      const full = e?.code === 4009;
      return this._problem(full ? 'full' : e?.status === 429 ? 'capped' : 'ticket', String(e?.message ?? e), false, e?.status);
    }
    if (gen !== this._gen) { void room.leave('moved'); return; }
    this.room = room;
    this._backoff = 0;
    this.lastProblem = '';
    const off = this._off;
    off.push(room.on('*', (data, from, meta) => { if (meta?.kind) this.msgs.emit(meta.kind, data, from, meta); this.msgs.emit('*', data, from, meta); }));
    off.push(room.onPose((...a) => this.ev.emit('pose', ...a)));
    off.push(room.onExpress((...a) => this.ev.emit('express', ...a)));
    for (const name of ['peer:join', 'peer:leave', 'peer:away', 'away', 'host', 'transport']) off.push(room.when(name, (x) => this.ev.emit(name, x)));
    off.push(room.when('problem', (x) => { this.lastProblem = `${x.code}${x.detail ? `: ${x.detail}` : ''}`; this.ev.emit('problem', x); }));
    off.push(room.when('status', ({ status }) => {
      if (gen !== this._gen) return;
      if (status !== 'closed') return this._setStatus(status);
      // Put out of the room by the game's server (a kick): stay out until the game joins again.
      if (this.lastProblem.includes('removed from the room')) { this._close(); return this._setStatus('offline'); }
      this._problem(this.lastProblem.startsWith('full') ? 'full' : 'lost', this.lastProblem, true);
    }));
    this._setStatus('online');
    this.ev.emit('joined', room);
  }

  _problem(code, detail, wasReady, httpStatus = 0) {
    this.lastProblem = `${code}${detail ? `: ${detail}` : ''}`;
    this._close();
    if (!this.area) return;
    if (code === 'full' && !this._explicit && this.shard < this.o.maxShards) {
      this.shard++;
      void this._open();
      return;
    }
    // Lost: soon, backing off to a minute. Refused at the door: 30 s backing off to five minutes (its limits).
    const refused = !wasReady && (code === 'ticket' || code === 'capped' || httpStatus === 403 || httpStatus === 429);
    this._backoff = refused ? Math.min(300, Math.max(30, this._backoff * 2)) : Math.min(60, Math.max(2, this._backoff * 2));
    this._setStatus(code === 'full' ? 'full' : 'offline');
    const gen = this._gen;
    this._retry = setTimeout(() => {
      if (gen !== this._gen || !this.area) return;
      if (!this._explicit) this.shard = 1; // the first shard may have room again
      void this._open();
    }, this._backoff * 1000);
  }

  _close() {
    this._gen++;
    clearTimeout(this._retry);
    this._retry = null;
    for (const f of this._off.splice(0)) f();
    const room = this.room;
    this.room = null;
    if (!room) return;
    if (room.status !== 'closed') void room.leave('left');
    this.ev.emit('left', room);
  }

  _setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.ev.emit('status', { status: s, area: this.area, room: this.roomName });
  }
}

export default { join, lobby, background, inBackground, VERSION, protocols, Track, Links };

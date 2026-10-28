// Hawkes Net core: the room logic and the wire codec, with no sockets, timers or DOM in it (docs/net.md). The same file
// runs in a relay node (src/net/node.ts) and in a host player's page (a p2p room's host runs the room here and forwards
// to its peers), so a room can move between the two without changing what anyone sees.
//
// Messages inside the core keep the shapes of the portal's protocol 2 (hawkesgen.ai src/relay.ts, where this came
// from): { t: 'me' | 'xf' | 'ev' | 'own' | 'clear' | 'ping' }. A connection speaks protocol 2 (JSON bundles) or 3
// (binary, below); each has its own encoder, so both kinds of page share one room.
//
// What a room keeps: who is here, the host (the lowest join order present: it simulates everything nobody else does),
// who owns each moving thing and which of those are held, the newest pose of every moving thing and copy of every
// synced state (so joiners and a new host start from the world as it is), and the last reliable sequence number of
// each peer (exactly-once across a reconnect).
//
// What it sends: every flush (33 ms) each connection gets one bundle: reliable things first, in order; other players'
// avatars (near ones at their full rate, far ones 5 a second); moving things by interest (near ones every time, farther
// ones less often) in priority order within a byte budget, delta-encoded against what that connection already has;
// synced states (only the keys that changed since that connection last got them).

export const PROTOCOL = 3;
export const VERSION = '1.3.0';

/** Room defaults; a room's config and its ticket's limits narrow them. */
export const DEFAULT_LIMITS = {
  playersPerRoom: 64,
  downBytesPerSec: 48 * 1024,
  upBytesPerSec: 64 * 1024,
  msgsPerSec: 90,
  innerPerSec: 900,
  messageBytes: 64 * 1024,
  ents: 4096,
  states: 2048,
};
export const DEFAULT_INTEREST = { tiers: [[45, 0, 0], [130, 250, 0], [320, 1000, 250], [null, 3000, 1000]], farAvatarM: 120 };
export const DEFAULT_QUANT = { posStep: 1 / 128, velStep: 0.05, spinStep: 0.1, keyframeMs: 2500 };
export const FLUSH_MS = 33;

const VALUES = 12;
const IMPORTANT = 1 << 12;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
// A peer's clock stamp: within ten minutes of the room's clock, else the room's (a stamp is never trusted to be sane).
const stamp = (v, now) => (typeof v === 'number' && v > now - 600_000 && v < now + 600_000 ? v : now);

// ===================================================================== bytes
const te = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const td = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

/** A growable byte buffer with LEB128 varints and zig-zag signed varints (safe up to 2^53). */
export class Writer {
  constructor(size = 512) { this.b = new Uint8Array(size); this.n = 0; }
  need(k) {
    if (this.n + k <= this.b.length) return;
    let s = this.b.length * 2;
    while (s < this.n + k) s *= 2;
    const nb = new Uint8Array(s);
    nb.set(this.b.subarray(0, this.n));
    this.b = nb;
  }
  u8(v) { this.need(1); this.b[this.n++] = v & 255; }
  u16(v) { this.need(2); this.b[this.n++] = v & 255; this.b[this.n++] = (v >>> 8) & 255; }
  uv(v) {
    this.need(8);
    // Total: any number writes at most 8 bytes (NaN and negatives as 0, Infinity and anything past 2^53 as 2^53 - 1),
    // so a peer's absurd value can't hang the loop below or overrun the 8 bytes reserved.
    v = v > 0 ? (v < 9007199254740991 ? Math.floor(v) : 9007199254740991) : 0;
    while (v >= 128) { this.b[this.n++] = (v % 128) | 128; v = Math.floor(v / 128); }
    this.b[this.n++] = v;
  }
  sv(v) { v = Math.round(v); if (!(v >= -4503599627370495 && v <= 4503599627370495)) v = v > 0 ? 4503599627370495 : v < 0 ? -4503599627370495 : 0; this.uv(v >= 0 ? v * 2 : -v * 2 - 1); }
  f64(v) { this.need(8); new DataView(this.b.buffer, this.b.byteOffset + this.n, 8).setFloat64(0, v, true); this.n += 8; }
  bytes(u8) { this.uv(u8.length); this.raw(u8); }
  raw(u8) { this.need(u8.length); this.b.set(u8, this.n); this.n += u8.length; }
  str(s) { const e = te.encode(s); this.uv(e.length); this.raw(e); }
  done() { return this.b.slice(0, this.n); }
  reset() { this.n = 0; return this; }
}
export class Reader {
  constructor(u8) { this.b = u8; this.i = 0; }
  get left() { return this.b.length - this.i; }
  u8() { if (this.i >= this.b.length) throw new RangeError('hawkes-net: short frame'); return this.b[this.i++]; }
  u16() { return this.u8() | (this.u8() << 8); }
  uv() {
    let v = 0, m = 1, x;
    do { x = this.u8(); v += (x & 127) * m; m *= 128; if (m > 2 ** 56) throw new RangeError('hawkes-net: varint too long'); } while (x & 128);
    return v;
  }
  sv() { const u = this.uv(); return u % 2 ? -(u + 1) / 2 : u / 2; }
  f64() { if (this.i + 8 > this.b.length) throw new RangeError('hawkes-net: short frame'); const v = new DataView(this.b.buffer, this.b.byteOffset + this.i, 8).getFloat64(0, true); this.i += 8; return v; }
  raw(k) { if (this.i + k > this.b.length) throw new RangeError('hawkes-net: short frame'); const s = this.b.subarray(this.i, this.i + k); this.i += k; return s; }
  bytes() { return this.raw(this.uv()).slice(); }
  str() { return td.decode(this.raw(this.uv())); }
}

// ===================================================================== a stream's string dictionary
// A string (an id, a kind, a key) goes once per stream, then as a number: uv(0) + the string defines the next index,
// uv(i + 1) is entry i. Both ends add entries in the same order up to the same cap, so they always agree. A stream that
// may lose messages (a p2p 'fast' channel) has no dictionary: strings always go in full.
const DICT_CAP = 8192;
// Only short strings go in a dictionary, and at most DICT_CHARS characters in all: a stream's memory stays small
// whatever a peer sends (both ends apply the same rule, so they agree).
const DICT_LONG = 256, DICT_CHARS = 262_144;
const STATE_KEYS = 512;
const BASE_CAP = 8192;
export class Dict {
  constructor() { this.map = new Map(); this.list = []; this.byKey = []; this.chars = 0; }
  room(s) { if (this.list.length >= DICT_CAP || s.length > DICT_LONG || this.chars + s.length > DICT_CHARS) return false; this.chars += s.length; return true; }
  /** put(), with a number the caller already has for the string (a room's key): no string hashing on the hot path. */
  putK(w, s, k) {
    let i = this.byKey[k];
    if (i === undefined) { i = this.map.get(s); if (i !== undefined) this.byKey[k] = i; }
    if (i !== undefined) return w.uv(i + 1);
    w.uv(0); w.str(s);
    if (this.room(s)) { const n = this.list.length; this.map.set(s, n); this.list.push(s); this.byKey[k] = n; }
  }
  put(w, s) {
    const i = this.map.get(s);
    if (i !== undefined) return w.uv(i + 1);
    w.uv(0); w.str(s);
    if (this.room(s)) { this.map.set(s, this.list.length); this.list.push(s); }
  }
  get(r) {
    const v = r.uv();
    if (v) { const s = this.list[v - 1]; if (s === undefined) throw new RangeError('hawkes-net: unknown dictionary entry'); return s; }
    const s = r.str();
    if (this.room(s)) { this.map.set(s, this.list.length); this.list.push(s); }
    return s;
  }
}
const putStr = (w, d, s) => (d ? d.put(w, s) : (w.uv(0), w.str(s)));
const putId = (w, d, s, k) => (d && k !== undefined && k >= 0 ? d.putK(w, s, k) : putStr(w, d, s));
const getStr = (r, d) => { if (d) return d.get(r); const v = r.uv(); if (v) throw new RangeError('hawkes-net: dictionary entry on a stream without one'); return r.str(); };

// ===================================================================== tagged values (state keys, event data)
// null 0, false 1, true 2, integer 3 (zig-zag), float 4 (f64), string 5, array 6, map 7 (keys through the dictionary),
// bytes 8, hundredths 9 (a number with two decimals, the portal's r2), thousandths 10 (r3).
export function putValue(w, d, v, depth = 0) {
  // Never throws (it runs inside a flush, where a throw would leave this stream's dictionary and baselines ahead of
  // what was sent): past 32 levels a value is sent as null. Received values are checked for depth before this.
  if (depth > 32) return w.u8(0);
  if (v === null || v === undefined) return w.u8(0);
  if (v === false) return w.u8(1);
  if (v === true) return w.u8(2);
  if (typeof v === 'number') {
    if (Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) { w.u8(3); return w.sv(v); }
    if (Number.isFinite(v) && Math.abs(v) < 1e12) {
      const h = Math.round(v * 100);
      if (Math.abs(h / 100 - v) < 1e-9) { w.u8(9); return w.sv(h); }
      const k = Math.round(v * 1000);
      if (Math.abs(k / 1000 - v) < 1e-9) { w.u8(10); return w.sv(k); }
    }
    w.u8(4); return w.f64(v);
  }
  if (typeof v === 'string') { w.u8(5); return w.str(v); }
  if (v instanceof Uint8Array) { w.u8(8); return w.bytes(v); }
  if (Array.isArray(v)) { w.u8(6); w.uv(v.length); for (const x of v) putValue(w, d, x, depth + 1); return; }
  if (typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined && typeof v[k] !== 'function');
    w.u8(7); w.uv(keys.length);
    for (const k of keys) { putStr(w, d, k); putValue(w, d, v[k], depth + 1); }
    return;
  }
  w.u8(0);
}
export function getValue(r, d, depth = 0) {
  if (depth > 32) throw new RangeError('hawkes-net: value nested too deep');
  switch (r.u8()) {
    case 0: return null;
    case 1: return false;
    case 2: return true;
    case 3: return r.sv();
    case 4: return r.f64();
    case 5: return r.str();
    case 6: { const n = r.uv(); if (n > r.left) throw new RangeError('hawkes-net: array too long'); const a = new Array(n); for (let i = 0; i < n; i++) a[i] = getValue(r, d, depth + 1); return a; }
    case 7: { const n = r.uv(); if (n > r.left) throw new RangeError('hawkes-net: map too long'); const o = {}; for (let i = 0; i < n; i++) { const k = getStr(r, d); const val = getValue(r, d, depth + 1); if (k !== '__proto__') o[k] = val; } return o; }
    case 8: return r.bytes();
    case 9: return r.sv() / 100;
    case 10: return r.sv() / 1000;
    default: throw new RangeError('hawkes-net: unknown value tag');
  }
}

// ===================================================================== protocol 3 frames
// Byte 0 of every frame: the kind. 0 = a bundle (binary items, below), 1 = hello (JSON), 2 = control (JSON: pings,
// signalling, migration; things that are rare and need no codec).
export const FRAME = { bundle: 0, hello: 1, control: 2, express: 3 };
// Bundle items: a one-byte tag, the payload's length, the payload (so an older page skips a tag it doesn't know).
export const TAG = { me: 1, xf: 2, st: 3, ev: 4, own: 5, join: 6, leave: 7, host: 8, ops: 9, clear: 10, pong: 11, ping: 13, away: 14 };

const TURN = 65536;
/** Quantizes value i of a moving thing (x y z, rx ry rz, vx vy vz, spin x y z) to an integer. */
function q(i, v, Q) {
  if (i < 3) return Math.round(v / Q.posStep);
  if (i < 6) return Math.round((v / (2 * Math.PI)) * TURN);
  if (i < 9) return Math.round(v / Q.velStep);
  return Math.round(v / Q.spinStep);
}
function dq(i, n, Q) {
  if (i < 3) return n * Q.posStep;
  if (i < 6) { let a = (n / TURN) * 2 * Math.PI; a = Math.round(a * 1e6) / 1e6; return a; }
  if (i < 9) return Math.round(n * Q.velStep * 1000) / 1000;
  return Math.round(n * Q.spinStep * 1000) / 1000;
}
// A rotation's delta is taken the short way round (it wraps at a full turn).
const wrapTurn = (d) => { d %= TURN; if (d > TURN / 2) d -= TURN; if (d < -TURN / 2) d += TURN; return d; };

/**
 * One direction of one protocol-3 stream: its dictionary and the baselines that deltas are taken against. `reliable`
 * streams (a WebSocket, a reliable data channel) carry deltas and dictionary references; others (an unordered,
 * no-retransmit data channel) carry every value whole.
 */
export class Codec {
  constructor(o = {}) {
    this.reliable = o.reliable !== false;
    this.Q = { ...DEFAULT_QUANT, ...(o.quant || {}) };
    this.dict = this.reliable ? new Dict() : null;
    this.base = new Map(); // thing id -> quantized values (what the other end has)
    this.baseK = []; // the same, by key (a room's numbers for its ids)
    this.nBase = 0; // baselines kept (at most BASE_CAP)
    this.meBase = new Map(); // peer -> quantized position
    this.w = new Writer(2048);
    this.s = new Writer(256);
  }
  /** Forget every baseline (a 'clear': the other end forgot too). */
  forget() { this.base.clear(); this.baseK = []; this.nBase = 0; }

  // ------------------------------------------------------------ encoding
  /** Encodes a list of core messages (the protocol 2 shapes) as one bundle frame. `toServer`: a page's own messages
   *  (no sender ids: the server knows who it is). Returns the frame (Uint8Array). */
  bundle(msgs, now, toServer = false) {
    const w = this.w.reset();
    w.u8(FRAME.bundle);
    w.uv(now);
    for (const m of msgs) this.item(m, now, toServer);
    return w.done();
  }
  item(m, now, toServer) {
    const s = this.s.reset();
    const d = this.dict;
    let tag;
    switch (m.t) {
      case 'me': {
        tag = TAG.me;
        if (!toServer) putId(s, d, m.c, m._k);
        s.sv((num(m.at) ?? now) - now);
        const st = m.s || {};
        const p = Array.isArray(st.p) && st.p.length >= 3 ? st.p : null;
        const extra = {};
        for (const k of Object.keys(st)) if (k !== 'p' && k !== 'y') extra[k] = st[k];
        const hasExtra = Object.keys(extra).length > 0;
        const key = toServer ? '' : m.c;
        const base = this.reliable ? this.meBase.get(key) : null;
        let mask = 0;
        if (p) mask |= base ? 2 : 1;
        if (typeof st.y === 'number') mask |= 4;
        if (hasExtra) mask |= 8;
        s.u8(mask);
        if (p) {
          const qp = [Math.round(p[0] / this.Q.posStep), Math.round(p[1] / this.Q.posStep), Math.round(p[2] / this.Q.posStep)];
          for (let k = 0; k < 3; k++) s.sv(base ? qp[k] - base[k] : qp[k]);
          if (this.reliable) this.meBase.set(key, qp);
        }
        if (mask & 4) s.u16(((Math.round((st.y / (2 * Math.PI)) * TURN) % TURN) + TURN) % TURN);
        if (hasExtra) putValue(s, d, extra);
        break;
      }
      case 'xf': {
        tag = TAG.xf;
        if (!toServer) putStr(s, d, m.c);
        s.sv((num(m.at) ?? now) - now);
        const list = Array.isArray(m.x) ? m.x : [];
        s.uv(list.length);
        for (const x of list) {
          const id = String(x[0]);
          const xk = x._k;
          const keyed = xk !== undefined && xk >= 0;
          let mask = x[1] & (IMPORTANT | 4095);
          const base = this.reliable ? (keyed ? this.baseK[xk] : this.base.get(id)) : null;
          if (!base) mask |= 1 << 13; // whole values, no baseline
          putId(s, d, id, xk);
          s.uv(mask);
          let k = 2;
          const nb = base || new Array(VALUES).fill(0);
          for (let i = 0; i < VALUES; i++) {
            if (!(x[1] & (1 << i))) continue;
            const v = num(x[k++]) ?? 0;
            const qv = q(i, v, this.Q);
            let dv = base ? qv - base[i] : qv;
            if (i >= 3 && i < 6) dv = wrapTurn(dv);
            s.sv(dv);
            nb[i] = base ? base[i] + dv : qv;
          }
          // At most BASE_CAP baselines a stream (the decoder keeps the same count): past it a thing goes whole each time.
          if (this.reliable && !base && (this.nBase || 0) < BASE_CAP) { this.nBase = (this.nBase || 0) + 1; if (keyed) this.baseK[xk] = nb; else this.base.set(id, nb); }
        }
        break;
      }
      case 'ev': {
        // A synced state rides as its own item; everything else is an event.
        if (m.name === '_s' && m.data && typeof m.data.n === 'string' && m.data.d && typeof m.data.d === 'object') {
          tag = TAG.st;
          const data = m.data;
          if (!toServer) putStr(s, d, m.c ?? '');
          putStr(s, d, data.n);
          s.sv((num(data.at) ?? now) - now);
          let fl = data.f ? 1 : 0;
          if (Array.isArray(data.w) && num(data.w[0]) !== undefined && num(data.w[1]) !== undefined) fl |= 2;
          if (data.i) fl |= 4;
          s.u8(fl);
          if (fl & 2) { s.sv(Math.round(data.w[0] * 10)); s.sv(Math.round(data.w[1] * 10)); }
          putValue(s, d, data.d);
          break;
        }
        tag = TAG.ev;
        let fl = 0;
        if (!toServer && m.c) fl |= 1;
        if (m.self) fl |= 2;
        if (m.to) fl |= 4;
        if (m.seq) fl |= 8;
        s.u8(fl);
        if (fl & 1) putStr(s, d, m.c);
        putStr(s, d, String(m.name ?? ''));
        if (fl & 4) putStr(s, d, String(m.to));
        if (fl & 8) s.uv(m.seq);
        putValue(s, d, m.data ?? null);
        break;
      }
      case 'own': {
        tag = TAG.own;
        putStr(s, d, String(m.id));
        if (toServer) { s.u8((m.on ? 1 : 0) | (m.lock ? 2 : 0)); break; }
        s.u8((m.c ? 1 : 0) | (m.lock ? 2 : 0));
        if (m.c) putStr(s, d, m.c);
        break;
      }
      case 'join': tag = TAG.join; putValue(s, d, { c: m.c, name: m.name ?? null, color: m.color ?? null, user: m.user ?? null, ord: m.ord ?? null, role: m.role ?? null }); break;
      case 'leave': tag = TAG.leave; putStr(s, d, m.c); s.u8(m.why === 'timeout' ? 1 : m.why === 'kicked' ? 2 : 0); break;
      case 'host': tag = TAG.host; putStr(s, d, m.c); break;
      // A page in the background (docs/net.md "Away"): to the room { on }, from it { c, on }. Older pages skip it.
      case 'away': tag = TAG.away; if (!toServer) putStr(s, d, m.c); s.u8(m.on ? 1 : 0); break;
      case 'ops': tag = TAG.ops; s.str(JSON.stringify({ ops: m.ops, by: m.by ?? null, c: m.c ?? null, fx: m.fx ?? null })); break;
      case 'clear': tag = TAG.clear; break;
      case 'pong': tag = TAG.pong; s.uv(m.at); s.uv(m.now); break;
      case 'ping': tag = TAG.ping; s.uv(m.at); break;
      default: return;
    }
    const w = this.w;
    w.u8(tag);
    w.uv(s.n);
    w.raw(s.b.subarray(0, s.n));
    if (m.t === 'clear') this.forget();
  }

  // ------------------------------------------------------------ decoding
  /** Decodes a bundle frame into core messages. `fromServer`: messages carry their sender. Throws on a bad frame. */
  read(u8, fromServer = false) {
    const r = new Reader(u8);
    if (r.u8() !== FRAME.bundle) throw new RangeError('hawkes-net: not a bundle');
    const now = r.uv();
    const out = [];
    while (r.left > 0) {
      const tag = r.u8();
      const len = r.uv();
      const body = r.raw(len);
      const m = this.readItem(tag, new Reader(body), now, fromServer);
      if (m) out.push(m);
    }
    return { now, msgs: out };
  }
  readItem(tag, r, now, fromServer) {
    const d = this.dict;
    switch (tag) {
      case TAG.me: {
        const c = fromServer ? getStr(r, d) : null;
        const at = now + r.sv();
        const mask = r.u8();
        const s = {};
        const key = fromServer ? c : '';
        if (mask & 3) {
          const base = mask & 2 ? this.meBase.get(key) : null;
          if ((mask & 2) && !base) throw new RangeError('hawkes-net: avatar delta with no baseline');
          const qp = [r.sv(), r.sv(), r.sv()];
          if (base) for (let k = 0; k < 3; k++) qp[k] += base[k];
          if (this.reliable) this.meBase.set(key, qp);
          s.p = qp.map((n) => Math.round(n * this.Q.posStep * 1000) / 1000);
        }
        if (mask & 4) { let y = (r.u16() / TURN) * 2 * Math.PI; if (y > Math.PI) y -= 2 * Math.PI; s.y = Math.round(y * 1000) / 1000; }
        if (mask & 8) { const extra = getValue(r, d); if (extra && typeof extra === 'object') Object.assign(s, extra); }
        return fromServer ? { t: 'me', c, s, at } : { t: 'me', s, at };
      }
      case TAG.xf: {
        const c = fromServer ? getStr(r, d) : null;
        const at = now + r.sv();
        const n = r.uv();
        if (n > 4096) throw new RangeError('hawkes-net: too many things');
        const x = [];
        for (let j = 0; j < n; j++) {
          const id = getStr(r, d);
          const mask = r.uv();
          const whole = Boolean(mask & (1 << 13));
          let base = whole ? null : this.base.get(id);
          if (!whole && !base) throw new RangeError('hawkes-net: delta with no baseline');
          const nb = base ? base.slice() : new Array(VALUES).fill(0);
          const entry = [id, mask & (IMPORTANT | 4095)];
          for (let i = 0; i < VALUES; i++) {
            if (!(mask & (1 << i))) continue;
            const dv = r.sv();
            let qv = base ? base[i] + dv : dv;
            if (i >= 3 && i < 6) qv = ((qv % TURN) + TURN) % TURN;
            nb[i] = qv;
            let v = dq(i, qv, this.Q);
            if (i >= 3 && i < 6 && v > Math.PI) v = Math.round((v - 2 * Math.PI) * 1e6) / 1e6;
            entry.push(i < 3 ? Math.round(v * 1000) / 1000 : v);
          }
          if (this.reliable && (!whole || this.base.has(id) || this.base.size < BASE_CAP)) this.base.set(id, nb);
          x.push(entry);
        }
        return fromServer ? { t: 'xf', c, at, x } : { t: 'xf', at, x };
      }
      case TAG.st: {
        const c = fromServer ? getStr(r, d) || null : null;
        const n = getStr(r, d);
        const at = now + r.sv();
        const fl = r.u8();
        const data = { n, d: {}, f: fl & 1 ? 1 : 0, at };
        if (fl & 2) data.w = [r.sv() / 10, r.sv() / 10];
        if (fl & 4) data.i = 1;
        const keys = getValue(r, d);
        data.d = keys && typeof keys === 'object' && !Array.isArray(keys) ? keys : {};
        return fromServer ? { t: 'ev', c, name: '_s', data } : { t: 'ev', name: '_s', data };
      }
      case TAG.ev: {
        const fl = r.u8();
        const c = fl & 1 ? getStr(r, d) : null;
        const name = getStr(r, d);
        const to = fl & 4 ? getStr(r, d) : undefined;
        const seq = fl & 8 ? r.uv() : 0;
        const data = getValue(r, d);
        const m = { t: 'ev', name, data };
        if (fromServer) m.c = c;
        if (fl & 2) m.self = true;
        if (to !== undefined) m.to = to;
        if (seq) m.seq = seq;
        return m;
      }
      case TAG.own: {
        const id = getStr(r, d);
        const fl = r.u8();
        if (!fromServer) return { t: 'own', id, on: Boolean(fl & 1), lock: fl & 2 ? 1 : 0 };
        const c = fl & 1 ? getStr(r, d) : null;
        return { t: 'own', id, c, lock: fl & 2 ? 1 : 0 };
      }
      case TAG.join: { const v = getValue(r, d) || {}; return { t: 'join', c: String(v.c), name: v.name ?? null, color: v.color ?? null, user: v.user ?? null, ord: v.ord ?? null, role: v.role ?? null }; }
      case TAG.leave: { const c = getStr(r, d); const why = r.u8(); return { t: 'leave', c, why: why === 1 ? 'timeout' : why === 2 ? 'kicked' : 'left' }; }
      case TAG.host: return { t: 'host', c: getStr(r, d) };
      case TAG.away: { const c = fromServer ? getStr(r, d) : undefined; const on = Boolean(r.u8() & 1); return fromServer ? { t: 'away', c, on } : { t: 'away', on }; }
      case TAG.ops: { const o = JSON.parse(r.str()); return { t: 'ops', ops: Array.isArray(o.ops) ? o.ops : [], by: o.by ?? null, c: o.c ?? null, fx: o.fx ?? null }; }
      case TAG.clear: this.forget(); return { t: 'clear' };
      case TAG.pong: return { t: 'pong', at: r.uv(), now: r.uv() };
      case TAG.ping: return { t: 'ping', at: r.uv() };
      default: return null; // a newer page's item: skipped by its length
    }
  }
}

// ------------------------------------------------------------------ express: the game's own bytes, now
// A frame of its own (byte 0 = FRAME.express) for what can't wait for a bundle: a fighting game's inputs. It is sent the
// moment the game calls express() and forwarded by the relay (or the p2p host) the moment it arrives, never queued,
// never resent; between peers it rides an unordered, no-retransmit data channel. The game's bytes go as they are: a
// payload carries its own frame numbers, so loss and reordering are the game's to handle (rollback netcode does).
//   [3][flags: 1 from, 2 to][from: uv length + utf8][to: uv length + utf8][the game's bytes]
export const EXPRESS_MAX = 1200;
/** Express frames a second from one connection (unless the room's limits say otherwise). */
export const EXPRESS_PER_SEC = 240;
/** An express frame: from a page (`to`: one peer) or from the room (`from`: who sent it). */
export function expressFrame(payload, o = {}) {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const from = o.from ? te.encode(String(o.from)) : null;
  const to = o.to ? te.encode(String(o.to)) : null;
  const w = new Writer(bytes.length + 32);
  w.u8(FRAME.express);
  w.u8((from ? 1 : 0) | (to ? 2 : 0));
  if (from) { w.uv(from.length); w.raw(from); }
  if (to) { w.uv(to.length); w.raw(to); }
  w.raw(bytes);
  return w.done();
}
/** Reads an express frame: { from, to, payload } (payload a view into the frame), or null. */
export function readExpress(u8) {
  try {
    const r = new Reader(u8);
    if (r.u8() !== FRAME.express) return null;
    const fl = r.u8();
    const from = fl & 1 ? r.str() : null;
    const to = fl & 2 ? r.str() : null;
    return { from, to, payload: u8.subarray(r.i) };
  } catch { return null; }
}
/** Forwards an express frame from connection c at once: to `to`, or to everyone else in the room. A connection that
 *  takes express itself (`sendX`: the p2p host's own page, a link's unordered channel) gets it there. */
function express(room, c, frame, now) {
  if (frame.length > EXPRESS_MAX + 80) return;
  const x = readExpress(frame);
  if (!x) return;
  const out = expressFrame(x.payload, { from: c.id });
  const send = (t) => {
    if (!t.sendX && t.v !== 3) return; // a protocol 2 page can't read it
    t.stats.outBytes += out.length; t.stats.outMsgs++;
    room.stats.outBytes += out.length; room.stats.outMsgs++;
    if (t.out) t.out.tokens = (t.out.tokens ?? 0) - out.length;
    try { (t.sendX || t.send)(out); } catch { /* closed: its close handler takes it out */ }
  };
  if (x.to) { const t = room.conns.get(x.to); if (t && t !== c) send(t); return; }
  for (const t of room.conns.values()) if (t !== c) send(t);
}

/** A JSON frame (hello or control): byte 0 the kind, then UTF-8 JSON. */
export function jsonFrame(kind, obj) {
  const body = te.encode(JSON.stringify(obj));
  const out = new Uint8Array(body.length + 1);
  out[0] = kind;
  out.set(body, 1);
  return out;
}
/** What kind of frame this is, and its JSON when it isn't a bundle. */
export function peek(u8) {
  const kind = u8[0];
  if (kind === FRAME.bundle) return { kind: 'bundle' };
  if (kind === FRAME.hello || kind === FRAME.control) {
    let v = null;
    try { v = JSON.parse(td.decode(u8.subarray(1))); } catch { return { kind: 'bad' }; }
    return { kind: kind === FRAME.hello ? 'hello' : 'control', value: v };
  }
  return { kind: 'bad' };
}

// ===================================================================== the room
// A connection: an id (the peer id from its ticket), a join order (the host is the lowest present), a protocol (2 or 3)
// and a send(frame) that takes a string (2) or a Uint8Array (3).
//
// For speed at hundreds of players per process, the hot paths use small integers instead of string keys: every moving
// thing has a slot (room.slots), every connection an index (c.idx), and every id a key (room.keys) that each
// connection's codec maps to its dictionary entry and baseline. Updates are logged once per room (room.upd) and handed
// to each connection's pending list at the flush, instead of each update touching every connection.
export function newRoom(o = {}) {
  return {
    key: o.key || '',
    project: o.project || '',
    edit: Boolean(o.edit),
    epoch: o.epoch || 1,
    limits: { ...DEFAULT_LIMITS, ...(o.limits || {}) },
    interest: o.interest === null ? null : { ...DEFAULT_INTEREST, ...(o.interest || {}) },
    quant: { ...DEFAULT_QUANT, ...(o.quant || {}) },
    conns: new Map(),
    host: null,
    owners: new Map(),
    locks: new Map(),
    ents: new Map(), // id -> { id, slot, gen, k, v, c, at, imp }
    slots: [], // slot -> ent (or null)
    free: [],
    gen: 0,
    upd: [], // flat [slot, from idx, ...]: things updated since the last flush
    cidx: [], // connection index -> conn (or null)
    cfree: [],
    meClock: 0,
    keys: new Map(), // id -> key (numbers the codecs index by)
    states: new Map(),
    seqs: new Map(), // peer -> highest reliable seq seen (exactly once across reconnects)
    created: o.now || 0,
    stats: { inBytes: 0, outBytes: 0, inMsgs: 0, outMsgs: 0, skipped: 0 },
  };
}
const KEY_CAP = 200_000;
function keyOf(room, s) {
  let k = room.keys.get(s);
  if (k === undefined) { if (room.keys.size >= KEY_CAP) return -1; k = room.keys.size; room.keys.set(s, k); }
  return k;
}
const newOut = (room) => ({ rel: [], pend: [], flag: new Uint8Array(64), sent: [], meSeen: [], meAt: [], st: new Map(), stAt: new Map(), tokens: room.limits.downBytesPerSec, tokensAt: 0 });

/** o: { id, ord, name, color, user, role, v (2 or 3), send(frame), close?(code, why), now, budget? (bytes a second for
 *  this connection: a slow route gets less than the room's) }. */
export function newConn(room, o) {
  return {
    budget: Number.isFinite(o.budget) ? o.budget : null,
    id: String(o.id), ord: Number.isFinite(o.ord) ? o.ord : 0, name: o.name ?? null, color: o.color ?? null, user: o.user ?? null, role: o.role || 'player',
    joined: o.now || 0, v: o.v === 3 ? 3 : 2, send: o.send, close: o.close,
    codec: o.v === 3 ? { out: new Codec({ quant: room.quant }), in: new Codec({ quant: room.quant }) } : null,
    rate: { at: 0, n: 0, inner: 0 }, pos: null, out: newOut(room), idx: -1, k: keyOf(room, String(o.id)), meVer: 0, meS: null, meAt: 0,
    stats: { inBytes: 0, outBytes: 0, inMsgs: 0, outMsgs: 0, skipped: 0 },
  };
}

function rawSend(room, c, m, now) {
  if (c.v === 3) return sendFrame(room, c, jsonFrame(m.t === 'hello' ? FRAME.hello : FRAME.control, m));
  return sendFrame(room, c, JSON.stringify(m));
}
function sendFrame(room, c, frame) {
  const n = typeof frame === 'string' ? frame.length : frame.length;
  c.stats.outBytes += n; c.stats.outMsgs++;
  room.stats.outBytes += n; room.stats.outMsgs++;
  try { c.send(frame); } catch { /* a closed socket: its close handler takes it out */ }
}
/** Reliable: in order, to everyone (but `except`), in the next bundle. */
function reliable(room, m, except) {
  for (const c of room.conns.values()) if (c.id !== except) c.out.rel.push(m);
}
export const peerList = (room) => [...room.conns.values()].sort((a, b) => a.ord - b.ord).map((c) => ({ c: c.id, name: c.name, color: c.color, user: c.user, ord: c.ord, role: c.role, ...(c.away ? { away: true } : {}) }));
/** Who should host: the lowest join order among players whose page is present, else the lowest of all (everyone away). */
const lowest = (room) => {
  let best = null, any = null;
  for (const c of room.conns.values()) {
    if (c.role === 'spectator') continue;
    if (!any || c.ord < any.ord) any = c;
    if (!c.away && (!best || c.ord < best.ord)) best = c;
  }
  return best || any;
};
function pend(o, slot) {
  if (slot >= o.flag.length) { const f = new Uint8Array(Math.max(slot + 1, o.flag.length * 2)); f.set(o.flag); o.flag = f; }
  if (o.flag[slot]) return;
  o.flag[slot] = 1;
  o.pend.push(slot);
}

/** Someone joined: their hello now, everyone else hears of them, and the world as it is follows in their first bundle.
 *  The same peer again (a new socket after a reconnect, a new stream): its place, ownership and sequence are kept. */
export function join(room, c, now, o = {}) {
  const was = room.conns.get(c.id);
  if (was && was !== c && was.idx >= 0) { room.cidx[was.idx] = null; room.cfree.push(was.idx); }
  room.conns.set(c.id, c);
  if (c.idx < 0) { c.idx = room.cfree.length ? room.cfree.pop() : room.cidx.length; room.cidx[c.idx] = c; }
  if (was && was !== c) { c.pos = c.pos || was.pos; c.meVer = was.meVer; c.meS = was.meS; c.meAt = was.meAt; if (c.away === undefined) c.away = was.away; }
  const prevHost = room.host;
  const low = lowest(room);
  const hostConn = room.conns.get(room.host);
  // The lowest order present hosts; a host that is away gives way to anyone present (docs/net.md "Away").
  if (!room.host || !hostConn || (low && low.ord < hostConn.ord && !low.away && !o.keepHost) || (low && hostConn.away && !low.away)) room.host = low ? low.id : c.id;
  rawSend(room, c, {
    t: 'hello', you: c.id, name: c.name, color: c.color, host: room.host, peers: peerList(room),
    owners: Object.fromEntries(room.owners), locks: Object.fromEntries(room.locks), now, edit: room.edit, v: c.v, epoch: room.epoch,
    lastSeq: room.seqs.get(c.id) || 0, resume: o.resume || null, ...(o.hello || {}),
  }, now);
  if (!was) reliable(room, { t: 'join', c: c.id, name: c.name, color: c.color, user: c.user, ord: c.ord, role: c.role }, c.id);
  if (room.host !== prevHost && prevHost) reliable(room, { t: 'host', c: room.host });
  for (const e of room.ents.values()) pend(c.out, e.slot);
  for (const n of room.states.keys()) c.out.st.set(n, true);
}

/**
 * A player's page went into the background (a hidden tab, a minimised or covered window) or came back (docs/net.md
 * "Away"). Everyone hears it. A host that goes away hands the room to the first present player, so what nobody owns
 * keeps moving; it doesn't take it back when it returns. When everyone was away, the first back hosts.
 */
export function setAway(room, c, on) {
  on = Boolean(on);
  if (room.conns.get(c.id) !== c || Boolean(c.away) === on) return;
  c.away = on;
  reliable(room, { t: 'away', c: c.id, on }, c.id);
  const host = room.conns.get(room.host);
  let next = null;
  if (on && room.host === c.id) { const low = lowest(room); if (low && !low.away) next = low; }
  else if (!on && host && host.away && c.role !== 'spectator') next = c;
  if (next && next.id !== room.host) { room.host = next.id; reliable(room, { t: 'host', c: next.id }); }
}

/** Someone left (or timed out): what they owned goes back to the host; the next lowest order takes over if they hosted. */
export function leave(room, c, why = 'left') {
  if (room.conns.get(c.id) !== c) return false;
  room.conns.delete(c.id);
  if (c.idx >= 0) { room.cidx[c.idx] = null; room.cfree.push(c.idx); }
  for (const [eid, owner] of room.owners) if (owner === c.id) room.owners.delete(eid);
  for (const [eid, owner] of room.locks) if (owner === c.id) room.locks.delete(eid);
  reliable(room, { t: 'leave', c: c.id, why });
  if (room.host === c.id) {
    const next = lowest(room);
    room.host = next?.id ?? null;
    if (next) reliable(room, { t: 'host', c: next.id });
  }
  return true;
}

/** One frame from a connection: a string (protocol 2) or bytes (protocol 3). Returns control messages for the caller
 *  (the node or host page handles pings, signalling and migration itself). */
export function receive(room, c, frame, now) {
  const size = typeof frame === 'string' ? frame.length : frame.length;
  c.stats.inBytes += size; c.stats.inMsgs++;
  room.stats.inBytes += size; room.stats.inMsgs++;
  if (size > room.limits.messageBytes) return null;
  if (now - c.rate.at > 1000) { c.rate.at = now; c.rate.n = 0; c.rate.inner = 0; c.rate.bytes = 0; c.rate.x = 0; }
  // Express frames have their own allowance (a 60 fps game sends one a frame on top of everything else).
  if (typeof frame !== 'string' && frame[0] === FRAME.express) {
    if ((c.rate.x = (c.rate.x || 0) + 1) > (room.limits.expressPerSec || EXPRESS_PER_SEC)) return null;
    const before = c.rate.bytes || 0;
    c.rate.bytes = before + size;
    if (before > (room.limits.upBytesPerSec || Infinity)) return null;
    express(room, c, frame, now);
    return null;
  }
  if (++c.rate.n > room.limits.msgsPerSec) return null;
  // Bytes a second from one connection (what it sends is forwarded to everyone, so it is everyone's bill).
  // (One message may go past it, so a big world message still passes; the ones after it in that second don't.)
  const before = c.rate.bytes || 0;
  c.rate.bytes = before + size;
  if (before > (room.limits.upBytesPerSec || Infinity)) return null;
  let msgs;
  if (typeof frame === 'string') {
    let m;
    try { m = JSON.parse(frame); } catch { return null; }
    if (!m || typeof m !== 'object') return null;
    msgs = m.t === 'b' && Array.isArray(m.m) ? m.m.slice(0, 256) : [m];
  } else {
    const p = peek(frame);
    if (p.kind === 'control' || p.kind === 'hello') return p.value;
    if (p.kind !== 'bundle' || !c.codec) return null;
    try { msgs = c.codec.in.read(frame, false).msgs; } catch (e) { c.close?.(1007, 'bad frame'); return null; }
  }
  for (const x of msgs) {
    if (++c.rate.inner > room.limits.innerPerSec) return null;
    if (x && typeof x === 'object') one(room, c, x, now);
  }
  return null;
}

const may = (room, c, id) => { const o = room.owners.get(id); return o ? o === c.id : room.host === c.id; };
function dropEnt(room, id) {
  const e = room.ents.get(id);
  if (!e) return;
  room.ents.delete(id);
  room.slots[e.slot] = null;
  room.free.push(e.slot);
}

function one(room, c, m, now) {
  if (c.role === 'spectator' && m.t !== 'ping' && m.t !== 'me') return;
  switch (m.t) {
    case 'ping': return c.out.rel.push({ t: 'pong', at: num(m.at) ?? 0, now, _direct: true });
    case 'me': {
      const s = m.s && typeof m.s === 'object' ? m.s : null;
      if (!s) return;
      if (Array.isArray(s.p) && s.p.length >= 3 && num(s.p[0]) !== undefined && num(s.p[1]) !== undefined && num(s.p[2]) !== undefined) c.pos = [s.p[0], s.p[1], s.p[2]];
      c.meS = s; c.meAt = stamp(m.at, now); c.meVer = ++room.meClock;
      return;
    }
    case 'xf': {
      if (!Array.isArray(m.x)) return;
      const at = stamp(m.at, now);
      for (const x of m.x) {
        if (!Array.isArray(x) || typeof x[0] !== 'string' || typeof x[1] !== 'number') continue;
        const id = x[0].length > 64 ? x[0].slice(0, 64) : x[0];
        if (!may(room, c, id)) continue; // only the one simulating it says where it is
        let ent = room.ents.get(id);
        if (!ent) {
          if (room.ents.size >= room.limits.ents) continue;
          const slot = room.free.length ? room.free.pop() : room.slots.length;
          ent = { id, slot, gen: ++room.gen, k: keyOf(room, id), v: new Array(VALUES).fill(undefined), c: c.id, at, imp: false };
          room.slots[slot] = ent;
          room.ents.set(id, ent);
        }
        const mask = x[1];
        let k = 2;
        for (let i = 0; i < VALUES; i++) if (mask & (1 << i)) { const v = num(x[k++]); if (v !== undefined) ent.v[i] = v; }
        ent.c = c.id; ent.at = at; ent.imp = Boolean(mask & IMPORTANT);
        room.upd.push(ent.slot, c.idx);
      }
      return;
    }
    case 'ev': {
      const seq = num(m.seq);
      if (seq) {
        const last = room.seqs.get(c.id) || 0;
        if (seq <= last) return; // already had it (sent again after a reconnect)
        room.seqs.set(c.id, seq);
      }
      const name = String(m.name ?? '').slice(0, 64);
      const data = m.data ?? null;
      if (name === '_s' && data && typeof data.n === 'string' && data.d && typeof data.d === 'object') return syncState(room, c, data, now);
      const ev = { t: 'ev', c: c.id, name, data };
      if (typeof m.to === 'string') { const t = room.conns.get(m.to); if (t) t.out.rel.push(ev); if (m.self) c.out.rel.push(ev); return; }
      if (m.self) reliable(room, ev); else reliable(room, ev, c.id);
      return;
    }
    case 'away': return setAway(room, c, m.on);
    case 'own': {
      const eid = String(m.id ?? '').slice(0, 64);
      if (!eid) return;
      const lockedBy = room.locks.get(eid);
      if (m.on) {
        if (lockedBy && lockedBy !== c.id && room.conns.has(lockedBy)) {
          // Held by someone else (they're driving it): it stays theirs; tell the asker who has it.
          return void c.out.rel.push({ t: 'own', id: eid, c: lockedBy, lock: 1 });
        }
        if (!room.owners.has(eid) && room.owners.size >= room.limits.ents) return; // as many as things a room may hold
        room.owners.set(eid, c.id);
        if (m.lock) room.locks.set(eid, c.id); else room.locks.delete(eid);
      } else if (room.owners.get(eid) === c.id) { room.owners.delete(eid); room.locks.delete(eid); }
      else return;
      return reliable(room, { t: 'own', id: eid, c: m.on ? c.id : null, lock: m.on && m.lock ? 1 : 0 });
    }
    case 'clear': {
      // The host put the world back (reset or rewind): what's kept here is stale.
      if (room.host !== c.id) return;
      room.ents.clear(); room.slots = []; room.free = []; room.upd = [];
      for (const o of room.conns.values()) { o.out.pend = []; o.out.flag.fill(0); o.out.sent = []; if (o.v === 3) o.out.rel.push({ t: 'clear' }); }
      return;
    }
  }
}

function syncState(room, c, data, now) {
  const n = data.n.slice(0, 120);
  let st = room.states.get(n);
  if (!st) {
    if (room.states.size >= room.limits.states) return;
    st = { copy: {}, c: c.id, at: now, w: null, imp: false };
    room.states.set(n, st);
  }
  if (data.f) st.copy = {};
  // A state keeps at most STATE_KEYS keys (it is sent whole to every joiner and new host).
  const keys = Object.keys(data.d).filter((k) => k !== '__proto__' && (k in st.copy || Object.keys(st.copy).length < STATE_KEYS));
  for (const k of keys) st.copy[k] = data.d[k];
  st.c = c.id;
  st.at = stamp(data.at, now);
  st.w = Array.isArray(data.w) && num(data.w[0]) !== undefined && num(data.w[1]) !== undefined ? [data.w[0], data.w[1]] : null;
  st.imp = Boolean(data.i);
  for (const o of room.conns.values()) {
    if (o.id === c.id) continue;
    const d = o.out.st.get(n);
    if (data.f) o.out.st.set(n, true);
    else if (d === true) continue;
    else if (d) for (const k of keys) d.add(k);
    else o.out.st.set(n, new Set(keys));
  }
}

/** World edits saved by a server: everyone applies them; what was kept of the things they rebuild is dropped. */
export function ops(room, list, by, fx, except) {
  for (const op of list) {
    const id = op && (op.id || (op.entity && op.entity.id));
    if (typeof id !== 'string' || !(op.op === 'delete' || op.op === 'replace' || op.op === 'create' || (op.op === 'update' && op.patch && Object.keys(op.patch).some((k) => k !== 'transform')))) continue;
    dropEnt(room, id);
  }
  reliable(room, { t: 'ops', ops: list, by, c: except ?? null, fx }, except);
}
/** An event from the server (no sender) to everyone. */
export function event(room, name, data) { reliable(room, { t: 'ev', c: null, name, data }); }

// ------------------------------------------------------------------ the bundles
const dist2 = (a, x, z) => (!a || x === undefined || z === undefined ? 0 : (a[0] - x) ** 2 + (a[2] - z) ** 2);
/** How long a thing at this distance (squared) waits between updates, at most (ms). */
function tierMs(room, d2, imp) {
  const I = room.interest;
  if (!I) return 0;
  const T = I.tiers;
  for (let i = 0; i < T.length; i++) { const t = T[i]; if (t[0] === null || d2 < t[0] * t[0]) return imp ? t[2] : t[1]; }
  return 0;
}
const moving = (v) => Math.abs(v[6] ?? 0) + Math.abs(v[7] ?? 0) + Math.abs(v[8] ?? 0) > 0.05;
// Rough wire sizes, for the budget before encoding (real bytes are counted after).
const xfCost = (c, id, n) => (c.v === 3 ? 3 + Math.min(id.length, 2) + n * 2 : 8 + id.length + n * 7);

/** Sends each connection its bundle (call every FLUSH_MS, or at the room's own rate). */
export function flush(room, now) {
  // What changed since the last flush goes on each connection's pending list (not back to its sender).
  const upd = room.upd;
  if (upd.length) {
    for (const c of room.conns.values()) {
      const o = c.out;
      for (let i = 0; i < upd.length; i += 2) if (upd[i + 1] !== c.idx) pend(o, upd[i]);
    }
    room.upd = [];
  }
  for (const c of room.conns.values()) if (!c.slow) flushOne(room, c, now);
}
/** Sends one connection its bundle now (a p2p host flushes a player on the slow fallback route less often). */
export function flushConn(room, c, now) {
  if (room.conns.get(c.id) !== c) return;
  const upd = room.upd;
  // (Updates are handed out at the room's flush; a connection flushed alone also takes what's waiting.)
  for (let i = 0; i < upd.length; i += 2) if (upd[i + 1] !== c.idx) pend(c.out, upd[i]);
  flushOne(room, c, now);
}
function flushOne(room, c, now) {
  const o = c.out;
  const budget = c.budget ?? room.limits.downBytesPerSec;
  if (!o.tokensAt) o.tokensAt = now;
  o.tokens = Math.min(budget, o.tokens + ((now - o.tokensAt) / 1000) * budget);
  o.tokensAt = now;
  const m = o.rel;
  o.rel = [];
  // Avatars: what changed since this connection last got them; near ones every time, far ones 5 times a second, and
  // past four times as far once a second (a big shared room: a player far across the map costs little).
  const farM2 = room.interest ? room.interest.farAvatarM * room.interest.farAvatarM : Infinity;
  const remoteM2 = farM2 * 16;
  for (const p of room.conns.values()) {
    if (p === c || !p.meVer || p.meVer <= (o.meSeen[p.idx] || 0)) continue;
    if (p.pos && c.pos) {
      const d2 = dist2(c.pos, p.pos[0], p.pos[2]);
      if (d2 > farM2 && now - (o.meAt[p.idx] || 0) < (d2 > remoteM2 ? 1000 : 200)) continue;
    }
    m.push({ t: 'me', c: p.id, s: p.meS, at: p.meAt, _k: p.k });
    o.meSeen[p.idx] = p.meVer;
    o.meAt[p.idx] = now;
  }
  let used = 0;
  // Moving things: what's due, most important first, within the budget. (Sorted only when the budget can't take
  // everything that's due: most bundles fit.)
  if (o.pend.length) {
    const due = [];
    const keep = [];
    let cost = 0;
    const list = o.pend;
    for (let j = 0; j < list.length; j++) {
      const slot = list[j];
      const ent = room.slots[slot];
      if (!ent) { o.flag[slot] = 0; continue; }
      let last = o.sent[slot];
      if (last && last.gen !== ent.gen) last = null;
      const d2 = dist2(c.pos, ent.v[0], ent.v[2]);
      const wait = tierMs(room, d2, ent.imp);
      const waited = last ? now - last.at : 1e6;
      if (waited < wait) { c.stats.skipped++; room.stats.skipped++; keep.push(slot); continue; }
      due.push({ slot, ent, last, d2, wait, waited, pri: 0 });
      cost += xfCost(c, ent.id, VALUES);
    }
    if (cost > o.tokens) {
      for (const d of due) d.pri = (((d.waited + 50) / (d.wait + 50)) * (d.ent.imp ? 4 : 1) * (moving(d.ent.v) ? 2 : 1)) / (1 + Math.sqrt(d.d2) / 40);
      due.sort((a, b) => Number(b.ent.imp) - Number(a.ent.imp) || b.pri - a.pri);
    }
    let group = null;
    const groups = [];
    let j = 0;
    for (; j < due.length; j++) {
      if (used > 0 && used >= o.tokens) break;
      const { slot, ent, last } = due[j];
      o.flag[slot] = 0;
      const full = !last || now - last.full > room.quant.keyframeMs;
      let mask = 0;
      let n = 0;
      const v = ent.v;
      for (let i = 0; i < VALUES; i++) {
        const x = v[i];
        if (x === undefined) continue;
        if (full || last.v[i] === undefined || Math.abs(x - last.v[i]) > 1e-6) { mask |= 1 << i; n++; }
      }
      if (!mask) continue;
      const entry = new Array(n + 2);
      entry[0] = ent.id; entry[1] = ent.imp ? mask | IMPORTANT : mask;
      for (let i = 0, k = 2; i < VALUES; i++) if (mask & (1 << i)) entry[k++] = v[i];
      entry._k = ent.k;
      used += xfCost(c, ent.id, n);
      // Things sent together (one sender, one moment) stay one item.
      if (!group || group.c !== ent.c || group.at !== ent.at) {
        group = null;
        for (const g of groups) if (g.c === ent.c && g.at === ent.at) { group = g; break; }
        if (!group) { group = { t: 'xf', c: ent.c, at: ent.at, x: [] }; groups.push(group); }
      }
      group.x.push(entry);
      if (last) { for (let i = 0; i < VALUES; i++) last.v[i] = v[i]; last.at = now; if (full) last.full = now; }
      else o.sent[slot] = { gen: ent.gen, v: v.slice(), at: now, full: now };
    }
    for (; j < due.length; j++) keep.push(due[j].slot); // over the budget: next time
    o.pend = keep;
    for (const g of groups) m.push(g);
  }
  // Synced states: the keys that changed since this connection last got them; far ones (they say where) less often.
  if (o.st.size) {
    for (const [n, keys] of o.st) {
      const st = room.states.get(n);
      if (!st) { o.st.delete(n); continue; }
      const wait = st.w ? tierMs(room, dist2(c.pos, st.w[0], st.w[1]), st.imp) * 2 : 0;
      if (wait && now - (o.stAt.get(n) ?? 0) < wait) { c.stats.skipped++; room.stats.skipped++; continue; }
      if (used > 0 && used >= o.tokens && !st.imp) break;
      const full = keys === true;
      const d = {};
      if (full) Object.assign(d, st.copy);
      else for (const k of keys) if (k in st.copy) d[k] = st.copy[k];
      used += JSON.stringify(d).length * (c.v === 3 ? 0.6 : 1) + n.length + 12;
      m.push({ t: 'ev', c: st.c, name: '_s', data: { n, d, f: full ? 1 : 0, at: st.at } });
      o.st.delete(n);
      o.stAt.set(n, now);
    }
  }
  o.tokens -= used;
  if (!m.length) return;
  if (c.v === 3) {
    // Pongs and other direct answers go in the bundle too (they're small); everything is one frame.
    const frame = c.codec.out.bundle(m.map((x) => (x._direct ? { t: x.t, at: x.at, now: x.now } : x)), now, false);
    sendFrame(room, c, frame);
  } else {
    const list = m.map((x) => (x._direct ? { t: x.t, at: x.at, now: x.now } : x));
    sendFrame(room, c, JSON.stringify({ t: 'b', m: list }));
  }
}

// ------------------------------------------------------------------ moving a room (docs/net.md "Moving a room")
/** Everything this room keeps, as plain data (what a new carrier is seeded with). */
export function snapshot(room) {
  return {
    epoch: room.epoch,
    host: room.host,
    peers: peerList(room),
    owners: Object.fromEntries(room.owners),
    locks: Object.fromEntries(room.locks),
    things: [...room.ents.values()].map((e) => [e.id, e.c, e.at, e.imp, ...e.v.map((v) => (v === undefined ? null : v))]),
    states: [...room.states].map(([name, s]) => ({ name, from: s.c, at: s.at, where: s.w, important: s.imp, copy: s.copy })),
    recent: [...room.seqs].map(([from, seq]) => ({ from, seq })),
  };
}
/** Loads a snapshot into an empty room (its connections join after). */
export function seed(room, snap) {
  if (!snap || typeof snap !== 'object') return;
  if (Number.isFinite(snap.epoch)) room.epoch = Math.max(room.epoch, snap.epoch);
  for (const [k, v] of Object.entries(snap.owners || {})) room.owners.set(k, String(v));
  for (const [k, v] of Object.entries(snap.locks || {})) room.locks.set(k, String(v));
  for (const t of Array.isArray(snap.things) ? snap.things.slice(0, room.limits.ents) : []) {
    if (!Array.isArray(t) || typeof t[0] !== 'string' || room.ents.has(t[0])) continue;
    const slot = room.free.length ? room.free.pop() : room.slots.length;
    const ent = { id: t[0], slot, gen: ++room.gen, k: keyOf(room, t[0]), c: String(t[1]), at: num(t[2]) ?? 0, imp: Boolean(t[3]), v: t.slice(4, 4 + VALUES).map((v) => num(v)) };
    while (ent.v.length < VALUES) ent.v.push(undefined);
    room.slots[slot] = ent;
    room.ents.set(t[0], ent);
  }
  for (const s of Array.isArray(snap.states) ? snap.states.slice(0, room.limits.states) : []) {
    if (!s || typeof s.name !== 'string') continue;
    room.states.set(s.name, { copy: s.copy && typeof s.copy === 'object' ? { ...s.copy } : {}, c: String(s.from ?? ''), at: num(s.at) ?? 0, w: Array.isArray(s.where) ? s.where : null, imp: Boolean(s.important) });
  }
  for (const r of Array.isArray(snap.recent) ? snap.recent : []) if (r && typeof r.from === 'string' && num(r.seq)) room.seqs.set(r.from, Math.max(room.seqs.get(r.from) || 0, r.seq));
}

// ===================================================================== the snapshot buffer (Track)
// A buffer of stamped snapshots of some numbers, played back smoothly a little in the past: positions lerped, turns
// slerped, short gaps carried on by velocity, corrections blended out (from the portal's public/play/net.js Track).
// `clock()` gives the shared clock; `links` (optional, shared by a room) learns how late each sender's data arrives.
function lerpAngle(a, b, k) { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return a + d * k; }
function eulerToQuat(x, y, z, out) {
  // Babylon's order (YXZ): q = qy * qx * qz
  const cx = Math.cos(x / 2), sx = Math.sin(x / 2), cy = Math.cos(y / 2), sy = Math.sin(y / 2), cz = Math.cos(z / 2), sz = Math.sin(z / 2);
  out[0] = cy * sx * cz + sy * cx * sz;
  out[1] = sy * cx * cz - cy * sx * sz;
  out[2] = cy * cx * sz - sy * sx * cz;
  out[3] = cy * cx * cz + sy * sx * sz;
  return out;
}
function quatToEuler(q, out) {
  const [x, y, z, w] = q;
  const sinX = 2 * (w * x - y * z);
  out[0] = Math.abs(sinX) >= 1 ? Math.sign(sinX) * Math.PI / 2 : Math.asin(sinX);
  out[1] = Math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y));
  out[2] = Math.atan2(2 * (x * y + w * z), 1 - 2 * (x * x + z * z));
  return out;
}
function slerp(a, b, k, out) {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let ka, kb;
  if (cos > 0.9995) { ka = 1 - k; kb = k; } else { const th = Math.acos(cos), s = Math.sin(th); ka = Math.sin((1 - k) * th) / s; kb = Math.sin(k * th) / s; }
  out[0] = a[0] * ka + bx * kb; out[1] = a[1] * ka + by * kb; out[2] = a[2] * ka + bz * kb; out[3] = a[3] * ka + bw * kb;
  const l = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
  for (let i = 0; i < 4; i++) out[i] /= l;
  return out;
}
const qa = [0, 0, 0, 1], qb = [0, 0, 0, 1], qc = [0, 0, 0, 1], ve = [0, 0, 0];

export class Links {
  constructor(clock) { this.clock = clock; this.map = new Map(); }
  note(from, at) {
    const d = this.clock() - at;
    if (!Number.isFinite(d)) return;
    let l = this.map.get(from);
    if (!l) { l = { transit: d, jit: 8, n: 0 }; this.map.set(from, l); }
    l.n++;
    if (d < l.transit) l.transit += (d - l.transit) * 0.3; else l.transit += (d - l.transit) * 0.01;
    l.jit += (Math.max(0, d - l.transit) - l.jit) * 0.06;
  }
  get(from) { return this.map.get(from); }
  delete(from) { this.map.delete(from); }
}

export class Track {
  /** o: { pos: [i, i, i], vel: [i, i, i] | null, euler: [i, i, i] | null, yaw: [i...], quat: [i, i, i, i] | null, maxAhead }; env: { clock, links, wall, stats } */
  constructor(o = {}, env = {}) {
    this.o = { pos: [0, 1, 2], vel: null, euler: null, yaw: [], quat: null, maxAhead: o.vel ? 450 : 250, ...o };
    this.clock = env.clock || (() => Date.now());
    this.wall = env.wall || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.links = env.links || null;
    this.statsRef = env.stats || null;
    this.buf = []; this.gaps = []; this.interval = 100; this.delay = null; this.at = 0; this.from = null; this.out = []; this.ahead = 0;
  }
  get size() { return this.buf.length; }
  get newest() { return this.buf.length ? this.buf[this.buf.length - 1] : null; }
  still(s) {
    const o = this.o;
    if (!o.pos) return true;
    if (o.vel) return Math.abs(s.v[o.vel[0]]) + Math.abs(s.v[o.vel[1]]) + Math.abs(s.v[o.vel[2]]) < 0.1;
    const b = this.buf, i = b.indexOf(s), p = i > 0 ? b[i - 1] : null;
    if (!p) return true;
    const d = Math.abs(s.v[o.pos[0]] - p.v[o.pos[0]]) + Math.abs(s.v[o.pos[1]] - p.v[o.pos[1]]) + Math.abs(s.v[o.pos[2]] - p.v[o.pos[2]]);
    return (d / Math.max(1, s.at - p.at)) * 1000 < 0.1;
  }
  push(at, vals, from) {
    if (!Number.isFinite(at)) at = this.clock();
    const b = this.buf;
    const last = b[b.length - 1];
    if (last && at <= last.at) { if (at === last.at) last.v = vals.slice(); return; } // late (out of order): dropped
    if (last) {
      const gap = at - last.at;
      this.gaps.push(gap); if (this.gaps.length > 9) this.gaps.shift();
      const sorted = [...this.gaps].sort((x, y) => x - y);
      this.interval = Math.max(16, Math.min(3000, sorted[Math.floor(sorted.length / 2)]));
      // It rested (nothing was sent because it wasn't moving): it stayed where it was until just before it moved again.
      if (gap > this.interval * 2.5 && this.still(last)) b.push({ at: at - Math.min(gap / 2, this.interval), v: last.v.slice() });
    }
    b.push({ at, v: vals.slice() });
    while (b.length > 3 && b[1].at < at - 3000) b.shift();
    while (b.length > 48) b.shift();
    if (from) { this.from = from; this.links?.note(from, at); }
  }
  target() {
    const l = this.from && this.links?.get(this.from);
    const transit = l ? l.transit : 60, jit = l ? l.jit : 10;
    return Math.max(0, transit) + Math.min(this.interval, 1500) * 1.05 + jit * 2.5 + 8;
  }
  sample(now = this.clock()) {
    const b = this.buf;
    if (!b.length) return null;
    const wall = this.wall();
    const want = this.target();
    if (this.delay === null || wall - this.at > 1000) this.delay = want;
    else { const room = (wall - this.at) * 0.1; this.delay += Math.max(-room, Math.min(room, want - this.delay)); }
    this.at = wall;
    const rt = now - this.delay;
    const o = this.o, out = this.out;
    const was = this.ahead > 0 && this.out.length && o.pos ? o.pos.map((p) => this.out[p]) : null;
    const r = this.read(rt, b);
    if (was && this.ahead <= 0 && o.pos) {
      const d = o.pos.map((p, k) => was[k] - out[p]);
      const len = Math.hypot(d[0], d[1], d[2]);
      if (len > 0.01 && len < 10) { this.err = d; this.errAt = wall; }
    }
    if (this.err && o.pos) {
      const k = Math.exp(-(wall - this.errAt) / 90);
      if (k < 0.02) this.err = null;
      else for (let j = 0; j < 3; j++) out[o.pos[j]] += this.err[j] * k;
    }
    return r;
  }
  read(rt, b) {
    const o = this.o, out = this.out;
    let i = b.length - 1;
    while (i > 0 && b[i].at > rt) i--;
    const a = b[i];
    if (i === b.length - 1 || rt < a.at) {
      const ahead = rt < a.at ? 0 : Math.min(rt - a.at, o.maxAhead);
      this.ahead = rt - a.at;
      for (let k = 0; k < a.v.length; k++) out[k] = a.v[k];
      if (ahead > 0 && o.pos) {
        const prev = b.length > 1 ? b[b.length - 2] : null;
        for (let k = 0; k < 3; k++) {
          const p = o.pos[k];
          const v = o.vel ? a.v[o.vel[k]] : prev ? ((a.v[p] - prev.v[p]) / Math.max(1, a.at - prev.at)) * 1000 : 0;
          out[p] = a.v[p] + v * (ahead / 1000);
        }
      }
      if (this.ahead > 0 && this.statsRef) this.statsRef.extrapolated = (this.statsRef.extrapolated || 0) + 1;
      return out;
    }
    const c = b[i + 1];
    const k = (rt - a.at) / Math.max(1e-3, c.at - a.at);
    this.ahead = 0;
    if (this.statsRef) this.statsRef.interpolated = (this.statsRef.interpolated || 0) + 1;
    for (let j = 0; j < a.v.length; j++) out[j] = a.v[j] + (c.v[j] - a.v[j]) * k;
    for (const j of o.yaw) out[j] = lerpAngle(a.v[j], c.v[j], k);
    if (o.euler) {
      const [x, y, z] = o.euler;
      eulerToQuat(a.v[x], a.v[y], a.v[z], qa);
      eulerToQuat(c.v[x], c.v[y], c.v[z], qb);
      slerp(qa, qb, k, qc);
      quatToEuler(qc, ve);
      out[x] = ve[0]; out[y] = ve[1]; out[z] = ve[2];
    }
    if (o.quat) {
      const [x, y, z, w] = o.quat;
      qa[0] = a.v[x]; qa[1] = a.v[y]; qa[2] = a.v[z]; qa[3] = a.v[w];
      qb[0] = c.v[x]; qb[1] = c.v[y]; qb[2] = c.v[z]; qb[3] = c.v[w];
      slerp(qa, qb, k, qc);
      out[x] = qc[0]; out[y] = qc[1]; out[z] = qc[2]; out[w] = qc[3];
    }
    return out;
  }
  latest(now = this.clock(), cap = 400) {
    const a = this.newest;
    if (!a) return null;
    const v = a.v.slice();
    const o = this.o;
    const dt = Math.max(0, Math.min(cap, now - a.at)) / 1000;
    if (o.pos && o.vel) for (let k = 0; k < 3; k++) v[o.pos[k]] += a.v[o.vel[k]] * dt;
    return v;
  }
  clear() { this.buf.length = 0; this.gaps.length = 0; this.delay = null; }
}

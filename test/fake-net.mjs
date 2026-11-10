// An in-memory stand-in for @hawkesgen/net, with the same calls the recipes use (lobby, rooms, send/on, pose/onPose,
// sync.state and sync.action with the first player as host). It lets `npm test` run the recipes' exact code with no
// network. Every player in a Hub that joins the same room name meets the others.
export class Hub {
  rooms = new Map(); n = 0;
  room(name) { if (!this.rooms.has(name)) this.rooms.set(name, []); return this.rooms.get(name); }
}
export const hub = new Hub();
const later = (fn) => queueMicrotask(fn);

class Emitter {
  h = new Map();
  on(k, fn) { (this.h.get(k) ?? this.h.set(k, new Set()).get(k)).add(fn); return () => this.h.get(k).delete(fn); }
  emit(k, v, ...rest) { for (const fn of [...(this.h.get(k) ?? [])]) fn(v, ...rest); }
}

class FakeLobby {
  constructor(o) {
    this.o = o; this.ev = new Emitter(); this.msgs = new Emitter(); this.poses = new Set();
    this.id = `p${++hub.n}`; this.status = 'off'; this.room = null; this.peers = new Map();
    this.states = new Map(); this.actions = new Map(); this.ord = 0;
    this.sync = {
      state: (name, def) => { this.states.set(name, def); return { remove: () => this.states.delete(name) }; },
      action: (name, run) => {
        this.actions.set(name, run);
        return (data) => {
          run(data, { authoritative: this.isHost });
          this.peersOfRoom().forEach((p) => later(() => { if (this.isHost || p.isHost) p.actions.get(name)?.(data, { authoritative: p.isHost }); if (this.isHost) p.pushState(); }));
          if (!this.isHost) later(() => this.host()?.pushState());
        };
      },
    };
  }
  get isHost() { return this.members()[0] === this; }
  members() { return this.room ? hub.room(this.room) : []; }
  peersOfRoom() { return this.members().filter((m) => m !== this); }
  host() { return this.members()[0]; }
  nameFor(area) { return `t-${area}`; }
  on(kind, fn) { return this.msgs.on(kind, fn); }
  when(ev, fn) { return this.ev.on(ev, fn); }
  onPose(fn) { this.poses.add(fn); return () => this.poses.delete(fn); }
  send(kind, data, opt = {}) {
    if (this.status !== 'online') return;
    for (const p of this.peersOfRoom()) if (!opt.to || opt.to === p.id) later(() => p.msgs.emit(kind, data, this.asPeer()));
  }
  pose(p, y = 0) { if (this.status !== 'online') return; for (const m of this.peersOfRoom()) later(() => m.poses.forEach((fn) => fn(this.id, { p, y }, 0))); }
  asPeer() { return { id: this.id, name: this.o.name ?? null }; }
  pushState() { // the host's states to everyone else
    if (!this.isHost) return;
    for (const m of this.peersOfRoom()) for (const [n, def] of this.states) { const d = m.states.get(n); if (d) d.set(def.get(), Object.keys(def.get())); }
  }
  join(area) {
    this.leave();
    this.room = this.nameFor(area); this.status = 'connecting'; this.ev.emit('status', { status: 'connecting' });
    later(() => {
      if (!this.room) return;
      const members = hub.room(this.room); members.push(this);
      this.status = 'online'; this.peers = new Map(); this.ord = members.length;
      for (const m of members) { if (m === this) continue; this.peers.set(m.id, m.asPeer()); m.peers.set(this.id, this.asPeer()); m.ev.emit('peer:join', this.asPeer()); }
      this.ev.emit('status', { status: 'online', peers: members.length - 1 });
      this.ev.emit('joined', this);
      later(() => this.host()?.pushState());
    });
  }
  leave() {
    if (!this.room) return;
    const members = hub.room(this.room), i = members.indexOf(this);
    if (i >= 0) members.splice(i, 1);
    for (const m of members) { m.peers.delete(this.id); m.ev.emit('peer:leave', { peer: this.asPeer(), reason: 'left' }); }
    this.room = null; this.status = 'off'; this.peers = new Map();
  }
}

export const lobby = (o = {}) => new FakeLobby(o);
export const VERSION = 'fake';

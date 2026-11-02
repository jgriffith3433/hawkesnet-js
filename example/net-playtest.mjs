// Hawkes Studio's playtest bot for a Hawkes Net demo page: window.hawkesPlaytest (Studio's docs/playtest.md, contract v1),
// so a Studio playtest checks real multiplayer instead of only loading the page. The same file is in hawkesnet
// (public/demo-playtest.mjs), hawkesnet-js and hawkesnet-babylon (example/net-playtest.mjs): change one, copy it to all.
//
//   smoke        this page's player and a second player the bot opens in this same page meet in one room on the page's
//                Hawkes Net, see each other move (this page's player moved by real input), trade messages both ways,
//                and the second one leaves. One browser is enough, so every playtest is a real two-player check.
//   two-players  two (or more) real browsers on one ?room= (Studio's peers playtest) find each other, move, and trade
//                messages.
//
// Each check shows on the page as it passes or fails (top right), so the video and screenshots say what happened, and the
// report's problems say which check failed and why. Nothing runs until Studio calls start() or the address has
// ?playtest=<id>; the page looks the same to players.
//
//   installNetPlaytest({
//     product: 'hawkes-net-js', where: 'beta Hawkes Net',
//     main: () => net,                                    // this page's room or lobby
//     openBot: async () => { const b = lobby({...same room...}); b.join(area); return b; },
//     drive: async (step) => { ...real input for a few seconds; await step(ms) between inputs... },
//     myPos: () => [x, y, z],                             // where this page's player is (what it sends)
//     shownPos: (id) => [x, y, z] | null,                 // where this page draws another player
//     botPose: (u) => [x, y, z],                          // the second player's path, u from 0 to 1 (it stops at 1)
//     tolerance: 0.02,                                    // "the same place", in the page's units
//     extra: async (c) => {},                             // optional more checks: c.check(name, fn), c.main, c.bot
//     ready: () => true,                                  // optional: the page is ready to play (default: main() exists)
//   });

export function installNetPlaytest(o) {
  const scenarios = [
    { id: 'smoke', title: 'Two players in one page meet in a room, move, message and leave', seconds: 45, tags: ['smoke'],
      description: 'Connects to the page\'s Hawkes Net, opens a second player in the same room, checks poses both ways (this page\'s player moved by real input), messages both ways, and the second player leaving.' },
    { id: 'two-players', title: 'Real browsers on one ?room= find each other, move and message', seconds: 75, tags: ['full', 'multiplayer'],
      description: 'Run with Studio peers 2-4: each browser waits for another player in its ?room=, moves by real input, checks it sees the other move and that messages go both ways.' },
  ];
  const STALL = 60;
  let run = null;
  let bot = null;

  // ---- the panel: one line per check
  const panel = document.createElement('div');
  panel.id = 'hawkes-net-playtest';
  panel.style.cssText = 'position:fixed;right:12px;top:12px;z-index:99999;max-width:360px;background:rgba(10,12,16,.82);color:#e8eaed;font:12px/1.5 ui-monospace,Menlo,monospace;padding:8px 12px;border-radius:8px;display:none;pointer-events:none';
  const show = () => {
    if (!run) return;
    if (!panel.isConnected) document.body.appendChild(panel);
    panel.style.display = 'block';
    const head = run.done ? (run.state.status === 'won' ? '<b style="color:#9fe870">PASS</b>' : `<b style="color:#ff7b72">${run.state.status === 'lost' ? 'FAIL' : run.state.status.toUpperCase()}</b>`) : '<b style="color:#ffd84d">running</b>';
    panel.innerHTML = `Playtest ${esc(run.id)} on ${esc(o.where ?? 'Hawkes Net')} · ${head}<br>` + run.lines.map((l) => `${l.ok === true ? '<span style="color:#9fe870">✓</span>' : l.ok === false ? '<span style="color:#ff7b72">✗</span>' : '…'} ${esc(l.text)}${l.why ? ` <span style="color:#9aa1ad">(${esc(l.why)})</span>` : ''}`).join('<br>');
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // ---- run bookkeeping (the contract's state and report)
  const now = () => (run ? (performance.now() - run.t0) / 1000 : 0);
  const event = (type, detail) => { if (!run) return; run.events.push({ t: r1(now()), type, ...(detail === undefined ? {} : { detail: String(detail) }) }); run.moved = performance.now(); };
  const metric = (k, v) => { if (run) run.metrics[k] = v; };
  const problem = (severity, message) => { if (!run || run.problems.some((p) => p.message === message)) return; run.problems.push({ severity, message }); event('problem', `${severity}: ${message}`); };
  const log = (line) => { if (run) { run.log.push(`${r1(now())}s ${line}`); if (run.log.length > 200) run.log.shift(); } };
  const progress = (p) => { if (run) { run.state.progress = Math.max(0, Math.min(1, p)); run.moved = performance.now(); } };
  const finish = (outcome) => {
    if (!run || run.done) return;
    run.done = true; run.state.status = outcome; run.seconds = now();
    run.state.note = outcome === 'won' ? 'all checks passed' : `${run.lines.filter((l) => l.ok === false).length} check(s) failed`;
    event('finish', outcome); show();
  };
  const wait = (ms) => new Promise((res, rej) => { const r = run; setTimeout(() => (r === run && !r.done ? res() : rej(new Error('playtest stopped'))), ms); });
  const until = (test, ms, what) => new Promise((res, rej) => {
    const r = run, t0 = performance.now();
    const tick = () => {
      if (r !== run || r.done) return rej(new Error('playtest stopped'));
      let v = false; try { v = test(); } catch { /* not yet */ }
      if (v) return res(performance.now() - t0);
      if (performance.now() - t0 > ms) return rej(new Error(`timed out after ${Math.round(ms / 1000)} s waiting for ${typeof what === 'function' ? what() : what}`));
      setTimeout(tick, 50);
    };
    tick();
  });
  /** One check: a line on the page, an event, and a problem when it fails. Returns whether it passed. */
  async function check(text, fn) {
    const line = { text, ok: null, why: '' };
    run.lines.push(line); show(); event('check', text);
    try {
      const why = await fn();
      line.ok = true; line.why = typeof why === 'string' ? why : '';
      event('pass', text); run.metrics.checksPassed = (run.metrics.checksPassed ?? 0) + 1;
    } catch (e) {
      if (String(e?.message) === 'playtest stopped') throw e;
      line.ok = false; line.why = String(e?.message ?? e).slice(0, 200);
      problem('bug', `${text}: ${line.why}`); event('fail', text); run.metrics.checksFailed = (run.metrics.checksFailed ?? 0) + 1;
    }
    show();
    return line.ok;
  }

  // ---- the network side
  const isOnline = (n) => Boolean(n && (n.ready === true || n.status === 'online'));
  const near = (a, b, tol) => Boolean(a && b && Math.hypot(a[0] - b[0], (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0)) <= tol);
  const fmt = (p) => (p ? `[${p.map((v) => Math.round(v * 100) / 100).join(', ')}]` : 'nothing');
  const tol = o.tolerance ?? 0.05;
  let lastProblem = '';
  // Pings from anyone get a pong (the other browser in two-players, the bot in smoke). Installed once the page's net exists.
  const pongs = new Map(); // nonce -> resolve
  const pingsFrom = new Map(); // peer id -> count
  const wire = (n, who) => {
    if (!n || n.__hnpt) return;
    n.__hnpt = true;
    n.on('hn-pt-ping', (d, from) => {
      if (from?.id) pingsFrom.set(`${who}:${from.id}`, (pingsFrom.get(`${who}:${from.id}`) ?? 0) + 1);
      n.send('hn-pt-pong', d, from?.id ? { to: from.id } : undefined);
    });
    n.on('hn-pt-pong', (d) => { const f = pongs.get(`${who}:${d?.n}`); if (f) { pongs.delete(`${who}:${d?.n}`); f(); } });
    n.when('problem', (e) => { lastProblem = `${e?.code ?? 'problem'}: ${e?.detail ?? ''}`.trim(); if (run) log(`${who} problem ${lastProblem}`); });
  };
  const watchMain = setInterval(() => { const m = o.main(); if (m) { wire(m, 'main'); clearInterval(watchMain); } }, 100);
  /** Round trips from `from` to peer `to`: count pings, each answered within `ms`. Resolves with the median ms. */
  async function roundTrips(from, who, to, count = 5, ms = 5000) {
    const times = [];
    for (let i = 0; i < count; i++) {
      const n = `${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 6)}`;
      const t0 = performance.now();
      const got = new Promise((res) => pongs.set(`${who}:${n}`, res));
      from.send('hn-pt-ping', { n }, { to });
      await Promise.race([got, wait(ms).then(() => { throw new Error(`no answer to message ${i + 1} of ${count} within ${ms / 1000} s`); })]);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return Math.round(times[Math.floor(times.length / 2)]);
  }
  const step = (ms) => wait(ms);

  async function smoke() {
    let main = o.main();
    const okConnect = await check(`Connected to ${o.where ?? 'Hawkes Net'}`, async () => {
      const ms = await until(() => { main = o.main(); if (main) wire(main, 'main'); return isOnline(main); }, 20000, () => `the room to say online (${main ? `status ${main.status ?? '?'}` : "the page's client wasn't made"}${main?.lastProblem || lastProblem ? `, last problem: ${main?.lastProblem || lastProblem}` : ''})`);
      metric('joinMs', Math.round(ms)); log(`main online as ${main.id} in ${main.roomName ?? main.room ?? ''}`);
      return `${Math.round(ms)} ms`;
    });
    progress(0.15);
    if (!okConnect) return finish('lost');
    let poses = [];
    const okJoin = await check('A second player joined the same room', async () => {
      bot = await o.openBot();
      wire(bot, 'bot');
      bot.onPose((id, s) => { if (id === main.id && Array.isArray(s?.p)) poses.push(s.p.slice(0, 3)); });
      const ms = await until(() => isOnline(bot) && main.peers.has(bot.id) && bot.peers.has(main.id), 15000, 'both players to see each other');
      metric('secondJoinMs', Math.round(ms));
      return `${Math.round(ms)} ms`;
    });
    progress(0.3);
    if (!okJoin) return finish('lost');
    // The bot moves along its path while this page's player is moved by real input.
    let u = 0;
    const botTick = setInterval(() => { try { u = Math.min(1, u + 0.02); bot.pose(o.botPose(u), 0); } catch { /* left */ } }, 50);
    try {
      await check("This player's moves reach the other player", async () => {
        poses = [];
        const from = o.myPos().slice();
        await o.drive(step);
        const to = o.myPos().slice();
        if (near(from, to, tol)) throw new Error(`real input didn't move this page's player (still at ${fmt(to)})`);
        const ms = await until(() => near(poses[poses.length - 1], o.myPos(), tol), 5000, () => `the other player to see this one at ${fmt(o.myPos())} (it last saw ${fmt(poses[poses.length - 1])})`);
        metric('poseLagMs', Math.round(ms)); metric('posesSeen', poses.length);
        return `${poses.length} updates, caught up in ${Math.round(ms)} ms`;
      });
      progress(0.5);
      await check("The other player's moves show here", async () => {
        await until(() => u >= 1, 6000, 'the second player to finish its path');
        const target = o.botPose(1);
        const ms = await until(() => near(o.shownPos(bot.id), target, tol), 5000, () => `this page to draw the other player at ${fmt(target)} (it shows ${fmt(o.shownPos(bot.id))})`);
        metric('peerPoseLagMs', Math.round(ms));
        return `shown at ${fmt(o.shownPos(bot.id))}`;
      });
    } finally { clearInterval(botTick); }
    progress(0.65);
    await check('Messages go both ways', async () => {
      const a = await roundTrips(main, 'main', bot.id);
      const b = await roundTrips(bot, 'bot', main.id);
      metric('rttMs', a); metric('rttBackMs', b);
      return `round trip ${a} ms / ${b} ms`;
    });
    progress(0.8);
    if (o.extra) await o.extra({ check, main, bot, until, wait, metric, roundTrips: (f, w, t) => roundTrips(f, w, t) });
    await check('The second player left and this page saw it', async () => {
      const id = bot.id;
      await bot.leave();
      const ms = await until(() => !main.peers.has(id), 10000, 'the room to drop the second player');
      metric('leaveMs', Math.round(ms));
      return `${Math.round(ms)} ms`;
    });
    bot = null;
    progress(1);
    finish(run.lines.every((l) => l.ok) ? 'won' : 'lost');
  }

  async function twoPlayers() {
    let main = o.main();
    const room = new URLSearchParams(location.search).get('room');
    if (!room) problem('warning', 'no ?room= on the address: playing in the shared demo room, where strangers may be');
    const okConnect = await check(`Connected to ${o.where ?? 'Hawkes Net'}`, async () => {
      const ms = await until(() => { main = o.main(); if (main) wire(main, 'main'); return isOnline(main); }, 20000, () => `the room to say online (${main ? `status ${main.status ?? '?'}` : "the page's client wasn't made"}${main?.lastProblem || lastProblem ? `, last problem: ${main?.lastProblem || lastProblem}` : ''})`);
      metric('joinMs', Math.round(ms));
      return `${Math.round(ms)} ms${room ? ` in room ${room}` : ''}`;
    });
    if (!okConnect) return finish('lost');
    progress(0.2);
    const others = () => [...main.peers.keys()].filter((id) => id !== main.id);
    let other = null;
    const okMeet = await check('Another player is in the room', async () => {
      const ms = await until(() => others().length > 0, 60000, 'another browser to join');
      other = others()[0];
      metric('players', others().length + 1); metric('meetMs', Math.round(ms));
      return `${others().length + 1} players`;
    });
    if (!okMeet) return finish('lost');
    progress(0.4);
    // Keep moving for the rest of the run: the other browser may start watching after this one has made its first moves
    // (it found us later, or plays slower), and it must still see this player move.
    const r = run;
    (async () => { try { while (r === run && !r.done) await o.drive(step); } catch { /* the run ended */ } })();
    await check("The other player's moves show here", async () => {
      let first = o.shownPos(other)?.slice() ?? null;
      await until(() => { const p = o.shownPos(other); if (p && !first) first = p.slice(); return p && first && !near(p, first, tol); }, 15000, 'the other player to move on this page');
      return `now at ${fmt(o.shownPos(other))}`;
    });
    progress(0.7);
    await check('Messages go both ways', async () => {
      const ms = await roundTrips(main, 'main', other);
      await until(() => (pingsFrom.get(`main:${other}`) ?? 0) > 0, 20000, 'a message from the other player');
      metric('rttMs', ms);
      return `round trip ${ms} ms`;
    });
    progress(1);
    // Stay a little so the other browser can finish its own checks against this one.
    await wait(8000);
    finish(run.lines.every((l) => l.ok) ? 'won' : 'lost');
  }

  const api = {
    version: 1,
    product: o.product,
    scenarios: () => scenarios.map((s) => ({ ...s })),
    async start(id, options = {}) {
      const sc = scenarios.find((s) => s.id === id);
      if (run && !run.done) api.stop();
      run = { id, options: { seed: 1, speed: 1, ...options }, t0: performance.now(), moved: performance.now(), done: false, lines: [],
        state: { ready: true, status: 'running', progress: 0, scene: 'Demo' }, metrics: {}, events: [], problems: [], log: [] };
      const mine = run;
      event('start', id); event('scene', 'Demo'); show();
      try {
        if (!sc) { problem('bug', `no playtest scenario "${id}" (have: ${scenarios.map((s) => s.id).join(', ')})`); return finish('error'); }
        await (id === 'two-players' ? twoPlayers() : smoke());
      } catch (e) {
        if (mine === run && !mine.done) { problem('bug', `bot error: ${e?.message ?? e}`); log(String(e?.stack ?? e)); finish('error'); }
      } finally {
        if (mine === run && bot) { try { await bot.leave(); } catch { /* gone */ } bot = null; }
      }
    },
    stop() { if (run && !run.done) finish('done'); if (bot) { try { bot.leave(); } catch { /* gone */ } bot = null; } },
    state() {
      const ready = o.ready ? Boolean(o.ready()) : Boolean(o.main());
      if (!run) return { ready, status: 'idle' };
      if (!run.done && performance.now() - run.moved > STALL * 1000) { problem('bug', `no progress for ${STALL} s (softlock?)`); finish('stuck'); }
      return { ...run.state, ready, metrics: { ...run.metrics } };
    },
    report() {
      if (!run) return null;
      return { scenario: run.id, outcome: run.done ? run.state.status : 'stuck', seconds: r1(run.seconds ?? now()), metrics: { ...run.metrics },
        events: run.events.slice(), problems: run.problems.slice(), log: [...run.lines.map((l) => `${l.ok ? 'PASS' : l.ok === false ? 'FAIL' : '...'} ${l.text}${l.why ? ` (${l.why})` : ''}`), ...run.log] };
    },
  };
  window.hawkesPlaytest = api;
  addEventListener('error', (e) => problem('bug', `page error: ${e.message ?? e}`));
  addEventListener('unhandledrejection', (e) => problem('bug', `page error: ${e.reason?.message ?? e.reason ?? e}`));

  const q = new URLSearchParams(location.search);
  const auto = q.get('playtest');
  if (auto) { const go = () => ((o.ready ? o.ready() : o.main()) ? api.start(auto, { seed: Number(q.get('seed')) || 1 }) : setTimeout(go, 250)); go(); }
  return api;
}

const r1 = (n) => Math.round(n * 10) / 10;

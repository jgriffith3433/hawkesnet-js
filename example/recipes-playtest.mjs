// The demo's `recipes` playtest scenario: each recipe on the recipes page is run live, as written, and a second player (the
// bot, its own lobby) does the other side of it, so the review sees every recipe work between two players. Rooms are
// unique to the run (a suffix on each recipe's area, a fresh password) so strangers and earlier runs never join in.
import { RECIPES, runLive, sourceOf } from './recipes.mjs';

export function recipesScenario({ lobby, opts, pointer, sdk, hash }) {
  const tag = Math.random().toString(36).slice(2, 7);
  const by = (id) => RECIPES.find((r) => r.id === id);
  const bots = [];
  const bot = (area, name = 'Bot') => { const b = lobby({ ...opts, name, log: false }); b.join(area); bots.push(b); return b; };
  const lines = [];
  const logTo = (l) => lines.push(l);
  const online = (c, b, what) => c.until(() => b.ready, 15000, `${what} to be online`);
  // What each recipe prints when it works, and the other player (if any) it needs to hear something.
  const EXPECT = {
    chat: { re: /you: hi, anyone here\?/ },
    cursors: { re: /Bot is at 0\.70, 0\.20/, bot: (b) => setInterval(() => b.pose([0.7, 0.2, 0]), 300), area: 'recipe-cursors' },
    'shared-state': { re: /score: \d+/ },
    'password-room': { re: /Bot: hi from the vault/, bot: (b) => setInterval(() => b.send('chat', 'hi from the vault'), 700) },
    // Tag Run logs play: … then It:; no second player needed for the button check (recipe alone is host).
    tag: { re: /play:.*Tag room|It:/ },
  };
  const frames = [];
  const open = (url, w, h) => new Promise((res, rej) => {
    const f = document.createElement('iframe');
    f.src = url; f.title = `Recipes page ${w} x ${h}`;
    const scale = Math.min(1, innerWidth / w, (innerHeight - 24) / h);
    f.style.cssText = `position:fixed;left:0;top:12px;width:${w}px;height:${h}px;border:2px solid #3a4150;background:#0b0f14;z-index:99990;transform-origin:top left;transform:scale(${scale})`;
    f.addEventListener('load', () => res(f), { once: true });
    f.addEventListener('error', () => rej(new Error(`could not open ${url}`)), { once: true });
    document.body.append(f); frames.push(f);
  });
  const closeFrames = () => { while (frames.length) frames.pop().remove(); };

  async function buttonsAndLinks(c) {
    const page = new URL('./recipes.html', location.href).href;
    const runAll = async (w, h, tagName) => {
      let run = 0, passed = 0; const failed = [];
      for (const r of RECIPES) {
        const ex = EXPECT[r.id] ?? { re: /\S/ };
        let timer = null, b = null;
        const f = await open(page, w, h), d = f.contentDocument;
        try {
          await c.until(() => d.querySelector(`#${r.id} .run`) && d.querySelector(`#${r.id} pre.code`).textContent !== 'Loading…', 15000, `${r.title} to load at ${w}x${h}`);
          if (ex.bot) { b = bot(ex.area ?? `vault-${(await hash(`my-game/${r.password}`)).slice(0, 16)}`); await online(c, b, 'the other player'); timer = ex.bot(b); }
          const btn = d.querySelector(`#${r.id} .run`), out = d.querySelector(`#${r.id} pre.out`);
          btn.click(); run++;
          try { await c.until(() => ex.re.test(out.textContent), 5000, `${r.title} to print its result`); passed++; }
          catch { failed.push(`${r.title} (printed: ${JSON.stringify(out.textContent.slice(-80))})`); }
          await c.wait(400);
        } finally { clearInterval(timer); if (b) { try { b.leave(); } catch { /* gone */ } } f.remove(); frames.splice(frames.indexOf(f), 1); }
      }
      return { run, passed, failed, tagName };
    };
    await c.check('Run it here on every recipe prints its result within 5 s (1280x720)', async () => {
      const r = await runAll(1280, 720, 'desktop');
      c.metric('recipesRun', r.run); c.metric('recipesPassed', r.passed);
      if (r.run !== RECIPES.length) throw new Error(`pressed ${r.run} of ${RECIPES.length}`);
      if (r.failed.length) throw new Error(`no result in 5 s: ${r.failed.join('; ')}`);
      return `${r.passed} of ${r.run} recipes passed`;
    });
    c.progress(0.92);
    await c.check('The same at phone size (390x844)', async () => {
      const r = await runAll(390, 844, 'phone');
      c.metric('recipesPassedPhone', r.passed);
      if (r.failed.length) throw new Error(`no result in 5 s: ${r.failed.join('; ')}`);
      return `${r.passed} of ${r.run} recipes passed`;
    });
    c.progress(0.97);
    await c.check('Every link on the demo and recipes pages answers without leaving the site', async () => {
      const f = await open(page, 1280, 720);
      await c.until(() => f.contentDocument.querySelectorAll('#toc a, section.recipe').length >= RECIPES.length * 2, 15000, 'the recipes page to build its links');
      const docs = { [new URL('./recipes.html', location.href).href]: f.contentDocument };
      const demoUrl = new URL('./index.html', location.href).href;
      docs[demoUrl] = new DOMParser().parseFromString(await (await fetch(demoUrl)).text(), 'text/html');
      const startUrl = new URL('./start.html', location.href).href;
      docs[startUrl] = new DOMParser().parseFromString(await (await fetch(startUrl)).text(), 'text/html');
      const cache = new Map(), broken = []; let checked = 0, external = 0;
      for (const [from, doc] of Object.entries(docs)) {
        for (const a of doc.querySelectorAll('a[href]')) {
          const raw = a.getAttribute('href'); if (/^(mailto:|javascript:)/.test(raw)) continue;
          const u = new URL(raw, from);
          if (u.origin !== location.origin) { external++; continue; }
          checked++;
          const key = u.origin + u.pathname;
          if (!cache.has(key)) cache.set(key, fetch(key).then(async (res) => ({ ok: res.ok, status: res.status, html: res.ok && /html/.test(res.headers.get('content-type') || '') ? await res.text() : '' }), () => ({ ok: false, status: 'unreachable', html: '' })));
          const got = await cache.get(key);
          if (!got.ok) { broken.push(`${raw} (${got.status})`); continue; }
          if (u.hash) {
            const id = decodeURIComponent(u.hash.slice(1));
            const live = docs[key]; // the recipes page builds its sections in script
            const has = live ? live.getElementById(id) : new DOMParser().parseFromString(got.html, 'text/html').getElementById(id);
            if (!has) broken.push(`${raw} (no #${id})`);
          }
        }
      }
      closeFrames();
      c.metric('linksChecked', checked); c.metric('linksBroken', broken.length); c.metric('linksExternalSkipped', external);
      if (broken.length) throw new Error(`broken: ${broken.join('; ')}`);
      return `${checked} links answer, ${external} external ones to other sites not followed`;
    });
  }

  return {
    id: 'recipes', title: 'Each recipe has a live link and plays between two players', seconds: 210, tags: ['full', 'docs'],
    description: 'Checks the demo links to every recipe (chat, cursors, shared state, a room with a password, Tag), that each shows its code, and plays each one live with a second player: a message both ways, a cursor moved by pointer input, a shared score, a password room that a wrong password does not reach, and Tag (host It syncs to a joiner; Run opens the demo). Then opens the recipes page at 1280x720 and at 390x844, presses Run it here on every recipe and expects each to print its result within 5 s, and checks every link on the demo and recipes pages answers (recipesRun, recipesPassed, linksBroken).',
    run: async (c) => {
      try {
        await c.check('The demo links to every recipe', async () => {
          const links = [...document.querySelectorAll('#recipe-links a')];
          for (const r of RECIPES) if (!links.some((a) => new URL(a.href, location.href).hash === `#${r.id}` && /recipes\.html/.test(a.href))) throw new Error(`no link to the ${r.title} recipe`);
          return `${links.length} links`;
        });
        c.progress(0.1);
        await c.check('Each recipe has its code, using the published package', async () => {
          for (const r of RECIPES) {
            const src = await sourceOf(r, './recipes/');
            if (!/from '@hawkesgen\/net'/.test(src) || src.split('\n').length < 6) throw new Error(`${r.title}: code not found`);
          }
          return `${RECIPES.length} recipes`;
        });
        c.progress(0.2);
        const swapArea = (r) => [[`'${r.area}'`, `'${r.area}-${tag}'`]];
        const play = async (id, extra, fn) => {
          const r = by(id); lines.length = 0;
          await c.check(`${r.title}: runs live between two players`, async () => {
            const b = bot(`${r.area}-${tag}`);
            await online(c, b, 'the second player');
            const h = await runLive(r, { sdk, log: logTo, swap: [...swapArea(r), ...extra] });
            try { return await fn(b, h); } finally { h.stop(); }
          });
        };
        await play('chat', [], async (b) => {
          const heard = []; b.on('chat', (t, from) => heard.push(`${from.name}: ${t}`));
          await c.until(() => heard.length > 0, 15000, 'the recipe\'s hello to reach the second player');
          b.send('chat', 'hello back');
          await c.until(() => lines.includes('Bot: hello back'), 15000, () => `the recipe to print the reply (it printed: ${lines.join(' | ')})`);
          return `heard "${heard[0]}", printed "Bot: hello back"`;
        });
        c.progress(0.4);
        await play('cursors', [], async (b) => {
          const seen = []; b.onPose((id, s) => seen.push(s.p));
          // a real pointer move, as the recipe listens for it
          const at = [0.3, 0.6];
          await c.until(() => { pointer(at[0], at[1]); return seen.some((p) => Math.hypot(p[0] - at[0], p[1] - at[1]) < 0.02); }, 10000, 'the second player to see this cursor');
          b.pose([0.7, 0.2, 0]);
          await c.until(() => lines.some((l) => l.includes('Bot is at 0.70, 0.20')), 10000, () => `the recipe to print the bot's cursor (it printed: ${lines.slice(-3).join(' | ')})`);
          return 'cursor both ways';
        });
        c.progress(0.55);
        await (async () => {
          const r = by('shared-state'); lines.length = 0;
          await c.check(`${r.title}: runs live between two players`, async () => {
            const b = bot(`${r.area}-${tag}`); let score = 10; // the bot is the host and starts the score at 10
            b.when('joined', (room) => {
              room.sync.state('scoreboard', { get: () => ({ score }), set: () => {} });
              room.sync.action('addPoints', (n) => { score += n; });
            });
            await online(c, b, 'the host');
            await c.until(() => b.room?.isHost, 5000, 'the second player to be the host');
            const h = await runLive(r, { sdk, log: logTo, swap: swapArea(r) });
            try {
              await c.until(() => score === 11, 15000, () => `the recipe's point to reach the host (score ${score})`);
              await c.until(() => lines.includes('score: 11'), 15000, () => `the recipe to show the host's score plus its own point (it printed: ${lines.join(' | ')})`);
            } finally { h.stop(); }
            return 'host 10, recipe added 1, both show 11';
          });
        })();
        c.progress(0.7);
        const password = `swordfish-${tag}`;
        const code = (await hash(`my-game/${password}`)).slice(0, 16);
        await c.check('A room with a password: the right one meets, a wrong one does not', async () => {
          const right = bot(`vault-${code}`), wrong = bot(`vault-${(await hash('my-game/not-it')).slice(0, 16)}`);
          const heard = [], overheard = [];
          right.on('chat', (t, from) => heard.push(`${from.name}: ${t}`)); wrong.on('chat', (t, from) => overheard.push(t));
          await Promise.all([online(c, right, 'the right room'), online(c, wrong, 'the wrong room')]);
          lines.length = 0;
          const r = by('password-room');
          const h = await runLive(r, { sdk, log: logTo, swap: [[`'${r.password}'`, JSON.stringify(password)]] });
          try {
            await c.until(() => heard.includes('Ada: we have the right password'), 15000, () => `the right room to hear the recipe (heard ${JSON.stringify(heard)})`);
            await c.wait(1500);
            if (overheard.length) throw new Error(`the wrong room heard ${JSON.stringify(overheard)}`);
          } finally { h.stop(); }
          return 'the right room heard it, the wrong room heard nothing';
        });
        c.progress(0.8);
        // Tag: recipe joins first so it is host and picks It; a second lobby receives the same It via sync.
        await (async () => {
          const r = by('tag'); lines.length = 0;
          await c.check(`${r.title}: host It reaches a second player; Run opens the demo room`, async () => {
            if (!r.openDemo) throw new Error('Tag recipe must set openDemo to the demo page');
            const h = await runLive(r, { sdk, log: logTo, swap: swapArea(r) });
            try {
              await c.until(() => lines.some((l) => /^It:/.test(l)), 15000, () => `host to pick It (printed: ${lines.join(' | ')})`);
              let seen = null;
              const b = lobby({ ...opts, name: 'Bot', log: false });
              bots.push(b);
              b.when('joined', (room) => {
                room.sync.state('tag', { get: () => ({}), set: (s) => { seen = s; } });
                room.sync.action('tag:state', (s) => { seen = s; });
                room.sync.action('tag:touch', () => {});
              });
              b.join(`${r.area}-${tag}`);
              await online(c, b, 'the second Tag player');
              await c.until(() => seen?.it, 15000, () => `second player to learn who is It (seen ${JSON.stringify(seen)})`);
              c.event('tag-recipe-it', seen.it);
              return `It ${seen.it}; openDemo ${r.openDemo}`;
            } finally { h.stop(); }
          });
        })();
        c.progress(0.88);
        await buttonsAndLinks(c);
      } finally { closeFrames(); for (const b of bots) { try { b.leave(); } catch { /* gone */ } } }
    },
  };
}

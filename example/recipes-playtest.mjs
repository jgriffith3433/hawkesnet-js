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
  return {
    id: 'recipes', title: 'Each recipe has a live link and plays between two players', seconds: 110, tags: ['full', 'docs'],
    description: 'Checks the demo links to the four recipes (chat, cursors, shared state, a room with a password), that each shows its code, and plays each one live with a second player: a message both ways, a cursor moved by pointer input, a shared score, and a password room that a wrong password does not reach.',
    run: async (c) => {
      try {
        await c.check('The demo links to all four recipes', async () => {
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
          return 'four recipes';
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
        c.progress(0.75);
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
      } finally { for (const b of bots) { try { b.leave(); } catch { /* gone */ } } }
    },
  };
}

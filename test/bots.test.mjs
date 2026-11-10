import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lobby } from './fake-net.mjs';
import { createTag, TAG_RADIUS } from '../example/tag.mjs';
import { createBots, ALONE_MS, TARGET_TOTAL } from '../example/bots.mjs';

const flush = () => new Promise((r) => setTimeout(r, 15));

test('bots: alone host fills to 3 after aloneMs, labelled Bot with distinct colours', async () => {
  let clockMs = 100_000;
  const now = () => clockMs;
  const a = lobby({ name: 'Ada' });
  const tag = createTag(a, { now });
  const bots = createBots(a, { tag, now, aloneMs: 100, myPos: () => [0.5, 0.5] });

  a.join('bots-alone');
  await flush();
  bots.tick(clockMs);
  assert.equal(bots.count, 0, 'no bots before aloneMs');

  clockMs += 100;
  bots.tick(clockMs);
  assert.equal(bots.count, 3, '3 bots after aloneMs');
  assert.equal(ALONE_MS, 3000);
  assert.equal(TARGET_TOTAL, 4);
  const list = bots.list();
  assert.ok(list.every((b) => b.name === 'Bot'));
  assert.equal(new Set(list.map((b) => b.color)).size, 3);
  assert.equal(tag.extraIds().length, 3);
});

test('bots: leave one by one as real players join; Playtest bot clears them', async () => {
  let clockMs = 200_000;
  const now = () => clockMs;
  const a = lobby({ name: 'Ada' });
  const tag = createTag(a, { now });
  const bots = createBots(a, { tag, now, aloneMs: 0, myPos: () => [0.5, 0.5] });

  a.join('bots-leave');
  await flush();
  clockMs += 10;
  bots.tick(clockMs);
  assert.equal(bots.count, 3);

  const b = lobby({ name: 'Bob' });
  b.join('bots-leave');
  await flush();
  bots.tick(clockMs);
  assert.equal(bots.count, 2, 'one bot leaves when a second real player joins (keep total 4)');

  const c = lobby({ name: 'Cara' });
  c.join('bots-leave');
  await flush();
  bots.tick(clockMs);
  assert.equal(bots.count, 1);

  const pt = lobby({ name: 'Playtest bot' });
  pt.join('bots-leave');
  await flush();
  bots.tick(clockMs);
  assert.equal(bots.count, 0, 'Playtest bot clears filler bots so smoke is not blocked');
  assert.equal(tag.extraIds().length, 0);

  bots.resume();
  clockMs += 10;
  // Still has playtest peer → stays clear
  bots.tick(clockMs);
  assert.equal(bots.count, 0);
  bots.suspend();
  assert.equal(bots.count, 0, 'suspend() is the playtest escape hatch');

  a.leave(); b.leave(); c.leave(); pt.leave();
});

test('bots: chase as It and can tag a real player through tag extras', async () => {
  let clockMs = 300_000;
  const now = () => clockMs;
  const me = { x: 0.5, y: 0.5 };
  const a = lobby({ name: 'Ada' });
  const tag = createTag(a, { now });
  const bots = createBots(a, {
    tag, now, aloneMs: 0,
    myPos: () => [me.x, me.y],
  });

  a.join('bots-tag');
  await flush();
  bots.tick(clockMs);
  assert.equal(bots.count, 3);
  assert.equal(tag.it, a.id);

  // Hand It to the first bot, then let it chase the player into tag range.
  const bot = bots.list()[0];
  tag.setExtra(bot.id, 0.2, 0.5);
  // Force It onto the bot via a host tag from the player.
  a.pose([0.2, 0.5, 0]);
  tag.move(0.2, 0.5);
  await flush();
  assert.equal(tag.it, bot.id, 'player tags a bot; bot becomes It');

  clockMs += 1100; // past immunity
  me.x = 0.5; me.y = 0.5;
  tag.move(0.5, 0.5); // keep Tag's local pose in sync with myPos the AI chases
  a.pose([0.5, 0.5, 0]);
  // Run AI until the It-bot reaches the player.
  let tagged = false;
  for (let i = 0; i < 120 && !tagged; i++) {
    clockMs += 50;
    bots.tick(clockMs);
    tagged = tag.it === a.id;
  }
  assert.equal(tag.it, a.id, 'It-bot chases and tags the player');
  a.leave();
});

test('bots: wired into the demo and copied by tools/demo.mjs; tag.mjs stays timer-free', () => {
  const indexSrc = readFileSync(new URL('../example/index.html', import.meta.url), 'utf8');
  assert.match(indexSrc, /import\('\.\/bots\.mjs'\)/);
  assert.match(indexSrc, /beforeBot:/);
  assert.match(indexSrc, /filler bots appear within 5 seconds/);

  const demoToolSrc = readFileSync(new URL('../tools/demo.mjs', import.meta.url), 'utf8');
  assert.match(demoToolSrc, /'bots\.mjs'/);

  const tagSrc = readFileSync(new URL('../example/tag.mjs', import.meta.url), 'utf8');
  assert.equal(/\bsetInterval\b|\bsetTimeout\b/.test(tagSrc), false);

  const botsSrc = readFileSync(new URL('../example/bots.mjs', import.meta.url), 'utf8');
  assert.match(botsSrc, /sync\.state\('bots'/);
  assert.equal(TAG_RADIUS > 0, true);
});

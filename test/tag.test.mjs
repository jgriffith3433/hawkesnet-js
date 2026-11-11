import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lobby } from './fake-net.mjs';
import { createTag, DOT_RADIUS, TAG_RADIUS, IMMUNE_MS } from '../example/tag.mjs';

const flush = () => new Promise((r) => setTimeout(r, 15));

test('tag: host picks who is It in shared state, late joiners receive it, and label reads It', async () => {
  let clockMs = 10_000;
  const now = () => clockMs;
  const a = lobby({ name: 'Ada' });
  const b = lobby({ name: 'Bob' });
  const tagA = createTag(a, { now });
  const tagB = createTag(b, { now });

  a.join('tag-room-1');
  await flush();
  assert.equal(tagA.it, a.id, 'host picks itself as It when alone');
  assert.equal(tagA.isIt(a.id), true);
  assert.equal(tagA.labelFor(a.id, 'Ada'), 'It');
  assert.equal(tagA.labelFor(b.id, 'Bob'), 'Bob');

  clockMs += 400;
  b.join('tag-room-1');
  await flush();

  assert.equal(tagB.it, a.id, 'joining peer receives It from shared state');
  assert.equal(tagA.agreedWith(b.id), true, 'host sees peer agreed on It');
  assert.equal(tagB.agreedWith(a.id), true, 'peer sees host agreed on It');
  assert.ok(tagB.timeMs(a.id) >= 400, 'late joiner sees elapsed time as It');

  a.leave();
  b.leave();
});

test('tag: touching another dot (~1.5 dots radius) passes It on both screens within 300 ms, both ways', async () => {
  let clockMs = 20_000;
  const now = () => clockMs;
  const a = lobby({ name: 'Ada' });
  const b = lobby({ name: 'Bob' });
  const tagA = createTag(a, { now });
  const tagB = createTag(b, { now });

  assert.equal(TAG_RADIUS, DOT_RADIUS * 1.5, 'TAG_RADIUS is 1.5x DOT_RADIUS');
  assert.equal(IMMUNE_MS, 1000, 'IMMUNE_MS is 1000 ms');

  a.join('tag-room-2');
  b.join('tag-room-2');
  await flush();

  // Place players far apart initially.
  a.pose([0.2, 0.5, 0]);
  b.pose([0.8, 0.5, 0]);
  await flush();
  assert.equal(tagA.it, a.id);
  assert.equal(tagB.it, a.id);

  // Move just outside TAG_RADIUS: should not tag yet.
  clockMs += 300;
  a.pose([0.8 - TAG_RADIUS * 1.3, 0.5, 0]);
  await flush();
  assert.equal(tagA.it, a.id, 'outside TAG_RADIUS does not pass It');
  assert.equal(tagB.it, a.id);

  // Move inside TAG_RADIUS (~1.5 dots): host (a) tags peer (b).
  clockMs += 200;
  const t0 = performance.now();
  tagA.move(0.8 - TAG_RADIUS * 0.5, 0.5);
  await flush();
  const elapsedHostTag = performance.now() - t0;

  assert.equal(tagA.it, b.id, 'host sees Bob become It');
  assert.equal(tagB.it, b.id, 'Bob sees itself become It');
  assert.equal(tagA.agreedWith(b.id), true);
  assert.equal(tagB.agreedWith(a.id), true);
  assert.ok(elapsedHostTag <= 300, `It passed in ${elapsedHostTag} ms (<= 300 ms)`);

  // Advance past 1 s immunity, then non-host (b) moves onto host (a) to pass It back.
  a.pose([0.25, 0.5, 0]);
  b.pose([0.75, 0.5, 0]);
  await flush();
  clockMs += IMMUNE_MS + 50;

  const t1 = performance.now();
  tagB.move(0.25 + TAG_RADIUS * 0.4, 0.5);
  await flush();
  const elapsedPeerTag = performance.now() - t1;

  assert.equal(tagA.it, a.id, 'host sees Ada become It after non-host tag');
  assert.equal(tagB.it, a.id, 'non-host sees Ada become It');
  assert.equal(tagA.agreedWith(b.id), true);
  assert.equal(tagB.agreedWith(a.id), true);
  assert.ok(elapsedPeerTag <= 300, `non-host tag passed in ${elapsedPeerTag} ms (<= 300 ms)`);

  a.leave();
  b.leave();
});

test('tag: 1 s tag-back immunity prevents immediate tag-back and tracks time per player id', async () => {
  let clockMs = 50_000;
  const now = () => clockMs;
  const a = lobby({ name: 'Ada' });
  const b = lobby({ name: 'Bob' });
  const tagA = createTag(a, { now });
  const tagB = createTag(b, { now });

  a.join('tag-room-3');
  b.join('tag-room-3');
  await flush();

  a.pose([0.3, 0.5, 0]);
  b.pose([0.7, 0.5, 0]);
  await flush();

  // Ada spends 600 ms as It, then tags Bob at [0.7, 0.5].
  clockMs += 600;
  tagA.move(0.7, 0.5);
  await flush();

  assert.equal(tagA.it, b.id);
  assert.equal(tagB.it, b.id);
  assert.equal(tagA.isImmune(), true);
  assert.equal(tagB.isImmune(), true);
  assert.equal(tagA.timeMs(a.id), 600, 'Ada banked 600 ms as It');

  // At +200 ms and +800 ms (still < 1000 ms), Bob touches Ada repeatedly: must NOT tag back.
  for (const dt of [200, 600]) {
    clockMs += dt;
    tagB.move(0.7, 0.5);
    a.pose([0.7, 0.5, 0]);
    await flush();
    assert.equal(tagA.it, b.id, `Bob stays It at ${clockMs - 50_600} ms into immunity`);
    assert.equal(tagB.it, b.id);
    assert.equal(tagA.isImmune(), true);
  }

  // Once 1000 ms have passed since the tag, immunity expires and Bob can tag Ada back.
  clockMs += 250; // total 1050 ms as It for Bob
  assert.equal(tagA.isImmune(), false);
  assert.equal(tagB.isImmune(), false);
  assert.equal(tagA.timeMs(b.id), 1050, 'Bob accumulated 1050 ms as It');

  tagB.move(0.7, 0.5);
  await flush();
  assert.equal(tagA.it, a.id, 'after 1 s immunity expires, touching passes It back to Ada');
  assert.equal(tagB.it, a.id);
  assert.equal(tagA.timeMs(b.id), 1050, 'Bob keeps 1050 ms banked time as It');
  assert.equal(tagA.timeMs(a.id), 600, 'Ada starts second stint from 600 ms banked');

  // If the current It leaves the room, the host picks a remaining player as It.
  clockMs += 300;
  a.leave();
  await flush();
  assert.equal(tagB.it, b.id, 'remaining player becomes It when previous It leaves');

  b.leave();
});

test('tag: the player with the least time as It is the round winner', async () => {
  let clockMs = 80_000;
  const now = () => clockMs;
  const a = lobby({ name: 'Ada' });
  const b = lobby({ name: 'Bob' });
  const tagA = createTag(a, { now, roundMs: 1000, resultsMs: 300 });
  const tagB = createTag(b, { now, roundMs: 1000, resultsMs: 300 });

  a.join('tag-room-winner');
  b.join('tag-room-winner');
  await flush();

  a.pose([0.2, 0.5, 0]);
  b.pose([0.8, 0.5, 0]);
  await flush();
  assert.equal(tagA.phase, 'play');
  assert.ok(tagA.round >= 1, 'host started a round');
  assert.ok(tagA.remainingMs() > 0, 'timer counts down');

  // Ada is It for 900 ms, then tags Bob; Bob is It for 100 ms. Least time as It = Bob.
  clockMs += 900;
  tagA.move(0.8 - TAG_RADIUS * 0.5, 0.5);
  await flush();
  assert.equal(tagA.it, b.id);
  clockMs += 100;

  const times = { [a.id]: tagA.timeMs(a.id), [b.id]: tagA.timeMs(b.id) };
  assert.equal(times[a.id], 900, 'Ada banked 900 ms as It');
  assert.equal(times[b.id], 100, 'Bob has 100 ms as It');
  const winner = times[a.id] <= times[b.id] ? a.id : b.id;
  assert.equal(winner, b.id, 'least time as It wins the round');
  assert.equal(tagB.timeMs(a.id), 900);
  assert.equal(tagB.timeMs(b.id), 100);

  // Host ends the round when the timer hits 0; both tabs see the same winner and scoreboard.
  clockMs = tagA.roundEndsAt;
  tagA.tick();
  await flush();
  assert.equal(tagA.phase, 'results');
  assert.equal(tagB.phase, 'results');
  assert.equal(tagA.winner, b.id);
  assert.equal(tagB.winner, b.id);
  assert.equal(tagA.scoreboard[0]?.id, b.id);
  assert.ok(tagA.scoreboard[0].ms <= tagA.scoreboard[1].ms);

  const endedRound = tagA.round;
  clockMs = tagA.resultsUntil;
  tagA.tick();
  await flush();
  assert.equal(tagA.phase, 'play');
  assert.equal(tagB.phase, 'play');
  assert.ok(tagA.round > endedRound, 'a new round starts after the scoreboard');
  assert.equal(tagA.winner, null);
  assert.equal(tagA.timeMs(a.id), 0);
  assert.equal(tagA.timeMs(b.id), 0);

  a.leave();
  b.leave();
});

test('tag: beginRound(?round=) starts a fresh short round on the host', async () => {
  let clockMs = 90_000;
  const now = () => clockMs;
  const a = lobby({ name: 'Ada' });
  const b = lobby({ name: 'Bob' });
  const tagA = createTag(a, { now, roundMs: 60_000, resultsMs: 200 });
  const tagB = createTag(b, { now, roundMs: 60_000, resultsMs: 200 });
  a.join('tag-room-short');
  b.join('tag-room-short');
  await flush();
  assert.ok(tagA.beginRound(8_000));
  await flush();
  assert.equal(tagA.phase, 'play');
  assert.equal(tagB.phase, 'play');
  assert.ok(tagA.remainingMs() <= 8_000);
  assert.ok(tagB.remainingMs() <= 8_000);
  assert.equal(tagA.ROUND_MS, 8_000);
  a.leave();
  b.leave();
});

test('tag: event-driven with no polling timers, wired into example/index.html and tools/demo.mjs', () => {
  const tagSrc = readFileSync(new URL('../example/tag.mjs', import.meta.url), 'utf8');
  assert.equal(/\bsetInterval\b|\bsetTimeout\b/.test(tagSrc), false, 'example/tag.mjs must not use polling timers');

  const indexSrc = readFileSync(new URL('../example/index.html', import.meta.url), 'utf8');
  assert.match(indexSrc, /import\('\.\/tag\.mjs'\)/, 'example/index.html imports ./tag.mjs');
  assert.match(indexSrc, /afterTwoPlayers/, 'example/index.html wires afterTwoPlayers into installNetPlaytest');

  const demoToolSrc = readFileSync(new URL('../tools/demo.mjs', import.meta.url), 'utf8');
  assert.match(demoToolSrc, /'tag\.mjs'/, 'tools/demo.mjs copies example/tag.mjs into dist/');

  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /## Build a game: Tag/, 'README has Build a game: Tag');
  assert.match(readme, /example\/tag\.mjs/, 'README links the example file');
});

test('demo head stub lists real scenarios and hands off start() after installNetPlaytest', () => {
  const indexSrc = readFileSync(new URL('../example/index.html', import.meta.url), 'utf8');
  const stub = indexSrc.match(/<script>\s*\/\/ Playtest stub[\s\S]*?<\/script>/);
  assert.ok(stub, 'inline playtest stub script exists before the module');
  const stubSrc = stub[0];
  const modIdx = indexSrc.indexOf('<script type="module">');
  assert.ok(indexSrc.indexOf(stubSrc) < modIdx, 'stub is before <script type="module">');
  assert.match(stubSrc, /__stub:\s*true/);
  assert.match(stubSrc, /id:\s*'smoke'/);
  assert.match(stubSrc, /id:\s*'two-players'/);
  assert.match(stubSrc, /id:\s*'phone'/);
  assert.match(stubSrc, /id:\s*'recipes'/);
  assert.match(stubSrc, /id:\s*'demo-boot'/);
  assert.equal(/scenarios:\s*function\s*\(\)\s*\{\s*return\s*\[\];\s*\}/.test(stubSrc), false, 'stub must not return []');
  assert.match(stubSrc, /takePending/);
  assert.match(stubSrc, /pending\s*=\s*\{\s*id:/);
  assert.match(indexSrc, /__hawkesDemoBoot\.takePending/);
  assert.match(indexSrc, /upgradedAt\s*=\s*performance\.now\(\)/);
});

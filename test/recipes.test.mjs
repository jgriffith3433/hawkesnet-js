// `npm test`: every recipe in recipes/ runs here as it is written, with only its import address changed to a fake
// Hawkes Net in memory (test/fake-net.mjs). Each test plays two players: the recipe's code, and the other side of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hub, lobby } from './fake-net.mjs';
import { RECIPES } from '../example/recipes.mjs';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hn-recipes-'));
const fake = pathToFileURL(path.join(root, 'test', 'fake-net.mjs')).href;
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

/** Runs a recipe's code (the file's text, import swapped for the fake). What it prints goes to `printed`, per run. */
let runs = 0;
const realLog = console.log;
let printed = [];
async function runRecipe(id, edit = (s) => s) {
  const src = fs.readFileSync(path.join(root, 'recipes', RECIPES.find((r) => r.id === id).file), 'utf8');
  assert.match(src, /from '@hawkesgen\/net'/, 'the recipe imports the published package');
  const file = path.join(tmp, `${id}-${++runs}.mjs`);
  fs.writeFileSync(file, edit(src).replace(`'@hawkesgen/net'`, `'${fake}'`));
  const out = [];
  printed.push(out);
  console.log = (...a) => out.push(a.join(' '));
  await import(pathToFileURL(file).href); await settle();
  return out;
}
const other = (name, area) => { const n = lobby({ project: 'netdemo', name }); n.join(area); return n; };

// The recipes print with console.log: each run's lines go to its own list, found by the first line it prints.
test.beforeEach(() => { hub.rooms.clear(); printed = []; });
test.afterEach(() => { console.log = realLog; });

test('there are five recipes, each a file with an import, a project and a way to run it live', () => {
  assert.deepEqual(RECIPES.map((r) => r.id), ['chat', 'cursors', 'shared-state', 'password-room', 'tag']);
  for (const r of RECIPES) {
    assert.ok(fs.existsSync(path.join(root, 'recipes', r.file)), r.file);
    assert.ok(r.title && r.blurb && r.area, `${r.id} has a title, blurb and area`);
    assert.match(fs.readFileSync(path.join(root, 'recipes', r.file), 'utf8'), /project: 'netdemo'/);
  }
  const tag = RECIPES.find((r) => r.id === 'tag');
  assert.equal(tag.openDemo, './index.html', 'Tag Run opens the demo two-player room');
});

test('chat: you hear what others say, and they hear you', async () => {
  const bob = other('Bob', 'recipe-chat'); const heard = [];
  bob.on('chat', (t, from) => heard.push(`${from.name}: ${t}`));
  await settle();
  const out = await runRecipe('chat');
  assert.ok(out.includes('Bob joined') || out.includes('you: hi, anyone here?'));
  assert.deepEqual(heard, ['Ada: hi, anyone here?']);
  bob.send('chat', 'hello Ada'); await settle();
  assert.ok(out.includes('Bob: hello Ada'), out.join('\n'));
  bob.leave(); await settle();
  assert.ok(out.includes('Bob left'));
  const carol = other('Carol', 'recipe-chat'); await settle();
  assert.ok(out.includes('Carol joined'), out.join('\n'));
  carol.leave(); await settle();
});

test('cursors: a moving pointer is sent, and other players\' cursors are noticed', async () => {
  const bob = other('Bob', 'recipe-cursors'); const seen = [];
  bob.onPose((id, s) => seen.push(s.p));
  await settle();
  const listeners = {};
  Object.assign(globalThis, { innerWidth: 1000, innerHeight: 500, addEventListener: (ev, fn) => { listeners[ev] = fn; } });
  const out = await runRecipe('cursors');
  listeners.pointermove({ clientX: 250, clientY: 250 }); await settle();
  assert.deepEqual(seen.at(-1), [0.25, 0.5, 0]);
  bob.pose([0.1, 0.9, 0]); await settle();
  assert.ok(out.includes('Bob is at 0.10, 0.90'), out.join('\n'));
});

test('shared state: a joiner gets the host\'s score and adds their own point', async () => {
  const bob = other('Bob', 'recipe-state'); let bobScore = 10;
  bob.when('joined', (room) => {
    room.sync.state('scoreboard', { get: () => ({ score: bobScore }), set: () => {} });
    room.sync.action('addPoints', (n) => { bobScore += n; });
  });
  await settle();
  const out = await runRecipe('shared-state');
  assert.equal(out.at(-1), 'score: 11', out.join('\n'));
  assert.equal(bobScore, 11, 'the host added the point too');
});

test('shared state: with nobody else there, the first player starts the score', async () => {
  const out = await runRecipe('shared-state');
  assert.deepEqual(out, ['score: 1']);
});

test('password room: the same password meets, a different one does not', async () => {
  // Bob types the same password in his own copy of the recipe's code: he computes the room the same way.
  const { createHash } = await import('node:crypto');
  const vault = (pw) => `vault-${createHash('sha256').update(`my-game/${pw}`).digest('hex').slice(0, 16)}`;
  const right = other('Bob', vault('open sesame')), wrong = other('Eve', vault('wrong guess'));
  const heard = [], overheard = [];
  right.on('chat', (t, from) => heard.push(`${from.name}: ${t}`));
  wrong.on('chat', (t) => overheard.push(t));
  await settle();
  const out = await runRecipe('password-room', (s) => s.replace("'swordfish'", "'open sesame'"));
  assert.deepEqual(heard, ['Ada: we have the right password'], out.join(' | '));
  assert.deepEqual(overheard, [], 'a different password is a different room');
  assert.equal(hub.rooms.size, 2);
});

test('tag: host picks It in shared state and a late joiner receives it', async () => {
  const out = await runRecipe('tag');
  assert.ok(out.some((l) => /^It:/.test(l)), `host should print It (got: ${out.join(' | ')})`);
  assert.ok(out.some((l) => /Tag room open/.test(l)), 'recipe announces the Tag room');

  let seen = null;
  const bob = lobby({ project: 'netdemo', name: 'Bob' });
  bob.when('joined', (room) => {
    room.sync.state('tag', { get: () => ({}), set: (s) => { seen = s; } });
    room.sync.action('tag:state', (s) => { seen = s; });
    room.sync.action('tag:touch', () => {});
  });
  bob.join('recipe-tag');
  await settle();
  assert.ok(seen?.it, `Bob should receive It from shared state (seen ${JSON.stringify(seen)})`);
  bob.leave();
});

test('the README\'s chat snippet runs too, and talks to the chat recipe', async () => {
  const md = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const block = md.match(/```js\n(import \{ lobby \}[\s\S]*?)```/)?.[1];
  assert.ok(block, 'README has the chat snippet');
  const bob = other('Bob', 'recipe-chat'); const heard = [];
  bob.on('chat', (t, from) => heard.push(`${from.name}: ${t}`));
  await settle();
  const file = path.join(tmp, 'readme-chat.mjs');
  fs.writeFileSync(file, block.replace(`'@hawkesgen/net'`, `'${fake}'`));
  const out = []; console.log = (...a) => out.push(a.join(' '));
  await import(pathToFileURL(file).href); await settle();
  bob.send('chat', 'hello'); await settle();
  assert.deepEqual(heard, ['Ada: hi, anyone here?']);
  assert.deepEqual(out, ['Bob: hello']);
});

test('the demo quickstart snippet and peer:join handlers accept the Peer payload', async () => {
  const html = fs.readFileSync(path.join(root, 'example', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /when\('peer:join',\s*\(\{\s*peer\s*\}\)/, 'peer:join passes Peer directly, not { peer }');
  const qs = html.match(/<pre id="qs-code">([\s\S]*?)<\/pre>/)?.[1];
  assert.ok(qs, 'example/index.html has #qs-code');
  const file = path.join(tmp, 'demo-quickstart.mjs');
  fs.writeFileSync(file, qs.replace(`'https://net.hawkesgen.ai/sdk/hawkes-net@1.mjs'`, `'${fake}'`));
  const out = []; console.log = (...a) => out.push(a.join(' '));
  await import(pathToFileURL(file).href); await settle();
  const bob = other('Bob', 'quickstart'); await settle();
  assert.ok(out.includes('Bob joined'), `quickstart peer:join logged Bob joined (got: ${out.join(' | ')})`);
  bob.leave(); await settle();
});

test('getting started (example/start.html): five numbered steps with Copy and expected output, matching example/start.mjs', async () => {
  const startHtml = fs.readFileSync(path.join(root, 'example', 'start.html'), 'utf8');
  const startMjs = fs.readFileSync(path.join(root, 'example', 'start.mjs'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(root, 'example', 'index.html'), 'utf8');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const demoTool = fs.readFileSync(path.join(root, 'tools', 'demo.mjs'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  assert.match(indexHtml, /id="hud"[\s\S]*?href="\.\/start\.html"/, 'demo header links to ./start.html');
  assert.match(readme, /example\/start\.html/, 'README links to example/start.html');
  assert.match(demoTool, /'start\.html'/, 'tools/demo.mjs copies example/start.html into dist/');
  assert.match(demoTool, /'start\.mjs'/, 'tools/demo.mjs copies example/start.mjs into dist/');

  const unescape = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  const steps = [...startHtml.matchAll(/<li class="step" id="step-(\d+)" data-step="\d+">([\s\S]*?)<\/li>/g)];
  assert.equal(steps.length, 5, 'start.html has exactly five numbered steps');

  const codeBlocks = [];
  for (let i = 0; i < 5; i++) {
    const num = i + 1;
    assert.equal(Number(steps[i][1]), num, `step ${num} is numbered ${num}`);
    const body = steps[i][2];
    assert.match(body, new RegExp(`<span class="step-num"[^>]*>${num}<\\/span>\\s*<h2>${num}\\.`), `step ${num} heading starts with ${num}.`);
    const codeMatch = body.match(new RegExp(`<pre id="step-${num}-code" class="code" data-step="${num}">([\\s\\S]*?)<\\/pre>`));
    assert.ok(codeMatch, `step ${num} has #step-${num}-code`);
    codeBlocks.push(unescape(codeMatch[1]));
    assert.match(body, new RegExp(`<button type="button" class="copy" data-copy="step-${num}-code">Copy<\\/button>`), `step ${num} has a Copy button`);
    assert.match(body, new RegExp(`<div class="expect" id="step-${num}-expect"[\\s\\S]*?What you should see`), `step ${num} has a What you should see box`);
  }

  // Every <pre> on start.html is a step code block with a Copy button.
  assert.equal([...startHtml.matchAll(/<pre\b/g)].length, 5, 'every <pre> on start.html has a Copy button');

  // Step 1 installs the GitHub tag tarball from README.md.
  const tarballUrl = `https://github.com/jgriffith3433/hawkesnet-js/archive/refs/tags/v${pkg.version}.tar.gz`;
  assert.ok(readme.includes(tarballUrl), 'README names the current version tag tarball');
  assert.ok(codeBlocks[0].includes(tarballUrl), 'Step 1 installs the GitHub tag tarball from README');

  // Steps 2..5 match example/start.mjs byte-for-byte so the page cannot drift from tested code.
  assert.equal(codeBlocks.slice(1).join('\n\n') + '\n', startMjs, 'Steps 2..5 on start.html match example/start.mjs');

  // Font sizes in start.html are at least 12 px and code blocks scroll inside their box.
  for (const m of startHtml.matchAll(/font(?:-size)?:\s*(?:[0-9]+\s+)?([0-9.]+)px/g)) {
    assert.ok(Number(m[1]) >= 12, `font size ${m[1]}px in start.html is >= 12px`);
  }
  assert.match(startHtml, /pre\.code\s*\{[^}]*overflow-x:\s*auto/, 'pre.code scrolls horizontally inside its box');
  assert.match(startHtml, /pre\.code\s*\{[^}]*max-width:\s*100%/, 'pre.code stays within its container');

  // Run example/start.mjs against fake-net.mjs and verify the two-tab room flow matches the expected output boxes.
  const listeners = {};
  Object.assign(globalThis, { innerWidth: 1000, innerHeight: 500, addEventListener: (ev, fn) => { listeners[ev] = fn; } });
  const file = path.join(tmp, 'start-example.mjs');
  fs.writeFileSync(file, startMjs.replace(`'@hawkesgen/net'`, `'${fake}'`));
  const out = [];
  console.log = (...a) => out.push(a.join(' '));
  await import(pathToFileURL(file).href);
  await settle();
  assert.ok(out.includes('status: connecting'), 'logs status: connecting');
  assert.ok(out.includes('status: online'), 'logs status: online');
  assert.ok(out.includes('you: hi, anyone here?'), 'logs initial greeting');

  const bob = other('Bob', 'getting-started');
  const bobPoses = [];
  bob.onPose((id, s) => bobPoses.push(s.p));
  await settle();
  assert.ok(out.includes('Bob joined'), 'logs Bob joined');

  bob.send('chat', 'hello Ada');
  bob.pose([0.6, 0.4, 0]);
  listeners.pointermove({ clientX: 350, clientY: 250 });
  await settle();
  assert.ok(out.includes('Bob: hello Ada'), 'logs Bob: hello Ada');
  assert.ok(out.includes('Bob is at 0.60, 0.40'), 'logs Bob is at 0.60, 0.40');
  assert.deepEqual(bobPoses.at(-1), [0.35, 0.5, 0], 'sends pointer pose to Bob');

  bob.leave();
  await settle();
  assert.ok(out.includes('Bob left'), 'logs Bob left');
});

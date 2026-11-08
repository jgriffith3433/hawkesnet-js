// Builds the demo site into dist/: example/index.html beside this SDK's own files, plus release.json and the package
// tarball (npm pack). Hawkes Studio (project hawkes-net-js) builds it on every beta push, publishes it as the beta site
// and playtests it there; Studio's beta pages name beta Hawkes Net (window.HAWKES_NET_ENDPOINT), so the demo plays on
// beta Net's free test rooms (project netdemo).
//   node tools/demo.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist');
fs.mkdirSync(out, { recursive: true });
for (const f of ['hawkes-net.mjs', 'hawkes-net-core.mjs']) fs.copyFileSync(path.join(root, f), path.join(out, f));
// Studio's playtest bot for the page (window.hawkesPlaytest: smoke and two-players).
fs.copyFileSync(path.join(root, 'example', 'net-playtest.mjs'), path.join(out, 'net-playtest.mjs'));
const html = fs.readFileSync(path.join(root, 'example', 'index.html'), 'utf8');
if (!html.includes("'../hawkes-net.mjs'")) throw new Error('example/index.html changed: update tools/demo.mjs');
fs.writeFileSync(path.join(out, 'index.html'), html.split("'../hawkes-net.mjs'").join("'./hawkes-net.mjs'"));
// The recipes: the docs page, its helper modules, and the recipes' code (the same files `npm test` runs).
const sdkPath = (t) => t.split("'../hawkes-net.mjs'").join("'./hawkes-net.mjs'");
fs.writeFileSync(path.join(out, 'recipes.html'), sdkPath(fs.readFileSync(path.join(root, 'example', 'recipes.html'), 'utf8')));
fs.writeFileSync(path.join(out, 'recipes.mjs'), fs.readFileSync(path.join(root, 'example', 'recipes.mjs'), 'utf8').replace("'../recipes/'", "'./recipes/'"));
fs.copyFileSync(path.join(root, 'example', 'recipes-playtest.mjs'), path.join(out, 'recipes-playtest.mjs'));
fs.copyFileSync(path.join(root, 'example', 'phone-playtest.mjs'), path.join(out, 'phone-playtest.mjs'));
fs.mkdirSync(path.join(out, 'recipes'), { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'recipes'))) fs.copyFileSync(path.join(root, 'recipes', f), path.join(out, 'recipes', f));
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(out, 'release.json'), JSON.stringify({ package: '@hawkesgen/net', version }, null, 2) + '\n');
execFileSync('npm', ['pack', '--pack-destination', out, '--silent'], { cwd: root, stdio: 'inherit' });
console.log(`dist/: demo and package of @hawkesgen/net ${version}`);

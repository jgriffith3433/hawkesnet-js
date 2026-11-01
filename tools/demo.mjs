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
const html = fs.readFileSync(path.join(root, 'example', 'index.html'), 'utf8');
if (!html.includes("from '../hawkes-net.mjs'")) throw new Error('example/index.html changed: update tools/demo.mjs');
fs.writeFileSync(path.join(out, 'index.html'), html.replace("from '../hawkes-net.mjs'", "from './hawkes-net.mjs'"));
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(out, 'release.json'), JSON.stringify({ package: '@hawkesgen/net', version }, null, 2) + '\n');
execFileSync('npm', ['pack', '--pack-destination', out, '--silent'], { cwd: root, stdio: 'inherit' });
console.log(`dist/: demo and package of @hawkesgen/net ${version}`);

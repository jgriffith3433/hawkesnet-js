// The recipes: what each one is, and how a page runs its code live. The code itself is in recipes/<file> (the same
// files `npm test` runs). Used by the recipes page (recipes.html) and by the demo's playtest scenario.
export const CDN = 'https://net.hawkesgen.ai/sdk/hawkes-net@1.mjs';
export const RECIPES = [
  { id: 'chat', file: 'chat.mjs', area: 'recipe-chat', title: 'Chat',
    blurb: 'Say something and everyone in the room hears it, once and in order. Joins and leaves too.',
    seeIt: 'Open this page in a second tab: each tab says hi and prints what the other says.' },
  { id: 'cursors', file: 'cursors.mjs', area: 'recipe-cursors', title: 'Cursors',
    blurb: 'Every player\'s pointer, seen by everyone else, as a place from 0 to 1 so any screen size agrees.',
    seeIt: 'Open a second tab and move the mouse in one: the other prints where it is.' },
  { id: 'shared-state', file: 'shared-state.mjs', area: 'recipe-state', title: 'Shared state',
    blurb: 'One score everyone sees. The host keeps the truth, anyone can ask to change it, and joiners get the current value.',
    seeIt: 'Each tab you open adds a point: the score goes up in all of them.' },
  { id: 'password-room', file: 'password-room.mjs', area: 'recipe-vault', title: 'A room with a password',
    blurb: 'The room\'s name comes from a password, so people who know it meet and nobody else does.',
    seeIt: 'Open two tabs with the same password and they meet; give one another password and it stays alone.',
    password: 'swordfish' },
];

/** The recipe's code as a game would write it (import from the package). */
export async function sourceOf(r, base = '../recipes/') {
  const res = await fetch(new URL(r.file, new URL(base, location.href)));
  if (!res.ok) throw new Error(`recipe ${r.id}: ${res.status}`);
  return res.text();
}

/**
 * Runs the recipe's code in this page, as it is written. Only the import address changes (to this page's own copy of the
 * SDK). `swap` pairs of [from, to] change a literal in it (a password, or a room's area so a test has the room to itself).
 * `log` receives what the recipe prints. Returns { stop() }.
 */
export async function runLive(r, { sdk, log, swap = [] }) {
  let src = (await sourceOf(r)).replace('@hawkesgen/net', sdk);
  for (const [from, to] of swap) {
    if (!src.includes(from)) throw new Error(`recipe ${r.id} has no ${from}`);
    src = src.split(from).join(to);
  }
  const was = console.log;
  console.log = (...a) => { was(...a); log(a.join(' ')); };
  const reset = () => { console.log = was; };
  try { await import(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); }
  catch (e) { reset(); throw e; }
  return { stop: reset };
}

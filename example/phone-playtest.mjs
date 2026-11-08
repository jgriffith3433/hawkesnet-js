// The demo's `phone` playtest scenario: the demo page and the recipes page at phone size (390 x 844). Each page is opened in
// a frame that size inside this page (same origin), so it runs the same on a desktop browser or a phone: the frame is the
// phone's screen, and the page inside answers to its width exactly as it would on a phone. The dot is moved by touch
// (pointer events with pointerType 'touch' on the canvas: press, drag, lift, and a tap), and every layout claim is measured
// from the frame's real elements.
const W = 390, H = 844;
const MIN_TEXT_PX = 13; // text smaller than this needs zoom on a phone

export function phoneScenario({ pages }) {
  const frames = [];
  const open = (url) => new Promise((res, rej) => {
    const f = document.createElement('iframe');
    f.src = url; f.title = 'Phone-size view';
    const scale = Math.min(1, (innerHeight - 24) / H);
    f.style.cssText = `position:fixed;left:50%;top:12px;width:${W}px;height:${H}px;border:2px solid #3a4150;border-radius:18px;background:#0b0f14;z-index:99990;transform-origin:top center;transform:translateX(-50%) scale(${scale})`;
    f.addEventListener('load', () => res(f), { once: true });
    f.addEventListener('error', () => rej(new Error(`could not open ${url}`)), { once: true });
    document.body.append(f); frames.push(f);
  });
  const close = () => { while (frames.length) frames.pop().remove(); };
  return {
    id: 'phone', title: 'The demo and the recipes page work at phone size (390 x 844)', seconds: 70, tags: ['full', 'phone'],
    description: 'Opens the demo and the recipes page in a 390 x 844 phone frame and checks: nothing scrolls sideways, the canvas fits the width with the banner, player list and quickstart stacked under it, a finger dragging and tapping on the canvas moves your dot, the text is readable without zooming, and code blocks scroll inside their box.',
    run: async (c) => {
      const near = (a, b, t) => Math.abs(a - b) <= t;
      try {
        const demo = await open(pages.demo), win = demo.contentWindow, doc = demo.contentDocument;
        await c.until(() => win.hawkesDemoView && doc.getElementById('c') && doc.getElementById('plist')?.children.length, 15000, 'the demo to load in the phone frame');
        const $ = (id) => doc.getElementById(id);
        const sideways = (d, w) => d.documentElement.scrollWidth - w.innerWidth;
        await c.check('At 390 px wide the demo page does not scroll sideways', async () => {
          if (win.innerWidth !== W) throw new Error(`the frame is ${win.innerWidth} px wide, not ${W}`);
          const over = sideways(doc, win);
          const wide = [...doc.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > W + 1 && !e.closest('pre')).map((e) => e.id || e.tagName);
          c.metric('demoSidewaysPx', Math.max(0, over));
          if (over > 0 || wide.length) throw new Error(`the page is ${over} px wider than the screen${wide.length ? ` (${wide.slice(0, 4).join(', ')} stick out)` : ''}`);
          return `page width ${doc.documentElement.scrollWidth} px in a ${W} px screen`;
        });
        c.progress(0.15);
        await c.check('The canvas fits the width, with the banner, player list and quickstart stacked under it', async () => {
          const cv = $('c').getBoundingClientRect(), bn = $('banner').getBoundingClientRect(), pl = $('players').getBoundingClientRect(), q = $('quick').getBoundingClientRect();
          if (!win.hawkesDemoView().stacked) throw new Error('the page is still laid out as a desktop page');
          if (!near(cv.width, W, 1) || cv.left > 1) throw new Error(`the canvas is ${Math.round(cv.width)} px wide at x=${Math.round(cv.left)}, not the screen's ${W}`);
          if (cv.height < 200) throw new Error(`the canvas is only ${Math.round(cv.height)} px tall`);
          if (bn.top < cv.bottom - 1) throw new Error('the banner is over the canvas, not under it');
          if (pl.top < bn.bottom - 1) throw new Error('the player list is not under the banner');
          if (q.top < pl.bottom - 1) throw new Error('the quickstart is not under the player list');
          c.metric('phoneCanvasPx', `${Math.round(cv.width)}x${Math.round(cv.height)}`);
          return `canvas ${Math.round(cv.width)}x${Math.round(cv.height)}, banner at y=${Math.round(bn.top)}, players at y=${Math.round(pl.top)}, quickstart at y=${Math.round(q.top)}`;
        });
        c.progress(0.3);
        const spot = (x, y) => { const b = $('c').getBoundingClientRect(); return [b.left + x * b.width, b.top + y * b.height]; };
        const send = (type, [x, y]) => $('c').dispatchEvent(new win.PointerEvent(type, { pointerType: 'touch', pointerId: 5, isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true }));
        await c.check('Dragging a finger on the canvas moves your dot, and lifting it leaves the dot there', async () => {
          const before = win.hawkesDemoView().me;
          send('pointerdown', spot(0.15, 0.8));
          const seen = [];
          for (let i = 0; i <= 12; i++) { send('pointermove', spot(0.15 + i * 0.06, 0.8 - i * 0.05)); seen.push(win.hawkesDemoView().me.x); await c.wait(50); }
          send('pointerup', spot(0.87, 0.2));
          const me = win.hawkesDemoView().me;
          if (Math.hypot(me.x - before.x, me.y - before.y) < 0.2) throw new Error(`the dot did not follow the finger (from ${before.x.toFixed(2)}, ${before.y.toFixed(2)} to ${me.x.toFixed(2)}, ${me.y.toFixed(2)})`);
          if (!near(me.x, 0.87, 0.03) || !near(me.y, 0.2, 0.03)) throw new Error(`the dot is at ${me.x.toFixed(2)}, ${me.y.toFixed(2)}, not under the finger (0.87, 0.20)`);
          if (!seen.every((x, i) => i === 0 || x > seen[i - 1])) throw new Error('the dot did not move steadily with the finger');
          send('pointermove', spot(0.1, 0.1)); // a finger that is up does not move the dot
          if (win.hawkesDemoView().me.x !== me.x) throw new Error('the dot moved with no finger down');
          c.metric('dragMovedBy', Math.round(Math.hypot(me.x - before.x, me.y - before.y) * 100) / 100);
          return `from ${before.x.toFixed(2)}, ${before.y.toFixed(2)} to ${me.x.toFixed(2)}, ${me.y.toFixed(2)} in 13 steps`;
        });
        await c.check('Tapping the canvas puts your dot there', async () => {
          send('pointerdown', spot(0.3, 0.6)); send('pointerup', spot(0.3, 0.6));
          const me = win.hawkesDemoView().me;
          if (!near(me.x, 0.3, 0.03) || !near(me.y, 0.6, 0.03)) throw new Error(`a tap at 0.30, 0.60 left the dot at ${me.x.toFixed(2)}, ${me.y.toFixed(2)}`);
          await c.wait(400);
          return `dot at ${me.x.toFixed(2)}, ${me.y.toFixed(2)}`;
        });
        c.progress(0.5);
        $('quick').open = true; // the quickstart's text is part of what has to be readable
        await c.wait(100);
        await c.check('The player list, banner and quickstart are readable without zooming', async () => {
          if (!/width=device-width/.test(doc.querySelector('meta[name=viewport]')?.content || '')) throw new Error('no width=device-width viewport');
          const small = [], clipped = [];
          let n = 0, least = 99;
          for (const el of doc.querySelectorAll('#banner, #banner *, #side, #side *, #quick, #quick *')) {
            if (![...el.childNodes].some((x) => x.nodeType === 3 && x.textContent.trim())) continue;
            if (!el.getClientRects().length) continue;
            const px = parseFloat(win.getComputedStyle(el).fontSize); n++; least = Math.min(least, px);
            if (px < MIN_TEXT_PX) small.push(`${el.id || el.className || el.tagName} ${px}px`);
            const b = el.getBoundingClientRect();
            if (!el.closest('pre') && (b.left < -1 || b.right > W + 1)) clipped.push(el.id || el.className || el.tagName);
          }
          c.metric('phoneSmallestTextPx', least);
          if (small.length) throw new Error(`text under ${MIN_TEXT_PX}px: ${small.slice(0, 5).join(', ')}`);
          if (clipped.length) throw new Error(`text outside the screen: ${clipped.slice(0, 5).join(', ')}`);
          const rows = [...doc.querySelectorAll('#plist li')];
          if (!rows.length) throw new Error('the player list is empty');
          return `${n} pieces of text, the smallest ${least}px, ${rows.length} player row(s) inside the screen`;
        });
        c.progress(0.65);
        await c.check('Code on the demo page scrolls inside its box', async () => {
          const pre = $('qs-code'), b = pre.getBoundingClientRect(), before = doc.documentElement.scrollWidth;
          if (b.right > W + 1) throw new Error(`the code box is wider than the screen (right edge at ${Math.round(b.right)})`);
          if (pre.scrollWidth <= pre.clientWidth) throw new Error('the code box has no long line to scroll (nothing to prove)');
          pre.scrollLeft = 60;
          if (pre.scrollLeft < 1) throw new Error('the code box does not scroll sideways');
          if (doc.documentElement.scrollWidth !== before || win.scrollX !== 0) throw new Error('scrolling the code moved the page');
          return `box ${Math.round(b.width)} px, code ${pre.scrollWidth} px wide, scrolled to ${Math.round(pre.scrollLeft)}`;
        });
        close();

        const rec = await open(pages.recipes), rw = rec.contentWindow, rd = rec.contentDocument;
        await c.until(() => rd.querySelectorAll('pre.code').length >= 4 && [...rd.querySelectorAll('pre.code')].every((p) => p.textContent !== 'Loading…'), 15000, 'the recipes to load in the phone frame');
        c.progress(0.8);
        await c.check('At 390 px wide the recipes page does not scroll sideways', async () => {
          if (rw.innerWidth !== W) throw new Error(`the frame is ${rw.innerWidth} px wide, not ${W}`);
          const over = rd.documentElement.scrollWidth - rw.innerWidth;
          const wide = [...rd.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > W + 1 && !e.closest('pre')).map((e) => e.className || e.tagName);
          c.metric('recipesSidewaysPx', Math.max(0, over));
          if (over > 0 || wide.length) throw new Error(`the page is ${over} px wider than the screen${wide.length ? ` (${wide.slice(0, 4).join(', ')} stick out)` : ''}`);
          return `page width ${rd.documentElement.scrollWidth} px`;
        });
        await c.check('Code on the recipes page scrolls inside its box', async () => {
          const pres = [...rd.querySelectorAll('pre.code')];
          const wideOnes = pres.filter((p) => p.scrollWidth > p.clientWidth);
          if (!wideOnes.length) throw new Error('no recipe code is wider than its box (nothing to prove)');
          const before = rd.documentElement.scrollWidth;
          for (const p of wideOnes) {
            const b = p.getBoundingClientRect();
            if (b.right > W + 1) throw new Error(`a code box is wider than the screen (right edge at ${Math.round(b.right)})`);
            if (!['auto', 'scroll'].includes(rw.getComputedStyle(p).overflowX)) throw new Error('a code box does not scroll');
            p.scrollLeft = 80;
            if (p.scrollLeft < 1) throw new Error('a code box does not scroll sideways');
          }
          if (rd.documentElement.scrollWidth !== before || rw.scrollX !== 0) throw new Error('scrolling the code moved the page');
          c.metric('recipeCodeBoxesScrolling', wideOnes.length);
          return `${wideOnes.length} of ${pres.length} code boxes scroll inside themselves, the page stays ${before} px wide`;
        });
        c.progress(1);
      } finally { close(); }
    },
  };
}

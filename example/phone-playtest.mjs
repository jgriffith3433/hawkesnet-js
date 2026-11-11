// The demo's `phone` playtest scenario: checks the demo page and the recipes page honestly at phone size (390 x 844) with
// touch pointer events (pointerType 'touch'). When the browser viewport is already 390 x 844 (Studio's `device: "phone"`),
// the demo checks run directly on this page so screenshots are full-bleed 390 x 844 phone frames; on a wider desktop window,
// a 390 x 844 same-origin frame over a dark curtain runs the exact same checks and stays up at the end for screenshots.
const W = 390, H = 844;
const MIN_TEXT_PX = 12;

export function phoneScenario({ pages }) {
  let guardInstalled = false;
  const clearFrames = () => document.querySelectorAll('[data-phone-playtest]').forEach((e) => e.remove());
  const installGuard = () => {
    if (guardInstalled || !window.hawkesPlaytest) return;
    guardInstalled = true;
    const origStart = window.hawkesPlaytest.start.bind(window.hawkesPlaytest);
    const origStop = window.hawkesPlaytest.stop?.bind(window.hawkesPlaytest);
    window.hawkesPlaytest.start = (id, opts) => { if (id !== 'phone') clearFrames(); return origStart(id, opts); };
    if (origStop) window.hawkesPlaytest.stop = () => { clearFrames(); return origStop(); };
  };
  const ensureBackdrop = () => {
    if (document.querySelector('[data-phone-playtest="backdrop"]')) return;
    const bg = document.createElement('div');
    bg.dataset.phonePlaytest = 'backdrop';
    bg.style.cssText = 'position:fixed;inset:0;background:#0b0f14;z-index:99989';
    document.body.append(bg);
  };
  const openFrame = (url, kind, fullBleed) => new Promise((res, rej) => {
    const f = document.createElement('iframe');
    f.dataset.phonePlaytest = kind;
    f.src = url;
    f.title = `Phone-size view (${kind})`;
    if (fullBleed) {
      f.style.cssText = `position:fixed;left:0;top:0;width:${W}px;height:${H}px;box-sizing:content-box;border:0;background:#0b0f14;z-index:99991`;
    } else {
      ensureBackdrop();
      const scale = Math.min(1, (innerHeight - 16) / H, (innerWidth - 16) / W);
      f.style.cssText = `position:fixed;left:50%;top:50%;width:${W}px;height:${H}px;box-sizing:content-box;border:1px solid #2a3340;border-radius:14px;background:#0b0f14;z-index:99990;transform-origin:center center;transform:translate(-50%,-50%) scale(${scale})`;
    }
    f.addEventListener('load', () => res(f), { once: true });
    f.addEventListener('error', () => rej(new Error(`could not open ${url}`)), { once: true });
    document.body.append(f);
  });

  const hitAt = (d, x, y) => {
    const top = d.elementFromPoint(x, y);
    if (top?.hasAttribute?.('data-hawkes-report')) {
      return d.elementsFromPoint(x, y).find((e) => !e.hasAttribute?.('data-hawkes-report')) ?? null;
    }
    return top;
  };

  const assertVisibleByPoint = (d, w, el, name) => {
    if (!el) throw new Error(`missing ${name}`);
    el.scrollIntoView({ block: 'nearest' });
    const b = el.getBoundingClientRect();
    const cw = d.documentElement.clientWidth;
    if (b.width < 4 || b.height < 4) throw new Error(`${name} has empty box (${Math.round(b.width)}x${Math.round(b.height)})`);
    if (b.top < -1 || b.bottom > w.innerHeight + 1 || b.left < -1 || b.right > cw + 1) {
      throw new Error(`${name} is outside the ${w.innerWidth}x${w.innerHeight} viewport (${Math.round(b.left)},${Math.round(b.top)}..${Math.round(b.right)},${Math.round(b.bottom)})`);
    }
    const y = b.top + Math.min(b.height / 2, 20);
    const xs = [b.left + Math.min(14, b.width / 4), b.left + b.width / 2];
    for (const x of xs) {
      const hit = hitAt(d, x, y);
      if (!hit || !el.contains(hit)) {
        const who = hit ? (hit.id ? `#${hit.id}` : hit.tagName) : 'nothing';
        throw new Error(`${name} at (${Math.round(x)}, ${Math.round(y)}) is covered by ${who}`);
      }
    }
    return b;
  };

  const assertNoSidewaysScroll = (d, w, label) => {
    if (w.innerWidth !== W || w.innerHeight !== H) {
      throw new Error(`${label} viewport is ${w.innerWidth}x${w.innerHeight}, expected ${W}x${H}`);
    }
    const cw = d.documentElement.clientWidth;
    const sw = d.documentElement.scrollWidth;
    const wide = [...d.querySelectorAll('body *')].filter((e) => {
      if (e.closest('pre, #hawkes-net-playtest, [data-hawkes-report], [data-phone-playtest]')) return false;
      if (!e.getClientRects().length) return false;
      const b = e.getBoundingClientRect();
      return b.right > cw + 1 || b.left < -1;
    }).map((e) => e.id ? `#${e.id}` : e.className ? `.${String(e.className).trim().split(/\s+/)[0]}` : e.tagName.toLowerCase());
    const prevX = w.scrollX, prevY = w.scrollY;
    w.scrollTo(64, prevY);
    const movedX = w.scrollX;
    w.scrollTo(prevX, prevY);
    if (sw !== cw || sw > W || movedX !== 0 || wide.length) {
      throw new Error(`${label} document scrollWidth is ${sw} px vs viewport ${cw} px (scrollX=${movedX}${wide.length ? `, overflowing: ${wide.slice(0, 4).join(', ')}` : ''})`);
    }
    return { cw, sw };
  };

  const measureSmallestText = (d, w) => {
    const small = [], clipped = [];
    const cw = d.documentElement.clientWidth;
    const seen = new Set();
    let count = 0, least = Infinity;
    const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim()) continue;
      const el = node.parentElement;
      if (!el || seen.has(el)) continue;
      if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName)) continue;
      if (el.closest('#hawkes-net-playtest, [data-hawkes-report], [data-phone-playtest]')) continue;
      if (!el.getClientRects().length) continue;
      const cs = w.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
      seen.add(el);
      const px = parseFloat(cs.fontSize);
      if (!Number.isFinite(px)) continue;
      count++;
      least = Math.min(least, px);
      const name = el.id ? `#${el.id}` : el.className ? `.${String(el.className).trim().split(/\s+/)[0]}` : el.tagName.toLowerCase();
      if (px < MIN_TEXT_PX) small.push(`${name} ${px}px`);
      const b = el.getBoundingClientRect();
      if (!el.closest('pre') && (b.left < -1 || b.right > cw + 1)) clipped.push(name);
    }
    return { count, least: least === Infinity ? 0 : Math.round(least * 10) / 10, small, clipped };
  };

  return {
    id: 'phone',
    title: 'The demo and the recipes page work at phone size (390 x 844) with touch',
    seconds: 70,
    tags: ['full', 'phone'],
    description: 'Runs at 390 x 844 with touch pointer events (pointerType "touch"): asserts document width equals the viewport (no sideways scroll), #side stacks under the canvas, the banner, player list and quickstart are visible by elementFromPoint, dragging on the canvas moves your dot toward the drag, all text is at least 12 px, and code blocks scroll inside their box.',
    run: async (c) => {
      const near = (a, b, t) => Math.abs(a - b) <= t;
      installGuard();
      clearFrames();
      const nativePhone = innerWidth === W && innerHeight === H;
      let recipesFrame = null, startFrame = null;
      try {
        let win = window, doc = document;
        if (!nativePhone) {
          const demo = await openFrame(pages.demo, 'demo', false);
          win = demo.contentWindow;
          doc = demo.contentDocument;
        }
        await c.until(() => win.hawkesDemoView && doc.getElementById('c') && doc.getElementById('plist')?.children.length, 15000, 'the demo to load at 390x844');
        await c.until(() => doc.getElementById('banner')?.dataset.state === 'online', 8000, 'the demo room to connect').catch(() => {});
        const $ = (id) => doc.getElementById(id);
        win.scrollTo(0, 0);

        await c.check('At 390 x 844 document width equals the viewport (no sideways scroll)', async () => {
          if (!/width=device-width/.test(doc.querySelector('meta[name=viewport]')?.content || '')) throw new Error('missing width=device-width viewport meta');
          const { cw, sw } = assertNoSidewaysScroll(doc, win, 'demo');
          c.metric('phoneViewportW', win.innerWidth);
          c.metric('phoneViewportH', win.innerHeight);
          c.metric('demoDocumentWidthPx', sw);
          c.metric('demoSidewaysPx', Math.max(0, sw - cw));
          return `viewport ${win.innerWidth}x${win.innerHeight}, document width ${sw} px = viewport ${cw} px, scrollX=0`;
        });
        c.progress(0.15);

        await c.check('Under 700 px #side stacks, and the banner, player list and quickstart are visible by elementFromPoint', async () => {
          win.scrollTo(0, 0);
          if (!win.hawkesDemoView().stacked || win.getComputedStyle($('side')).position === 'fixed') {
            throw new Error('#side is still position:fixed instead of stacked');
          }
          const cv = $('c').getBoundingClientRect();
          const bn = $('banner').getBoundingClientRect();
          const sd = $('side').getBoundingClientRect();
          const pl = $('players').getBoundingClientRect();
          const q = $('quick').getBoundingClientRect();
          const cw = doc.documentElement.clientWidth;
          if (!near(cv.width, cw, 1) || cv.left < -0.5 || cv.left > 1) {
            throw new Error(`canvas is ${Math.round(cv.width)} px wide at x=${Math.round(cv.left)}, expected ${cw} px at x=0`);
          }
          if (cv.height < 240) throw new Error(`canvas height is only ${Math.round(cv.height)} px`);
          if (bn.top < cv.bottom - 1) throw new Error('banner is over the canvas, not stacked below it');
          if (sd.top < bn.bottom - 1 || pl.top < bn.bottom - 1) throw new Error('player list is not stacked below the banner');
          if (q.top < sd.bottom - 1 || q.top < pl.bottom - 1) throw new Error('quickstart is not stacked below the player list');
          c.metric('phoneCanvasPx', `${Math.round(cv.width)}x${Math.round(cv.height)}`);

          assertVisibleByPoint(doc, win, $('c'), 'canvas');
          assertVisibleByPoint(doc, win, $('banner'), 'banner');
          assertVisibleByPoint(doc, win, $('players'), 'player list');
          const rows = [...doc.querySelectorAll('#plist li')];
          if (!rows.length) throw new Error('player list has no rows');
          for (const li of rows) assertVisibleByPoint(doc, win, li, `player row "${li.querySelector('.nm')?.textContent || ''}"`);

          const summary = $('quick').querySelector('summary');
          assertVisibleByPoint(doc, win, summary, 'quickstart summary');
          if (!$('quick').open) summary.click();
          await c.wait(200);
          assertVisibleByPoint(doc, win, $('quick'), 'quickstart');
          assertVisibleByPoint(doc, win, $('qs-code'), 'quickstart code');
          assertVisibleByPoint(doc, win, $('qs-run'), 'quickstart Run button');
          await c.wait(350);
          // Re-verify player list rows remain uncovered while quickstart is open (m_98d0e8584bd2), and nothing widened the page.
          for (const li of rows) assertVisibleByPoint(doc, win, li, `player row "${li.querySelector('.nm')?.textContent || ''}" with quickstart open`);
          assertNoSidewaysScroll(doc, win, 'demo with quickstart open');
          win.scrollTo(0, 0);
          await c.wait(150);
          return `canvas ${Math.round(cv.width)}x${Math.round(cv.height)}, banner, ${rows.length} player row(s) and quickstart verified by elementFromPoint`;
        });
        c.progress(0.35);

        const spot = (x, y) => {
          const b = $('c').getBoundingClientRect();
          return [b.left + x * b.width, b.top + y * b.height];
        };
        const sendTouch = (el, type, [x, y], pointerId = 5) => el.dispatchEvent(new win.PointerEvent(type, {
          pointerType: 'touch',
          pointerId,
          isPrimary: true,
          clientX: x,
          clientY: y,
          width: 22,
          height: 22,
          pressure: type === 'pointerup' || type === 'pointercancel' ? 0 : 0.5,
          bubbles: true,
          cancelable: true,
        }));

        await c.check('Dragging on the canvas with touch pointer events moves your dot toward the drag', async () => {
          win.scrollTo(0, 0);
          await c.wait(100);
          let touchMovesSeen = 0;
          const onMove = (e) => { if (e.pointerType === 'touch') touchMovesSeen++; };
          $('c').addEventListener('pointermove', onMove);
          try {
            const dragLeg = async (toX, toY, steps) => {
              const start = win.hawkesDemoView().me;
              const dx = toX - start.x, dy = toY - start.y;
              let prevDist = Math.hypot(dx, dy);
              if (prevDist < 0.2) throw new Error(`drag start (${start.x.toFixed(2)}, ${start.y.toFixed(2)}) too close to target (${toX}, ${toY})`);
              sendTouch($('c'), 'pointerdown', spot(start.x, start.y));
              for (let i = 1; i <= steps; i++) {
                const u = i / steps;
                sendTouch($('c'), 'pointermove', spot(start.x + dx * u, start.y + dy * u));
                const cur = win.hawkesDemoView().me;
                const toward = (cur.x - start.x) * dx + (cur.y - start.y) * dy;
                const dist = Math.hypot(toX - cur.x, toY - cur.y);
                if (toward <= 0 || dist >= prevDist - 1e-4) {
                  throw new Error(`step ${i}/${steps} did not move toward (${toX}, ${toY}): at (${cur.x.toFixed(2)}, ${cur.y.toFixed(2)}), dist ${dist.toFixed(3)} vs ${prevDist.toFixed(3)}`);
                }
                prevDist = dist;
                await c.wait(50);
              }
              sendTouch($('c'), 'pointerup', spot(toX, toY));
              const end = win.hawkesDemoView().me;
              if (!near(end.x, toX, 0.03) || !near(end.y, toY, 0.03)) {
                throw new Error(`dot ended at (${end.x.toFixed(2)}, ${end.y.toFixed(2)}), expected (${toX.toFixed(2)}, ${toY.toFixed(2)})`);
              }
              return { moved: Math.hypot(end.x - start.x, end.y - start.y), end };
            };

            const init = win.hawkesDemoView().me;
            const [t1x, t1y] = Math.hypot(0.84 - init.x, 0.20 - init.y) >= 0.4 ? [0.84, 0.20] : [0.18, 0.76];
            const [t2x, t2y] = t1x > 0.5 ? [0.18, 0.76] : [0.84, 0.20];
            const leg1 = await dragLeg(t1x, t1y, 14);
            const leg2 = await dragLeg(t2x, t2y, 16);
            if (touchMovesSeen < 30) throw new Error(`expected >= 30 touch pointermove events on canvas, saw ${touchMovesSeen}`);

            // A lifted finger or a touch drag outside the canvas must not move the dot.
            const held = win.hawkesDemoView().me;
            sendTouch($('c'), 'pointermove', spot(0.9, 0.9));
            const bn = $('banner').getBoundingClientRect();
            sendTouch($('banner'), 'pointerdown', [bn.left + 20, bn.top + 12], 6);
            sendTouch($('banner'), 'pointermove', [bn.left + 120, bn.top + 12], 6);
            sendTouch($('banner'), 'pointerup', [bn.left + 120, bn.top + 12], 6);
            const after = win.hawkesDemoView().me;
            if (after.x !== held.x || after.y !== held.y) throw new Error('dot moved without an active touch on the canvas');

            // A touch tap on the canvas places your dot there.
            sendTouch($('c'), 'pointerdown', spot(0.66, 0.36));
            sendTouch($('c'), 'pointerup', spot(0.66, 0.36));
            const tapped = win.hawkesDemoView().me;
            if (!near(tapped.x, 0.66, 0.03) || !near(tapped.y, 0.36, 0.03)) {
              throw new Error(`touch tap at (0.66, 0.36) left dot at (${tapped.x.toFixed(2)}, ${tapped.y.toFixed(2)})`);
            }
            await c.wait(300);
            const total = Math.round((leg1.moved + leg2.moved) * 100) / 100;
            c.metric('dragMovedBy', total);
            c.metric('touchMoveEvents', touchMovesSeen);
            return `${touchMovesSeen} touch moves across 2 drags (${total} canvas widths), tap at (${tapped.x.toFixed(2)}, ${tapped.y.toFixed(2)})`;
          } finally {
            $('c').removeEventListener('pointermove', onMove);
          }
        });
        c.progress(0.55);

        await c.check('At 390 x 844 with 4 players the frame time stays under 20 ms (p95)', async () => {
          win.hawkesDemoLoad(3); // you plus 3 blobs circling the room
          await c.wait(300); win.hawkesFrameStats(true); await c.wait(3000);
          const s = win.hawkesFrameStats(); win.hawkesDemoLoad(0);
          c.metric('p95FrameMs', s.p95FrameMs);
          if (s.frames < 30) throw new Error(`only ${s.frames} frames in 3 s`);
          if (s.p95FrameMs > 20) throw new Error(`p95 frame time ${s.p95FrameMs} ms over ${s.frames} frames (limit 20)`);
          return `p95 ${s.p95FrameMs} ms over ${s.frames} frames, 4 players`;
        });

        await c.check(`All text on the demo page is at least ${MIN_TEXT_PX} px at 390 px`, async () => {
          if (!$('quick').open) $('quick').querySelector('summary').click();
          await c.wait(100);
          const { count, least, small, clipped } = measureSmallestText(doc, win);
          c.metric('phoneSmallestTextPx', least);
          if (!count) throw new Error('no visible text found on demo page');
          if (small.length) throw new Error(`text under ${MIN_TEXT_PX}px: ${small.slice(0, 5).join(', ')}`);
          if (clipped.length) throw new Error(`text clipped outside 390px viewport: ${clipped.slice(0, 5).join(', ')}`);
          return `${count} text elements checked, smallest ${least} px (>= ${MIN_TEXT_PX} px)`;
        });
        c.progress(0.7);

        await c.check('Code on the demo page scrolls inside its box without scrolling the page', async () => {
          const pre = $('qs-code'), b = pre.getBoundingClientRect(), cw = doc.documentElement.clientWidth;
          if (b.right > cw + 1) throw new Error(`code box right edge is at ${Math.round(b.right)} px (> ${cw} px)`);
          if (pre.scrollWidth <= pre.clientWidth) throw new Error('code box has no long line to scroll');
          pre.scrollLeft = 60;
          if (pre.scrollLeft < 1) throw new Error('code box did not scroll sideways');
          assertNoSidewaysScroll(doc, win, 'demo after code scroll');
          return `box ${Math.round(b.width)} px, code ${pre.scrollWidth} px, scrollLeft=${Math.round(pre.scrollLeft)}, page scrollX=0`;
        });
        c.progress(0.8);

        recipesFrame = await openFrame(pages.recipes, 'recipes', nativePhone);
        const rw = recipesFrame.contentWindow, rd = recipesFrame.contentDocument;
        await c.until(
          () => rd.querySelectorAll('pre.code').length >= 4 && [...rd.querySelectorAll('pre.code')].every((p) => p.textContent !== 'Loading…'),
          15000,
          'the recipes page to load at 390x844',
        );

        await c.check(`At 390 x 844 the recipes page has no sideways scroll, text >= ${MIN_TEXT_PX} px, and scrolling code boxes`, async () => {
          const { cw, sw } = assertNoSidewaysScroll(rd, rw, 'recipes');
          const { count, least, small, clipped } = measureSmallestText(rd, rw);
          c.metric('recipesSidewaysPx', Math.max(0, sw - cw));
          c.metric('recipesSmallestTextPx', least);
          if (!count) throw new Error('no visible text on recipes page');
          if (small.length) throw new Error(`recipes text under ${MIN_TEXT_PX}px: ${small.slice(0, 5).join(', ')}`);
          if (clipped.length) throw new Error(`recipes text outside 390px viewport: ${clipped.slice(0, 5).join(', ')}`);
          const pres = [...rd.querySelectorAll('pre.code')];
          const wideOnes = pres.filter((p) => p.scrollWidth > p.clientWidth);
          if (!wideOnes.length) throw new Error('no recipe code is wider than its box');
          for (const p of wideOnes) {
            const b = p.getBoundingClientRect();
            if (b.right > cw + 1) throw new Error(`recipe code box right edge at ${Math.round(b.right)} px (> ${cw} px)`);
            if (!['auto', 'scroll'].includes(rw.getComputedStyle(p).overflowX)) throw new Error('recipe code box lacks overflow-x scroll');
            p.scrollLeft = 80;
            if (p.scrollLeft < 1) throw new Error('recipe code box did not scroll sideways');
          }
          assertNoSidewaysScroll(rd, rw, 'recipes after code scroll');
          c.metric('recipeCodeBoxesScrolling', wideOnes.length);
          return `document width ${sw} px = viewport ${cw} px, smallest text ${least} px, ${wideOnes.length}/${pres.length} code boxes scroll`;
        });

        recipesFrame.remove();
        recipesFrame = null;

        if (pages.start) {
          startFrame = await openFrame(pages.start, 'start', nativePhone);
          const swWin = startFrame.contentWindow, sd = startFrame.contentDocument;
          await c.until(
            () => sd.getElementById('net')?.dataset.version && sd.querySelectorAll('pre.code').length === 5,
            15000,
            'the getting started page to load at 390x844',
          );
          await c.check(`At 390 x 844 the getting started page has no sideways scroll, text >= ${MIN_TEXT_PX} px, and scrolling code boxes`, async () => {
            const { cw, sw } = assertNoSidewaysScroll(sd, swWin, 'start');
            const { count, least, small, clipped } = measureSmallestText(sd, swWin);
            c.metric('startSidewaysPx', Math.max(0, sw - cw));
            c.metric('startSmallestTextPx', least);
            if (!count) throw new Error('no visible text on getting started page');
            if (small.length) throw new Error(`start text under ${MIN_TEXT_PX}px: ${small.slice(0, 5).join(', ')}`);
            if (clipped.length) throw new Error(`start text outside 390px viewport: ${clipped.slice(0, 5).join(', ')}`);
            const pres = [...sd.querySelectorAll('pre.code')];
            const wideOnes = pres.filter((p) => p.scrollWidth > p.clientWidth);
            if (!wideOnes.length) throw new Error('no getting started code is wider than its box');
            for (const p of wideOnes) {
              const b = p.getBoundingClientRect();
              if (b.right > cw + 1) throw new Error(`start code box right edge at ${Math.round(b.right)} px (> ${cw} px)`);
              if (!['auto', 'scroll'].includes(swWin.getComputedStyle(p).overflowX)) throw new Error('start code box lacks overflow-x scroll');
              p.scrollLeft = 60;
              if (p.scrollLeft < 1) throw new Error('start code box did not scroll sideways');
            }
            assertNoSidewaysScroll(sd, swWin, 'start after code scroll');
            c.metric('startCodeBoxesScrolling', wideOnes.length);
            return `document width ${sw} px = viewport ${cw} px, smallest text ${least} px, ${wideOnes.length}/${pres.length} code boxes scroll`;
          });
          startFrame.remove();
          startFrame = null;
        }
        // Return the 390x844 demo view to the top so final screenshots show the stacked phone layout and moved dot.
        win.scrollTo(0, 0);
        await c.wait(400);
        c.progress(1);
      } finally {
        if (recipesFrame) recipesFrame.remove();
        if (startFrame) startFrame.remove();
      }
    },
  };
}

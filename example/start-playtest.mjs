// The demo's `start` playtest scenario: opens example/start.html from the demo header link, verifies the five numbered
// steps and their "What you should see" boxes, clicks every Copy button, runs start.mjs live between two players, and
// checks at 390 x 844 that nothing scrolls sideways, all text is >= 12 px, and every code block scrolls inside its box.
const W = 390, H = 844, MIN_TEXT_PX = 12;

export function startScenario({ lobby, opts, page = new URL('./start.html', location.href).href }) {
  let guardInstalled = false;
  const clearFrames = () => document.querySelectorAll('[data-start-playtest]').forEach((e) => e.remove());
  const installGuard = () => {
    if (guardInstalled || !window.hawkesPlaytest) return;
    guardInstalled = true;
    const origStart = window.hawkesPlaytest.start.bind(window.hawkesPlaytest);
    const origStop = window.hawkesPlaytest.stop?.bind(window.hawkesPlaytest);
    window.hawkesPlaytest.start = (id, o) => { if (id !== 'start') clearFrames(); return origStart(id, o); };
    if (origStop) window.hawkesPlaytest.stop = () => { clearFrames(); return origStop(); };
  };

  const ensureBackdrop = () => {
    if (document.querySelector('[data-start-playtest="backdrop"]')) return;
    const bg = document.createElement('div');
    bg.dataset.startPlaytest = 'backdrop';
    bg.style.cssText = 'position:fixed;inset:0;background:#0b0f14;z-index:99989';
    document.body.append(bg);
  };

  const openFrame = (url, w, h, kind) => new Promise((res, rej) => {
    ensureBackdrop();
    const f = document.createElement('iframe');
    f.dataset.startPlaytest = kind;
    f.src = url;
    f.title = `Getting started (${kind} ${w}x${h})`;
    if (innerWidth === w && innerHeight === h) {
      f.style.cssText = `position:fixed;left:0;top:0;width:${w}px;height:${h}px;box-sizing:content-box;border:0;background:#0b0f14;z-index:99990`;
    } else {
      const scale = Math.min(1, (innerHeight - 16) / h, (innerWidth - 16) / w);
      f.style.cssText = `position:fixed;left:50%;top:50%;width:${w}px;height:${h}px;box-sizing:content-box;border:1px solid #2a3340;border-radius:14px;background:#0b0f14;z-index:99990;transform-origin:center center;transform:translate(-50%,-50%) scale(${scale})`;
    }
    f.addEventListener('load', () => res(f), { once: true });
    f.addEventListener('error', () => rej(new Error(`could not open ${url}`)), { once: true });
    document.body.append(f);
  });

  const assertNoSidewaysScroll = (d, w, label) => {
    if (w.innerWidth !== W || w.innerHeight !== H) {
      throw new Error(`${label} viewport is ${w.innerWidth}x${w.innerHeight}, expected ${W}x${H}`);
    }
    const cw = d.documentElement.clientWidth;
    const sw = d.documentElement.scrollWidth;
    const wide = [...d.querySelectorAll('body *')].filter((e) => {
      if (e.closest('pre, #hawkes-net-playtest, [data-hawkes-report], [data-start-playtest]')) return false;
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
      if (el.closest('#hawkes-net-playtest, [data-hawkes-report], [data-start-playtest]')) continue;
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
    id: 'start',
    title: 'Getting started shows five numbered steps with expected output, Copy buttons, and 390 px layout',
    seconds: 60,
    tags: ['full', 'docs'],
    description: 'Follows the demo header link to start.html, verifies the five numbered steps from GitHub tag tarball install to two tabs in one room and what you should see after each, clicks Copy on every code block, runs start.mjs live between two players, and verifies at 390 x 844 that nothing scrolls sideways, text is >= 12 px, and every code block scrolls inside its own box.',
    run: async (c) => {
      installGuard();
      clearFrames();
      let desktopFrame = null, bot = null;
      try {
        const headerLink = document.querySelector('#hud a[href*="start.html"]');
        if (!headerLink) throw new Error('demo #hud header has no link to start.html');

        desktopFrame = await openFrame(new URL(headerLink.getAttribute('href'), location.href).href, 1100, 720, 'desktop');
        const dw = desktopFrame.contentWindow, dd = desktopFrame.contentDocument;
        await c.until(() => dd.getElementById('net')?.dataset.version && dd.querySelectorAll('ol#steps > li.step').length === 5, 15000, 'start.html to load with 5 steps');

        await c.check('Getting started shows five numbered steps, each with what you should see after it', async () => {
          const steps = [...dd.querySelectorAll('ol#steps > li.step')];
          if (steps.length !== 5) throw new Error(`expected 5 steps, found ${steps.length}`);
          const summaries = [];
          for (let i = 0; i < steps.length; i++) {
            const s = steps[i], num = i + 1;
            s.scrollIntoView({ block: 'center' });
            await c.wait(220);
            const badge = s.querySelector('.step-num')?.textContent.trim();
            const h2 = s.querySelector('h2')?.textContent.trim() || '';
            if (badge !== String(num) || !h2.startsWith(`${num}.`)) {
              throw new Error(`step ${num} is not numbered ${num} (badge="${badge}", h2="${h2}")`);
            }
            const expectBox = s.querySelector('.expect');
            const title = expectBox?.querySelector('.expect-title')?.textContent.trim() || '';
            const consoleBox = expectBox?.querySelector('.console');
            if (!expectBox || !/What you should see/i.test(title) || !consoleBox || !consoleBox.textContent.trim()) {
              throw new Error(`step ${num} is missing its "What you should see" box`);
            }
            const eb = expectBox.getBoundingClientRect();
            if (eb.width < 40 || eb.height < 20) throw new Error(`step ${num} expect box has empty bounds`);
            summaries.push(`${num}: ${consoleBox.textContent.trim().split('\n')[0]}`);
          }
          // Step 1 must show the GitHub tag tarball; Step 5 must show the two-tab room preview and console transcript.
          const step1Code = dd.getElementById('step-1-code')?.textContent || '';
          if (!/github\.com\/jgriffith3433\/hawkesnet-js\/archive\/refs\/tags\/v\d+\.\d+\.\d+\.tar\.gz/.test(step1Code)) {
            throw new Error(`step 1 does not install the GitHub tag tarball: ${step1Code}`);
          }
          if (dd.querySelectorAll('#step-5-expect .tab-shot').length < 2) {
            throw new Error('step 5 expect box is missing the two-tab preview');
          }
          // Verify steps 2..5 match start.mjs byte-for-byte.
          const startSrc = (await (await fetch(new URL('./start.mjs', page))).text()).replace(/\r\n/g, '\n');
          const joined = [2, 3, 4, 5].map((n) => dd.getElementById(`step-${n}-code`).textContent.replace(/\r\n/g, '\n')).join('\n\n') + '\n';
          if (joined !== startSrc) throw new Error('steps 2..5 on start.html drifted from start.mjs');
          c.metric('gettingStartedSteps', steps.length);
          c.metric('expectedOutputBoxes', steps.length);
          return `5 numbered steps verified (${summaries.join(' | ')})`;
        });
        c.progress(0.35);

        await c.check('Every code block has a working Copy button', async () => {
          const pres = [...dd.querySelectorAll('pre')];
          if (pres.length !== 5) throw new Error(`expected 5 code blocks, found ${pres.length}`);
          let copied = 0;
          for (let i = 0; i < pres.length; i++) {
            const pre = pres[i];
            pre.scrollIntoView({ block: 'center' });
            const step = pre.closest('.step');
            const btn = step?.querySelector('button.copy');
            if (!btn) throw new Error(`code block ${i + 1} has no Copy button`);
            const b = btn.getBoundingClientRect();
            if (b.width < 20 || b.height < 16) throw new Error(`code block ${i + 1} Copy button is not visible`);
            btn.click();
            await c.until(() => btn.dataset.copied === '1' && btn.textContent === 'Copied' && btn.classList.contains('copied'), 2000, `Copy button ${i + 1} to copy`);
            copied++;
            await c.wait(100);
          }
          c.metric('codeBlocks', pres.length);
          c.metric('copyButtonsPassed', copied);
          return `${copied} of ${pres.length} code blocks copied`;
        });
        c.progress(0.6);

        // Run start.mjs live on Step 5 with a second player so the page's live output matches its "What you should see" boxes.
        if (lobby && opts) {
          const roomArea = `getting-started-${Math.random().toString(36).slice(2, 8)}`;
          dw.__hawkesStartArea = roomArea;
          const runBtn = dd.getElementById('start-run'), outEl = dd.getElementById('start-out');
          runBtn.scrollIntoView({ block: 'center' });
          runBtn.click();
          await c.until(() => /status: online/.test(outEl.textContent) && /you: hi, anyone here\?/.test(outEl.textContent), 15000, 'Step 5 Run it here to reach online');
          bot = lobby({ ...opts, name: 'Bob', log: false });
          bot.join(roomArea);
          await c.until(() => bot.ready && /Bob joined/.test(outEl.textContent), 15000, 'second tab Bob to join getting-started');
          bot.send('chat', 'hello Ada');
          bot.pose([0.6, 0.4, 0]);
          await c.until(() => /Bob: hello Ada/.test(outEl.textContent) && /Bob is at 0\.60, 0\.40/.test(outEl.textContent), 10000, 'start.html to log Bob chat and cursor');
          await bot.leave();
          bot = null;
          await c.until(() => /Bob left/.test(outEl.textContent), 10000, 'start.html to log Bob left');
          await c.wait(250);
        }
        c.progress(0.75);

        desktopFrame.remove();
        desktopFrame = null;

        const phoneFrame = await openFrame(page, W, H, 'phone');
        const pw = phoneFrame.contentWindow, pd = phoneFrame.contentDocument;
        await c.until(() => pd.getElementById('net')?.dataset.version && pd.querySelectorAll('pre.code').length === 5, 15000, 'start.html to load at 390x844');

        await c.check('At 390 px nothing scrolls sideways and code scrolls inside its own box', async () => {
          pw.scrollTo(0, 0);
          const { cw, sw } = assertNoSidewaysScroll(pd, pw, 'start.html');
          const { count, least, small, clipped } = measureSmallestText(pd, pw);
          if (!count) throw new Error('no visible text on start.html');
          if (small.length) throw new Error(`start.html text under ${MIN_TEXT_PX}px: ${small.slice(0, 5).join(', ')}`);
          if (clipped.length) throw new Error(`start.html text outside 390px viewport: ${clipped.slice(0, 5).join(', ')}`);
          const pres = [...pd.querySelectorAll('pre.code')];
          if (pres.length !== 5) throw new Error(`expected 5 code blocks at 390px, found ${pres.length}`);
          let scrolled = 0;
          for (let i = 0; i < pres.length; i++) {
            const p = pres[i];
            p.scrollIntoView({ block: 'center' });
            const b = p.getBoundingClientRect();
            if (b.right > cw + 1 || b.left < -1) {
              throw new Error(`step ${i + 1} code box (${Math.round(b.left)}..${Math.round(b.right)}) overflows ${cw} px`);
            }
            if (!['auto', 'scroll'].includes(pw.getComputedStyle(p).overflowX)) {
              throw new Error(`step ${i + 1} code box lacks overflow-x scroll`);
            }
            if (p.scrollWidth <= p.clientWidth) {
              throw new Error(`step ${i + 1} code box (${p.scrollWidth} <= ${p.clientWidth}) did not need to scroll inside its box`);
            }
            p.scrollLeft = 60;
            if (p.scrollLeft < 1) throw new Error(`step ${i + 1} code box did not scroll sideways`);
            scrolled++;
          }
          assertNoSidewaysScroll(pd, pw, 'start.html after code scroll');
          pw.scrollTo(0, 0);
          await c.wait(400);
          c.metric('startPhoneWidthPx', sw);
          c.metric('startPhoneSidewaysPx', Math.max(0, sw - cw));
          c.metric('startSmallestTextPx', least);
          c.metric('startScrollingCodeBoxes', scrolled);
          return `document width ${sw} px = viewport ${cw} px (scrollX=0), smallest text ${least} px, ${scrolled}/${pres.length} code boxes scroll inside their box`;
        });
        c.progress(1);
      } finally {
        if (desktopFrame) desktopFrame.remove();
        if (bot) { try { await bot.leave(); } catch { /* gone */ } }
      }
    },
  };
}

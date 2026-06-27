// Vitalisera djupdyk, levande undervattensscen på canvas.
// Bakgrunden förändras med djupet: ljus petrol-turkos yta med ljusstrålar högst
// upp, mörkt petrolsvart djuphav längst ned. Bubblor stiger, partiklar driver.
// Färgerna följer Vitaliseras palett (petrol-teal). Lättviktig.

(function (global) {
  'use strict';

  const canvas = document.getElementById('ocean');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  let W = 0, H = 0, DPR = 1;
  let depth = 0;          // mål-djup 0..1
  let depthCur = 0;       // utjämnat djup
  let bubbles = [];
  let motes = [];
  let rays = [];
  let running = true;
  let last = 0;

  const lerp = (a, b, t) => a + (b - a) * t;

  // Färgpaletter (yta -> djup), interpoleras med depthCur.
  const TOP = [
    [150, 214, 218],  // yta: ljus aqua-grön (mot brand #cce2e3)
    [6, 54, 74],      // djup-topp: mörk petrol
  ];
  const BOTTOM = [
    [40, 104, 124],   // yta-botten: petrol
    [1, 7, 11],       // djup-botten: nästan svart
  ];
  function mixStop(stops, t) {
    const a = stops[0], b = stops[1];
    return `rgb(${Math.round(lerp(a[0], b[0], t))},${Math.round(lerp(a[1], b[1], t))},${Math.round(lerp(a[2], b[2], t))})`;
  }

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    seed();
  }

  function rnd(a, b) { return a + Math.random() * (b - a); }

  function seed() {
    const bubbleCount = Math.round((W * H) / 26000);
    bubbles = Array.from({ length: bubbleCount }, makeBubble);
    const moteCount = Math.round((W * H) / 12000);
    motes = Array.from({ length: moteCount }, makeMote);
    rays = Array.from({ length: 5 }, (_, i) => ({
      x: rnd(0, W),
      w: rnd(60, 160),
      speed: rnd(0.02, 0.06),
      phase: rnd(0, Math.PI * 2),
      skew: rnd(-0.25, 0.25),
    }));
  }

  function makeBubble() {
    return {
      x: rnd(0, W),
      y: rnd(0, H),
      r: rnd(1.2, 4.5),
      speed: rnd(14, 42),
      drift: rnd(-10, 10),
      wobble: rnd(0, Math.PI * 2),
      alpha: rnd(0.15, 0.5),
    };
  }
  function makeMote() {
    return {
      x: rnd(0, W),
      y: rnd(0, H),
      r: rnd(0.4, 1.6),
      vx: rnd(-6, 6),
      vy: rnd(-4, 4),
      alpha: rnd(0.05, 0.28),
    };
  }

  function step(dt) {
    depthCur += (depth - depthCur) * Math.min(1, dt * 1.6);

    for (const b of bubbles) {
      b.y -= b.speed * dt;
      b.wobble += dt * 2;
      b.x += Math.sin(b.wobble) * b.drift * dt;
      if (b.y + b.r < -4) { Object.assign(b, makeBubble(), { y: H + rnd(2, 30) }); }
    }
    for (const m of motes) {
      m.x += m.vx * dt; m.y += m.vy * dt;
      if (m.x < -4) m.x = W + 4; else if (m.x > W + 4) m.x = -4;
      if (m.y < -4) m.y = H + 4; else if (m.y > H + 4) m.y = -4;
    }
    for (const r of rays) { r.phase += r.speed; }
  }

  function draw() {
    // Djup-gradient, eased så att nedstigningen mörknar tydligt och kännbart.
    const de = Math.pow(depthCur, 0.78);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, mixStop(TOP, de));
    g.addColorStop(1, mixStop(BOTTOM, de));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Mörk vinjett som växer kraftigt med djupet (sluten, tryckande känsla djupt ner)
    const vg = ctx.createRadialGradient(W / 2, H * 0.3, H * 0.08, W / 2, H * 0.5, H * 1.0);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, `rgba(1,8,12,${0.3 + de * 0.62})`);
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);

    // Ljusstrålar uppifrån (bleknar med djupet)
    const rayAlpha = (1 - depthCur) * 0.10;
    if (rayAlpha > 0.005) {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      for (const r of rays) {
        const sway = Math.sin(r.phase) * 40;
        const x = r.x + sway;
        const top = x + r.skew * 120;
        const grad = ctx.createLinearGradient(x, 0, x, H * 0.8);
        grad.addColorStop(0, `rgba(202,240,242,${rayAlpha})`);
        grad.addColorStop(1, 'rgba(202,240,242,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(top - r.w / 2, 0);
        ctx.lineTo(top + r.w / 2, 0);
        ctx.lineTo(x + r.w, H * 0.85);
        ctx.lineTo(x - r.w, H * 0.85);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    // Svävande partiklar
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (const m of motes) {
      ctx.globalAlpha = m.alpha * (0.5 + depthCur * 0.5);
      ctx.fillStyle = '#cfeef0';
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Stigande bubblor
    ctx.save();
    for (const b of bubbles) {
      ctx.globalAlpha = b.alpha;
      ctx.strokeStyle = 'rgba(222,244,245,0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = b.alpha * 0.5;
      ctx.fillStyle = 'rgba(206,238,240,0.6)';
      ctx.beginPath();
      ctx.arc(b.x - b.r * 0.3, b.y - b.r * 0.3, b.r * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function frame(t) {
    if (!running) return;
    const dt = Math.min(0.05, (t - last) / 1000 || 0);
    last = t;
    step(dt);
    draw();
    requestAnimationFrame(frame);
  }

  const Ocean = {
    setDepth(t) { depth = Math.max(0, Math.min(1, t)); },
    pause() { running = false; },
    resume() { if (!running) { running = true; last = performance.now(); requestAnimationFrame(frame); } },
  };

  window.addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) Ocean.pause(); else Ocean.resume();
  });

  resize();
  requestAnimationFrame((t) => { last = t; frame(t); });

  global.Ocean = Ocean;
})(typeof window !== 'undefined' ? window : globalThis);

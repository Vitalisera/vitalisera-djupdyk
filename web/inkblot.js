// Vitalisera djupdyk, procedurell symmetrisk bläckbild (Rorschach-känsla).
// Samma frö ger exakt samma bild på alla enheter. Inget behov av bildfiler.
(function (global) {
  'use strict';

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // Bygger en spegelsymmetrisk organisk form av sammansmälta ellipser (gooey-filter).
  function svg(seed, color) {
    const w = 300, h = 360, cx = w / 2;
    const rnd = mulberry32((seed | 0) || 1);
    let s = '';
    const n = 9 + Math.floor(rnd() * 6);
    for (let i = 0; i < n; i++) {
      const x = (cx - 6 - rnd() * (w * 0.40));
      const y = (h * 0.12 + rnd() * h * 0.76);
      const r = 10 + rnd() * 54;
      const rx = (r * (0.55 + rnd() * 0.95)).toFixed(1);
      const ry = (r * (0.55 + rnd() * 0.95)).toFixed(1);
      const rot = (rnd() * 60 - 30).toFixed(1);
      s += `<ellipse transform="rotate(${rot} ${x.toFixed(1)} ${y.toFixed(1)})" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="${rx}" ry="${ry}"/>`;
      s += `<ellipse transform="rotate(${(-rot)} ${(w - x).toFixed(1)} ${y.toFixed(1)})" cx="${(w - x).toFixed(1)}" cy="${y.toFixed(1)}" rx="${rx}" ry="${ry}"/>`;
    }
    // Mittspalt så formen hänger ihop kring symmetriaxeln.
    const m = 3 + Math.floor(rnd() * 3);
    for (let i = 0; i < m; i++) {
      const y = (h * 0.16 + rnd() * h * 0.66).toFixed(1);
      const r = 16 + rnd() * 36;
      s += `<ellipse cx="${cx}" cy="${y}" rx="${(r * 0.8).toFixed(1)}" ry="${r.toFixed(1)}"/>`;
    }
    const fid = 'goo' + (seed | 0);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">`
      + `<defs><filter id="${fid}" x="-20%" y="-20%" width="140%" height="140%">`
      + `<feGaussianBlur stdDeviation="7"/>`
      + `<feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 26 -11"/>`
      + `</filter></defs>`
      + `<g filter="url(#${fid})" fill="${color}">${s}</g></svg>`;
  }

  global.Inkblot = { svg };
})(typeof window !== 'undefined' ? window : globalThis);

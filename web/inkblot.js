// Vitalisera djupdyk, procedurell symmetrisk bläckbild (Rorschach-känsla).
// Samma frö ger exakt samma bild på alla enheter. Inget behov av bildfiler.
// Ren funktion av seedet: samma seed → samma bild överallt, servern berörs ej.
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

  const W = 300, H = 360, CX = W / 2;

  // Genererar formens parametrar ur ett frö. Riktiga Rorschach-tavlor har en
  // kroppsaxel med utskott (lemmar/vingar) och konkava vikar, inte bara runda
  // klumpar. Vi bygger därför: huvudmassa + mittspalt + utskott + bett + stänk.
  function genBlot(seed) {
    const rnd = mulberry32((seed | 0) || 1);
    const main = [];
    const n = 9 + Math.floor(rnd() * 6);
    for (let i = 0; i < n; i++) {
      const x = CX - 6 - rnd() * (W * 0.40);
      const y = H * 0.12 + rnd() * H * 0.76;
      const r = 10 + rnd() * 54;
      const rx = r * (0.55 + rnd() * 0.95);
      const ry = r * (0.55 + rnd() * 0.95);
      const rot = rnd() * 60 - 30;
      main.push({ x, y, rx, ry, rot });
    }
    // Mittspalt så halvorna hänger ihop kring symmetriaxeln.
    const center = [];
    const m = 3 + Math.floor(rnd() * 3);
    for (let i = 0; i < m; i++) {
      const y = H * 0.16 + rnd() * H * 0.66;
      const r = 16 + rnd() * 36;
      center.push({ y, rx: r * 0.8, ry: r });
    }
    // Utskott: kraftigt avlånga ellipser som strålar UT från massans kant
    // (rx 4-6x ry, rotation lutad utåt). Ger vingar, lemmar, tentakler.
    const prot = [];
    const p = 3 + Math.floor(rnd() * 3);
    for (let i = 0; i < p; i++) {
      const base = main[Math.floor(rnd() * main.length)];
      const ry = 6 + rnd() * 9;
      const rx = ry * (4 + rnd() * 2);
      const dir = base.x < CX ? -1 : 1;                       // pekar utåt från axeln
      const rot = dir * (35 + rnd() * 55);                    // ~±(35..90) grader
      const x = base.x + dir * (base.rx * 0.5 + rnd() * 26);
      const y = base.y + (rnd() * 44 - 22);
      prot.push({ x, y, rx, ry, rot });
    }
    // Konkava bett: skär in i silhuetten (via mask) för vikar, hål och anatomi.
    const bite = [];
    const b = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < b; i++) {
      const base = main[Math.floor(rnd() * main.length)];
      const r = 11 + rnd() * 24;
      const x = base.x + (rnd() * 2 - 1) * base.rx;           // vid kanten
      const y = base.y + (rnd() * 2 - 1) * base.ry;
      bite.push({ x, y, rx: r, ry: r * (0.65 + rnd() * 0.6) });
    }
    // Stänk: små droppar utanför huvudmassan, egen svagare goo (bläckkänsla).
    const spl = [];
    const sp = 4 + Math.floor(rnd() * 5);
    for (let i = 0; i < sp; i++) {
      const x = CX - 10 - rnd() * (W * 0.44);
      const y = H * 0.08 + rnd() * H * 0.84;
      spl.push({ x, y, r: 1.5 + rnd() * 4 });
    }
    // Formindex: belöna avlånga huvudellipser + vertikal spridning (undvik runt).
    let elong = 0, minY = H, maxY = 0;
    for (const e of main) {
      if (Math.max(e.rx, e.ry) / Math.max(1, Math.min(e.rx, e.ry)) > 1.7) elong++;
      minY = Math.min(minY, e.y); maxY = Math.max(maxY, e.y);
    }
    const index = elong + ((maxY - minY) / H > 0.5 ? 2 : 0);
    return { main, center, prot, bite, spl, index };
  }

  function svg(seed, color) {
    // Deterministisk omdragning om formen blir för rund. Regeln är en ren funktion
    // av seedet → alla enheter drar om identiskt.
    let s = (seed | 0) || 1, g;
    for (let attempt = 0; attempt < 3; attempt++) {
      g = genBlot(s);
      if (g.index >= 2) break;
      s = (s * 31 + 7) | 0;
    }
    const f1 = (v) => v.toFixed(1);
    // Speglade positiva former (huvudmassa + utskott).
    let pos = '';
    const mir = (o) => {
      pos += `<ellipse transform="rotate(${f1(o.rot)} ${f1(o.x)} ${f1(o.y)})" cx="${f1(o.x)}" cy="${f1(o.y)}" rx="${f1(o.rx)}" ry="${f1(o.ry)}"/>`;
      pos += `<ellipse transform="rotate(${f1(-o.rot)} ${f1(W - o.x)} ${f1(o.y)})" cx="${f1(W - o.x)}" cy="${f1(o.y)}" rx="${f1(o.rx)}" ry="${f1(o.ry)}"/>`;
    };
    g.main.forEach(mir);
    g.prot.forEach(mir);
    g.center.forEach((o) => { pos += `<ellipse cx="${CX}" cy="${f1(o.y)}" rx="${f1(o.rx)}" ry="${f1(o.ry)}"/>`; });
    // Mask: vit = synligt, svarta bett = urskuret. Speglade.
    let mask = `<rect width="${W}" height="${H}" fill="#fff"/>`;
    g.bite.forEach((o) => {
      mask += `<ellipse cx="${f1(o.x)}" cy="${f1(o.y)}" rx="${f1(o.rx)}" ry="${f1(o.ry)}" fill="#000"/>`;
      mask += `<ellipse cx="${f1(W - o.x)}" cy="${f1(o.y)}" rx="${f1(o.rx)}" ry="${f1(o.ry)}" fill="#000"/>`;
    });
    // Stänk (speglade små droppar).
    let spl = '';
    g.spl.forEach((o) => {
      spl += `<circle cx="${f1(o.x)}" cy="${f1(o.y)}" r="${f1(o.r)}"/>`;
      spl += `<circle cx="${f1(W - o.x)}" cy="${f1(o.y)}" r="${f1(o.r)}"/>`;
    });
    const gid = 'goo' + s, mid = 'bite' + s, sid = 'spl' + s;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">`
      + `<defs>`
      + `<filter id="${gid}" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="7"/><feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 26 -11"/></filter>`
      + `<filter id="${sid}" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="1.6"/><feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -7"/></filter>`
      + `<mask id="${mid}">${mask}</mask>`
      + `</defs>`
      + `<g filter="url(#${gid})" mask="url(#${mid})" fill="${color}">${pos}</g>`
      + `<g filter="url(#${sid})" fill="${color}">${spl}</g></svg>`;
  }

  global.Inkblot = { svg };
})(typeof window !== 'undefined' ? window : globalThis);

// Vitalisera djupdyk, realtidsserver.
// En Cloudflare Worker som dirigerar varje rum till ett Durable Object (DO).
// DO:t ligger alltid uppe och äger den auktoritativa staten genom att köra
// exakt samma rena reducer som klienten (web/game.js). Spelarna är tunna
// WebSocket-klienter. Att en spelare (även den som skapade rummet) byter app
// stör därför inte de andra: servern finns kvar.
//
// Dessutom: ett singleton-register (Registry-DO) håller en live-översikt över
// aktiva rum för en lösenordsskyddad användnings-dashboard.

// Viktigt: questions.js importeras FÖRE game.js så att dess sidoeffekt sätter
// globalThis.DECK innan game.js läser den.
import DECK from '../../web/data/questions.js';
import Game from '../../web/game.js';

if (DECK && typeof globalThis !== 'undefined' && !globalThis.DECK) globalThis.DECK = DECK;

// Svårgissad väg till dashboarden. Token bor i en Cloudflare-SECRET (env.DASH_TOKEN),
// ALDRIG i koden, eftersom repot är publikt. Sätts med: wrangler secret put DASH_TOKEN.
// Saknas secreten matchar ingen token (fail-closed) och dashboarden ger 404.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Rate limit per IP via Workers ratelimit-binding (JOIN_RL i wrangler.toml, delad inom
// colo). Hotbilden är kod-gissning mot känsliga rum (32^4 kombinationer), inte data.
// Fail-open: saknas bindningen (t.ex. lokal dev) släpps trafiken igenom.
async function rateLimited(env, ip) {
  try {
    if (!env.JOIN_RL || !ip) return false;
    const { success } = await env.JOIN_RL.limit({ key: ip });
    return !success;
  } catch (_) { return false; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    // Användnings-dashboard på en svårgissad URL.
    const dm = url.pathname.match(/^\/dash\/([a-zA-Z0-9]+)(\/reset)?\/?$/);
    if (dm) {
      const token = env.DASH_TOKEN || '';
      if (!token || dm[1] !== token) return new Response('Not found', { status: 404 });
      const reg = env.REGISTRY.get(env.REGISTRY.idFromName('global'));
      return reg.fetch(new Request(dm[2] ? 'https://reg/reset' : 'https://reg/view'));
    }

    const m = url.pathname.match(/^\/room\/([A-Za-z0-9]{1,12})\/?$/);
    if (m) {
      if (await rateLimited(env, request.headers.get('cf-connecting-ip') || '')) {
        return new Response('För många försök. Vänta en stund.', { status: 429, headers: CORS });
      }
      const code = m[1].toUpperCase();
      const id = env.ROOM.idFromName(code);
      return env.ROOM.get(id).fetch(request);
    }
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('Vitalisera djupdyk realtidsserver är uppe.', { status: 200, headers: CORS });
    }
    return new Response('Not found', { status: 404, headers: CORS });
  },
};

export class Room {
  constructor(state, env) {
    this.ctx = state;
    this.env = env;
    this.game = null;
    this.code = null;
    this.meta = {};        // playerId -> { ip, country, city, region, utm } (EJ del av spel-staten, broadcastas ej)
    this.created = null;
    this.counted = {};     // playerId -> true: spelare vi redan räknat (mot dubbelräkning vid återanslutning)
    this._statSent = false;
    this._lastReport = 0;
    this.ctx.blockConcurrencyWhile(async () => {
      this.game = (await this.ctx.storage.get('game')) || null;
      this.code = (await this.ctx.storage.get('code')) || null;
      this.meta = (await this.ctx.storage.get('meta')) || {};
      this.created = (await this.ctx.storage.get('created')) || null;
      this.counted = (await this.ctx.storage.get('counted')) || {};
      this._statSent = (await this.ctx.storage.get('statSent')) || false;
      this._playReported = (await this.ctx.storage.get('playReported')) || false;
      this.mirrorState = (await this.ctx.storage.get('mirrorState')) || null;
      this.secrets = (await this.ctx.storage.get('secrets')) || {};   // playerId -> hemlighet (identitetsskydd)
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Förväntade en WebSocket-uppkoppling.', { status: 426 });
    }
    const code = url.pathname.split('/').filter(Boolean).pop().toUpperCase();

    // "Visa på TV": en passiv display-anslutning. Den prenumererar bara på staten
    // (stort kort + turindikator på en TV/laptop), styrs av en fjärr-telefon i samma
    // rum. Räknas ALDRIG som spelare: inget addPlayer, ingen meta, ingen rapport,
    // och den skapar inte ett rum (en TV riktad mot en tom kod ska inte starta dyk).
    if (url.searchParams.get('display') === '1') {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ['display']);
      pair[1].serializeAttachment({ display: true });
      // Prioritera ett riktigt server-spel; annars mirror-state (Runt bordet på TV).
      try { pair[1].send(JSON.stringify({ type: 'state', state: this.game || this.mirrorState || null })); } catch (_) {}
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // "Runt bordet på TV": telefonen kör spelet lokalt och SPEGLAR sin state hit.
    // Servern är bara ett relä mellan telefonen (mirror) och TV:n (display). Den kör
    // ingen reducer, lägger inte till spelare, rapporterar inte till dashboarden.
    if (url.searchParams.get('mirror') === '1') {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ['mirror']);
      pair[1].serializeAttachment({ mirror: true });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const playerId = (url.searchParams.get('id') || ('p' + Math.random().toString(36).slice(2, 9))).slice(0, 40);
    const name = (url.searchParams.get('name') || 'Gäst').slice(0, 24);

    // Identitetsskydd: spelar-id är självdeklarerat, så första anslutningen får en
    // hemlighet som sedan KRÄVS för att återta samma id (annars kan den som kan
    // rumskod + id agera som vem som helst, inklusive värden).
    const sec = (url.searchParams.get('s') || '').slice(0, 64);
    const known = this.secrets[playerId];
    if (known && known !== sec) {
      // Fel hemlighet: acceptera kort (ej hibernation-poolen), säg nej, stäng.
      const dp = new WebSocketPair();
      dp[1].accept();
      try { dp[1].send(JSON.stringify({ type: 'denied', reason: 'identitet' })); dp[1].close(4403, 'denied'); } catch (_) {}
      return new Response(null, { status: 101, webSocket: dp[0] });
    }
    // Okänt id: adoptera klientens hemlighet om den skickar en (samma enhet har EN
    // hemlighet för alla rum), annars utfärda en ny och skicka tillbaka den.
    let issuedSecret = null;
    if (!known) {
      if (sec) this.secrets[playerId] = sec;
      else { issuedSecret = crypto.randomUUID().replace(/-/g, ''); this.secrets[playerId] = issuedSecret; }
    }

    // Fånga IP/geo/UTM för dashboarden (separat från spel-staten).
    const cf = request.cf || {};
    this.meta[playerId] = {
      ip: request.headers.get('cf-connecting-ip') || '',
      country: cf.country || '', city: cf.city || '', region: cf.region || '',
      utm: (url.searchParams.get('utm') || '').slice(0, 200),
    };

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server, [playerId]);
    server.serializeAttachment({ playerId, name });
    // Ny identitet: skicka hemligheten privat till just den här socketen.
    if (issuedSecret) { try { server.send(JSON.stringify({ type: 'secret', secret: issuedSecret })); } catch (_) {} }

    if (!this.game) {
      this.game = Game.create(code, playerId); this.code = code; this.created = Date.now();
      // Ett riktigt spel tar över rummet: släng ev. gammal mirror-state (t.ex. en
      // återvunnen rumskod som tidigare kört Runt bordet-spegling).
      if (this.mirrorState) { this.mirrorState = null; try { this.ctx.storage.delete('mirrorState'); } catch (_) {} }
    }
    Game.addPlayer(this.game, { id: playerId, name });
    if (this.game.phase === 'playing' && !this.game.turnId) this.game.turnId = playerId;

    await this.persist();
    this.broadcast();
    await this.report();   // dyk + dykare räknas i Registry utifrån summary (konsekvent med peak, reset-rent)
    // TTL: rensa bort övergivna rum (och deras IP/geo-metadata) efter ett dygn utan nya anslutningar.
    try { await this.ctx.storage.setAlarm(Date.now() + 24 * 3600 * 1000); } catch (_) {}

    return new Response(null, { status: 101, webSocket: client });
  }

  async stat(ev) {
    try {
      const reg = this.env.REGISTRY.get(this.env.REGISTRY.idFromName('global'));
      await reg.fetch(new Request('https://reg/stat', { method: 'POST', body: JSON.stringify(ev) }));
    } catch (_) {}
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;
    const att = ws.deserializeAttachment() || {};
    if (att.display) return;   // en TV-display är passiv, den styr aldrig spelet
    if (att.mirror) {
      // Telefonen (Runt bordet) speglar sin lokala state hit → vidarebefordra till TV:n.
      // OBS: mirror-rum har ingen server-game, så detta måste ligga FÖRE game-guarden.
      // Ett riktigt server-spel accepterar ALDRIG mirror-push (annars kan vem som helst
      // som känner rumskoden spoofa spelets TV:ar).
      if (this.game) return;
      if (msg.type === 'mirror' && msg.state) {
        this.mirrorState = msg.state;
        try { await this.ctx.storage.put('mirrorState', this.mirrorState); } catch (_) {}
        const payload = JSON.stringify({ type: 'state', state: msg.state });
        for (const s of this.ctx.getWebSockets('display')) { try { s.send(payload); } catch (_) {} }
      }
      return;
    }
    if (!this.game) return;   // spelar-handlingar kräver ett server-game (mirror/display redan hanterade)
    const actorId = att.playerId;

    if (msg.type === 'action' && msg.action) {
      // Kort-engagemang: notera om det kort som lämnas behölls (Skicka vidare) eller byttes
      // (Byt fråga), hur länge det låg framme (dwell) och om följdfrågan drogs.
      const prev = this.game.card;
      const t = msg.action.type;
      this.game = Game.apply(this.game, msg.action, actorId);
      await this.persist();
      this.broadcast();
      await this.report(true);   // throttlad: håller fas/djup uppdaterat
      const statable = prev && prev.text && ['deck', 'quote', 'parable', 'parcard'].includes(prev.source);
      if (statable && (t === 'next' || t === 'skip')) {
        // Dwell: tid kortet låg framme. Cappas (idle-flikar ska inte blåsa upp snittet).
        const dwell = this._cardAt ? Math.min(Date.now() - this._cardAt, 20 * 60 * 1000) : 0;
        await this.stat({ card: { text: prev.text.slice(0, 160), source: prev.source, kept: t === 'next' ? 1 : 0, skipped: t === 'skip' ? 1 : 0, dwell } });
      } else if (statable && t === 'followup' && this.game.card && this.game.card.followup) {
        await this.stat({ card: { text: prev.text.slice(0, 160), source: prev.source, followed: 1 } });
      }
      // Nytt kort framme? Nollställ dwell-klockan.
      const cur = this.game.card;
      if (!prev || !cur || cur.text !== prev.text || cur.source !== prev.source) this._cardAt = Date.now();
    } else if (msg.type === 'hello') {
      const p = this.game.players.find((x) => x.id === actorId);
      if (p && msg.name) {
        const n = String(msg.name).slice(0, 24);
        if (p.name !== n) { p.name = n; await this.persist(); this.broadcast(); await this.report(true); }
      }
    } else if (msg.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong' })); } catch (_) {}
    }
  }

  async webSocketClose(ws) { await this._gone(ws); }
  async webSocketError(ws) { await this._gone(ws); }

  // TTL: ett dygn efter senaste anslutning. Är någon kvar → skjut fram; annars glöm
  // rummet helt (spelstat, hemligheter och IP/geo/UTM-metadata städas ur lagringen).
  async alarm() {
    const anyOnline = this.ctx.getWebSockets().some((s) => s.readyState === WebSocket.OPEN);
    if (anyOnline) { try { await this.ctx.storage.setAlarm(Date.now() + 24 * 3600 * 1000); } catch (_) {} return; }
    try { await this.report(false, true, 0); } catch (_) {}
    try { await this.ctx.storage.deleteAll(); } catch (_) {}
    this.game = null; this.code = null; this.meta = {}; this.mirrorState = null; this.secrets = {};
    this.created = null; this.counted = {}; this._statSent = false; this._playReported = false;
  }

  async _gone(ws) {
    const att = ws.deserializeAttachment() || {};
    const pid = att.playerId;
    if (!pid || !this.game) return;
    const left = this.ctx.getWebSockets(pid).filter((s) => s !== ws && s.readyState === WebSocket.OPEN);
    if (left.length > 0) return;

    Game.setConnected(this.game, pid, false);
    if (this.game.hostId === pid) {
      const next = this.game.players.find((p) => p.connected);
      if (next) this.game.hostId = next.id;
    }
    await this.persist();
    this.broadcast();
    // Rapportera: om ingen är kvar uppkopplad, ta bort rummet ur registret och
    // bokför dyk-längden (speltid) en gång.
    // Bara spelare håller rummet "levande" för speltid/registret. En kvarlämnad
    // TV-display (utan playerId) ska inte hålla ett tomt rum öppet i evighet.
    const anyOnline = this.ctx.getWebSockets().some((s) => {
      const a = s.deserializeAttachment() || {};
      return s.readyState === WebSocket.OPEN && a.playerId;
    });
    let played = 0;
    if (!anyOnline && this.created && !this._playReported) {
      played = Math.max(0, Date.now() - this.created);
      this._playReported = true;
      try { await this.ctx.storage.put('playReported', true); } catch (_) {}
    }
    // Alla spelare borta → tala om för ev. TV-displayer att dyket är slut (annars
    // fryser TV:n tyst på sista kortet).
    if (!anyOnline) {
      const ended = JSON.stringify({ type: 'ended' });
      for (const s of this.ctx.getWebSockets('display')) { try { s.send(ended); } catch (_) {} }
    }
    await this.report(false, !anyOnline, played);
  }

  broadcast() {
    const payload = JSON.stringify({ type: 'state', state: this.game });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(payload); } catch (_) {}
    }
  }

  // Live-sammanfattning för dashboarden (bara uppkopplade spelare).
  summary() {
    const onlineIds = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const a = ws.deserializeAttachment() || {};
      if (a.playerId) onlineIds.add(a.playerId);
    }
    const players = (this.game.players || []).filter((p) => onlineIds.has(p.id)).map((p) => {
      const m = this.meta[p.id] || {};
      return { id: p.id, name: p.name, country: m.country, city: m.city, ip: m.ip, utm: m.utm };
    });
    return {
      code: this.code, phase: this.game.phase, level: this.game.levelId, mode: this.game.mode,
      duet: !!this.game.duet, count: players.length, players,
      created: this.created || Date.now(), updated: Date.now(),
    };
  }

  async report(throttle, remove, played) {
    if (throttle && !remove && Date.now() - this._lastReport < 8000) return;
    this._lastReport = Date.now();
    try {
      const reg = this.env.REGISTRY.get(this.env.REGISTRY.idFromName('global'));
      const body = remove ? { code: this.code, remove: true, played: played || 0 } : { code: this.code, summary: this.summary() };
      await reg.fetch(new Request('https://reg/update', { method: 'POST', body: JSON.stringify(body) }));
    } catch (_) {}
  }

  async persist() {
    try {
      await this.ctx.storage.put('game', this.game);
      if (this.code) await this.ctx.storage.put('code', this.code);
      await this.ctx.storage.put('meta', this.meta);
      if (this.created) await this.ctx.storage.put('created', this.created);
      await this.ctx.storage.put('counted', this.counted);
      await this.ctx.storage.put('statSent', this._statSent);
      await this.ctx.storage.put('secrets', this.secrets);
    } catch (_) {}
  }
}

// ---- Singleton-register över aktiva rum (för dashboarden) -----------------
export class Registry {
  constructor(state) {
    this.ctx = state;
    this.rooms = {};
    this.stats = null;   // långsiktiga totaler
    this.ctx.blockConcurrencyWhile(async () => {
      this.rooms = (await this.ctx.storage.get('rooms')) || {};
      this.stats = (await this.ctx.storage.get('stats')) || this.freshStats();
      this.seen = (await this.ctx.storage.get('seen')) || { codes: {}, players: {} };
      // Migrera in ev. saknade fält i en äldre stats-post.
      const f = this.freshStats(); for (const k in f) if (this.stats[k] == null) this.stats[k] = f[k];
    });
  }

  freshStats() { return { dyk: 0, joins: 0, peak: 0, since: Date.now(), byDay: {}, byCountry: {}, byCity: {}, byUtm: {}, playMs: 0, playDay: {}, playWeek: {}, playMonth: {}, playYear: {}, cards: {} }; }
  day(t) { try { return new Date(t || Date.now()).toISOString().slice(0, 10); } catch (_) { return 'okänt'; } }
  weekKey(t) { const d = new Date(t || Date.now()); const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const day = dt.getUTCDay() || 7; dt.setUTCDate(dt.getUTCDate() + 4 - day); const ys = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1)); const wk = Math.ceil((((dt - ys) / 86400000) + 1) / 7); return dt.getUTCFullYear() + '-v' + String(wk).padStart(2, '0'); }
  accruePlay(ms, t) { const s = this.stats; if (!(ms > 0)) return; s.playMs += ms; const d = this.day(t), w = this.weekKey(t), mo = this.day(t).slice(0, 7), y = this.day(t).slice(0, 4); s.playDay[d] = (s.playDay[d] || 0) + ms; s.playWeek[w] = (s.playWeek[w] || 0) + ms; s.playMonth[mo] = (s.playMonth[mo] || 0) + ms; s.playYear[y] = (s.playYear[y] || 0) + ms; }

  prune() {
    const now = Date.now();
    for (const k of Object.keys(this.rooms)) {
      const r = this.rooms[k];
      if (!r || now - (r.updated || 0) > 15 * 60 * 1000 || (r.count || 0) <= 0) {
        // Eviction-fall (rummet hann aldrig rapportera ren stängning): bokför den
        // kända aktiva tiden (created → senaste rapport) innan vi släpper rummet.
        if (r && r.created && r.updated > r.created) this.accruePlay(r.updated - r.created, r.updated);
        delete this.rooms[k];
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/stat') && request.method === 'POST') {
      // Bara kort-engagemang här (next/skip). Dyk + dykare räknas i /update.
      let ev = {};
      try { ev = await request.json(); } catch (_) {}
      const s = this.stats;
      if (ev.card && ev.card.text) {
        const c = s.cards[ev.card.text] || (s.cards[ev.card.text] = { kept: 0, skipped: 0, source: ev.card.source || '' });
        c.kept += ev.card.kept || 0; c.skipped += ev.card.skipped || 0;
        c.dwell = (c.dwell || 0) + (ev.card.dwell || 0);       // total framme-tid (ms)
        c.follows = (c.follows || 0) + (ev.card.followed || 0); // ggr följdfrågan drogs
      }
      await this.ctx.storage.put('stats', s);
      return new Response('ok');
    }
    if (url.pathname.endsWith('/update') && request.method === 'POST') {
      let b = {};
      try { b = await request.json(); } catch (_) {}
      const s = this.stats; const d = this.day();
      if (b && b.code) {
        if (b.remove || (b.summary && (b.summary.count || 0) <= 0)) {
          if (b.played) this.accruePlay(b.played, Date.now());   // dyk-längd när rummet stänger rent
          delete this.rooms[b.code];
        } else if (b.summary) {
          this.rooms[b.code] = b.summary;
          // Räkna utifrån vad dashboarden FAKTISKT ser → konsekvent med peak, och reset nollar allt.
          if (!this.seen.codes[b.code]) { this.seen.codes[b.code] = 1; s.dyk += 1; s.byDay[d] = (s.byDay[d] || 0) + 1; }
          for (const p of b.summary.players || []) {
            const pk = b.code + '|' + (p.id || p.name || '');
            if (!this.seen.players[pk]) {
              this.seen.players[pk] = 1; s.joins += 1;
              if (p.country) s.byCountry[p.country] = (s.byCountry[p.country] || 0) + 1;
              if (p.city) s.byCity[p.city] = (s.byCity[p.city] || 0) + 1;
              const src = (p.utm || '').match(/source=([^\s]+)/);
              const key = src ? src[1] : (p.utm ? 'övrigt' : 'direkt');
              s.byUtm[key] = (s.byUtm[key] || 0) + 1;
            }
          }
          await this.ctx.storage.put('seen', this.seen);
        }
      }
      this.prune();
      const active = Object.keys(this.rooms).length;
      if (active > (this.stats.peak || 0)) this.stats.peak = active;
      await this.ctx.storage.put('stats', this.stats);
      await this.ctx.storage.put('rooms', this.rooms);
      return new Response('ok');
    }
    if (url.pathname.endsWith('/reset')) {
      this.rooms = {}; this.stats = this.freshStats(); this.seen = { codes: {}, players: {} };
      await this.ctx.storage.put('rooms', this.rooms);
      await this.ctx.storage.put('stats', this.stats);
      await this.ctx.storage.put('seen', this.seen);
      return new Response('nollställt', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    this.prune();
    await this.ctx.storage.put('rooms', this.rooms);
    await this.ctx.storage.put('stats', this.stats);
    return new Response(renderDashboard(this.rooms, this.stats), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function renderDashboard(rooms, stats) {
  const list = Object.values(rooms || {}).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const totalPlayers = list.reduce((n, r) => n + (r.count || 0), 0);
  const LV = { ytan: 'Ytan', grundvatten: 'Grundvatten', revet: 'Revet', djupvatten: 'Djupvatten', djuphavet: 'Djuphavet' };
  const now = Date.now();
  const ago = (t) => { const s = Math.max(0, Math.round((now - (t || now)) / 1000)); return s < 60 ? s + ' s' : Math.round(s / 60) + ' min'; };
  // Långsiktiga totaler.
  const s = stats || { dyk: 0, joins: 0, peak: 0, since: now, byDay: {}, byCountry: {}, byUtm: {} };
  const topList = (obj, n) => Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, n);
  const days = Object.keys(s.byDay || {}).sort().slice(-14);
  const maxDay = Math.max(1, ...days.map((d) => s.byDay[d] || 0));
  const sinceStr = (() => { try { return new Date(s.since || now).toISOString().slice(0, 10); } catch (_) { return ''; } })();
  const bars = days.map((d) => `<div class="bar" title="${esc(d)}: ${s.byDay[d]}"><span style="height:${Math.round((s.byDay[d] || 0) / maxDay * 100)}%"></span><em>${esc(d.slice(5))}</em></div>`).join('');
  const countryRows = topList(s.byCountry, 8).map(([c, n]) => `<div class="kv"><span>${esc(c)}</span><b>${n}</b></div>`).join('') || '<span class="meta">–</span>';
  const cityRows = topList(s.byCity, 10).map(([c, n]) => `<div class="kv"><span>${esc(c)}</span><b>${n}</b></div>`).join('') || '<span class="meta">–</span>';
  const utmRows = topList(s.byUtm, 8).map(([c, n]) => `<div class="kv"><span>${esc(c)}</span><b>${n}</b></div>`).join('') || '<span class="meta">–</span>';
  // Speltid (dyk-minuter).
  const fmtMin = (ms) => Math.round((ms || 0) / 60000) + ' min';
  const fmtH = (ms) => { const m = Math.round((ms || 0) / 60000); return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m + ' min'; };
  const recent = (obj, n) => Object.keys(obj || {}).sort().slice(-n).map((k) => `<div class="kv"><span>${esc(k)}</span><b>${fmtMin(obj[k])}</b></div>`).join('') || '<span class="meta">–</span>';
  // Kort-engagemang: lägst behållningsgrad (mest utbytta) först.
  const cardArr = Object.entries(s.cards || {}).map(([text, c]) => ({ text, ...c, total: (c.kept || 0) + (c.skipped || 0) })).filter((c) => c.total >= 1);
  const rate = (c) => c.total ? Math.round(c.kept / c.total * 100) : 0;
  // Bara kort som FAKTISKT bytts ut hör hemma i "svagast"-listan (annars fyller
  // 100%-behållna kort ut listan när det finns färre än 10 utbytta).
  const mostSwapped = cardArr.filter((c) => c.skipped > 0).sort((a, b) => (b.skipped / b.total) - (a.skipped / a.total) || b.skipped - a.skipped).slice(0, 10);
  const mostKept = cardArr.filter((c) => c.kept > 0).sort((a, b) => rate(b) - rate(a) || b.total - a.total).slice(0, 10);
  const dwellAvg = (c) => { const m = c.total ? Math.round(c.dwell / c.total / 1000) : 0; return m >= 60 ? Math.floor(m / 60) + 'm ' + (m % 60) + 's' : m + 's'; };
  const cardRow = (c) => `<div class="card-row"><span class="ct">${esc(c.text)}</span><span class="cr">behålls ${rate(c)}% · ${c.kept}/${c.total}${c.dwell ? ' · framme ' + dwellAvg(c) : ''}${c.follows ? ' · ↳ ' + c.follows : ''}</span></div>`;
  const totalsBlock = `
  <h2>Totalt sedan ${esc(sinceStr)}</h2>
  <div class="stats">
    <div class="stat"><div class="n">${s.dyk || 0}</div><div class="l">dyk startade</div></div>
    <div class="stat"><div class="n">${s.joins || 0}</div><div class="l">anslutningar totalt</div></div>
    <div class="stat"><div class="n">${s.peak || 0}</div><div class="l">flest samtidiga dyk</div></div>
  </div>
  <div class="panel"><h3>Dyk per dag (senaste 14)</h3><div class="chart">${bars || '<span class="meta">Ingen data än</span>'}</div></div>
  <div class="cols3">
    <div class="panel"><h3>Per land</h3>${countryRows}</div>
    <div class="panel"><h3>Per stad</h3>${cityRows}</div>
    <div class="panel"><h3>Per UTM-källa</h3>${utmRows}</div>
  </div>
  <h2>Speltid · totalt ${fmtH(s.playMs)}</h2>
  <div class="cols4">
    <div class="panel"><h3>Per dag</h3>${recent(s.playDay, 10)}</div>
    <div class="panel"><h3>Per vecka</h3>${recent(s.playWeek, 8)}</div>
    <div class="panel"><h3>Per månad</h3>${recent(s.playMonth, 12)}</div>
    <div class="panel"><h3>Per år</h3>${recent(s.playYear, 5)}</div>
  </div>
  <h2>Kort-engagemang</h2>
  <div class="cols2">
    <div class="panel"><h3>Mest utbytta (svagast)</h3>${mostSwapped.length ? mostSwapped.map(cardRow).join('') : '<span class="meta">Ingen data än</span>'}</div>
    <div class="panel"><h3>Mest behållna (starkast)</h3>${mostKept.length ? mostKept.map(cardRow).join('') : '<span class="meta">Ingen data än</span>'}</div>
  </div>`;
  const rows = list.map((r) => {
    const players = (r.players || []).map((p) => {
      const loc = [p.city, p.country].filter(Boolean).join(', ');
      return `<div class="pl"><b>${esc(p.name)}</b><span class="meta">${esc(loc || '–')} · ${esc(p.ip || '–')}${p.utm ? ' · utm: ' + esc(p.utm) : ''}</span></div>`;
    }).join('');
    const phase = r.phase === 'playing' ? 'spelar' : r.phase === 'summary' ? 'avslutar' : 'lobby';
    return `<tr>
      <td class="code">${esc(r.code)}</td>
      <td><span class="pill ${esc(r.phase)}">${phase}</span>${r.duet ? '<span class="pill duet">duett</span>' : ''}</td>
      <td>${esc(LV[r.level] || r.level || '')}</td>
      <td>${esc(r.mode || '')}</td>
      <td class="num">${r.count || 0}</td>
      <td>${players || '<span class="meta">–</span>'}</td>
      <td class="meta">${ago(r.updated)} sedan</td>
    </tr>`;
  }).join('');
  return `<!doctype html><html lang="sv"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta http-equiv="refresh" content="15">
<title>Djupdyk · aktiva dyk</title>
<style>
  :root{--bg:#04141b;--card:#0c2430;--ink:#eaf6f8;--soft:#9fc5cf;--dim:#6f95a0;--acc:#7fe3ef}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:24px}
  h1{font-size:1.5rem;margin:0 0 4px} .sub{color:var(--soft);margin:0 0 22px}
  .stats{display:flex;gap:16px;margin:0 0 22px;flex-wrap:wrap}
  .stat{background:var(--card);border-radius:14px;padding:16px 22px;min-width:150px}
  .stat .n{font-size:2.2rem;font-weight:800;color:var(--acc)} .stat .l{color:var(--soft);font-size:.85rem}
  table{width:100%;border-collapse:collapse;background:var(--card);border-radius:14px;overflow:hidden}
  th,td{text-align:left;padding:11px 14px;border-bottom:1px solid rgba(255,255,255,.06);vertical-align:top}
  th{color:var(--soft);font-size:.78rem;text-transform:uppercase;letter-spacing:.06em}
  .code{font-weight:800;letter-spacing:.12em} .num{text-align:center;font-weight:700}
  .meta{color:var(--dim);font-size:.82rem} .pl{margin:1px 0} .pl b{font-weight:600}
  .pill{display:inline-block;font-size:.72rem;padding:2px 8px;border-radius:20px;background:rgba(127,227,239,.14);color:var(--acc);margin-right:4px}
  .pill.playing{background:rgba(127,227,239,.18)} .pill.lobby{background:rgba(160,197,207,.14);color:var(--soft)}
  .pill.duet{background:rgba(255,180,200,.16);color:#ffb4c8}
  .empty{color:var(--dim);padding:40px;text-align:center}
  .foot{color:var(--dim);font-size:.78rem;margin-top:18px}
  h2{font-size:1.15rem;margin:30px 0 12px;color:var(--soft)}
  h3{font-size:.82rem;text-transform:uppercase;letter-spacing:.06em;color:var(--soft);margin:0 0 10px}
  .cols3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:14px}
  .cols4{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
  .cols2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:760px){.cols3,.cols4,.cols2{grid-template-columns:1fr}}
  .card-row{padding:7px 0;border-bottom:1px solid rgba(255,255,255,.05)}
  .card-row .ct{display:block;font-size:.86rem} .card-row .cr{font-size:.74rem;color:var(--acc)}
  .panel{background:var(--card);border-radius:14px;padding:16px 18px}
  .chart{display:flex;align-items:flex-end;gap:5px;height:120px}
  .bar{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%;gap:5px}
  .bar span{width:100%;min-height:2px;background:linear-gradient(180deg,var(--acc),#2c8aa0);border-radius:4px 4px 0 0}
  .bar em{font-size:.6rem;color:var(--dim);font-style:normal}
  .kv{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.05)}
  .kv b{color:var(--acc)}
</style></head><body>
  <h1>Djupdyk · aktiva dyk</h1>
  <p class="sub">Live-översikt. Sidan uppdateras var 15:e sekund.</p>
  <div class="stats">
    <div class="stat"><div class="n">${list.length}</div><div class="l">aktiva dyk just nu</div></div>
    <div class="stat"><div class="n">${totalPlayers}</div><div class="l">dykare uppkopplade</div></div>
  </div>
  ${list.length ? `<table><thead><tr><th>Kod</th><th>Status</th><th>Djup</th><th>Läge</th><th>Antal</th><th>Dykare (plats · ip · utm)</th><th>Senast</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">Inga aktiva dyk just nu.</div>'}
  ${totalsBlock}
  <p class="foot">Innehåller personuppgifter (namn, IP, plats). Behandla varsamt. Endast åtkomlig via den hemliga adressen. Totaler sparas, men ingen rad-historik per spelare.</p>
</body></html>`;
}

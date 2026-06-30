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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    // Användnings-dashboard på en svårgissad URL.
    const dm = url.pathname.match(/^\/dash\/([a-zA-Z0-9]+)\/?$/);
    if (dm) {
      const token = env.DASH_TOKEN || '';
      if (!token || dm[1] !== token) return new Response('Not found', { status: 404 });
      const reg = env.REGISTRY.get(env.REGISTRY.idFromName('global'));
      return reg.fetch(new Request('https://reg/view'));
    }

    const m = url.pathname.match(/^\/room\/([A-Za-z0-9]{1,12})\/?$/);
    if (m) {
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
    this._lastReport = 0;
    this.ctx.blockConcurrencyWhile(async () => {
      this.game = (await this.ctx.storage.get('game')) || null;
      this.code = (await this.ctx.storage.get('code')) || null;
      this.meta = (await this.ctx.storage.get('meta')) || {};
      this.created = (await this.ctx.storage.get('created')) || null;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Förväntade en WebSocket-uppkoppling.', { status: 426 });
    }
    const code = url.pathname.split('/').filter(Boolean).pop().toUpperCase();
    const playerId = (url.searchParams.get('id') || ('p' + Math.random().toString(36).slice(2, 9))).slice(0, 40);
    const name = (url.searchParams.get('name') || 'Gäst').slice(0, 24);

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

    if (!this.game) { this.game = Game.create(code, playerId); this.code = code; this.created = Date.now(); }
    Game.addPlayer(this.game, { id: playerId, name });
    if (this.game.phase === 'playing' && !this.game.turnId) this.game.turnId = playerId;

    await this.persist();
    this.broadcast();
    await this.report();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || typeof msg !== 'object' || !this.game) return;
    const att = ws.deserializeAttachment() || {};
    const actorId = att.playerId;

    if (msg.type === 'action' && msg.action) {
      this.game = Game.apply(this.game, msg.action, actorId);
      await this.persist();
      this.broadcast();
      await this.report(true);   // throttlad: håller fas/djup uppdaterat
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
    // Rapportera: om ingen är kvar uppkopplad, ta bort rummet ur registret.
    const anyOnline = this.ctx.getWebSockets().some((s) => s.readyState === WebSocket.OPEN);
    await this.report(false, !anyOnline);
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
      return { name: p.name, country: m.country, city: m.city, ip: m.ip, utm: m.utm };
    });
    return {
      code: this.code, phase: this.game.phase, level: this.game.levelId, mode: this.game.mode,
      duet: !!this.game.duet, count: players.length, players,
      created: this.created || Date.now(), updated: Date.now(),
    };
  }

  async report(throttle, remove) {
    if (throttle && !remove && Date.now() - this._lastReport < 8000) return;
    this._lastReport = Date.now();
    try {
      const reg = this.env.REGISTRY.get(this.env.REGISTRY.idFromName('global'));
      const body = remove ? { code: this.code, remove: true } : { code: this.code, summary: this.summary() };
      await reg.fetch(new Request('https://reg/update', { method: 'POST', body: JSON.stringify(body) }));
    } catch (_) {}
  }

  async persist() {
    try {
      await this.ctx.storage.put('game', this.game);
      if (this.code) await this.ctx.storage.put('code', this.code);
      await this.ctx.storage.put('meta', this.meta);
      if (this.created) await this.ctx.storage.put('created', this.created);
    } catch (_) {}
  }
}

// ---- Singleton-register över aktiva rum (för dashboarden) -----------------
export class Registry {
  constructor(state) {
    this.ctx = state;
    this.rooms = {};
    this.ctx.blockConcurrencyWhile(async () => { this.rooms = (await this.ctx.storage.get('rooms')) || {}; });
  }

  prune() {
    const now = Date.now();
    for (const k of Object.keys(this.rooms)) {
      const r = this.rooms[k];
      // Ta bort rum som inte rapporterat på länge (säkerhetsnät mot eviction).
      if (!r || now - (r.updated || 0) > 15 * 60 * 1000 || (r.count || 0) <= 0) delete this.rooms[k];
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/update') && request.method === 'POST') {
      let b = {};
      try { b = await request.json(); } catch (_) {}
      if (b && b.code) {
        if (b.remove || (b.summary && (b.summary.count || 0) <= 0)) delete this.rooms[b.code];
        else if (b.summary) this.rooms[b.code] = b.summary;
      }
      this.prune();
      await this.ctx.storage.put('rooms', this.rooms);
      return new Response('ok');
    }
    this.prune();
    await this.ctx.storage.put('rooms', this.rooms);
    return new Response(renderDashboard(this.rooms), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function renderDashboard(rooms) {
  const list = Object.values(rooms || {}).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const totalPlayers = list.reduce((n, r) => n + (r.count || 0), 0);
  const LV = { ytan: 'Ytan', grundvatten: 'Grundvatten', revet: 'Revet', djupvatten: 'Djupvatten', djuphavet: 'Djuphavet' };
  const now = Date.now();
  const ago = (t) => { const s = Math.max(0, Math.round((now - (t || now)) / 1000)); return s < 60 ? s + ' s' : Math.round(s / 60) + ' min'; };
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
</style></head><body>
  <h1>Djupdyk · aktiva dyk</h1>
  <p class="sub">Live-översikt. Sidan uppdateras var 15:e sekund.</p>
  <div class="stats">
    <div class="stat"><div class="n">${list.length}</div><div class="l">aktiva dyk just nu</div></div>
    <div class="stat"><div class="n">${totalPlayers}</div><div class="l">dykare uppkopplade</div></div>
  </div>
  ${list.length ? `<table><thead><tr><th>Kod</th><th>Status</th><th>Djup</th><th>Läge</th><th>Antal</th><th>Dykare (plats · ip · utm)</th><th>Senast</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">Inga aktiva dyk just nu.</div>'}
  <p class="foot">Innehåller personuppgifter (namn, IP, plats). Behandla varsamt. Endast åtkomlig via den hemliga adressen.</p>
</body></html>`;
}

// Vitalisera djupdyk, realtidsserver.
// En Cloudflare Worker som dirigerar varje rum till ett Durable Object (DO).
// DO:t ligger alltid uppe och äger den auktoritativa staten genom att köra
// exakt samma rena reducer som klienten (web/game.js). Spelarna är tunna
// WebSocket-klienter. Att en spelare (även den som skapade rummet) byter app
// stör därför inte de andra: servern finns kvar.

// Viktigt: questions.js importeras FÖRE game.js så att dess sidoeffekt sätter
// globalThis.DECK innan game.js läser den.
import DECK from '../../web/data/questions.js';
import Game from '../../web/game.js';

// Säkerställ att game.js hittar leken även om importordningen skulle ändras.
if (DECK && typeof globalThis !== 'undefined' && !globalThis.DECK) globalThis.DECK = DECK;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

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
    // Återställ rummets state efter en eventuell viloläge/omstart.
    this.ctx.blockConcurrencyWhile(async () => {
      this.game = (await this.ctx.storage.get('game')) || null;
      this.code = (await this.ctx.storage.get('code')) || null;
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

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernerbar WebSocket, taggad med spelar-id (så vi kan hitta alla sockets
    // för en och samma spelare, t.ex. om hen har två flikar öppna).
    this.ctx.acceptWebSocket(server, [playerId]);
    server.serializeAttachment({ playerId, name });

    if (!this.game) { this.game = Game.create(code, playerId); this.code = code; }
    Game.addPlayer(this.game, { id: playerId, name });
    // Om spelet redan är igång och ingen har turen, ge den till den som kom in.
    if (this.game.phase === 'playing' && !this.game.turnId) this.game.turnId = playerId;

    await this.persist();
    this.broadcast();

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
    } else if (msg.type === 'hello') {
      const p = this.game.players.find((x) => x.id === actorId);
      if (p && msg.name) {
        const n = String(msg.name).slice(0, 24);
        if (p.name !== n) { p.name = n; await this.persist(); this.broadcast(); }
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
    // Markera bara frånkopplad om spelaren inte har någon annan öppen socket kvar.
    const left = this.ctx.getWebSockets(pid).filter((s) => s !== ws && s.readyState === WebSocket.OPEN);
    if (left.length > 0) return;

    Game.setConnected(this.game, pid, false);
    // Krona/värdkontroller följer staten: om värden försvann, lämna värdskapet
    // till nästa anslutna spelare (rent kosmetiskt och för menystyrning, servern
    // är ändå den verkliga auktoriteten).
    if (this.game.hostId === pid) {
      const next = this.game.players.find((p) => p.connected);
      if (next) this.game.hostId = next.id;
    }
    await this.persist();
    this.broadcast();
  }

  broadcast() {
    const payload = JSON.stringify({ type: 'state', state: this.game });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(payload); } catch (_) {}
    }
  }

  async persist() {
    try {
      await this.ctx.storage.put('game', this.game);
      if (this.code) await this.ctx.storage.put('code', this.code);
    } catch (_) {}
  }
}

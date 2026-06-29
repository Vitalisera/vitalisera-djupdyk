// Vitalisera djupdyk, nätlager (servervariant via WebSocket mot Cloudflare).
// Samma publika yta som det gamla P2P-lagret (net.js), så app.js är oförändrat.
// Skillnaden: rummet bor i en alltid uppe-server (Durable Object). Ingen spelare
// är värd. Att någon byter app stör inte de andra, och återanslutning är trivial:
// koppla upp WebSocketen igen och ta emot färsk state.

(function (global) {
  'use strict';

  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function randomCode(len = 4) {
    let s = '';
    for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return s;
  }
  function makeId() {
    return 'p' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
  }

  // Serverns adress. Kan överstyras via window.VD_WS_URL.
  const WS_BASE = String(global.VD_WS_URL || 'wss://djupdyk-room.vitalisera.workers.dev').replace(/\/+$/, '');

  const Net = {
    role: null,
    code: null,
    me: null,
    state: null,
    handlers: {},
    _ws: null,
    _alive: false,
    _open: false,
    _everOpen: false,
    _retryTimer: null,
    _clientRetry: 0,
    _pending: [],
    local: false,        // "Runt bordet": en enhet, alla spelare, ingen server
    _localHost: null,

    on(event, fn) { this.handlers[event] = fn; return this; },
    _emit(event, payload) { if (this.handlers[event]) this.handlers[event](payload); },

    // ---- Persistens (resume vid omladdning) --------------------------------
    _saveSession() {
      try { localStorage.setItem('vd_session', JSON.stringify({ role: this.role, code: this.code, me: this.me })); } catch (_) {}
    },
    loadSession() { try { return JSON.parse(localStorage.getItem('vd_session')); } catch (_) { return null; } },
    clearSession() { try { localStorage.removeItem('vd_session'); } catch (_) {} },
    _persistName() { try { return JSON.parse(localStorage.getItem('vd_name')); } catch (_) { return null; } },
    saveName(name) { try { localStorage.setItem('vd_name', JSON.stringify(name)); } catch (_) {} },
    _myPlayerId() {
      let id = null;
      try { id = JSON.parse(localStorage.getItem('vd_pid')); } catch (_) {}
      if (!id) { id = makeId(); try { localStorage.setItem('vd_pid', JSON.stringify(id)); } catch (_) {} }
      return id;
    },

    // ---- Ingångar ----------------------------------------------------------
    // host = den som skapar rummet (får en kod), client = den som går med.
    // I servermodellen är skillnaden bara kosmetisk; servern äger staten.
    host(name, opts = {}) { this._enter('host', (opts.code || randomCode()).toUpperCase(), name); },
    join(code, name) { this._enter('client', String(code).toUpperCase(), name); },

    _enter(role, code, name) {
      this.local = false;   // säkerställ att ett ev. lokalt läge inte hänger kvar
      this.role = role;
      this.code = code;
      this.me = { id: this._myPlayerId(), name: name || 'Gäst' };
      this.saveName(this.me.name);
      this._alive = true;
      this._everOpen = false;
      this._clientRetry = 0;
      this._connect(true);
    },

    _connect(first) {
      if (!this._alive) return;
      this._emit('status', { phase: first && !this._everOpen ? 'connecting' : 'reconnecting' });
      try { if (this._ws) { this._ws.onclose = null; this._ws.onerror = null; this._ws.close(); } } catch (_) {}
      const url = WS_BASE + '/room/' + encodeURIComponent(this.code)
        + '?id=' + encodeURIComponent(this.me.id)
        + '&name=' + encodeURIComponent(this.me.name);
      let ws;
      try { ws = new WebSocket(url); } catch (_) { this._scheduleRetry(); return; }
      this._ws = ws;
      this._open = false;

      ws.onopen = () => {
        this._open = true;
        this._everOpen = true;
        this._clientRetry = 0;
        clearTimeout(this._retryTimer); this._retryTimer = null;
        this._saveSession();
        this._emit('open', { code: this.code, role: this.role });
        this._emit('status', { phase: 'connected' });
        try { ws.send(JSON.stringify({ type: 'hello', name: this.me.name })); } catch (_) {}
        this._flush();
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (msg && msg.type === 'state') { this.state = msg.state; this._emit('state', this.state); }
      };
      ws.onclose = () => {
        this._open = false;
        if (this._alive) { this._emit('status', { phase: 'reconnecting' }); this._scheduleRetry(); }
      };
      ws.onerror = () => { /* onclose följer och sköter återförsöket */ };
    },

    _scheduleRetry() {
      if (!this._alive || this._retryTimer) return;
      this._clientRetry = Math.min(this._clientRetry + 1, 8);
      const delay = Math.min(700 * Math.pow(1.4, this._clientRetry), 6000);
      this._retryTimer = setTimeout(() => { this._retryTimer = null; if (this._alive) this._connect(false); }, delay);
    },

    // Knuff vid synlig flik / nät tillbaka: kolla att vi är uppe, annars koppla upp.
    poke() {
      if (this.local) return;   // lokalt läge har ingen server att knuffa
      if (!this._alive) return;
      const ws = this._ws;
      const down = !ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING;
      if (down && !this._retryTimer) this._connect(false);
    },

    // ---- Lokalt läge: "Runt bordet" ----------------------------------------
    // En enda enhet, alla spelare, ingen server. Reducern (Game) kör i sidan.
    // För att den enda enheten ska kunna göra ALLT kör vi varje handling som
    // värden (actorId = hostId, allsmäktig). me speglar däremot den vars tur
    // det är, så att gränssnittets "din tur" alltid stämmer på enheten.
    startLocal(players, opts = {}) {
      this.local = true;
      this.role = 'local';
      this.code = null;
      this._alive = true;
      let st = Game.create('LOKAL', null);
      (players || []).forEach((p) => Game.addPlayer(st, { id: p.id || makeId(), name: p.name }));
      st = Game.apply(st, { type: 'start', levelId: opts.levelId, session: opts.session || 'dyk', mode: opts.mode || 'oppen', duet: false }, st.hostId);
      this.state = st;
      this._localHost = st.hostId;
      this._syncLocalMe();
      this._saveLocal();
      this._emit('open', { code: null, role: 'local' });
      this._emit('status', { phase: 'connected' });
      this._emit('state', this.state);
    },
    _syncLocalMe() {
      const t = (this.state && (this.state.turnId || this.state.hostId)) || null;
      const p = this.state && this.state.players.find((x) => x.id === t);
      this.me = { id: t, name: p ? p.name : '' };
    },
    _saveLocal() { try { localStorage.setItem('vd_local', JSON.stringify(this.state)); } catch (_) {} },
    loadLocal() { try { return JSON.parse(localStorage.getItem('vd_local')); } catch (_) { return null; } },
    resumeLocal(state) {
      this.local = true; this.role = 'local'; this.code = null; this._alive = true;
      this.state = state; this._localHost = state && state.hostId;
      this._syncLocalMe();
      this._emit('open', { code: null, role: 'local' });
      this._emit('status', { phase: 'connected' });
      this._emit('state', this.state);
    },

    // ---- Handlingar --------------------------------------------------------
    dispatch(action) {
      if (this.local) {
        try { this.state = Game.apply(this.state, action, this._localHost || (this.state && this.state.hostId)); }
        catch (_) {}
        this._syncLocalMe();
        this._saveLocal();
        this._emit('state', this.state);
        return;
      }
      if (this._ws && this._open && this._ws.readyState === WebSocket.OPEN) {
        try { this._ws.send(JSON.stringify({ type: 'action', action })); }
        catch (_) { this._queue(action); this._emit('dropped'); }
      } else {
        // Inte uppe just nu (t.ex. precis tillbaka från bakgrundsflik): köa och
        // skicka när vi är inne igen, så att ett tryck inte går förlorat.
        this._queue(action);
        this._emit('dropped');
        this.poke();
      }
    },
    _queue(action) { this._pending.push({ action, at: Date.now() }); if (this._pending.length > 8) this._pending.shift(); },
    _flush() {
      if (!this._pending.length || !this._ws || this._ws.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      const items = this._pending; this._pending = [];
      items.forEach((it) => { if (now - it.at < 15000) { try { this._ws.send(JSON.stringify({ type: 'action', action: it.action })); } catch (_) {} } });
    },

    rename(name) {
      this.me.name = String(name).slice(0, 24);
      this.saveName(this.me.name);
      if (this._ws && this._open) { try { this._ws.send(JSON.stringify({ type: 'hello', name: this.me.name })); } catch (_) {} }
    },

    leave() {
      this._alive = false;
      this._open = false;
      this._pending = [];
      clearTimeout(this._retryTimer); this._retryTimer = null;
      try { if (this._ws) { this._ws.onclose = null; this._ws.onerror = null; this._ws.close(); } } catch (_) {}
      this._ws = null;
      this.role = null; this.code = null; this.state = null;
      this.local = false; this._localHost = null;
      try { localStorage.removeItem('vd_local'); } catch (_) {}
      this.clearSession();
    },
  };

  Net.randomCode = randomCode;
  if (typeof window !== 'undefined') window.Net = Net;
})(typeof window !== 'undefined' ? window : globalThis);

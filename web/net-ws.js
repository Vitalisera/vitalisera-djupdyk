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

  // Fånga marknadsförings-parametrar (utm_*) DIREKT vid laddning, innան appen
  // hinner städa URL:en (history.replaceState). Bara för dashboarden, kort sträng.
  const INITIAL_UTM = (function () {
    try {
      const p = new URLSearchParams(global.location && global.location.search || '');
      const parts = [];
      for (const [k, v] of p.entries()) { if (/^utm_/i.test(k) && v) parts.push(k.replace(/^utm_/i, '') + '=' + v); }
      return parts.join(' ').slice(0, 200);
    } catch (_) { return ''; }
  })();

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
      if (this.role === 'display') return;   // display resumas ur ?visa-länken, inte ur sessionen
      try { localStorage.setItem('vd_session', JSON.stringify({ role: this.role, code: this.code, me: this.me })); } catch (_) {}
    },
    loadSession() { try { return JSON.parse(localStorage.getItem('vd_session')); } catch (_) { return null; } },
    clearSession() { try { localStorage.removeItem('vd_session'); } catch (_) {} },
    _readUtm() { return INITIAL_UTM || ''; },
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

    // "Visa på TV": passiv display som bara prenumererar på rummets state.
    // Ingen spelare, inga handlingar, ingen rumskod-ägare. Återansluter automatiskt
    // (samma _connect-logik) om TV:ns uppkoppling tappas.
    display(code) {
      this.local = false;
      this.role = 'display';
      this.code = String(code).toUpperCase();
      this._utm = '';
      this.me = { id: 'display', name: '' };
      this._alive = true;
      this._everOpen = false;
      this._clientRetry = 0;
      this._connect(true);
    },

    _enter(role, code, name) {
      this.local = false;   // säkerställ att ett ev. lokalt läge inte hänger kvar
      this.role = role;
      this.code = code;
      this._utm = this._readUtm();   // marknadsföringsparametrar ur länken (för dashboarden)
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
        + '&name=' + encodeURIComponent(this.me.name)
        + (this.role === 'display' ? '&display=1' : '')
        + (this._utm ? '&utm=' + encodeURIComponent(this._utm) : '');
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
        else if (msg && msg.type === 'ended') { this._emit('ended'); }
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
      // Väck även TV-speglingen (Runt bordet) om den tappat uppkopplingen vid t.ex.
      // skärmsläckning/appbyte, annars fryser TV:n tyst på sista kortet.
      if (this._mirrorAlive) {
        const mws = this._mirrorWs;
        const mdown = !mws || mws.readyState === WebSocket.CLOSED || mws.readyState === WebSocket.CLOSING;
        if (mdown && !this._mirrorTimer) this._mirrorConnect();
        else this._mirrorSend();
      }
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
      if (this._mirrorAlive) this._mirrorSend();
    },
    _syncLocalMe() {
      const t = (this.state && (this.state.turnId || this.state.hostId)) || null;
      const p = this.state && this.state.players.find((x) => x.id === t);
      this.me = { id: t, name: p ? p.name : '' };
    },
    _saveLocal() {
      try { localStorage.setItem('vd_local', JSON.stringify(this.state)); } catch (_) {}
      try {
        if (this._mirrorAlive && this._mirrorCode) localStorage.setItem('vd_mirror', JSON.stringify({ code: this._mirrorCode }));
        else localStorage.removeItem('vd_mirror');
      } catch (_) {}
    },
    loadLocal() { try { return JSON.parse(localStorage.getItem('vd_local')); } catch (_) { return null; } },
    resumeLocal(state) {
      this.local = true; this.role = 'local'; this.code = null; this._alive = true;
      this.state = state; this._localHost = state && state.hostId;
      this._syncLocalMe();
      this._emit('open', { code: null, role: 'local' });
      this._emit('status', { phase: 'connected' });
      this._emit('state', this.state);
      // Återuppta ev. TV-spegling som var igång före omladdningen (koden är persistad).
      if (!this._mirrorAlive) {
        try { const m = JSON.parse(localStorage.getItem('vd_mirror')); if (m && m.code) { this._mirrorCode = m.code; this._mirrorAlive = true; this._mirrorConnect(); } } catch (_) {}
      }
      if (this._mirrorAlive) this._mirrorSend();
    },

    // ---- Spegling till TV (Runt bordet på storbild) ------------------------
    // Telefonen kör spelet lokalt och skickar sin state till ett relä-rum på servern.
    // TV:n ansluter som display till samma rum och får staten. Returnerar rumskoden.
    _mirrorWs: null, _mirrorCode: null, _mirrorAlive: false, _mirrorTimer: null,
    mirrorCode() { return this._mirrorCode; },
    startMirror() {
      if (!this.local) return null;
      if (this._mirrorCode) return this._mirrorCode;
      this._mirrorCode = randomCode();
      this._mirrorAlive = true;
      this._emit('mirror', { phase: 'connecting', code: this._mirrorCode });
      this._mirrorConnect();
      this._saveLocal();   // persistera koden direkt
      return this._mirrorCode;
    },
    _mirrorConnect() {
      if (!this._mirrorAlive || !this._mirrorCode) return;
      try { if (this._mirrorWs) { this._mirrorWs.onclose = null; this._mirrorWs.onerror = null; this._mirrorWs.close(); } } catch (_) {}
      let ws;
      try { ws = new WebSocket(WS_BASE + '/room/' + encodeURIComponent(this._mirrorCode) + '?mirror=1'); }
      catch (_) { this._mirrorRetry(); return; }
      this._mirrorWs = ws;
      ws.onopen = () => { this._emit('mirror', { phase: 'on', code: this._mirrorCode }); this._mirrorSend(); };
      ws.onclose = () => { if (this._mirrorAlive) { this._emit('mirror', { phase: 'connecting', code: this._mirrorCode }); this._mirrorRetry(); } };
      ws.onerror = () => {};
    },
    _mirrorRetry() {
      if (!this._mirrorAlive || this._mirrorTimer) return;
      this._mirrorTimer = setTimeout(() => { this._mirrorTimer = null; if (this._mirrorAlive) this._mirrorConnect(); }, 1500);
    },
    _mirrorSend() {
      const ws = this._mirrorWs;
      if (ws && ws.readyState === WebSocket.OPEN && this.state) {
        try { ws.send(JSON.stringify({ type: 'mirror', state: this.state })); } catch (_) {}
      }
    },
    stopMirror() {
      this._mirrorAlive = false; this._mirrorCode = null;
      clearTimeout(this._mirrorTimer); this._mirrorTimer = null;
      try { if (this._mirrorWs) { this._mirrorWs.onclose = null; this._mirrorWs.onerror = null; this._mirrorWs.close(); } } catch (_) {}
      this._mirrorWs = null;
      try { localStorage.removeItem('vd_mirror'); } catch (_) {}
      this._emit('mirror', { phase: 'off' });
    },

    // ---- Handlingar --------------------------------------------------------
    dispatch(action) {
      if (this.local) {
        try { this.state = Game.apply(this.state, action, this._localHost || (this.state && this.state.hostId)); }
        catch (_) {}
        this._syncLocalMe();
        this._saveLocal();
        this._emit('state', this.state);
        if (this._mirrorAlive) this._mirrorSend();
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
      this.stopMirror();
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

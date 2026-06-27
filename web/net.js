// Vitalisera djupdyk, nätlager (peer-to-peer via WebRTC/PeerJS).
// Värden (host) äger den auktoritativa staten och har det fasta peer-id:t
// "vd-<KOD>". Gäster ansluter dit, skickar handlingar och får hela staten tillbaka.
//
// Robusthet (självläkande rum):
//  - Värden tappar uppkopplingen → försöker återta samma id (aldrig ny kod).
//  - Värden lämnar helt → en gäst befordras automatiskt till ny värd med sin
//    senast kända state (värdmigrering). Övriga gäster återansluter till koden.
//  - Allt serverlöst; tål omladdning, sömn och nätbyten.

(function (global) {
  'use strict';

  const ID_PREFIX = 'vd-';
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // utan lättförväxlade tecken

  function randomCode(len = 4) {
    let s = '';
    for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return s;
  }
  function makeId() {
    return 'p' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
  }
  function peerId(code) { return ID_PREFIX + code.toUpperCase(); }

  const PEER_CONFIG = Object.assign({
    debug: 1,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' },
        {
          urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443'],
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
      ],
    },
  }, (typeof window !== 'undefined' && window.VD_PEER) || {});

  const Net = {
    role: null,        // 'host' | 'client'
    code: null,
    me: null,          // { id, name }
    state: null,
    handlers: {},
    _peer: null,
    _conns: new Map(), // host: connId -> { conn, playerId }
    _hostConn: null,   // client: conn till värden
    _alive: false,
    _everConnected: false, // klient: har nått en värd minst en gång
    _everHosted: false,    // har varit aktiv värd i den här sessionen (för stabil återhämtning)
    _electing: false,      // klient: pågående värdmigrering
    _resumed: false,       // klient: återupptog en sparad session (får ta över om värden uteblir)
    _electAttempt: 0,
    _clientRetry: 0,
    _hostRetry: 0,

    on(event, fn) { this.handlers[event] = fn; return this; },
    _emit(event, payload) { if (this.handlers[event]) this.handlers[event](payload); },

    // ---- Persistens (för resume vid omladdning) ----------------------------
    _saveSession() {
      try {
        localStorage.setItem('vd_session', JSON.stringify({
          role: this.role, code: this.code, me: this.me,
          state: this.state, // sparas även för gäst → möjliggör värdmigrering efter omladdning
        }));
      } catch (_) {}
    },
    loadSession() {
      try { return JSON.parse(localStorage.getItem('vd_session')); } catch (_) { return null; }
    },
    clearSession() { try { localStorage.removeItem('vd_session'); } catch (_) {} },

    _persistName() {
      try { return JSON.parse(localStorage.getItem('vd_name')); } catch (_) { return null; }
    },
    saveName(name) { try { localStorage.setItem('vd_name', JSON.stringify(name)); } catch (_) {} },

    // ---- Identitet ---------------------------------------------------------
    _myPlayerId() {
      let id = null;
      try { id = JSON.parse(localStorage.getItem('vd_pid')); } catch (_) {}
      if (!id) { id = makeId(); try { localStorage.setItem('vd_pid', JSON.stringify(id)); } catch (_) {} }
      return id;
    },

    // ---- Publika ingångar --------------------------------------------------
    host(name, opts = {}) {
      this.me = { id: this._myPlayerId(), name: name || 'Gäst' };
      this.saveName(this.me.name);
      this.code = (opts.code || randomCode()).toUpperCase();
      this._alive = true;
      // Behåll state direkt vid återupptagning, då kan vi återta rummet även om
      // vårt eget id ännu spökar på servern (faller då tillbaka via migrering).
      if (opts.resumeState) this.state = opts.resumeState;
      this._becomeHost(opts.resumeState || null);
    },

    join(code, name) {
      this.me = { id: this._myPlayerId(), name: name || 'Gäst' };
      this.saveName(this.me.name);
      this.code = code.toUpperCase();
      this._alive = true;
      this._everConnected = false;
      this._resumed = !!this.state; // satt av boot() vid återupptagning
      this._startClient(0);
    },

    // Får vi befordras till värd om värden saknas? Ja om vi varit anslutna, eller
    // återupptog en session med känd state.
    _canPromote() { return (this._everConnected || this._resumed) && !!this.state; },

    // ---- VÄRD --------------------------------------------------------------
    _becomeHost(resumeState) {
      if (!this._alive) return;
      this.role = 'host';
      this._electing = false;
      this._clearTimers(); // inga klient-timers får fyra medan vi är värd
      this._emit('status', { phase: resumeState ? 'recovering' : 'connecting' });
      try { this._peer && this._peer.destroy(); } catch (_) {}
      const peer = new Peer(peerId(this.code), PEER_CONFIG);
      this._peer = peer;

      peer.on('open', () => {
        this._hostRetry = 0;
        this._everHosted = true;
        if (resumeState) {
          this.state = resumeState;
          this.state.hostId = this.me.id;
          // Inga gäster anslutna ännu, de återansluter själva.
          this.state.players.forEach((p) => { if (p.id !== this.me.id) p.connected = false; });
          Game.addPlayer(this.state, this.me);
          // Om den vars tur det var inte är inne längre, lämna turen till oss (värden).
          if (this.state.phase === 'playing') {
            const t = this.state.players.find((p) => p.id === this.state.turnId);
            if (!t || !t.connected) this.state.turnId = this.me.id;
          }
        } else {
          this.state = Game.create(this.code, this.me.id);
          Game.addPlayer(this.state, this.me);
        }
        this._conns = new Map();
        this._hostConn = null;
        this._emit('open', { code: this.code, role: 'host' });
        this._emit('status', { phase: 'connected' });
        this._pushState();
      });

      peer.on('connection', (conn) => this._onClientConnect(conn));

      peer.on('error', (err) => {
        const t = (err && err.type) || '';
        if (t === 'unavailable-id') {
          try { peer.destroy(); } catch (_) {}
          if (this._everHosted) {
            // Vi har redan varit värd i sessionen → detta är oftast en transient
            // glitch (vår egen återanslutning), inte en verklig övertagning.
            // Behåll värdrollen och återta id:t några gånger. Lyckas det inte
            // har någon annan tagit över → anslut då som gäst.
            this._hostRetry = Math.min(this._hostRetry + 1, 8);
            if (this._hostRetry <= 5) {
              this._emit('status', { phase: 'recovering' });
              if (this._alive) setTimeout(() => this._becomeHost(this.state), Math.min(700 * this._hostRetry, 4000));
            } else {
              this._hostRetry = 0; this._everConnected = true;
              this._startClient(0);
            }
          } else if (!resumeState && !this._everConnected && !this._resumed) {
            // Färsk skapa-kollision (osannolikt) → välj ny kod och skapa igen.
            this.code = randomCode();
            if (this._alive) this._becomeHost(null);
          } else {
            // Vårt eget spöke efter omladdning, eller en annan värd finns redan.
            // Anslut som gäst; är det ett spöke utlöser det migrering och vi
            // återtar id:t när spöket släppts.
            this._everConnected = true;
            this._startClient(0);
          }
          return;
        }
        if (t === 'network' || t === 'server-error' || t === 'socket-error') {
          this._emit('status', { phase: 'reconnecting' });
          this._hostRetry = Math.min(this._hostRetry + 1, 8);
          if (this._alive) setTimeout(() => this._becomeHost(this.state), Math.min(1200 * this._hostRetry, 6000));
          return;
        }
        this._emit('error', humanError(err));
      });

      peer.on('disconnected', () => {
        if (!this._alive) return;
        // En ensam värd har ingen att tappa kontakt med, så varna inte i onödan.
        if (this._conns.size > 0) this._emit('status', { phase: 'reconnecting' });
        try { peer.reconnect(); } catch (_) {}
        // Healing: rensa statusen så snart signal-anslutningen är uppe igen.
        // Ger inte upp på en fast deadline, utan återetablerar helt om brokern
        // är borta länge (vanligt efter mobil bakgrund), så bannern aldrig fastnar.
        clearInterval(this._hostHeal);
        let ticks = 0;
        this._hostHeal = setInterval(() => {
          if (!this._alive || !this._peer || this.role !== 'host') { clearInterval(this._hostHeal); this._hostHeal = null; return; }
          if (this._peer.open && !this._peer.disconnected) {
            clearInterval(this._hostHeal); this._hostHeal = null; this._emit('status', { phase: 'connected' }); return;
          }
          if (++ticks > 25) { // omkring 20 s utan signal: bygg upp värd-peern på nytt
            clearInterval(this._hostHeal); this._hostHeal = null;
            if (this._alive) this._becomeHost(this.state);
          }
        }, 800);
      });
    },

    _onClientConnect(conn) {
      conn.on('open', () => {
        const meta = conn.metadata || {};
        const playerId = meta.playerId || makeId();
        this._conns.set(conn.peer, { conn, playerId });
        Game.addPlayer(this.state, { id: playerId, name: meta.name });
        this._pushState();
      });
      conn.on('data', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        const rec = this._conns.get(conn.peer);
        const actorId = rec ? rec.playerId : null;
        if (msg.type === 'action') {
          this.state = Game.apply(this.state, msg.action, actorId);
          this._pushState();
        } else if (msg.type === 'hello') {
          if (rec && msg.name) {
            const p = this.state.players.find((x) => x.id === rec.playerId);
            if (p && p.name !== String(msg.name).slice(0, 24)) { p.name = String(msg.name).slice(0, 24); this._pushState(); }
          }
        }
      });
      conn.on('close', () => {
        const rec = this._conns.get(conn.peer);
        // Bara om det fortfarande är samma conn för peer-id:t. Annars skulle en
        // sen close på en redan ersatt conn slå ner en spelare som just återanslutit.
        if (rec && rec.conn === conn) { Game.setConnected(this.state, rec.playerId, false); this._conns.delete(conn.peer); this._pushState(); }
      });
      conn.on('error', () => {
        const rec = this._conns.get(conn.peer);
        if (rec && rec.conn === conn) { try { conn.close(); } catch (_) {} }
      });
    },

    _pushState() {
      this._saveSession();
      const snapshot = JSON.stringify(this.state);
      for (const { conn } of this._conns.values()) {
        if (conn.open) { try { conn.send({ type: 'state', state: JSON.parse(snapshot) }); } catch (_) {} }
      }
      this._emit('state', this.state);
    },

    // ---- GÄST --------------------------------------------------------------
    _startClient(attempt) {
      if (!this._alive) return;
      this.role = 'client';
      this._clearTimers();
      this._emit('status', { phase: attempt === 0 && !this._everConnected ? 'connecting' : 'reconnecting' });
      try { this._peer && this._peer.destroy(); } catch (_) {}
      const peer = new Peer(PEER_CONFIG);
      this._peer = peer;

      peer.on('open', () => this._connectToHost());

      peer.on('error', (err) => {
        const t = (err && err.type) || '';
        if (t === 'peer-unavailable') {
          // Värd-id:t är inte registrerat just nu.
          if (this._canPromote()) {
            // Vi hade en värd (eller återupptog state) som nu saknas → ta över rummet.
            this._emit('status', { phase: 'recovering' });
            this._scheduleElection();
          } else {
            // Värd-id:t hittades inte. Det kan bero på att värden inte startat
            // än, fel kod, ELLER att den gratis-signalservern la värden och
            // gästen på olika servernoder. Vi söker därför om med en HELT ny
            // anslutning till signalservern, så vi kan hamna på samma nod som
            // värden registrerade sig på.
            this._emit('status', { phase: 'waiting-host', attempts: this._clientRetry });
            this._scheduleHostSearch();
          }
          return;
        }
        if (t === 'network' || t === 'server-error' || t === 'socket-error') {
          this._scheduleClientRetry();
          return;
        }
        this._emit('error', humanError(err));
      });

      peer.on('disconnected', () => {
        if (!this._alive || this._retryTimer) return; // redan på väg, undvik dubbla spår
        try { peer.reconnect(); } catch (_) {}
      });
    },

    _connectToHost() {
      // Om signal-peern dött faller vi tillbaka på en full omstart.
      if (!this._peer || this._peer.destroyed) { this._startClient(this._clientRetry); return; }
      // Stäng en eventuell tidigare värd-conn innan vi öppnar en ny.
      try { if (this._hostConn) this._hostConn.close(); } catch (_) {}
      const conn = this._peer.connect(peerId(this.code), {
        reliable: true,
        metadata: { name: this.me.name, playerId: this.me.id },
      });
      this._hostConn = conn;

      conn.on('open', () => {
        clearTimeout(this._connTimer); this._connTimer = null;
        clearTimeout(this._retryTimer); this._retryTimer = null; // vi är inne, avbryt väntande försök
        this._clientRetry = 0;
        this._electAttempt = 0;
        this._everConnected = true;
        this._emit('open', { code: this.code, role: 'client' });
        this._emit('status', { phase: 'connected' });
        try { conn.send({ type: 'hello', name: this.me.name }); } catch (_) {}
        this._flushActions(); // skicka det som köades medan vi var frånkopplade
      });
      conn.on('data', (msg) => {
        if (msg && msg.type === 'state') { this.state = msg.state; this._saveSession(); this._emit('state', this.state); }
      });
      conn.on('close', () => { clearTimeout(this._connTimer); this._connTimer = null; if (this._alive) { this._emit('status', { phase: 'reconnecting' }); this._scheduleClientRetry(); } });
      conn.on('error', () => { clearTimeout(this._connTimer); this._connTimer = null; this._scheduleClientRetry(); });

      clearTimeout(this._connTimer);
      this._connTimer = setTimeout(() => { this._connTimer = null; if (this._alive && (!conn || !conn.open)) { try { conn.close(); } catch (_) {} this._scheduleClientRetry(); } }, 8000);
    },

    // Söker värdrummet på nytt med en FÄRSK signalanslutning (ny Peer). Viktigt
    // när värd och gäst hamnat på olika noder hos den lastbalanserade gratis-
    // servern, då en återanvänd anslutning skulle fråga samma fel nod om och om.
    _scheduleHostSearch() {
      if (!this._alive || this._retryTimer) return;
      this._clientRetry = Math.min(this._clientRetry + 1, 8);
      const delay = Math.min(800 * Math.pow(1.35, this._clientRetry), 6000);
      this._retryTimer = setTimeout(() => {
        this._retryTimer = null;
        if (this._alive) this._startClient(this._clientRetry);
      }, delay);
    },

    _scheduleClientRetry() {
      // Timern själv är sanningen om ett försök redan pågår; ingen separat flagga
      // som kan glida ur synk och fastna.
      if (!this._alive || this._retryTimer) return;
      this._clientRetry = Math.min(this._clientRetry + 1, 8);
      const delay = Math.min(900 * Math.pow(1.4, this._clientRetry), 7000);
      this._retryTimer = setTimeout(() => {
        this._retryTimer = null;
        if (!this._alive) return;
        const peer = this._peer;
        // Lever signal-peern fortfarande räcker det att öppna en ny conn till
        // värden, i stället för att riva och återskapa hela peern. Snabbare och
        // ger inte det flimrande Återansluter som uppstår vid full omstart.
        if (peer && !peer.destroyed && peer.open && !peer.disconnected) this._connectToHost();
        else this._startClient(this._clientRetry);
      }, delay);
    },

    // Värdmigrering: befordra (om vi står näst i tur) eller vänta in den som gör det.
    _scheduleElection() {
      if (!this._alive || this._electing) return;
      this._electing = true;
      this._electAttempt = Math.min(this._electAttempt + 1, 8);
      // Tidigare plats i turordningen → kortare väntan (en blir värd, övriga ansluter).
      const order = (this.state && this.state.order) || [];
      let rank = order.indexOf(this.me.id);
      if (rank < 0) rank = order.length;
      // Ge en omladdande värd en chans att återta rummet innan en gäst tar över.
      const grace = this._everConnected ? 1600 : 2800;
      const backoff = Math.min(300 * Math.pow(1.5, this._electAttempt - 1), 4000);
      const delay = grace + 500 + rank * 800 + backoff + Math.random() * 250;
      clearTimeout(this._electTimer);
      this._electTimer = setTimeout(() => {
        this._electing = false;
        if (!this._alive) return;
        if (this.state) this._becomeHost(this.state);
        else this._startClient(this._clientRetry);
      }, delay);
    },

    // ---- Handlingar --------------------------------------------------------
    dispatch(action) {
      if (this.role === 'host') {
        this.state = Game.apply(this.state, action, this.me.id);
        this._pushState();
      } else if (this._hostConn && this._hostConn.open) {
        try { this._hostConn.send({ type: 'action', action }); } catch (_) {}
      } else {
        // Inte ansluten just nu (t.ex. precis tillbaka från bakgrundsflik på
        // mobil). Köa handlingen och skicka den så snart vi är inne igen, så
        // att ett tryck inte går förlorat. Knuffa igång återanslutningen direkt.
        this._queueAction(action);
        this._emit('dropped');
        this.poke();
      }
    },

    _queueAction(action) {
      this._pendingActions = this._pendingActions || [];
      this._pendingActions.push({ action, at: Date.now() });
      if (this._pendingActions.length > 8) this._pendingActions.shift();
    },
    _flushActions() {
      if (!this._pendingActions || !this._pendingActions.length) return;
      if (!this._hostConn || !this._hostConn.open) return;
      const now = Date.now();
      const items = this._pendingActions; this._pendingActions = [];
      // Skicka bara färska handlingar (inom 15 s), äldre är troligen inaktuella.
      items.forEach((it) => { if (now - it.at < 15000) { try { this._hostConn.send({ type: 'action', action: it.action }); } catch (_) {} } });
    },

    rename(name) {
      this.me.name = String(name).slice(0, 24);
      this.saveName(this.me.name);
      if (this.role === 'host') {
        const p = this.state && this.state.players.find((x) => x.id === this.me.id);
        if (p) { p.name = this.me.name; this._pushState(); }
      } else if (this._hostConn && this._hostConn.open) {
        try { this._hostConn.send({ type: 'hello', name: this.me.name }); } catch (_) {}
      }
    },

    // Stänger av alla löpande timers/intervall. Anropas vid varje rollbyte och
    // vid leave så att inget gammalt spår fyrar och stör en ny anslutning.
    _clearTimers() {
      clearTimeout(this._retryTimer); this._retryTimer = null;
      clearTimeout(this._connTimer); this._connTimer = null;
      clearTimeout(this._electTimer); this._electTimer = null;
      clearInterval(this._hostHeal); this._hostHeal = null;
    },

    // Anropas när fliken blir synlig igen (mobil sömn/nätbyte): kollar att vi
    // fortfarande är uppkopplade och knuffar igång en återanslutning vid behov.
    poke() {
      if (!this._alive || !this._peer) return;
      if (this._peer.destroyed) {
        if (this.role === 'host') this._becomeHost(this.state); else this._startClient(this._clientRetry);
        return;
      }
      if (this._peer.disconnected) { try { this._peer.reconnect(); } catch (_) {} }
      if (this.role === 'client' && (!this._hostConn || !this._hostConn.open) && !this._retryTimer) this._scheduleClientRetry();
    },

    leave() {
      this._alive = false;
      this._pendingActions = [];
      this._clearTimers();
      this.clearSession();
      try { this._peer && this._peer.destroy(); } catch (_) {}
      this._peer = null; this._conns = new Map(); this._hostConn = null;
      this.role = null; this.code = null; this.state = null;
      this._everConnected = false; this._electing = false;
      this._resumed = false; this._electAttempt = 0; this._everHosted = false;
    },
  };

  function humanError(err) {
    const t = (err && err.type) || '';
    const map = {
      'browser-incompatible': 'Din webbläsare stöder tyvärr inte den här tekniken.',
      'invalid-id': 'Ogiltig rumskod.',
      'ssl-unavailable': 'Säker anslutning krävs (https).',
      'webrtc': 'Kunde inte upprätta anslutningen.',
    };
    return map[t] || 'Något gick fel med anslutningen. Försöker igen…';
  }

  Net.randomCode = randomCode;
  if (typeof window !== 'undefined') window.Net = Net;
})(typeof window !== 'undefined' ? window : globalThis);

// Vitalisera djupdyk, gränssnitt. Binder DOM mot nätlagret och renderar staten.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const LEVELS = (window.DECK && window.DECK.levels) || [];
  let selectedLevel = LEVELS[0] && LEVELS[0].id;
  let selectedSession = 'dyk';     // sessionsdjup, väljs i lobbyn
  let selectedMode = 'oppen';      // sällskapsläge, väljs i lobbyn
  let selectedDuet = false;        // duett på distans, väljs i lobbyn
  let silenceTimer = null;         // lokal nedräkning för tystnadskort
  let lastCardKey = null;
  let lastReflectReveal = null;    // för att skrolla fram tolkningen en gång
  let lastLevelRendered = null;   // för nedsänknings-effekt vid nivåbyte
  let lastTurnId = null;          // för turbyte-ljud
  let displayMode = false;        // "Visa på TV": passiv display-vy (ingen styrning)

  // Sessions-journal: vad DEN HÄR enheten sett och valt, som kontext till feedback.
  // Rör aldrig spel-staten, broadcastas aldrig, innehåller inget medspelarna delat.
  const Journal = {
    startedAt: null, startLevel: null, cards: [],
    track(s) {
      if (!s || s.phase !== 'playing') return;
      if (!this.startedAt) this.startedAt = Date.now();
      if (!this.startLevel && s.levelId) this.startLevel = s.levelId;
      const c = s.card; if (!c) return;
      const t = String(c.text || '').slice(0, 80);
      const src = c.source || 'deck';
      const last = this.cards[this.cards.length - 1];
      if (last && last.t === t && last.src === src) return;   // hoppa dubbletter i rad
      this.cards.push({ t, src, lvl: c.levelId || s.levelId || '' });
      if (this.cards.length > 50) this.cards.shift();
    },
    reset() { this.startedAt = null; this.startLevel = null; this.cards = []; },
  };

  // ---- Ljud (valbart) -----------------------------------------------------
  // Subtila toner via WebAudio. Obs: på iOS spelas inget om telefonens
  // ringknapp står på tyst (en webbegränsning), och första ljudet kräver att
  // man rört skärmen en gång (vi låser upp ljudet vid första touch).
  const Snd = (function () {
    let ctx = null, muted = false;
    try { muted = JSON.parse(localStorage.getItem('vd_muted')) === true; } catch (_) {}
    function ac() { if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {} } return ctx; }
    function tone(freq, dur, when, gain, type) {
      const c = ac(); if (!c) return;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine'; o.frequency.value = freq;
      const t = c.currentTime + (when || 0);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(c.destination);
      o.start(t); o.stop(t + dur + 0.03);
    }
    return {
      get muted() { return muted; },
      toggle() { muted = !muted; try { localStorage.setItem('vd_muted', JSON.stringify(muted)); } catch (_) {} return muted; },
      resume() { const c = ac(); if (c && c.state === 'suspended') { try { c.resume(); } catch (_) {} } },
      // Tydlig, vänlig stigande klang när det blir DIN tur.
      yourTurn() { if (muted) return; this.resume(); tone(523.25, 0.22, 0, 0.10, 'triangle'); tone(659.25, 0.24, 0.10, 0.09, 'triangle'); tone(783.99, 0.5, 0.21, 0.085, 'triangle'); },
      // Dämpad markering när turen byter till någon annan.
      turn() { if (muted) return; this.resume(); tone(440, 0.14, 0, 0.035); tone(587.33, 0.16, 0.06, 0.03); },
      // Mjukt sjunkande svep vid nytt djup.
      descend() { if (muted) return; this.resume(); tone(330, 0.5, 0, 0.06); tone(220, 0.7, 0.09, 0.05); tone(160, 0.95, 0.18, 0.045); },
      // Klangskål när tystnaden är över: grundton + inharmoniska deltoner (som en riktig
      // skål), en lätt svävning och lång, mjuk utklingning.
      bowl() {
        if (muted) return; this.resume();
        const f = 330;
        tone(f, 3.8, 0, 0.11, 'sine');
        tone(f * 1.004, 3.8, 0, 0.075, 'sine');   // svag svävning (~1,3 Hz) för levande klang
        tone(f * 2.76, 2.9, 0.01, 0.05, 'sine');  // inharmonisk överton
        tone(f * 5.40, 1.9, 0.02, 0.022, 'sine'); // skimmer
        tone(f * 8.90, 1.1, 0.03, 0.010, 'sine'); // luftigt anslag
      },
    };
  })();
  // Lås upp ljudet vid första interaktionen (krav på iOS/Safari).
  ['pointerdown', 'touchstart', 'keydown'].forEach((ev) =>
    window.addEventListener(ev, () => Snd.resume(), { once: true, passive: true }));

  // Lätt haptisk knäpp när man trycker på en knapp (där enheten stöder det,
  // i praktiken Android). Subtil, och bara för knappar som faktiskt går att trycka.
  document.addEventListener('pointerdown', (e) => {
    if (!navigator.vibrate) return;
    const btn = e.target && e.target.closest && e.target.closest('button, .btn, .chip');
    if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
      try { navigator.vibrate(6); } catch (_) {}
    }
  }, { passive: true });

  // Hindra iOS-Safaris dubbeltap-zoom (touch-action räcker inte alltid där).
  // Nyp-zoom med två fingrar är kvar för tillgänglighet. Vi stoppar bara det
  // andra snabba tappet inom 300 ms.
  let _lastTouchEnd = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - _lastTouchEnd <= 300) e.preventDefault();
    _lastTouchEnd = now;
  }, { passive: false });

  // ---- Tema & färger -------------------------------------------------------
  function levelIndex(id) { return Math.max(0, LEVELS.findIndex((l) => l.id === id)); }
  function levelMeta(id) { return LEVELS.find((l) => l.id === id) || LEVELS[0]; }

  function applyTheme(levelId) {
    const i = levelIndex(levelId);
    const c = LEVELS[i].color;
    const c2 = (LEVELS[Math.min(i + 1, LEVELS.length - 1)] || LEVELS[i]).color;
    document.documentElement.style.setProperty('--depth', c);
    document.documentElement.style.setProperty('--depth-2', c2);
    if (window.Ocean) window.Ocean.setDepth(LEVELS.length > 1 ? i / (LEVELS.length - 1) : 0);
  }

  // Avatarfärg ur namn (stabil).
  function hashHue(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return h;
  }
  function avatarBg(name) { return `hsl(${hashHue(name || '?')} 62% 58%)`; }
  function hashStr(str) { let h = 0; str = String(str); for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0; return Math.abs(h); }
  const BLOT_COLOR = '#a6dbe1';
  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  // ---- Skärmhantering ------------------------------------------------------
  function showScreen(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    const el = $('screen-' + name);
    if (el) el.classList.add('active');
  }

  let _state = null;
  function state() { return _state; }

  // ---- Spelarchips: nyckelbaserad uppdatering (ingen omritning → ingen flimmer) ----
  function syncPlayers(container, players, opts = {}) {
    const meId = Net.me && Net.me.id;
    const hostId = (_state && _state.hostId);
    const existing = new Map();
    Array.from(container.children).forEach((node) => existing.set(node.dataset.pid, node));

    players.forEach((p) => {
      let node = existing.get(p.id);
      const isNew = !node;
      if (isNew) {
        node = document.createElement('span');
        node.className = 'pchip enter';
        node.dataset.pid = p.id;
        node.innerHTML = '<span class="pavatar"></span><span class="pname"></span><span class="crown" hidden>👑</span>';
        // ta bort entré-animationsklassen efter att den spelats en gång
        node.addEventListener('animationend', () => node.classList.remove('enter'), { once: true });
      }
      const av = node.firstChild;
      const nm = node.children[1];
      const cr = node.children[2];
      const bg = avatarBg(p.name);
      if (av.style.background !== bg) av.style.background = bg;
      const ini = initials(p.name);
      if (av.textContent !== ini) av.textContent = ini;
      const label = p.name + (p.id === meId ? ' · du' : '');
      if (nm.textContent !== label) nm.textContent = label;
      const showCrown = p.id === hostId;
      if (cr.hidden === showCrown) cr.hidden = !showCrown;
      node.classList.toggle('off', !p.connected);
      node.classList.toggle('current', !!opts.current && p.id === (_state && _state.turnId));
      existing.delete(p.id);
      container.appendChild(node); // håller ordningen och flyttar utan att återskapa
    });
    existing.forEach((node) => node.remove()); // spelare som lämnat helt
  }

  function levelCard(l, selected, compact) {
    return `<button class="lvl ${selected ? 'selected' : ''}" data-id="${l.id}" style="--lvl-c:${l.color}">
      <span class="lvl-badge">${escapeHtml(l.depth)}<small>djup</small></span>
      <span class="lvl-main">
        <span class="lvl-name">${escapeHtml(l.name)}</span>
        ${compact ? '' : `<span class="lvl-sub">${escapeHtml(l.intro || l.subtitle || '')}</span><span class="lvl-count">${(l.cards ? l.cards.length : l.count) || ''} frågor</span>`}
      </span>
      <span class="check">✓</span>
    </button>`;
  }

  // ---- Rendering -----------------------------------------------------------
  function render(state) {
    if (!state) return;
    Journal.track(state);
    if (state.phase !== 'playing') { toggleOverlay('ritual', false); toggleOverlay('pause', false); stopSilence(); $('handoff').hidden = true; }
    if (state.phase === 'lobby') {
      // Runt bordet har ingen nätlobby. "Spela igen" (restart → lobby) ska bara
      // dela om med samma grupp och inställningar och gå rakt in i spelet igen.
      if (Net.role === 'local') {
        if (!localRestartPending) { localRestartPending = true; localPrevTurn = null; localStarted = false; setTimeout(() => Net.dispatch({ type: 'start' }), 0); }
        return;
      }
      lastLevelRendered = null; lastTurnId = null; renderLobby(state); showScreen('lobby');
    }
    else if (state.phase === 'summary') { renderSummary(state); showScreen('summary'); }
    else { localRestartPending = false; renderGame(state); showScreen('game'); maybeHandoff(state); }
  }

  // ---- Display-vy ("Visa på TV"): passiv, stor, ingen styrning ------------
  // En TV/laptop som bara speglar rummets state. Styrs av en fjärr-telefon.
  function renderDisplay(s) { paintDisplay(s); fitTvText(); requestAnimationFrame(() => { if (displayMode) fitTvText(); }); }

  // Skala kortets text så hela kortet får plats på höjden (TV:n kan inte skrolla),
  // och så att den stora ytan på en bred skärm faktiskt används. Mäter och krymper.
  function fitTvText() {
    const stage = document.querySelector('.tv-stage');
    const card = $('tv-card');
    const text = $('tv-text');
    const fu = $('tv-followup');
    if (!stage || !card || !text) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    // Kapa hela TV-omslaget till den VERKLIGT synliga höjden (visualViewport) så flex-layouten
    // fördelar rätt: scenen får resten medan footern (turindikator + fotnot) behåller sin plats.
    // På iOS refererar vh/dvh annars till adressfält-DOLT-läget medan mindre faktiskt syns → utan
    // kap växer kortet ner bakom adressfältet/footern (telefon-i-liggande som TV-skärm).
    const vvH = (window.visualViewport && window.visualViewport.height) || vh;
    const wrap = document.querySelector('.tv-wrap');
    if (wrap) {
      // max-height, inte height: .tv-wrap är flex:1 (grow) och skulle strunta i en explicit height.
      const wrapTop = wrap.getBoundingClientRect().top;
      wrap.style.maxHeight = Math.max(0, vvH - wrapTop) + 'px';
    }
    let size = Math.max(20, Math.min(vw * 0.052, vh * 0.12));   // generös startstorlek
    const apply = (px) => { text.style.fontSize = px + 'px'; if (fu) fu.style.fontSize = (px * 0.62) + 'px'; };
    apply(size);
    // Krymp texten (och följdfrågan proportionellt) tills hela kortet får plats i scenen.
    // Omslaget är nu kapat till synligt område, så inget får rinna ut. Konvergerar, golv 16px.
    for (let i = 0; i < 20; i++) {
      const avail = stage.clientHeight - 12;
      const need = card.scrollHeight;
      if (!(avail > 0) || !(need > 0)) break;   // under övergång kan höjden vara 0 → undvik NaN
      if (need <= avail || size <= 16) break;
      size = Math.max(16, size * Math.max(0.8, Math.sqrt(avail / need)));
      apply(size);
    }
  }
  // Om-passa när Fraunces laddat (mätning mot fallback-fonten kan annars bli fel).
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (displayMode) fitTvText(); });

  // Display: dyket avslutat (alla telefoner borta) + en väg ut ur TV-läget.
  function showTvEnded() {
    showScreen('display');
    $('tv-turn').hidden = true; $('tv-blot').hidden = true;
    $('tv-eyebrow').textContent = ''; $('tv-depth').textContent = '';
    $('tv-followup').textContent = ''; $('tv-followup').classList.remove('show');
    $('tv-players').innerHTML = '';
    $('tv-qr').hidden = true;
    $('tv-text').textContent = 'Dyket är avslutat. Tack för att ni dök tillsammans.';
    fitTvText();
  }
  function leaveDisplay() {
    displayMode = false;
    if (Net.leave) Net.leave();
    document.body.classList.remove('display-mode');
    try { history.replaceState({}, '', location.pathname); } catch (_) {}
    _state = null;
    showScreen('home');
    applyTheme(LEVELS[0].id);
  }
  Net.on('ended', () => { if (displayMode) showTvEnded(); });
  if ($('btn-tv-exit')) $('btn-tv-exit').onclick = leaveDisplay;

  // "Gör den här (offer-)telefonen till TV-skärm": helskärm + lås liggande + wake lock,
  // så att en telefon i display-läge fyller en 16:9-panel när man speglar den till TV:n
  // via AirPlay/Chromecast. På iOS respekteras orienteringslåset först i helskärm.
  let _wakeLock = null;
  async function tvWakeLock() { try { if ('wakeLock' in navigator) _wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {} }
  async function tvFullscreen() {
    try { const el = document.documentElement; if (el.requestFullscreen) await el.requestFullscreen(); } catch (_) {}
    try { if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape'); } catch (_) {}
    tvWakeLock();
    if (displayMode) fitTvText();
  }
  if ($('btn-tv-fs')) $('btn-tv-fs').onclick = tvFullscreen;
  document.addEventListener('visibilitychange', () => { if (!document.hidden && displayMode && !_wakeLock) tvWakeLock(); });

  // QR med join-länken i display-lobbyn: telefonen skannar och är med direkt.
  // ALDRIG för Runt bordet-spegling (code 'LOKAL'): en join på relä-koden skulle skapa
  // ett riktigt spel i relä-rummet och tysta speglingen. Bara riktiga nätrum.
  function updateTvQr(s) {
    const box = $('tv-qr'); if (!box) return;
    const isMirror = !!(s && s.code === 'LOKAL');
    // Endast vid BEKRÄFTAD nätlobby (state framme). Vid null-state vet vi inte om rummet
    // är en spegling under uppstart, och en skannad join på relä-koden skulle döda den.
    // Låst dyk = ingen inbjudan att visa.
    const show = !isMirror && !!Net.code && !!(s && s.phase === 'lobby') && !s.locked && !!window.QR;
    box.hidden = !show;
    if (!show) return;
    const url = location.origin + location.pathname + '?join=' + Net.code;
    if (box.dataset.url !== url) {
      box.dataset.url = url;
      try { $('tv-qr-img').innerHTML = window.QR.svg(url, { margin: 2 }); } catch (_) { box.hidden = true; }
    }
  }

  function paintDisplay(s) {
    Journal.track(s);
    showScreen('display');
    $('tv-code').textContent = Net.code || '••••';
    updateTvQr(s);
    const turnEl = $('tv-turn'), eyebrow = $('tv-eyebrow'), textEl = $('tv-text'),
      fu = $('tv-followup'), blot = $('tv-blot'), depthEl = $('tv-depth');
    const noFu = () => { fu.textContent = ''; fu.classList.remove('show'); };

    // Inget rum ännu / väntar på första staten.
    if (!s || !s.phase) {
      applyTheme(LEVELS[0].id);
      depthEl.textContent = ''; turnEl.hidden = true; blot.hidden = true;
      eyebrow.textContent = 'Väntar på dyket'; noFu(); $('tv-players').innerHTML = '';
      textEl.textContent = `Den här skärmen visar dyket med koden ${Net.code || '••••'}. Starta eller fortsätt på telefonen, så dyker det upp här. Syns inget? Kontrollera att koden stämmer.`;
      return;
    }

    const lvl = levelMeta(s.card ? s.card.levelId : s.levelId);
    applyTheme(lvl.id);

    if (s.phase === 'lobby') {
      depthEl.textContent = ''; turnEl.hidden = true; blot.hidden = true; noFu();
      eyebrow.textContent = 'Snart börjar dyket';
      const n = (s.players || []).filter((p) => p.connected).length;
      textEl.textContent = n
        ? (n === 1 ? 'En dykare är med. Vänta in de andra, och starta sedan från en telefon.' : `${n} dykare är med. Starta dyket från en telefon när ni är samlade.`)
        : 'Gå med med koden ovan från era telefoner.';
      syncPlayers($('tv-players'), s.players, {});
      return;
    }

    if (s.phase === 'summary') {
      const sm = s.summary || {};
      depthEl.textContent = ''; turnEl.hidden = true; blot.hidden = true; noFu();
      eyebrow.textContent = 'Ni dök tillsammans';
      textEl.textContent = `${sm.depth || ''} · ${sm.cards || 0} ${sm.cards === 1 ? 'fråga' : 'frågor'} · ${sm.players || 0} dykare`;
      $('tv-players').innerHTML = '';
      if (window.Ocean) window.Ocean.setDepth(1);
      return;
    }

    // Spelar.
    depthEl.textContent = `${lvl.name} · ${lvl.depth}`;
    const turnP = s.players.find((p) => p.id === s.turnId);
    turnEl.hidden = false;
    $('tv-avatar').style.cssText = turnP ? `background:${avatarBg(turnP.name)}` : '';
    $('tv-avatar').textContent = turnP ? initials(turnP.name) : '…';
    $('tv-turn-text').textContent = turnP ? `${turnP.name} läser` : 'Väntar på dykare…';

    const src = s.card && s.card.source;
    const isInkblot = src === 'inkblot', isStrom = src === 'strom', isReflection = src === 'reflection';
    const isClosing = src === 'closing', isSilence = src === 'silence', isWhirl = src === 'whirl';
    const isAscent = src === 'ascent', isQuote = src === 'quote', isParable = src === 'parable', isParCard = src === 'parcard';

    eyebrow.textContent =
      isClosing ? 'Avslutning'
        : isReflection ? '✨ Spegling'
        : isInkblot ? '✦ Bläckbild'
        : isStrom ? '🌊 Para ihop två'
        : isSilence ? '🤫 Tystnad'
        : isWhirl ? '🌀 Strömvirvel'
        : isAscent ? '🫧 Uppstigning'
        : isQuote ? '💬 Diskussion'
        : isParable ? '🪷 Visdomsberättelse'
        : isParCard ? '💞 För er två'
        : '';   // vanligt kort: djupet står redan uppe till vänster, ingen dubblett

    // Bläckbild: visa själva bilden + den gemensamma frågan (var och en har sin egna fråga på sin telefon).
    if (isInkblot && window.Inkblot && window.DECK.inkblot && s.card) {
      blot.hidden = false;
      blot.innerHTML = window.Inkblot.svg(s.card.seed, BLOT_COLOR);
      const cfg = window.DECK.inkblot;
      const words = s.card.words || {};
      if (s.card.revealed === false) {
        const live = s.players.filter((p) => p.connected);
        const n = live.filter((p) => words[p.id]).length;
        textEl.textContent = 'Alla låser i smyg in vad de ser … ' + n + ' av ' + live.length + ' klara.';
      } else if (Object.keys(words).length) {
        textEl.textContent = s.players.filter((p) => words[p.id]).map((p) => p.name + ': ' + words[p.id]).join('  ·  ');
      } else {
        textEl.textContent = cfg.shared[s.card.sharedIdx % cfg.shared.length];
      }
    } else {
      blot.hidden = true;
      textEl.textContent = s.card ? s.card.text : '…';
    }

    // Para ihop två: visa paret när det är klart.
    if (isStrom && s.card && s.card.partnerId) {
      const chooser = s.players.find((p) => p.id === s.card.chooserId);
      const partner = s.players.find((p) => p.id === s.card.partnerId);
      if (partner) textEl.textContent = `${chooser ? chooser.name : '?'} och ${partner.name}: ${s.card.text}`;
    }

    // Följdfråga/tolkning/diskussion när den avslöjats.
    if (s.card && s.card.followup) {
      const lbl = isQuote ? 'Diskussion' : isParable ? 'Eftertanke' : isReflection ? 'Vad det kan betyda' : 'Följdfråga';
      fu.innerHTML = '<span class="fu-label">' + lbl + '</span>' + escapeHtml(s.card.followup);
      fu.classList.add('show');
    } else noFu();

    syncPlayers($('tv-players'), s.players, { current: true });
  }

  function nextConnectedName(s) {
    const order = s.order || [];
    const ci = order.indexOf(s.turnId);
    for (let k = 1; k <= order.length; k++) {
      const id = order[(ci + k) % order.length];
      if (id === s.turnId) continue;
      const p = s.players.find((x) => x.id === id);
      if (p && p.connected) return p.name;
    }
    return null;
  }

  function renderSummary(s) {
    const sm = s.summary || {};
    applyTheme(LEVELS[Math.min(s.deepest || 0, LEVELS.length - 1)].id);
    if (window.Ocean) window.Ocean.setDepth(1);
    $('sum-depth').textContent = sm.depth || '•';
    $('sum-depth-name').textContent = sm.levelName || 'djup';
    $('sum-cards').textContent = sm.cards || 0;
    $('sum-cards-lbl').textContent = sm.cards === 1 ? 'fråga' : 'frågor';
    $('sum-players').textContent = sm.players || 0;

    // Snäckor: personliga minnesmarkörer från den här enheten.
    const shells = loadShells();
    const box = $('shells-box');
    if (shells.length) {
      box.hidden = false;
      $('shells-list').innerHTML = shells.slice().reverse().map((x) => `<li>${escapeHtml(x.text)}</li>`).join('');
    } else { box.hidden = true; }

    // Vykort från djupet.
    drawPostcard(sm);
  }

  function renderLobby(s) {
    $('lobby-code').textContent = s.code;
    $('invite-code').textContent = s.code;
    syncPlayers($('lobby-players'), s.players);
    syncChips('session-chips', 'session', selectedSession);
    syncChips('mode-chips', 'mode', selectedMode);
    applyLobbyFormat(s);

    if (!selectedLevel) selectedLevel = s.levelId;
    const opt = $('level-options');
    // Bygg nivåkorten en gång, annars flimrar de vid varje state-uppdatering
    // (t.ex. när en spelare ansluter). Därefter uppdateras bara markeringen.
    if (!opt.children.length) {
      opt.innerHTML = LEVELS.map((l) => levelCard(l, l.id === selectedLevel, false)).join('');
      bindLevelButtons('level-options', (id) => {
        selectedLevel = id; applyTheme(id);
        opt.querySelectorAll('.lvl').forEach((el) => el.classList.toggle('selected', el.dataset.id === id));
      });
    } else {
      opt.querySelectorAll('.lvl').forEach((el) => el.classList.toggle('selected', el.dataset.id === selectedLevel));
    }
    applyTheme(selectedLevel);
  }

  function renderGame(s) {
    const lvl = levelMeta(s.card ? s.card.levelId : s.levelId);
    const li = levelIndex(lvl.id);
    applyTheme(lvl.id);
    $('depth-val').textContent = lvl.depth;
    $('depth-name').textContent = lvl.name;
    $('game-code').textContent = s.code;
    $('game-code').hidden = Net.role === 'local';   // ingen rumskod att dela lokalt

    // Djupmätare, markören rör sig nedåt med nivån
    $('dg-marker').style.top = (LEVELS.length > 1 ? (li / (LEVELS.length - 1)) * 100 : 0) + '%';

    // Nedsänknings-effekt + milstolpe vid nivåbyte (men inte vid första rendern)
    if (lastLevelRendered !== null && lastLevelRendered !== lvl.id) {
      const fx = $('descend-fx'); fx.classList.remove('run'); void fx.offsetWidth; fx.classList.add('run');
      Snd.descend();
      if (navigator.vibrate) { try { navigator.vibrate([10, 40, 14]); } catch (_) {} }
      const deeper = li > levelIndex(lastLevelRendered);
      toast(`${deeper ? 'Ni sjunker till' : 'Ni stiger till'} ${lvl.name} · ${lvl.depth}`);
    }
    lastLevelRendered = lvl.id;

    const meId = Net.me && Net.me.id;
    const myTurn = s.turnId === meId;
    const turnP = s.players.find((p) => p.id === s.turnId);

    // Turbyte: en tydlig, vänlig klang (plus en liten vibration där det stöds)
    // när det blir DIN tur, en dämpad markering när den går till någon annan.
    if (s.turnId && lastTurnId && s.turnId !== lastTurnId) {
      if (myTurn) { Snd.yourTurn(); if (navigator.vibrate) { try { navigator.vibrate([14, 40, 22]); } catch (_) {} } }
      else Snd.turn();
      // Mjuk glöd-svep över turbannern vid varje turbyte.
      const tb = $('turn'); if (tb) { tb.classList.remove('flash'); void tb.offsetWidth; tb.classList.add('flash'); }
    }
    lastTurnId = s.turnId;

    // Turbanner
    const turnEl = $('turn');
    turnEl.classList.toggle('you', myTurn);
    if (myTurn) {
      $('turn-avatar').style.cssText = '';
      $('turn-avatar').textContent = s.duet ? '💞' : '🤿';
      $('turn-text').textContent = s.duet ? 'Din tur att börja' : 'Din tur, läs frågan högt';
    } else {
      $('turn-avatar').style.cssText = turnP ? `background:${avatarBg(turnP.name)}` : '';
      $('turn-avatar').textContent = turnP ? initials(turnP.name) : '…';
      $('turn-text').textContent = turnP ? `${turnP.name} ${s.duet ? 'börjar' : 'har turen'}` : (s.duet ? 'Väntar på din partner…' : 'Väntar på dykare…');
    }

    // Kort
    const card = $('card');
    const src = s.card && s.card.source;
    const isClosing = src === 'closing';
    const isReflection = src === 'reflection';
    const isInkblot = src === 'inkblot';
    const isStrom = src === 'strom';
    const isSilence = src === 'silence';
    const isWhirl = src === 'whirl';
    const isAscent = src === 'ascent';
    const isQuote = src === 'quote';
    const isParable = src === 'parable';
    const isParCard = src === 'parcard';
    const isSpecial = isClosing || isReflection || isInkblot || isStrom || isSilence || isWhirl || isAscent || isQuote || isParable || isParCard;
    const noFollowup = isInkblot || isStrom || isSilence || isWhirl || isAscent;
    card.classList.toggle('closing', !!isClosing);
    card.classList.toggle('reflection', !!isReflection);
    card.classList.toggle('inkblot', !!isInkblot);
    card.classList.toggle('strom', !!isStrom);
    card.classList.toggle('silence', !!isSilence);
    card.classList.toggle('whirl', !!isWhirl);
    card.classList.toggle('ascent', !!isAscent);
    card.classList.toggle('quote', !!isQuote);
    card.classList.toggle('parable', !!isParable);
    card.classList.toggle('parcard', !!isParCard);
    if (s.card) {
      // Bläckbild: alla ser samma bild + gemensam fråga, plus en egen fråga
      $('card-blot').hidden = !isInkblot;
      if (isInkblot && window.Inkblot && window.DECK.inkblot) {
        const cfg = window.DECK.inkblot;
        // Rita bara om bilden när fröet byts (annars startar tona-fram-animationen om
        // vid varje state-uppdatering).
        const bi = $('blot-img');
        if (bi.dataset.seed !== String(s.card.seed)) { bi.dataset.seed = String(s.card.seed); bi.innerHTML = window.Inkblot.svg(s.card.seed, BLOT_COLOR); }

        // Pulsmekanik: ordfas tills alla låst in, sedan samtidig avtäckning.
        const revealed = s.card.revealed !== false;   // äldre kort utan fältet = klassiskt flöde
        const words = s.card.words || {};
        const live = s.players.filter((p) => p.connected);
        const lockedN = live.filter((p) => words[p.id]).length;
        const iLocked = !!words[meId];
        $('blot-words').hidden = revealed;
        $('blot-shared').hidden = !revealed;
        document.querySelector('.blot-mine').hidden = !revealed;
        if (!revealed) {
          $('blot-word-status').textContent = lockedN + ' av ' + live.length + ' har låst in' + (iLocked ? ' · ditt ord är inne' : '');
          $('btn-blot-lock').textContent = iLocked ? 'Ändra' : 'Lås in';
          // Nödventil för turen/värden om någon inte skriver.
          $('btn-blot-reveal').hidden = !(myTurn || s.hostId === meId) || lockedN === 0;
        }
        // Avtäckta ord: deltat mellan tolkningarna är samtalet.
        const aw = $('blot-all-words');
        aw.hidden = !revealed || !Object.keys(words).length;
        if (!aw.hidden) {
          aw.innerHTML = s.players.filter((p) => words[p.id]).map((p) =>
            '<span class="blot-word"><b>' + escapeHtml(p.name) + '</b>' + escapeHtml(words[p.id]) + '</span>').join('');
        }

        $('blot-shared').textContent = cfg.shared[s.card.sharedIdx % cfg.shared.length];
        const connected = (s.order || []).filter((id) => { const p = s.players.find((x) => x.id === id); return p && p.connected; });
        const myPos = Math.max(0, connected.indexOf(meId));
        // Djupgradering: Ytan/Grundvatten är ren lek (bara Humor), Revet öppnar
        // Fördjupning/Relation/Beslut, Djupvatten och djupare öppnar Skugga.
        const bli = levelIndex(s.card.levelId || s.levelId);
        const avail = cfg.categories.filter((c) =>
          c.name === 'Humor'
          || (bli >= levelIndex('djupvatten'))
          || (bli >= levelIndex('revet') && c.name !== 'Skugga'));
        const cat = avail[myPos % avail.length];
        const q = cat.qs[hashStr(s.card.seed + ':' + meId) % cat.qs.length];
        $('blot-cat').textContent = 'Din fråga · ' + cat.name;
        // Förankra i spelarens egna inlåsta ord när de finns.
        $('blot-q').textContent = (revealed && words[meId] ? 'Du sa "' + words[meId] + '". ' : '') + q;
      }

      // Strömmar: den som har turen väljer en partner, övriga vittnar.
      renderStrom(s, isStrom, myTurn, meId);

      // Tystnad: lugn nedräkning som startar när kortet visas.
      $('silence-ring').hidden = !isSilence;

      $('card-eyebrow').textContent =
        isClosing ? 'Avslutning'
        : isReflection ? '✨ Spegling'
        : isStrom ? '🌊 Para ihop två'
        : isSilence ? '🤫 Tystnad'
        : isWhirl ? '🌀 Strömvirvel'
        : isAscent ? '🫧 Uppstigning'
        : isQuote ? '💬 Diskussion'
        : isParable ? '🪷 Visdomsberättelse'
        : isParCard ? '💞 För er två'
        : `${lvl.name} · ${lvl.depth}`;
      $('card-text').textContent = s.card.text;
      $('card-index').textContent = isAscent && s.ascent
        ? `Var och en i tur och ordning · ${Math.min(s.ascent.done, s.ascent.total)} av ${s.ascent.total}`
        : (isQuote || isParable) ? `${s.card.by || ''}`
        : isSpecial ? '' : `Fråga ${s.cardsRevealed}`;

      const fu = $('card-followup');
      if (s.card.followup) {
        fu.innerHTML = '<span class="fu-label">' + (isQuote ? 'Diskussion' : isParable ? 'Eftertanke' : isReflection ? 'Vad det kan betyda' : 'Följdfråga') + '</span>' + escapeHtml(s.card.followup)
          + (isReflection ? '<span class="fu-mirror">🪞 En spegel, ingen sanning</span>' : '');   // fast disclaimer (flyttad ur f-texterna)
        fu.classList.add('show'); fu.classList.toggle('reveal', !!isReflection);
      } else { fu.classList.remove('show'); fu.classList.remove('reveal'); fu.textContent = ''; }

      // När en speglings tolkning avslöjas: skrolla fram den så hela texten syns.
      if (isReflection && s.card.followup) {
        const rk = 'r|' + s.card.text;
        if (rk !== lastReflectReveal) {
          lastReflectReveal = rk;
          const inner = card.querySelector('.card-inner');
          if (inner) setTimeout(() => { try { inner.scrollTo({ top: inner.scrollHeight, behavior: 'smooth' }); } catch (_) { inner.scrollTop = inner.scrollHeight; } }, 120);
        }
      } else if (!isReflection) { lastReflectReveal = null; }

      // Speglingar läses av uppläsaren. Övriga ser kortets baksida tills
      // tolkningen avslöjas, så att ingen läser i förväg utan blundar och lyssnar.
      const revealed = !!s.card.followup;
      const showBack = isReflection && !myTurn && !revealed;
      $('card-back').hidden = !showBack;
      card.classList.toggle('backed', showBack);
      if (showBack) $('card-back-text').textContent = turnP ? `Blunda och lyssna medan ${turnP.name} läser ${s.duet ? 'för dig' : 'högt'}.` : 'Blunda och lyssna.';

      // Följdfråge-/tolkningsknappen byter skepnad för speglingar
      const fLbl = $('btn-followup').querySelector('.ctrl-lbl');
      const fIco = $('btn-followup').querySelector('.ctrl-ico');
      fLbl.textContent = isQuote ? 'Diskussion' : isParable ? 'Eftertanke' : isReflection ? 'Tolkning' : 'Följdfråga';
      fIco.textContent = isQuote ? '💬' : isParable ? '🪷' : isReflection ? '✨' : '↳';

      // Vänd bara kortet när själva frågan byts (inte när följdfrågan visas)
      const flipKey = isInkblot ? 'inkblot|' + s.card.seed
        : isStrom ? 'strom|' + s.card.text
        : s.card.source + '|' + s.card.text;
      if (flipKey !== lastCardKey) {
        card.classList.remove('flip'); void card.offsetWidth; card.classList.add('flip');
        lastCardKey = flipKey;
        if (isInkblot) $('blot-word-input').value = '';   // nytt frö = tomt ordfält
        if (isSilence) startSilence(); else stopSilence();
        if (navigator.vibrate) { try { navigator.vibrate(isWhirl ? [8, 30, 8, 30, 8] : 8); } catch (_) {} }
      }
    }

    // Skicka-vidare-knappen byter etikett under Uppstigningen.
    $('next-lbl').textContent = isAscent ? 'Nästa dykare' : 'Skicka vidare';

    // Kontroller, bara den vars tur det är kan styra
    const followupShown = !!(s.card && s.card.followup);
    const canGoBack = !!(s.history && s.history.length) && !s.ascent;
    const stromNeedsPartner = isStrom && !s.card.partnerId;
    const stromInvited = isStrom && s.card.inviteId === meId;
    const stromInvitePending = isStrom && !!s.card.inviteId;
    $('btn-next').disabled = !myTurn || stromNeedsPartner;
    $('btn-skip').disabled = !myTurn;
    $('btn-skip').hidden = isAscent;
    $('btn-followup').disabled = !myTurn || followupShown || noFollowup;
    // När följdfrågan/diskussionen/eftertanken redan är framme har knappen gjort sitt
    // → dölj den helt (i stället för en bleknad spökknapp) och låt raden balansera om.
    $('btn-followup').hidden = noFollowup || followupShown;
    $('btn-back').hidden = !(myTurn && canGoBack);
    $('controls').classList.toggle('locked', !myTurn);
    const nextName = nextConnectedName(s);
    $('controls-hint').textContent = controlsHint(s, { isInkblot, isReflection, isStrom, isSilence, isWhirl, isAscent, myTurn, turnP, nextName, stromNeedsPartner, stromInvited, stromInvitePending });

    // Snäck-knappen: dölj på special-kort som inte är en delad fråga att minnas.
    $('btn-shell').hidden = !(isReflection || isStrom || isInkblot || isClosing || src === 'deck');
    $('btn-shell').classList.toggle('saved', !!(s.card && shellSaved(s.card.text)));

    // Bojen-knappen är alltid tillgänglig för alla under spelet.
    $('btn-buoy').hidden = false;

    // Spelar-remsa
    syncPlayers($('game-players'), s.players, { current: true });

    // Ritualer & paus-ventil (synkade overlays)
    toggleOverlay('ritual', !!s.ritual);
    toggleOverlay('pause', !!s.pause);
  }

  function bindLevelButtons(containerId, fn) {
    $(containerId).querySelectorAll('.lvl').forEach((el) => { el.onclick = () => fn(el.dataset.id); });
  }

  // ---- Strömmar: partnerval -----------------------------------------------
  function renderStrom(s, isStrom, myTurn, meId) {
    const pair = $('strom-pair'), pick = $('strom-pick'), wait = $('strom-wait'), row = $('strom-pick-row'), invite = $('strom-invite');
    pair.hidden = true; pick.hidden = true; wait.hidden = true; invite.hidden = true;
    if (!isStrom) return;
    const card = s.card;
    const chooser = s.players.find((p) => p.id === card.chooserId);
    const partner = card.partnerId && s.players.find((p) => p.id === card.partnerId);
    const invited = card.inviteId && s.players.find((p) => p.id === card.inviteId);
    const iAmChooser = meId === card.chooserId;
    const iAmInvited = meId === card.inviteId;

    if (partner) {
      pair.hidden = false; pair.textContent = `${chooser ? chooser.name : '?'} och ${partner.name}`;
      return;
    }
    if (card.inviteId) {
      // En inbjudan är ute och väntar på svar.
      if (iAmInvited) {
        invite.hidden = false;
        $('strom-invite-text').textContent = `${chooser ? chooser.name : 'Någon'} vill göra det här tillsammans med dig. Vill du?`;
      } else {
        wait.hidden = false;
        wait.textContent = iAmChooser
          ? `Väntar på att ${invited ? invited.name : 'din partner'} ska tacka ja …`
          : `${chooser ? chooser.name : 'Någon'} bjöd in ${invited ? invited.name : 'någon'}, väntar på svar …`;
      }
      return;
    }
    // Ingen inbjudan ännu: den som har turen bjuder in, övriga väntar.
    if (iAmChooser) {
      pick.hidden = false;
      const opts = s.players.filter((p) => p.connected && p.id !== card.chooserId);
      row.innerHTML = opts.length
        ? opts.map((p) => `<button class="strom-opt" data-pid="${p.id}"><span class="pavatar" style="background:${avatarBg(p.name)}">${escapeHtml(initials(p.name))}</span>${escapeHtml(p.name)}</button>`).join('')
        : '<span class="strom-wait">Para ihop två behöver minst två dykare. Tryck Byt fråga så länge.</span>';
      row.querySelectorAll('.strom-opt').forEach((b) => { b.onclick = () => Net.dispatch({ type: 'invitePartner', playerId: b.dataset.pid, direct: Net.role === 'local' }); });
    } else {
      wait.hidden = false;
      wait.textContent = `${chooser ? chooser.name : 'Någon'} väljer vem hen vill bjuda in …`;
    }
  }

  // ---- Tystnad: lokal nedräkning ------------------------------------------
  function startSilence() {
    stopSilence();
    let n = 20; const el = $('silence-count'); el.textContent = n;
    silenceTimer = setInterval(() => {
      n -= 1;
      if (n <= 0) { el.textContent = '✓'; stopSilence(); Snd.bowl(); } else el.textContent = n;
    }, 1000);
  }
  function stopSilence() { if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = null; } }

  // ---- Hjälptext under kontrollerna ---------------------------------------
  function controlsHint(s, f) {
    const d = !!s.duet;
    if (f.isStrom) {
      if (f.stromInvited) return 'Du är inbjuden. Vill du vara med? Svara ja eller nej på kortet ovanför.';
      if (f.stromNeedsPartner) {
        if (f.stromInvitePending) return f.myTurn ? 'Inbjudan är skickad. Väntar på svar.' : 'En inbjudan är skickad. Väntar på svar.';
        if (f.myTurn) return d ? 'Bjud in din partner till det här. Ni gör det tillsammans, via ert samtal.' : 'Bjud in någon att göra det här tillsammans med dig. Resten ser på medan ni två gör det.';
        return 'Den som har turen bjuder in någon att göra det här tillsammans med.';
      }
      if (d) return f.myTurn ? 'Det här är bara ni två. Gör det tillsammans, via ert samtal och i er takt. Skicka vidare när ni är klara.' : 'Ni två gör det här tillsammans. Möt varandra.';
      return f.myTurn ? 'Ni två gör det tillsammans, i er takt. Resten håller utrymmet. Skicka vidare när ni är klara.' : 'Två dykare gör en liten sak tillsammans. Att se på är också att vara med.';
    }
    if (f.isSilence) {
      if (d) return f.myTurn ? 'Dela tystnaden tillsammans, var för sig men samtidigt. Skicka vidare när ni är redo.' : 'En delad tystnad, fast på var sitt håll. Inget behöver sägas.';
      return f.myTurn ? 'Låt tystnaden få ta plats. Skicka vidare när ni är redo.' : 'En delad tystnad. Inget behöver sägas.';
    }
    if (f.isWhirl) return f.myTurn ? 'Havet vände turordningen. Läs och skicka vidare som vanligt.' : 'Turordningen kastades om. Häng med i flödet.';
    if (f.isAscent) {
      if (d) return f.myTurn ? 'Säg det du vill till varandra innan ni stiger upp. När du är klar är det partnerns tur.' : (f.turnP ? `${f.turnP.name} säger något till dig innan ni stiger upp.` : 'Snart är det din tur att säga något.');
      return f.myTurn ? 'Säg det du vill till gruppen. När du är klar går turen vidare till nästa.' : (f.turnP ? `${f.turnP.name} säger något till gruppen innan ni stiger upp.` : 'Snart är det din tur att säga något.');
    }
    if (f.isInkblot) {
      const c = s.card;
      if (c && c.revealed === false) {
        return 'Titta på bilden och lås i smyg in ett par ord om vad du ser. När alla låst avtäcks orden samtidigt.';
      }
      const revealTip = c && c.words && Object.keys(c.words).length > 1
        ? 'Be den vars ord ligger längst från ditt att börja berätta. '
        : '';
      if (d) return f.myTurn ? revealTip + 'Ni ser samma bild och har var sin egen fråga om den. Dela med varandra och skicka vidare när ni är klara.' : 'Ni ser samma bild. Din egen fråga står ovanför.';
      return f.myTurn ? revealTip + 'Alla svarar på den gemensamma frågan, och var och en på sin egen. Skicka vidare när ni är klara.' : 'Alla svarar på bilden. Din egen fråga står ovanför.';
    }
    if (f.myTurn) {
      if (f.isReflection) return 'Gör övningen i fantasin och dela det ni vill. Tryck Tolkning när ni är nyfikna på vad det kan betyda.';
      const nudge = sessionNudge(s);
      const base = d
        ? (f.nextName ? `Läs frågan för varandra och samtala i er takt. Klar? Skicka vidare till ${f.nextName}.` : 'Läs frågan för varandra och prata på i er takt, via ert samtal. Skicka vidare när ni är redo.')
        : (f.nextName ? `Läs frågan högt och samtala i er takt. Klar? Skicka vidare till ${f.nextName}.` : 'Läs frågan högt och samtala i er takt. Tryck Skicka vidare när ni är redo.');
      return nudge ? nudge + ' ' + base : base;
    }
    if (d) return f.turnP ? `${f.turnP.name} börjar. Lyssna och möt varandra.` : 'Väntar på din partner…';
    return f.turnP ? `${f.turnP.name} har ordet. Att lyssna är också en gåva.` : 'Väntar på nästa dykare…';
  }

  // Varsam puff att stiga upp när ni dykt en stund (sessionsdjup).
  const SESSION_TARGET = { snorkel: 12, dyk: 28, expedition: 64 };
  function sessionNudge(s) {
    const target = SESSION_TARGET[s.session] || SESSION_TARGET.dyk;
    if (s.cardsRevealed >= target) return 'Ni har dykt en fin stund. Vill ni stiga upp snart? Ni hittar uppstigningen i menyn.';
    return '';
  }

  function toggleOverlay(id, on) {
    const el = $(id); if (!el) return;
    el.classList.toggle('open', on);
    el.setAttribute('aria-hidden', on ? 'false' : 'true');
  }

  // ---- Snäckor (lokala minnesmarkörer) ------------------------------------
  const SHELL_KEY = 'vd_shells';
  function loadShells() { try { return JSON.parse(localStorage.getItem(SHELL_KEY)) || []; } catch (_) { return []; } }
  function shellSaved(txt) { return loadShells().some((x) => x.text === txt); }
  function saveShell() {
    const s = state(); if (!s || !s.card) return;
    // Bläckbilder har tom card.text (bilden är ordlös). Spara den personliga frågan
    // som minne i stället, annars returnerar snäckan tyst (Roberts "går inte att trycka").
    let txt = s.card.text;
    if (!txt && s.card.source === 'inkblot') txt = 'Bläckbild · ' + ($('blot-q').textContent || '');
    if (!txt) return;
    if (shellSaved(txt)) { toast('Den snäckan har du redan plockat upp'); return; }
    const lvl = levelMeta(s.card.levelId || s.levelId);
    const shells = loadShells();
    shells.push({ text: txt, level: lvl.name });
    try { localStorage.setItem(SHELL_KEY, JSON.stringify(shells.slice(-12))); } catch (_) {}
    $('btn-shell').classList.add('saved');
    toast('Snäcka sparad. Du ser den vid avslutet.');
  }

  // ---- Vykort från djupet (canvas) ----------------------------------------
  function wrapText(ctx, text, x, y, maxW, lh) {
    const words = String(text).split(' '); let line = ''; let yy = y;
    for (let i = 0; i < words.length; i++) {
      const test = line + words[i] + ' ';
      if (ctx.measureText(test).width > maxW && i > 0) { ctx.fillText(line.trim(), x, yy); line = words[i] + ' '; yy += lh; }
      else line = test;
    }
    ctx.fillText(line.trim(), x, yy);
    return yy; // sista radens baslinje
  }
  // Hämtar Vitalisera-loggan ur en befintlig CSS-bakgrund (funkar både i
  // enfilsbygget med data-URI och i flerfilsversionen med ikonfilen).
  let _logoImg = null;
  function loadLogo() {
    return new Promise((resolve) => {
      if (_logoImg) return resolve(_logoImg);
      const el = document.querySelector('.summary-mark') || document.querySelector('.brand-mark');
      const bg = el ? (getComputedStyle(el).backgroundImage || '') : '';
      const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
      if (!m) return resolve(null);
      const img = new Image();
      img.onload = () => { _logoImg = img; resolve(img); };
      img.onerror = () => resolve(null);
      img.src = m[1];
    });
  }
  // Liten deterministisk slump så att vykortet ser likadant ut varje gång.
  function pcRng(seed) {
    let t = seed >>> 0;
    return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
  }
  function depthLine(name) {
    const n = String(name || '').toLowerCase();
    if (n.indexOf('djuphav') >= 0) return 'Vi nådde djuphavet tillsammans.';
    if (n.indexOf('djupvatten') >= 0) return 'Vi dök ner i det som betyder något.';
    if (n.indexOf('revet') >= 0) return 'Vi vågade gå under ytan.';
    if (n.indexOf('grundvatten') >= 0) return 'Vi lät nyfikenheten bära oss neråt.';
    return 'Vi tog ett första andetag tillsammans.';
  }
  function drawPostcard(sm) {
    const c = $('postcard'); if (!c || !c.getContext) return;
    const ctx = c.getContext('2d'); const W = c.width, H = c.height; // 1080 x 1350
    ctx.clearRect(0, 0, W, H);

    // Djuphavs-gradient: en aning ljus aqua nära ytan, nattsvart längst ner.
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#176574'); g.addColorStop(0.34, '#0c4858'); g.addColorStop(0.68, '#072c3b'); g.addColorStop(1, '#03121a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // Ljusstrålar uppifrån.
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    [[0.30, 0.14], [0.5, 0.2], [0.71, 0.12]].forEach(([cx, w]) => {
      const grd = ctx.createLinearGradient(0, 0, 0, H * 0.82);
      grd.addColorStop(0, 'rgba(184,228,231,0.10)'); grd.addColorStop(1, 'rgba(184,228,231,0)');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.moveTo(W * (cx - 0.018), 0); ctx.lineTo(W * (cx + 0.018), 0);
      ctx.lineTo(W * (cx + w), H * 0.84); ctx.lineTo(W * (cx - w), H * 0.84); ctx.closePath(); ctx.fill();
    });
    ctx.restore();

    // Bubblor, deterministiskt utlagda ur djup och antal dykare.
    const rand = pcRng((sm.cards || 0) * 131 + (sm.players || 0) * 977 + 17);
    for (let i = 0; i < 28; i++) {
      const x = rand() * W, y = rand() * H, r = 3 + rand() * 17;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(200,226,227,' + (0.03 + rand() * 0.10).toFixed(3) + ')'; ctx.fill();
    }

    // Mjuk vinjett.
    const vg = ctx.createRadialGradient(W / 2, H * 0.42, H * 0.18, W / 2, H * 0.5, H * 0.78);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(2,10,16,0.58)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);

    ctx.textAlign = 'center';
    // Ordmärke.
    ctx.fillStyle = 'rgba(204,226,227,0.92)'; ctx.font = '700 30px system-ui, -apple-system, sans-serif';
    ctx.fillText('V I T A L I S E R A   D J U P D Y K', W / 2, 372);
    // Stor djup-siffra.
    ctx.fillStyle = '#f5fbfb'; ctx.font = '200 224px Georgia, serif';
    ctx.fillText(sm.depth || '0 m', W / 2, 656);
    // Nivånamn.
    ctx.fillStyle = '#cce2e3'; ctx.font = '600 42px system-ui, sans-serif';
    ctx.fillText(String(sm.levelName || '').toUpperCase(), W / 2, 726);
    // Poetisk rad (peak-end), bryts vid behov.
    ctx.fillStyle = '#eaf4f5'; ctx.font = 'italic 54px Georgia, serif';
    const lineY = wrapText(ctx, depthLine(sm.levelName), W / 2, 884, W - 220, 70);
    // Skiljelinje.
    ctx.strokeStyle = 'rgba(204,226,227,0.25)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(W * 0.34, lineY + 56); ctx.lineTo(W * 0.66, lineY + 56); ctx.stroke();
    // Statistik.
    const statsY = lineY + 168;
    const cols = [[String(sm.cards || 0), sm.cards === 1 ? 'FRÅGA' : 'FRÅGOR'], [String(sm.players || 0), 'DYKARE']];
    const cxs = [W * 0.36, W * 0.64];
    cols.forEach((col, i) => {
      ctx.fillStyle = '#f3f9fa'; ctx.font = '300 76px system-ui, sans-serif'; ctx.fillText(col[0], cxs[i], statsY);
      ctx.fillStyle = '#9fc1c8'; ctx.font = '600 25px system-ui, sans-serif'; ctx.fillText(col[1], cxs[i], statsY + 46);
    });
    // Sidfot.
    ctx.fillStyle = 'rgba(150,193,200,0.9)'; ctx.font = '500 27px system-ui, sans-serif';
    ctx.fillText('Det ni delade stannar mellan er  ·  vitalisera.se', W / 2, H - 76);

    // Loggan läggs på överst när den laddats (ritar om bara loggrutan).
    loadLogo().then((img) => { if (img) { const s = 168; ctx.drawImage(img, W / 2 - s / 2, 150, s, s); } });
  }
  function savePostcard() {
    const c = $('postcard'); if (!c || !c.toBlob) { toast('Vykort stöds inte här'); return; }
    try {
      c.toBlob((blob) => {
        if (!blob) { toast('Kunde inte skapa vykortet'); return; }
        const file = new File([blob], 'vitalisera-djupdyk.png', { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file], text: 'Vi gick på djupet tillsammans. Vitalisera djupdyk.' }).catch(() => {});
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = 'vitalisera-djupdyk.png';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1200);
        toast('Vykort sparat. Dela det varsomhelst.');
      });
    } catch (_) { toast('Kunde inte skapa vykortet'); }
  }

  // ---- Lobby-chips: sessionsdjup & sällskapsläge --------------------------
  function syncChips(containerId, attr, value) {
    const c = $(containerId); if (!c) return;
    c.querySelectorAll('.chip').forEach((el) => el.classList.toggle('selected', el.dataset[attr] === value));
  }
  function bindChips() {
    const sc = $('session-chips'), mc = $('mode-chips'), fc = $('format-chips');
    if (sc) sc.querySelectorAll('.chip').forEach((el) => { el.onclick = () => { selectedSession = el.dataset.session; syncChips('session-chips', 'session', selectedSession); }; });
    if (mc) mc.querySelectorAll('.chip').forEach((el) => { el.onclick = () => { selectedMode = el.dataset.mode; syncChips('mode-chips', 'mode', selectedMode); }; });
    if (fc) fc.querySelectorAll('.chip').forEach((el) => { el.onclick = () => { selectedDuet = el.dataset.duet === '1'; if (selectedDuet) selectedMode = 'par'; if (_state) renderLobby(_state); }; });
  }

  // Lobbyns texter och knappar byter skepnad i duett-läget (två på distans).
  function applyLobbyFormat(s) {
    const duet = selectedDuet;
    syncChips('format-chips', 'duet', duet ? '1' : '0');
    const mg = $('mode-group'); if (mg) mg.hidden = duet;
    $('lobby-title').textContent = duet ? 'Ni två, var för sig' : 'Vem är med på dyket?';
    $('invite-hint').innerHTML = duet
      ? 'Skicka länken till din partner så hamnar hen direkt här. Eller läs upp koden <b id="invite-code">' + (s.code || '••••') + '</b> så skriver hen in den. Ha gärna ett vanligt samtal eller videosamtal igång vid sidan om.'
      : 'Den som öppnar länken hamnar direkt här i ert rum. Eller läs upp koden <b id="invite-code">' + (s.code || '••••') + '</b> så skriver de in den själva.';
    $('btn-invite').textContent = duet ? '💞 Bjud in din partner' : '🔗 Bjud in fler';
    $('safe-note').textContent = duet
      ? 'Det här är en stund för er två, byggd på trygghet. Avståndet finns där, men just nu är ni på samma plats i samtalet. Du delar det du vill, i din takt, och får alltid säga pass.'
      : 'Det här är ett rum byggt på trygghet. Ingen tvingas till något. Du delar det du vill, i din takt, och får alltid säga pass. Att vara här är redan modigt.';
    const connected = s.players.filter((p) => p.connected).length;
    if (duet) {
      const ready = connected >= 2;
      $('btn-start').disabled = !ready;
      $('dock-note').textContent = ready ? 'Ni är två. Starta när ni är redo.' : 'Väntar på din partner. Dyket startar när ni är två.';
    } else {
      $('btn-start').disabled = false;
      $('dock-note').textContent = 'Alla kan starta. Vänta tills ni är samlade.';
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---- Toast & netbar ------------------------------------------------------
  let toastT = null;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2800);
  }
  let netbarT = null;
  function netbar(html, kind) {
    const b = $('netbar');
    if (!html) { b.hidden = true; return; }
    b.className = 'netbar' + (kind ? ' ' + kind : '');
    b.innerHTML = html; b.hidden = false;
    if (kind === 'ok') { clearTimeout(netbarT); netbarT = setTimeout(() => { b.hidden = true; }, 1800); }
  }

  // ---- Net-händelser -------------------------------------------------------
  let everConnected = false;
  let statusTimer = null;
  Net.on('state', (s) => { _state = s; if (displayMode) renderDisplay(s); else render(s); });
  Net.on('open', () => { everConnected = true; clearTimeout(statusTimer); netbar('<span class="dot"></span> Ansluten', 'ok'); persistEntry(); });
  Net.on('status', (st) => {
    clearTimeout(statusTimer);
    if (st.phase === 'connected') { netbar(null); return; }
    const render = () => {
      const map = {
        connecting: '<span class="spin"></span> Ansluter…',
        reconnecting: '<span class="spin"></span> Återansluter…',
        recovering: '<span class="spin"></span> Återupprättar rummet…',
        'waiting-host': '<span class="spin"></span> Väntar på värden…',
      };
      if (st.phase === 'waiting-host' && st.attempts >= 4) {
        netbar('<span class="spin"></span> Hittar inget rum ännu, dubbelkolla koden ' + (Net.code || ''), null);
        return;
      }
      if (map[st.phase] !== undefined) netbar(map[st.phase], null);
    };
    // Det allra första anslutningsförsöket visas direkt. Senare hack måste
    // hålla i sig en stund innan vi varnar, annars blinkar banner till i onödan.
    statusTimer = setTimeout(render, everConnected ? 1500 : 0);
  });
  Net.on('error', (msg) => { toast(msg); });
  Net.on('denied', (d) => {
    const locked = d && d.reason === 'låst';
    if (displayMode) {
      // TV:n: visa beskedet stort och stanna kvar (ingen spelar-toast + hem-hopp).
      showScreen('display');
      $('tv-turn').hidden = true; $('tv-blot').hidden = true; $('tv-qr').hidden = true;
      $('tv-followup').textContent = ''; $('tv-followup').classList.remove('show');
      $('tv-players').innerHTML = ''; $('tv-eyebrow').textContent = ''; $('tv-depth').textContent = '';
      $('tv-text').textContent = locked
        ? 'Dyket är låst av värden just nu. Be värden öppna det, så kan skärmen ansluta igen.'
        : 'Skärmen kunde inte ansluta till dyket.';
      fitTvText();
      return;
    }
    toast(locked
      ? 'Dyket är låst av värden just nu. Be dem öppna det, eller vänta till nästa dyk.'
      : 'Ditt spelar-id används redan i det här rummet från en annan enhet.');
    leave();
  });
  let droppedT = 0;
  Net.on('dropped', () => { const now = Date.now(); if (now - droppedT > 2500) { droppedT = now; toast('Inte ansluten just nu. Det du valde skickas så snart du är inne igen.'); } });

  // När fliken kommer tillbaka i förgrunden (mobil sömn, appbyte) eller nätet
  // kommer tillbaka: knuffa nätlagret att kontrollera och återansluta vid behov.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Net.poke) Net.poke(); });
  window.addEventListener('online', () => { if (Net.poke) Net.poke(); });
  window.addEventListener('resize', () => { if (displayMode) fitTvText(); });
  // iOS: adressfältet som tonar in/ut ändrar den synliga höjden UTAN ett tillförlitligt
  // resize-event. visualViewport fångar det → passa om texten så den aldrig klipps.
  if (window.visualViewport) {
    const vvRefit = () => { if (displayMode) fitTvText(); };
    window.visualViewport.addEventListener('resize', vvRefit);
    window.visualViewport.addEventListener('scroll', vvRefit);
  }
  // Fraunces kan ladda EFTER första mätningen (mätning mot fallback-fonten blir för liten
  // → texten växer och överflödar). Passa om varje gång ett typsnitt laddats klart.
  if (document.fonts && document.fonts.addEventListener) {
    document.fonts.addEventListener('loadingdone', () => { if (displayMode) fitTvText(); });
  }

  function persistEntry() {
    try { localStorage.setItem('vd_last', JSON.stringify({ role: Net.role, code: Net.code })); } catch (_) {}
  }

  // ---- Knappar: START ------------------------------------------------------
  const nameInput = $('name-input');
  const codeInput = $('code-input');
  nameInput.value = (Net._persistName && Net._persistName()) || '';

  function currentName() { return nameInput.value.trim() || 'Gäst'; }

  $('btn-create').onclick = () => { Snd.resume(); Net.host(currentName()); };
  $('btn-join').onclick = () => { Snd.resume(); doJoin(); };
  codeInput.addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });

  function doJoin(prefCode) {
    const code = (prefCode || codeInput.value).trim().toUpperCase();
    if (code.length < 4) return toast('Skriv in koden på fyra tecken.');
    Net.join(code, currentName());
  }

  // ---- Runt bordet (lokalt läge, en telefon) -------------------------------
  let localSession = 'dyk';
  let localMode = 'oppen';    // sällskapsläge (samma val som nätlobbyn)
  let localLevel = LEVELS[0] && LEVELS[0].id;   // startdjup
  let localPrevTurn = null;   // för överlämningen mellan turerna
  let localStarted = false;   // hoppa över överlämning för allra första turen
  let localRestartPending = false;   // vakt mot loop om 'start' skulle kasta vid lokal omstart
  function localRow() {
    return '<div class="local-row"><input class="local-name" type="text" maxlength="24" placeholder="Namn" enterkeyhint="next" /><button class="local-del" type="button" aria-label="Ta bort">×</button></div>';
  }
  function bindLocalRow(row) {
    const box = $('local-players');
    row.querySelector('.local-del').onclick = () => { if (box.querySelectorAll('.local-row').length > 2) row.remove(); };
    row.querySelector('.local-name').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const rows = Array.from(box.querySelectorAll('.local-row'));
      const next = rows[rows.indexOf(row) + 1];
      if (next) next.querySelector('.local-name').focus(); else addLocalRow();
    });
  }
  function addLocalRow() {
    const box = $('local-players');
    box.insertAdjacentHTML('beforeend', localRow());
    const row = box.lastElementChild;
    bindLocalRow(row);
    row.querySelector('.local-name').focus();
  }
  function openLocalSetup() {
    localSession = 'dyk'; localMode = 'oppen'; localLevel = LEVELS[0].id;
    const box = $('local-players');
    box.innerHTML = localRow() + localRow();
    box.querySelectorAll('.local-row').forEach(bindLocalRow);
    syncChips('local-session-chips', 'session', localSession);
    syncChips('local-mode-chips', 'mode', localMode);
    const opt = $('local-level-options');
    opt.innerHTML = LEVELS.map((l) => levelCard(l, l.id === localLevel, false)).join('');
    bindLevelButtons('local-level-options', (id) => {
      localLevel = id; applyTheme(id);
      opt.querySelectorAll('.lvl').forEach((el) => el.classList.toggle('selected', el.dataset.id === id));
    });
    applyTheme(localLevel);
    showScreen('local');
  }
  $('btn-local').onclick = () => { Snd.resume(); openLocalSetup(); };
  $('btn-local-add').onclick = addLocalRow;
  $('btn-local-back').onclick = () => { applyTheme(LEVELS[0].id); showScreen('home'); };
  $('local-session-chips').querySelectorAll('.chip').forEach((el) => {
    el.onclick = () => { localSession = el.dataset.session; syncChips('local-session-chips', 'session', localSession); };
  });
  $('local-mode-chips').querySelectorAll('.chip').forEach((el) => {
    el.onclick = () => { localMode = el.dataset.mode; syncChips('local-mode-chips', 'mode', localMode); };
  });
  $('btn-local-start').onclick = () => {
    Snd.resume();
    const names = Array.from($('local-players').querySelectorAll('.local-name')).map((i) => i.value.trim()).filter(Boolean);
    if (names.length < 2) { toast('Skriv in minst två namn.'); return; }
    const players = names.slice(0, 8).map((n) => ({ id: 'L' + Math.random().toString(36).slice(2, 8), name: n }));
    localPrevTurn = null; localStarted = false;
    Net.startLocal(players, { levelId: localLevel, session: localSession, mode: localMode });
  };
  // Överlämning: när turen byter på den enda enheten, visa en lugn "nästa tur"-skärm.
  function maybeHandoff(s) {
    if (Net.role !== 'local') return;
    if (s.phase !== 'playing' || !s.turnId) return;
    if (s.turnId === localPrevTurn) return;
    const first = !localStarted;
    localPrevTurn = s.turnId; localStarted = true;
    if (first || s.ritual) return;            // ingen överlämning för första turen / under ritualen
    const p = s.players.find((x) => x.id === s.turnId);
    $('handoff-name').textContent = p ? p.name : '';
    $('handoff').hidden = false;
  }
  $('btn-handoff-show').onclick = () => { $('handoff').hidden = true; };

  // ---- Visa på TV (display-läge) ------------------------------------------
  function startDisplay(code) {
    displayMode = true;
    document.body.classList.add('display-mode');
    try { history.replaceState({}, '', location.pathname + '?visa=' + code); } catch (_) {}
    $('tv-code').textContent = code;
    renderDisplay(null);
    Net.display(code);
  }
  const tvCodeInput = $('tv-code-input');
  function doTvStart() {
    const code = (tvCodeInput.value || '').trim().toUpperCase();
    if (code.length < 4) { toast('Skriv in koden på fyra tecken.'); return; }
    startDisplay(code);
  }
  $('btn-tv-home').onclick = () => { showScreen('tv-entry'); setTimeout(() => tvCodeInput.focus(), 60); };
  $('btn-tv-back').onclick = () => { showScreen('home'); };
  $('btn-tv-start').onclick = doTvStart;
  tvCodeInput.addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  tvCodeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doTvStart(); });

  // "Visa på TV"-panelen på telefonen. Visar KODEN att skriva in på TV:n (i lokalt
  // läge "Runt bordet" finns ingen serverkod → vi startar en spegling som ger en
  // relä-kod telefonen pushar sin state till), plus hur-gör-jag och live-status.
  function displayCode() { return Net.local ? (Net.mirrorCode && Net.mirrorCode()) : Net.code; }
  function tvDisplayUrl() { return location.origin + location.pathname + '?visa=' + (displayCode() || ''); }
  let tvMirrorPhase = 'off';
  function updateTvPanelStatus() {
    const st = $('tvpanel-status'); if (!st) return;
    if (Net.local) {
      const on = tvMirrorPhase === 'on';
      st.textContent = on ? '✓ Klart — koden visar ert dyk på TV:n.' : 'Kopplar upp speglingen …';
      st.className = 'tvp-status' + (on ? ' ok' : '');
    } else {
      st.textContent = 'Skriv koden på TV:n, så följer den ert dyk.';
      st.className = 'tvp-status';
    }
  }
  function openTvPanel() {
    if (Net.local && Net.startMirror) Net.startMirror();   // starta spegling + generera kod
    const code = displayCode();
    if (!code) { toast('Skapa eller gå med i ett dyk först, så kan du visa det på en TV.'); return; }
    $('tvpanel-code').textContent = code;
    $('btn-tvpanel-stop').hidden = !Net.local;              // "sluta visa" är bara relevant för spegling
    $('tvp-cast-hint').hidden = true;
    $('btn-tvp-cast-api').hidden = !window.PresentationRequest;   // Chrome/Android med Cast
    updateTvPanelStatus();
    $('tvpanel').classList.add('open'); $('tvpanel').setAttribute('aria-hidden', 'false');
  }
  function closeTvPanel() { $('tvpanel').classList.remove('open'); $('tvpanel').setAttribute('aria-hidden', 'true'); }
  Net.on('mirror', (m) => { tvMirrorPhase = (m && m.phase) || 'off'; if ($('tvpanel').classList.contains('open')) updateTvPanelStatus(); });
  $('btn-tvpanel-close').onclick = closeTvPanel;
  $('tvpanel').addEventListener('click', (e) => { if (e.target.id === 'tvpanel') closeTvPanel(); });
  $('btn-tvpanel-copy').onclick = () => {
    const url = tvDisplayUrl();
    if (navigator.share) navigator.share({ title: 'Vitalisera djupdyk: visa på TV', text: 'Öppna på en TV eller dator:', url }).catch(() => {});
    else if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast('Länk kopierad. Öppna den på TV:n eller datorn.')).catch(() => toast('Länk: ' + url));
    else toast('Länk: ' + url);
  };
  $('btn-tvpanel-stop').onclick = () => { if (Net.stopMirror) Net.stopMirror(); closeTvPanel(); toast('Slutade visa på TV.'); };
  // Presentation API: låt Chrome/Android lista Cast-mottagare och ladda display-URL:en
  // direkt på TV:n (Chromecast/Google TV/Android TV), utan att någon startar TV-webbläsaren.
  $('btn-tvp-cast-api').onclick = () => {
    if (Net.local && Net.startMirror) Net.startMirror();
    const url = tvDisplayUrl();
    if (!displayCode()) { toast('Skapa eller gå med i ett dyk först.'); return; }
    try {
      const pr = new PresentationRequest([url]);
      pr.start().then(() => { toast('Öppnar dyket på TV:n …'); closeTvPanel(); }).catch(() => toast('Ingen TV att casta till hittades.'));
    } catch (_) { toast('Casta stöds inte i den här webbläsaren.'); }
  };
  // Spegling via AirPlay/Chromecast går inte att starta från en webbsida (media-API:er
  // resp. eget Cast-bygge krävs), så ikonerna visar hur man gör i respektive system.
  function tvCastHint(kind) {
    const h = $('tvp-cast-hint');
    h.textContent = kind === 'airplay'
      ? 'Bäst med en extra telefon som TV-skärm: öppna koden på den, tryck ⛶ för liggande helskärm, och spegla den till TV:n via Kontrollcenter, Skärmdupplicering. Stående telefon fyller aldrig en 16:9-skärm.'
      : 'Android eller Chrome på datorn: öppna webbläsarens meny (⋮), Casta, välj din Chromecast. För AirPlay/spegling: gör en extra telefon till TV-skärm (⛶ liggande helskärm) och spegla den. (Chromecast stöds ej på iPhone.)';
    h.hidden = false;
  }
  $('btn-tvp-airplay').onclick = () => tvCastHint('airplay');
  $('btn-tvp-cast').onclick = () => tvCastHint('cast');

  // ---- Knappar: LOBBY ------------------------------------------------------
  $('btn-start').onclick = () => { Snd.resume(); Net.dispatch({ type: 'start', levelId: selectedLevel, session: selectedSession, mode: selectedDuet ? 'par' : selectedMode, duet: selectedDuet }); };
  bindChips();
  $('btn-leave-lobby').onclick = leave;
  $('lobby-code-pill').onclick = copyCode;
  $('btn-share').onclick = shareInvite;
  $('btn-invite').onclick = shareInvite;

  // ---- Knappar: SPEL -------------------------------------------------------
  $('btn-next').onclick = () => { Snd.resume(); Net.dispatch({ type: 'next' }); };
  $('btn-skip').onclick = () => Net.dispatch({ type: 'skip' });
  $('btn-followup').onclick = () => Net.dispatch({ type: 'followup' });
  $('btn-back').onclick = () => Net.dispatch({ type: 'back' });
  $('btn-menu').onclick = openSheet;
  $('game-code').onclick = shareInvite;
  $('btn-invite-game').onclick = () => { shareInvite(); closeSheet(); };
  $('btn-tv-share').onclick = () => { closeSheet(); openTvPanel(); };
  $('btn-tv-lobby').onclick = openTvPanel;
  $('btn-shell').onclick = saveShell;
  $('btn-buoy').onclick = () => { Net.dispatch({ type: 'buoy' }); };
  // Bläckbildens ordfas: lås in (eller ändra) det du ser; turen/värden kan avtäcka i förtid.
  function lockBlotWord() {
    const w = $('blot-word-input').value.trim();
    if (!w) { toast('Skriv först ett par ord om vad du ser.'); return; }
    Net.dispatch({ type: 'inkblotWord', text: w });
  }
  $('btn-blot-lock').onclick = lockBlotWord;
  $('blot-word-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lockBlotWord(); $('blot-word-input').blur(); } });
  $('btn-blot-reveal').onclick = () => Net.dispatch({ type: 'inkblotReveal' });
  $('btn-strom-accept').onclick = () => { Snd.resume(); Net.dispatch({ type: 'acceptPartner' }); };
  $('btn-strom-decline').onclick = () => { Net.dispatch({ type: 'declinePartner' }); };
  $('btn-begin-dive').onclick = () => { Snd.resume(); Net.dispatch({ type: 'beginDive' }); };
  $('btn-resume').onclick = () => { Net.dispatch({ type: 'resume' }); };

  // ---- Sammanfattning ------------------------------------------------------
  $('btn-again').onclick = () => Net.dispatch({ type: 'restart' });
  $('btn-summary-leave').onclick = leave;

  // ---- Meny-ark ------------------------------------------------------------
  function openSheet() {
    const s = state(); if (!s) return;
    const myTurn = s.turnId === (Net.me && Net.me.id);
    const isLocal = Net.role === 'local';
    const isHost = Net.role === 'host' || isLocal;   // runt bordet: enheten styr allt
    const canDrive = isHost || myTurn;
    // Grupper: specialkort (den som driver kortet), din tur (bara nätläge), spelledaren (värd).
    $('grp-cards').hidden = !canDrive;
    $('grp-turn').hidden = isLocal;
    $('grp-host').hidden = !isHost;
    // Enskilda villkor inom grupperna.
    $('btn-parcard').hidden = s.mode !== 'par';                                       // par-kort bara i parläge
    $('btn-strom').hidden = s.players.filter((p) => p.connected).length < 2;          // kräver två
    const inv = $('btn-invite-game'); if (inv) inv.hidden = isLocal;                  // ingen inbjudan lokalt
    $('sheet-note').hidden = canDrive;
    // Lås dyket: bara meningsfullt i nätläge (lokalt finns inga anslutningar att stänga ute).
    $('btn-lock').hidden = isLocal;
    $('btn-lock').textContent = s.locked ? '🔓 Öppna dyket för nya igen' : '🔒 Lås dyket för nya';
    updateSoundLabel();
    $('game-invite-code').textContent = s.code;
    $('sheet').classList.add('open'); $('sheet').setAttribute('aria-hidden', 'false');
  }
  function closeSheet() { $('sheet').classList.remove('open'); $('sheet').setAttribute('aria-hidden', 'true'); }

  // ---- Djupväljare (öppnas via djup-mätaren i topbaren) --------------------
  function openDepthPicker() {
    const s = state(); if (!s) return;
    const isHost = Net.role === 'host' || Net.role === 'local';
    $('depthpick-levels').innerHTML = LEVELS.map((l) => levelCard(l, l.id === s.levelId, true)).join('');
    $('depthpick-levels').classList.toggle('inert', !isHost);   // icke-värd: dämpad, ej klickbar
    $('depthpick-note').hidden = isHost;   // bara värden kan byta djup mitt i dyket
    if (isHost) {
      bindLevelButtons('depthpick-levels', (id) => { Net.dispatch({ type: 'setLevel', levelId: id }); closeDepthPicker(); });
    }
    $('depthpick').classList.add('open'); $('depthpick').setAttribute('aria-hidden', 'false');
  }
  function closeDepthPicker() { $('depthpick').classList.remove('open'); $('depthpick').setAttribute('aria-hidden', 'true'); }
  $('depth-meter').onclick = openDepthPicker;
  $('btn-depthpick-close').onclick = closeDepthPicker;
  $('depthpick').addEventListener('click', (e) => { if (e.target.id === 'depthpick') closeDepthPicker(); });
  function updateSoundLabel() { $('btn-sound').textContent = Snd.muted ? '🔇 Ljud: av' : '🔊 Ljud: på'; }
  $('btn-close-sheet').onclick = closeSheet;
  $('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
  $('btn-reflection').onclick = () => { Net.dispatch({ type: 'reflection' }); closeSheet(); };
  $('btn-quote').onclick = () => { Net.dispatch({ type: 'quote' }); closeSheet(); };
  $('btn-parable').onclick = () => { Net.dispatch({ type: 'parable' }); closeSheet(); };
  $('btn-parcard').onclick = () => { Net.dispatch({ type: 'parcard' }); closeSheet(); };
  $('btn-inkblot').onclick = () => { Net.dispatch({ type: 'inkblot' }); closeSheet(); };
  $('btn-strom').onclick = () => {
    const st = state();
    if (st && st.players.filter((p) => p.connected).length < 2) { closeSheet(); toast('Det här är för två. Bjud in en dykare till först.'); return; }
    Net.dispatch({ type: 'strom' }); closeSheet();
  };
  $('btn-silence').onclick = () => { Net.dispatch({ type: 'silence' }); closeSheet(); };
  $('btn-postcard').onclick = savePostcard;
  $('btn-closing').onclick = () => { Net.dispatch({ type: 'closing' }); closeSheet(); };
  $('btn-lock').onclick = () => {
    const s = state(); const on = !(s && s.locked);
    Net.dispatch({ type: 'setLock', on });
    closeSheet();
    toast(on ? 'Dyket är låst. Inga nya kan ansluta, men alla som är med kan återansluta.' : 'Dyket är öppet för nya igen.');
  };
  $('btn-pass').onclick = () => { Net.dispatch({ type: 'passTurn' }); closeSheet(); };
  $('btn-pass-back').onclick = () => { Net.dispatch({ type: 'turnBack' }); closeSheet(); };
  $('btn-finish').onclick = () => { Net.dispatch({ type: 'finish' }); closeSheet(); };
  $('btn-restart').onclick = () => { Net.dispatch({ type: 'restart' }); closeSheet(); };
  $('btn-leave-game').onclick = () => { closeSheet(); leave(); };
  $('btn-sound').onclick = () => { Snd.toggle(); Snd.resume(); updateSoundLabel(); };

  // ---- Onboarding ----------------------------------------------------------
  const INTRO_KEY = 'vd_intro_hidden';
  function introHidden() { try { return JSON.parse(localStorage.getItem(INTRO_KEY)) === true; } catch (_) { return false; } }
  function openIntro() {
    $('intro-hide').checked = introHidden();
    $('intro').classList.add('open'); $('intro').setAttribute('aria-hidden', 'false');
  }
  function closeIntro() {
    $('intro').classList.remove('open'); $('intro').setAttribute('aria-hidden', 'true');
    try { localStorage.setItem(INTRO_KEY, JSON.stringify(!!$('intro-hide').checked)); } catch (_) {}
  }
  function maybeShowIntro() { if (!introHidden()) openIntro(); }
  $('btn-intro-start').onclick = closeIntro;
  $('intro').addEventListener('click', (e) => { if (e.target.id === 'intro') closeIntro(); });
  $('btn-help-home').onclick = openIntro;
  $('btn-help-game').onclick = () => { closeSheet(); openIntro(); };

  // ---- Komplett manual + PDF-utskrift -------------------------------------
  function openManual() {
    $('manual').classList.add('open'); $('manual').setAttribute('aria-hidden', 'false');
    const p = $('manual').querySelector('.intro-panel'); if (p) p.scrollTop = 0;
  }
  function closeManual() { $('manual').classList.remove('open'); $('manual').setAttribute('aria-hidden', 'true'); }
  $('btn-manual-close').onclick = closeManual;
  $('manual').addEventListener('click', (e) => { if (e.target.id === 'manual') closeManual(); });
  $('btn-manual-intro').onclick = openManual;

  // ---- Instruktionsfilm -----------------------------------------------------
  function openVideo() { const v = $('video'); v.classList.add('open'); v.setAttribute('aria-hidden', 'false'); }
  function closeVideo() {
    const v = $('video'); v.classList.remove('open'); v.setAttribute('aria-hidden', 'true');
    try { $('video-el').pause(); } catch (_) {}
  }
  $('btn-video-intro').onclick = openVideo;
  $('btn-video-manual').onclick = openVideo;
  $('btn-video-game').onclick = () => { closeSheet(); openVideo(); };
  $('btn-video-close').onclick = closeVideo;
  $('video').addEventListener('click', (e) => { if (e.target.id === 'video') closeVideo(); });
  // Lobbyns lyfta genvägar (samma som i menyn/hemma).
  $('btn-help-lobby').onclick = openIntro;
  $('btn-video-lobby').onclick = openVideo;
  $('btn-sound-lobby').onclick = () => { Snd.toggle(); Snd.resume(); $('btn-sound-lobby').textContent = Snd.muted ? '🔇 Ljud' : '🔊 Ljud'; };
  $('btn-manual-game').onclick = () => { closeSheet(); openManual(); };
  $('btn-manual-print').onclick = () => {
    // iOS-PWA i standalone kan inte printa direkt: öppna i en vanlig flik som auto-printar.
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    if (standalone) { window.open(location.origin + location.pathname + '?print=manual', '_blank'); return; }
    setTimeout(() => { try { window.print(); } catch (_) {} }, 60);
  };

  // ---- Lägg till på hemskärmen (PWA-installation) --------------------------
  (function installPrompt() {
    const sheet = $('install');
    const hint = $('btn-install');
    if (!sheet || !hint) return;

    const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || window.navigator.standalone === true;
    const ua = navigator.userAgent || '';
    // iPadOS utger sig för att vara Mac, så vi känner igen den på pekskärmen.
    const isIOS = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const isSafari = isIOS && /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
    const DISMISS_KEY = 'vd_install_dismissed';
    let deferred = null; // beforeinstallprompt-händelsen (Android/Chrome)
    let dismissed = false;
    try { dismissed = localStorage.getItem(DISMISS_KEY) === '1'; } catch (_) {}

    function canShow() {
      if (standalone || dismissed) return false; // redan installerad eller bortvald
      return isIOS || !!deferred;                // iOS får instruktion, Android när prompten finns
    }
    function refresh() { hint.hidden = !canShow(); }
    function remember() { dismissed = true; hint.hidden = true; try { localStorage.setItem(DISMISS_KEY, '1'); } catch (_) {} }

    function openInstall() {
      $('install-android').hidden = !deferred;
      $('install-ios').hidden = !(isIOS && isSafari);
      $('install-ios-hint').hidden = !(isIOS && !isSafari);
      sheet.classList.add('open'); sheet.setAttribute('aria-hidden', 'false');
    }
    function closeInstall() { sheet.classList.remove('open'); sheet.setAttribute('aria-hidden', 'true'); }

    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; refresh(); });
    window.addEventListener('appinstalled', () => { deferred = null; closeInstall(); remember(); });

    hint.onclick = openInstall;
    $('btn-close-install').onclick = () => { closeInstall(); remember(); };
    sheet.addEventListener('click', (e) => { if (e.target.id === 'install') closeInstall(); });
    $('btn-install-now').onclick = async () => {
      if (!deferred) { closeInstall(); return; }
      deferred.prompt();
      try { await deferred.userChoice; } catch (_) {}
      deferred = null; closeInstall(); refresh();
    };

    refresh();
  })();

  // ---- Feedback ------------------------------------------------------------
  (function feedbackModule() {
    const sheet = $('feedback');
    if (!sheet) return;
    const form = $('fb-form'), done = $('fb-done'), err = $('fb-error'), sendBtn = $('btn-fb-send');
    let rating = 0;
    const dots = Array.from(sheet.querySelectorAll('.fb-dot'));
    const paintDots = () => dots.forEach((d) => { const on = Number(d.dataset.v) <= rating; d.classList.toggle('on', on); d.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    dots.forEach((d) => { d.onclick = () => { const v = Number(d.dataset.v); rating = rating === v ? 0 : v; paintDots(); }; });

    function appVersion() {
      const el = $('app-version'); const t = ((el && el.textContent) || '').replace(/^\s*version\s*/i, '').trim();
      return t && !/__BUILD__/.test(t) ? t : '';
    }
    function platform() {
      const ua = navigator.userAgent || '';
      const os = /iphone/i.test(ua) ? 'iPhone'
        : (/ipad/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) ? 'iPad'
        : /android/i.test(ua) ? 'Android' : /macintosh/i.test(ua) ? 'Mac'
        : /windows/i.test(ua) ? 'Windows' : /linux/i.test(ua) ? 'Linux' : 'Okänd enhet';
      const br = /crios/i.test(ua) ? 'Chrome' : /fxios|firefox/i.test(ua) ? 'Firefox'
        : /edgi?os|edg\//i.test(ua) ? 'Edge' : /chrome/i.test(ua) ? 'Chrome' : /safari/i.test(ua) ? 'Safari' : '';
      const iab = /FBAN|FBAV|FB_IAB|Instagram|Messenger|Line\/|TikTok|LinkedInApp/i.test(ua) ? ' (in-app)' : '';
      return os + (br ? ' · ' + br : '') + iab;
    }
    function collectMeta() {
      const s = _state;
      const SESS = { snorkel: 'Snorkling', dyk: 'Dyk', expedition: 'Expedition' };
      const REL = { oppen: 'Blandat', par: 'Par', familj: 'Familj', vanner: 'Nära vänner', nya: 'Nya bekanta', kollegor: 'Kollegor' };
      const SCREEN = { 'screen-home': 'Start', 'screen-lobby': 'Lobby', 'screen-game': 'I spelet', 'screen-summary': 'Avslut', 'screen-display': 'TV-skärm', 'screen-local': 'Runt bordet-uppsättning', 'screen-tv-entry': 'TV-entré' };
      const scr = document.querySelector('.screen.active');
      const m = { version: appVersion(), plats: platform(), var: SCREEN[scr && scr.id] || (scr && scr.id) || '' };
      m.lage = Net.role === 'local' ? 'Runt bordet' : displayMode ? 'Visa på TV'
        : Net.role === 'host' ? 'Nät · värd' : Net.role === 'client' ? 'Nät · deltagare' : 'Utanför dyk';
      if (s) {
        const players = s.players || [];
        const online = players.filter((p) => p.connected).length;
        if (players.length) m.spelare = String(players.length) + (online && online !== players.length ? ' (' + online + ' online)' : '');
        if (s.duet != null) m.traffas = s.duet ? 'På distans' : 'I samma rum';
        if (s.session) m.langd = SESS[s.session] || s.session;
        if (s.mode) m.relation = REL[s.mode] || s.mode;
        try { if (Journal.startLevel) m.startdjup = levelMeta(Journal.startLevel).name; } catch (_) {}
        try { if (s.levelId) m.djupNu = levelMeta(s.levelId).name; } catch (_) {}
        if (s.deepest != null && LEVELS[s.deepest]) m.djupast = LEVELS[s.deepest].name;
        if (s.summary && s.summary.cards != null) m.kortTotalt = s.summary.cards;
      }
      if (Journal.startedAt) m.minuter = Math.max(1, Math.round((Date.now() - Journal.startedAt) / 60000));
      if (Journal.cards.length) m.kortVisade = Journal.cards.slice(-40);
      return m;
    }

    function showForm() { form.hidden = false; done.hidden = true; sendBtn.disabled = false; sendBtn.textContent = 'Skicka'; }
    function reset() { rating = 0; paintDots(); $('fb-best').value = ''; $('fb-worse').value = ''; $('fb-change').value = ''; $('fb-name').value = ''; err.hidden = true; showForm(); }
    let lastFocus = null;
    const onKey = (e) => {
      if (e.key === 'Escape') { close(); return; }
      if (e.key !== 'Tab') return;
      // Fokus-fälla: Tab cyklar inuti dialogen, hoppar aldrig ut till bakgrunden.
      const f = Array.from(sheet.querySelectorAll('a[href],button:not([disabled]),textarea,input,[tabindex]:not([tabindex="-1"])')).filter((el) => el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    function open() {
      reset();
      lastFocus = document.activeElement;
      sheet.classList.add('open'); sheet.setAttribute('aria-hidden', 'false');
      // Fokusera panelen (inte ett textfält) → skärmläsare får kontext utan att mobilens
      // tangentbord slår upp innan man hunnit läsa frågorna.
      const panel = sheet.querySelector('.sheet-panel');
      if (panel) setTimeout(() => { try { panel.focus(); } catch (_) {} }, 40);
      document.addEventListener('keydown', onKey);
    }
    function close() {
      sheet.classList.remove('open'); sheet.setAttribute('aria-hidden', 'true');
      document.removeEventListener('keydown', onKey);
      if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (_) {} }
      lastFocus = null;
    }

    $('btn-fb-close').onclick = close;
    $('btn-fb-close2').onclick = close;
    sheet.addEventListener('click', (e) => { if (e.target.id === 'feedback') close(); });

    sendBtn.onclick = () => {
      const payload = {
        rating,
        best: $('fb-best').value.trim(), worse: $('fb-worse').value.trim(), change: $('fb-change').value.trim(),
        name: $('fb-name').value.trim(), meta: collectMeta(),
      };
      if (!payload.rating && !payload.best && !payload.worse && !payload.change && !payload.name) {
        err.textContent = 'Skriv något eller sätt ett betyg först.'; err.hidden = false; return;
      }
      err.hidden = true; sendBtn.disabled = true; sendBtn.textContent = 'Skickar …';
      Net.feedback(payload)
        .then(() => { form.hidden = true; done.hidden = false; const cb = $('btn-fb-close2'); if (cb) { try { cb.focus(); } catch (_) {} } })
        .catch(() => { sendBtn.disabled = false; sendBtn.textContent = 'Skicka'; err.textContent = 'Kunde inte skicka just nu. Kolla nätet och försök igen.'; err.hidden = false; try { err.focus(); } catch (_) {} });
    };

    const openBtn = $('btn-feedback-game'); if (openBtn) openBtn.onclick = () => { closeSheet(); open(); };
    const sumBtn = $('btn-feedback-summary'); if (sumBtn) sumBtn.onclick = open;
  })();

  // ---- Dela / kopiera ------------------------------------------------------
  function inviteUrl() { return location.origin + location.pathname + '?join=' + (Net.code || ''); }
  function copyCode() {
    const code = Net.code || '';
    if (navigator.clipboard) navigator.clipboard.writeText(code).then(() => toast('Kod kopierad: ' + code)).catch(() => toast('Kod: ' + code));
    else toast('Kod: ' + code);
  }
  function shareInvite() {
    const text = `Jag har startat ett Vitalisera djupdyk, ett samtalsspel där vi dyker djupare tillsammans. Öppna länken så är du med i mitt rum (kod ${Net.code}):`;
    const data = { title: 'Vitalisera djupdyk: gå med i mitt rum', text, url: inviteUrl() };
    if (navigator.share) navigator.share(data).catch(() => {});
    else if (navigator.clipboard) navigator.clipboard.writeText(inviteUrl()).then(() => toast('Inbjudningslänk kopierad. Dela den så går de med direkt.')).catch(() => toast('Länk: ' + inviteUrl()));
    else toast('Länk: ' + inviteUrl());
  }

  function leave() {
    Net.leave();
    Journal.reset();
    try { localStorage.removeItem('vd_last'); } catch (_) {}
    _state = null; lastCardKey = null; closeSheet(); stopSilence();
    toggleOverlay('ritual', false); toggleOverlay('pause', false);
    localPrevTurn = null; localStarted = false; $('handoff').hidden = true;
    netbar(null);
    showScreen('home');
    applyTheme(LEVELS[0].id);
  }

  // ---- Service worker ------------------------------------------------------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  // ---- Uppstart: ?join= eller återuppta session ----------------------------
  function boot() {
    applyTheme(LEVELS[0].id);
    const params = new URLSearchParams(location.search);
    // Utskriftsläge (öppnas i ny flik från iOS-PWA): visa bara manualen och printa.
    if (params.get('print') === 'manual') {
      showScreen('home');
      openManual();
      setTimeout(() => { try { window.print(); } catch (_) {} }, 450);
      return;
    }
    // Visa på TV: passiv display som följer ett rum (ingen styrning här).
    const showCode = (params.get('visa') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (showCode) { startDisplay(showCode); return; }

    // Smart-TV: klumpig webbläsare + gammal Chromium som renderar spelarvyn trasigt.
    // Styr TV:n direkt till "skriv en kod"-vägen (bli display) i stället för spelar-hemmet.
    // ?tv tvingar samma väg. tv-back leder tillbaka hem för den som ändå vill spela på TV:n.
    const ua = navigator.userAgent || '';
    const isTV = /webos|web0s|tizen|smart-?tv|smarttv|hbbtv|netcast|viera|bravia|aquos|googletv|android ?tv|crkey|nettv|philipstv|dlnadoc/i.test(ua);
    if (params.get('tv') !== null || isTV) {
      document.body.classList.add('tv-device');
      showScreen('tv-entry');
      const inp = $('tv-code-input'); if (inp) setTimeout(() => inp.focus(), 60);
      return;
    }

    const joinCode = (params.get('join') || '').toUpperCase();

    // Runt bordet: återuppta ett lokalt spel (ligger bara på den här enheten).
    const localState = Net.loadLocal && Net.loadLocal();
    if (localState && localState.phase && localState.phase !== 'lobby' && !joinCode) {
      localStarted = true; localPrevTurn = localState.turnId || null;
      Net.resumeLocal(localState);
      return;
    }

    const session = Net.loadSession && Net.loadSession();
    if (session && session.role && session.code && !joinCode) {
      nameInput.value = (session.me && session.me.name) || nameInput.value;
      netbar('<span class="spin"></span> Återansluter…');
      if (session.role === 'host') Net.host(session.me.name, { code: session.code, resumeState: session.state });
      else { Net.state = session.state || null; Net.join(session.code, session.me.name); }
      return;
    }

    if (joinCode) {
      codeInput.value = joinCode;
      history.replaceState({}, '', location.pathname);
      if (nameInput.value.trim()) { doJoin(joinCode); return; }
      showScreen('home'); toast('Skriv ditt namn och tryck Gå med'); nameInput.focus();
      maybeShowIntro();
      return;
    }
    showScreen('home');
    maybeShowIntro();
  }

  // ---- In-app-browser (Facebook/Instagram m.fl.): guida ut till riktig webbläsare ----
  // Delade länkar öppnas ofta i appens egen webbläsare, där PWA:n inte kan installeras
  // och en del funktioner strular. Vi kan inte tvinga ut länken, men vi upptäcker läget
  // och visar en banner: instruktion (⋯ → Öppna i webbläsare) + på Android en intent-knapp
  // som hoppar direkt till Chrome. Körs FÖRE boot() så ?join= finns kvar i intent-länken.
  // Hela blocket är try/catch:at: en in-app-browser-detektering får ALDRIG kunna sänka boot().
  (function inAppBrowser() {
    try {
      const banner = $('iab-banner');
      const textEl = $('iab-text');
      if (!banner || !textEl) return;
      const p = new URLSearchParams(location.search);
      if (p.get('visa') || p.get('tv') !== null || p.get('print')) return; // TV/visa/utskrift: inte relevant
      const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
        || window.navigator.standalone === true;
      if (standalone) return; // installerad PWA kan aldrig vara en in-app-browser
      let dismissed = false;
      try { dismissed = sessionStorage.getItem('vd_iab_dismissed') === '1'; } catch (_) {}
      if (dismissed) return;

      const ua = navigator.userAgent || '';
      // Ordning: Instagram/Messenger före Facebook (deras UA innehåller också FBAN-tokens).
      const apps = [
        { re: /Instagram/i, name: 'Instagram' },
        { re: /Messenger|MessengerForiOS|Orca/i, name: 'Messenger' },
        { re: /FBAN|FBAV|FB_IAB|FBIOS/i, name: 'Facebook' },
        { re: /\bLine\//i, name: 'Line' },
        { re: /Snapchat/i, name: 'Snapchat' },
        { re: /TikTok|musical_ly|BytedanceWebview/i, name: 'TikTok' },
        { re: /LinkedInApp/i, name: 'LinkedIn' },
        { re: /Twitter|TwitterAndroid/i, name: 'X' },
        { re: /MicroMessenger/i, name: 'WeChat' },
      ];
      const hit = apps.find((a) => a.re.test(ua));
      if (!hit) return; // vanlig webbläsare: ingen banner

      // Undvik possessiv (blir konstigt för Line/X m.fl.): "webbläsaren i <app>".
      const lead = '<b>Du är i den inbyggda webbläsaren i ' + hit.name + '.</b> ';
      const openBtn = $('iab-open');

      if (/android/i.test(ua) && openBtn) {
        // intent:// hoppar ut till Chrome, med fallback om Chrome saknas.
        // Escapa #, ; och % i URI-delen (host är redan validerad av URL) så att inget
        // användarstyrt i sökvägen/frågan kan tolkas som intent-syntax och byta paket/scheme.
        const u = new URL(location.href);
        const safe = (u.pathname + u.search).replace(/[#;%]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
        const fallback = encodeURIComponent(location.href);
        openBtn.href = 'intent://' + u.host + safe
          + '#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' + fallback + ';end';
        openBtn.hidden = false;
        textEl.innerHTML = lead + 'Öppna djupdyk i Chrome för att kunna installera appen och få full funktion.';
      } else {
        textEl.innerHTML = lead + 'Öppna i Safari för full funktion: tryck på <b>•••</b> och välj <b>Öppna i webbläsare</b>.';
      }

      const app = $('app');
      const close = $('iab-close');
      if (close) close.onclick = () => {
        banner.hidden = true;
        document.body.classList.remove('iab-open');
        if (app) app.style.paddingTop = '';
        try { sessionStorage.setItem('vd_iab_dismissed', '1'); } catch (_) {}
      };
      banner.hidden = false;
      document.body.classList.add('iab-open');
      // Dynamisk topp-padding: bannerns höjd varierar med radbrytning + safe-area (notch).
      if (app) app.style.paddingTop = banner.offsetHeight + 'px';
    } catch (_) { /* får aldrig blockera boot() */ }
  })();

  boot();
})();

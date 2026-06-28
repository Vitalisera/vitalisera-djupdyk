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
  // Nyp-zoom med två fingrar är kvar för tillgänglighet — vi stoppar bara det
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
    if (state.phase !== 'playing') { toggleOverlay('ritual', false); toggleOverlay('pause', false); stopSilence(); }
    if (state.phase === 'lobby') { lastLevelRendered = null; lastTurnId = null; renderLobby(state); showScreen('lobby'); }
    else if (state.phase === 'summary') { renderSummary(state); showScreen('summary'); }
    else { renderGame(state); showScreen('game'); }
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
    const isSpecial = isClosing || isReflection || isInkblot || isStrom || isSilence || isWhirl || isAscent || isQuote || isParable;
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
    if (s.card) {
      // Bläckbild: alla ser samma bild + gemensam fråga, plus en egen fråga
      $('card-blot').hidden = !isInkblot;
      if (isInkblot && window.Inkblot && window.DECK.inkblot) {
        const cfg = window.DECK.inkblot;
        $('blot-img').innerHTML = window.Inkblot.svg(s.card.seed, BLOT_COLOR);
        $('blot-shared').textContent = cfg.shared[s.card.sharedIdx % cfg.shared.length];
        const connected = (s.order || []).filter((id) => { const p = s.players.find((x) => x.id === id); return p && p.connected; });
        const myPos = Math.max(0, connected.indexOf(meId));
        const cat = cfg.categories[myPos % cfg.categories.length];
        const q = cat.qs[hashStr(s.card.seed + ':' + meId) % cat.qs.length];
        $('blot-cat').textContent = 'Din fråga · ' + cat.name;
        $('blot-q').textContent = q;
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
        : `${lvl.name} · ${lvl.depth}`;
      $('card-text').textContent = s.card.text;
      $('card-index').textContent = isAscent && s.ascent
        ? `Var och en i tur och ordning · ${Math.min(s.ascent.done, s.ascent.total)} av ${s.ascent.total}`
        : (isQuote || isParable) ? `— ${s.card.by || ''}`
        : isSpecial ? '' : `Fråga ${s.cardsRevealed}`;

      const fu = $('card-followup');
      if (s.card.followup) {
        fu.innerHTML = '<span class="fu-label">' + (isQuote ? 'Diskussion' : isParable ? 'Eftertanke' : isReflection ? 'Vad det kan betyda' : 'Följdfråga') + '</span>' + escapeHtml(s.card.followup);
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
    $('btn-followup').hidden = noFollowup;
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
      row.querySelectorAll('.strom-opt').forEach((b) => { b.onclick = () => Net.dispatch({ type: 'invitePartner', playerId: b.dataset.pid }); });
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
      if (n <= 0) { el.textContent = '✓'; stopSilence(); } else el.textContent = n;
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
      if (d) return f.myTurn ? 'Ni ser samma bild och har var sin egen fråga om den. Dela med varandra och skicka vidare när ni är klara.' : 'Ni ser samma bild. Din egen fråga står ovanför.';
      return f.myTurn ? 'Alla svarar på den gemensamma frågan, och var och en på sin egen. Skicka vidare när ni är klara.' : 'Alla svarar på bilden. Din egen fråga står ovanför.';
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
    const s = state(); if (!s || !s.card || !s.card.text) return;
    const txt = s.card.text;
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
  Net.on('state', (s) => { _state = s; render(s); });
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
  let droppedT = 0;
  Net.on('dropped', () => { const now = Date.now(); if (now - droppedT > 2500) { droppedT = now; toast('Inte ansluten just nu. Det du valde skickas så snart du är inne igen.'); } });

  // När fliken kommer tillbaka i förgrunden (mobil sömn, appbyte) eller nätet
  // kommer tillbaka: knuffa nätlagret att kontrollera och återansluta vid behov.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Net.poke) Net.poke(); });
  window.addEventListener('online', () => { if (Net.poke) Net.poke(); });

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
  $('btn-shell').onclick = saveShell;
  $('btn-buoy').onclick = () => { Net.dispatch({ type: 'buoy' }); };
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
    const isHost = Net.role === 'host';
    const canDrive = isHost || myTurn;
    $('sheet-levels').innerHTML = LEVELS.map((l) => levelCard(l, l.id === s.levelId, true)).join('');
    bindLevelButtons('sheet-levels', (id) => { Net.dispatch({ type: 'setLevel', levelId: id }); closeSheet(); });
    // Spelledar-bara (formar sessionen) vs turspelare/värd (driver kortet) vs alla.
    $('sheet-depth').hidden = !isHost;                 // byt djup = värd-bara
    $('btn-reflection').hidden = !canDrive;
    $('btn-quote').hidden = !canDrive;
    $('btn-parable').hidden = !canDrive;
    $('btn-inkblot').hidden = !canDrive;
    $('btn-strom').hidden = !canDrive || s.players.filter((p) => p.connected).length < 2; // kräver två
    $('btn-silence').hidden = !canDrive;
    $('btn-closing').hidden = !isHost;                 // avslutningskort = värd-bara
    $('btn-pass').hidden = false;                      // skicka vidare = vem som helst
    $('btn-pass-back').hidden = false;                 // ge tillbaka turen = vem som helst
    $('btn-finish').hidden = !isHost;                  // avsluta = värd-bara
    $('btn-restart').hidden = !isHost;
    $('sheet-note').hidden = canDrive;
    updateSoundLabel();
    $('game-invite-code').textContent = s.code;
    $('sheet').classList.add('open'); $('sheet').setAttribute('aria-hidden', 'false');
  }
  function closeSheet() { $('sheet').classList.remove('open'); $('sheet').setAttribute('aria-hidden', 'true'); }
  function updateSoundLabel() { $('btn-sound').textContent = Snd.muted ? '🔇 Ljud: av' : '🔊 Ljud: på'; }
  $('btn-close-sheet').onclick = closeSheet;
  $('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
  $('btn-reflection').onclick = () => { Net.dispatch({ type: 'reflection' }); closeSheet(); };
  $('btn-quote').onclick = () => { Net.dispatch({ type: 'quote' }); closeSheet(); };
  $('btn-parable').onclick = () => { Net.dispatch({ type: 'parable' }); closeSheet(); };
  $('btn-inkblot').onclick = () => { Net.dispatch({ type: 'inkblot' }); closeSheet(); };
  $('btn-strom').onclick = () => {
    const st = state();
    if (st && st.players.filter((p) => p.connected).length < 2) { closeSheet(); toast('Det här är för två. Bjud in en dykare till först.'); return; }
    Net.dispatch({ type: 'strom' }); closeSheet();
  };
  $('btn-silence').onclick = () => { Net.dispatch({ type: 'silence' }); closeSheet(); };
  $('btn-postcard').onclick = savePostcard;
  $('btn-closing').onclick = () => { Net.dispatch({ type: 'closing' }); closeSheet(); };
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
    try { localStorage.removeItem('vd_last'); } catch (_) {}
    _state = null; lastCardKey = null; closeSheet(); stopSilence();
    toggleOverlay('ritual', false); toggleOverlay('pause', false);
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
    const joinCode = (params.get('join') || '').toUpperCase();

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

  boot();
})();

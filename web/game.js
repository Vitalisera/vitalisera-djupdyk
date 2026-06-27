// Vitalisera djupdyk, spellogik (ren, deterministisk reducer).
// Körs hos värden (host) som äger den auktoritativa staten. Klienterna är tunna
// och renderar bara staten de får. Bygger på window.DECK från data/questions.js.

(function (global) {
  'use strict';

  const DECK = global.DECK || (typeof require !== 'undefined' ? require('./data/questions.js') : null);

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function levelById(id) {
    return DECK.levels.find((l) => l.id === id) || DECK.levels[0];
  }
  function levelIndexOf(id) {
    const i = DECK.levels.findIndex((l) => l.id === id);
    return i < 0 ? 0 : i;
  }

  // Strömmar gatas till Revet och nedåt. Varje kort har ett min-djup, och
  // sällskapsläget sätter ett tak för hur intima strömmar som bjuds in.
  const STROM_RANK = { revet: 2, djupvatten: 3, djuphavet: 4 };
  const MODE_CAP = {
    oppen: 'djuphavet', par: 'djuphavet', vanner: 'djuphavet',
    familj: 'djupvatten', nya: 'djupvatten', kollegor: 'revet',
  };
  // Ungefärligt antal kort innan spelet varsamt föreslår att stiga upp.
  const SESSION_TARGET = { snorkel: 12, dyk: 28, expedition: 64 };

  function connectedCount(state) {
    return state.players.filter((p) => p.connected).length;
  }
  function modeCap(state) { return MODE_CAP[state.mode] || 'djuphavet'; }

  // Spara nuvarande läge så att "Föregående" kan ångra ett kortbyte.
  function pushHistory(state) {
    state.history = state.history || [];
    state.history.push({
      card: state.card ? clone(state.card) : null,
      turnId: state.turnId,
      cardsRevealed: state.cardsRevealed,
      levelId: state.levelId,
    });
    if (state.history.length > 25) state.history.shift();
  }

  function publicLevels() {
    return DECK.levels.map((l) => ({
      id: l.id, name: l.name, depth: l.depth, color: l.color,
      subtitle: l.subtitle, intro: l.intro, count: l.cards.length,
    }));
  }

  function create(code, hostId) {
    return {
      v: 1,
      code,
      hostId,
      phase: 'lobby',           // 'lobby' | 'playing' | 'summary'
      levelId: DECK.levels[0].id,
      session: 'dyk',           // sessionsdjup: 'snorkel' | 'dyk' | 'expedition'
      mode: 'oppen',            // sällskapsläge, styr bland annat strömmarnas tak
      players: [],              // { id, name, connected, joinedAt }
      order: [],                // turordning (player-id)
      turnId: null,             // vems tur
      card: null,               // { text, levelId, source, followup }
      cardsRevealed: 0,
      queues: {},               // levelId -> { order:[idx], pos:int }
      history: [],              // för "Föregående", stack av tidigare kort/tur
      deepest: 0,               // djupaste nådda nivå-index (för sammanfattning)
      summary: null,            // { levelName, depth, cards, players } vid avslut
      ritual: false,            // Första andetaget: trygghetsritual vid start
      pause: null,              // Bojen: { at } när någon bett om en paus, anonymt
      ascent: null,             // Uppstigningen: { total, done } under avslutet
      duet: false,              // Duett på distans: ett läge byggt för två som är ifrån varandra
      levelsMeta: publicLevels(),
      lastAction: null,
    };
  }

  // ---- Spelarnärvaro (anropas av nätlagret) --------------------------------

  function addPlayer(state, player) {
    const existing = state.players.find((p) => p.id === player.id);
    if (existing) {
      existing.connected = true;
      if (player.name) existing.name = player.name;
    } else {
      state.players.push({
        id: player.id,
        name: player.name || 'Gäst',
        connected: true,
        joinedAt: Date.now(),
      });
      if (!state.order.includes(player.id)) state.order.push(player.id);
    }
    if (!state.hostId) state.hostId = player.id;
    if (state.phase === 'playing' && !state.turnId) state.turnId = firstConnected(state);
    return state;
  }

  function setConnected(state, playerId, connected) {
    const p = state.players.find((x) => x.id === playerId);
    if (p) p.connected = connected;
    if (!connected && state.turnId === playerId) advanceTurn(state);
    return state;
  }

  function firstConnected(state) {
    for (const id of state.order) {
      const p = state.players.find((x) => x.id === id);
      if (p && p.connected) return id;
    }
    return null;
  }

  function advanceTurn(state) {
    const live = state.order.filter((id) => {
      const p = state.players.find((x) => x.id === id);
      return p && p.connected;
    });
    if (live.length === 0) { state.turnId = null; return; }
    const i = live.indexOf(state.turnId);
    state.turnId = live[(i + 1) % live.length];
  }

  // Ge tillbaka turen till föregående spelare (ångrar en felaktig "skicka vidare").
  function regressTurn(state) {
    const live = state.order.filter((id) => {
      const p = state.players.find((x) => x.id === id);
      return p && p.connected;
    });
    if (live.length === 0) { state.turnId = null; return; }
    const i = live.indexOf(state.turnId);
    state.turnId = live[(i - 1 + live.length) % live.length];
  }

  // ---- Kortleksdragning -----------------------------------------------------

  function ensureQueue(state, levelId) {
    const lvl = levelById(levelId);
    let q = state.queues[levelId];
    if (!q || q.pos >= q.order.length) {
      q = { order: shuffle(lvl.cards.map((_, i) => i)), pos: 0 };
      state.queues[levelId] = q;
    }
    return q;
  }

  function drawCard(state) {
    const lvl = levelById(state.levelId);
    const q = ensureQueue(state, state.levelId);
    const idx = q.order[q.pos];
    q.pos += 1;
    const card = lvl.cards[idx];
    const text = typeof card === 'string' ? card : card.q;
    const followupText = typeof card === 'string' ? null : card.f;
    state.card = { text, followupText, levelId: lvl.id, source: 'deck', followup: null };
    state.cardsRevealed += 1;
  }

  // Speglingskort: en lekfull projektiv övning vars tolkning avslöjas efteråt.
  function drawReflection(state) {
    const list = DECK.reflections || [];
    if (!list.length) { drawCard(state); return; }
    const r = list[Math.floor(Math.random() * list.length)];
    state.card = { text: r.q, followupText: r.f, levelId: state.levelId, source: 'reflection', followup: null };
    state.cardsRevealed += 1;
  }

  // Diskussion: ett filosofiskt citat + författare, med en diskussionspunkt som
  // följdfråga. Korten är graderade per djup; vi drar ur aktuellt djups pool.
  function drawQuote(state) {
    const pool = (DECK.quotes && DECK.quotes[state.levelId]) || [];
    if (!pool.length) { drawCard(state); return; }
    const r = pool[Math.floor(Math.random() * pool.length)];
    state.card = { text: r.q, by: r.by, followupText: r.f, levelId: state.levelId, source: 'quote', followup: null };
    state.cardsRevealed += 1;
  }

  // Bläckbild: en symmetrisk bild som alla tolkar tillsammans. Fröet ger samma
  // bild på alla enheter; varje spelare räknar själv ut sin egen fråga.
  function drawInkblot(state) {
    const cfg = DECK.inkblot;
    if (!cfg) { drawCard(state); return; }
    state.card = {
      source: 'inkblot',
      seed: 1 + Math.floor(Math.random() * 1e9),
      sharedIdx: Math.floor(Math.random() * cfg.shared.length),
      text: '', followupText: null, levelId: state.levelId, followup: null,
    };
    state.cardsRevealed += 1;
  }

  // Strömmar: ett ömsesidighetskort där två personer paras ihop. Den vars tur
  // det är väljer själv sin partner i gränssnittet (partnerId fylls i efteråt).
  function drawStrom(state) {
    // Strömmar kräver minst två anslutna. Annars faller vi tillbaka på en
    // vanlig fråga, så att ingen fastnar med ett kort utan partner.
    if (connectedCount(state) < 2) { drawCard(state); return; }
    const li = levelIndexOf(state.levelId);
    const capRank = STROM_RANK[modeCap(state)];
    // I duetten finns ingen publik. Kort som vänder sig till "resten" eller
    // "rummet" passar bara när fler ser på, så de utesluts för två på distans.
    const audienceRe = /resten|i rummet|i sällskapet/i;
    const pool = (DECK.strommar || []).filter((c) => {
      const need = STROM_RANK[c.min] || 99;
      if (need > li || need > capRank) return false;
      if (state.duet && audienceRe.test(c.q)) return false;
      return true;
    });
    if (!pool.length) { drawCard(state); return; }
    const c = pool[Math.floor(Math.random() * pool.length)];
    state.card = {
      source: 'strom', text: c.q, min: c.min, levelId: state.levelId,
      chooserId: state.turnId, inviteId: null, partnerId: null, declined: [],
      followupText: null, followup: null,
    };
    // I duetten finns ingen att välja mellan: partnern är helt enkelt den andra.
    if (state.duet) {
      const others = state.players.filter((p) => p.connected && p.id !== state.turnId);
      if (others.length === 1) state.card.partnerId = others[0].id;
    }
    state.cardsRevealed += 1;
  }

  // Distansfråga (bara i duett-läget): en vanlig fråga som nuddar vid avståndet.
  function drawDuetCard(state) {
    const list = DECK.duetCards || [];
    if (!list.length) { drawCard(state); return; }
    const c = list[Math.floor(Math.random() * list.length)];
    state.card = { text: c.q, followupText: c.f, levelId: state.levelId, source: 'deck', followup: null };
    state.cardsRevealed += 1;
  }

  // Tystnad: en delad stunds tystnad. Klienten visar en lugn nedräkning.
  function drawSilence(state) {
    const list = DECK.silence || [];
    if (!list.length) { drawCard(state); return; }
    const c = list[Math.floor(Math.random() * list.length)];
    state.card = { source: 'silence', text: c.q, levelId: state.levelId, followupText: null, followup: null };
    state.cardsRevealed += 1;
  }


  // Uppstigningen: ett avslutningskort per spelare, i tur och ordning.
  function drawAscent(state) {
    const list = (state.duet && (DECK.ascentDuet || []).length) ? DECK.ascentDuet : (DECK.ascent || []);
    const n = ((state.ascent && state.ascent.done) || 1) - 1;
    const text = list.length ? list[n % list.length] : 'Säg en sak du tar med dig.';
    state.card = { source: 'ascent', text, levelId: state.levelId, followupText: null, followup: null };
  }

  function finishGame(state) {
    const lvl = DECK.levels[state.deepest || 0];
    state.summary = {
      levelName: lvl.name,
      depth: lvl.depth,
      cards: state.cardsRevealed,
      players: connectedCount(state),
    };
    state.phase = 'summary';
    state.card = null;
    state.ascent = null;
  }

  // Ibland bjuds ett specialkort in i stället för en vanlig fråga, men aldrig två
  // i rad, så att det känns som en oväntad krydda och inte ett stående inslag.
  function drawNext(state) {
    const prevSpecial = state.card && state.card.source !== 'deck';
    const li = levelIndexOf(state.levelId);
    const roll = Math.random();
    // Duett: strömmarna är hjärtat och får mer plats, inga virvlar (kräver tre),
    // och distansfrågor vävs in regelbundet.
    if (state.duet) {
      if (!prevSpecial) {
        if ((DECK.reflections || []).length && roll < 0.07) { drawReflection(state); return; }
        if (DECK.inkblot && roll < 0.12) { drawInkblot(state); return; }
        if ((DECK.strommar || []).length && li >= 2 && connectedCount(state) >= 2 && roll < 0.32) { drawStrom(state); return; }
        if ((DECK.silence || []).length && roll < 0.36) { drawSilence(state); return; }
      }
      if ((DECK.duetCards || []).length && Math.random() < 0.18) { drawDuetCard(state); return; }
      drawCard(state);
      return;
    }
    if (!prevSpecial) {
      if ((DECK.reflections || []).length && roll < 0.09) { drawReflection(state); return; }
      if (DECK.inkblot && roll < 0.15) { drawInkblot(state); return; }
      if ((DECK.strommar || []).length && li >= 2 && connectedCount(state) >= 2 && roll < 0.25) { drawStrom(state); return; }
      if ((DECK.silence || []).length && connectedCount(state) >= 2 && roll < 0.29) { drawSilence(state); return; }
      if (DECK.quotes && (DECK.quotes[state.levelId] || []).length && roll < 0.43) { drawQuote(state); return; }
    }
    drawCard(state);
  }

  // ---- Reducer --------------------------------------------------------------

  // Bara den vars tur det är (eller värden, som override) får styra spelets gång.
  function canControl(state, actorId) {
    return !!actorId && (actorId === state.turnId || actorId === state.hostId);
  }
  // Spelledar-bara: handlingar som formar hela sessionen (byt djup, avsluta, etc.).
  function isHost(state, actorId) {
    return !!actorId && actorId === state.hostId;
  }

  function apply(state, action, actorId) {
    state = clone(state);
    state.lastAction = { type: action.type, actorId, at: Date.now() };

    switch (action.type) {
      case 'start': {
        if (action.levelId) state.levelId = levelById(action.levelId).id;
        if (action.session) state.session = action.session;
        if (action.mode) state.mode = action.mode;
        state.duet = !!action.duet;
        if (state.duet) state.mode = 'par'; // duetten är alltid mellan två nära
        state.phase = 'playing';
        state.queues = {};
        state.cardsRevealed = 0;
        state.history = [];
        state.deepest = levelIndexOf(state.levelId);
        state.summary = null;
        state.ascent = null;
        state.pause = null;
        state.ritual = true;       // Första andetaget innan första frågan
        state.order = orderedConnected(state);
        state.turnId = firstConnected(state);
        drawCard(state);
        break;
      }
      case 'setSession': { if (state.phase !== 'playing') state.session = action.session; break; }
      case 'setMode': { if (state.phase !== 'playing') state.mode = action.mode; break; }
      // Första andetaget: vem som helst får släppa ritualen när alla är redo.
      case 'beginDive': { state.ritual = false; break; }
      // Bojen: en anonym paus-ventil. Vem som helst får be om en paus, och vem
      // som helst får simma vidare igen. Vi sparar aldrig vem som tryckte.
      case 'buoy': { if (state.phase === 'playing') state.pause = { at: Date.now() }; break; }
      case 'resume': { state.pause = null; break; }
      // Strömmar, steg 1: den som har turen (eller värden) bjuder in en partner.
      // Partnern är inte vald förrän hen själv tackat ja, så ingen paras ihop
      // mot sin vilja.
      case 'invitePartner': {
        if (!state.card || state.card.source !== 'strom') break;
        if (actorId !== state.card.chooserId && actorId !== state.hostId) break;
        const target = state.players.find((x) => x.id === action.playerId);
        if (target && target.connected && target.id !== state.card.chooserId) {
          state.card.inviteId = action.playerId;
          state.card.partnerId = null;
        }
        break;
      }
      // Steg 2a: den inbjudna tackar ja och paret är satt.
      case 'acceptPartner': {
        if (!state.card || state.card.source !== 'strom') break;
        if (actorId !== state.card.inviteId) break;
        state.card.partnerId = actorId;
        state.card.inviteId = null;
        break;
      }
      // Steg 2b: den inbjudna avstår. Inbjudan släpps och den som har turen
      // får bjuda in någon annan.
      case 'declinePartner': {
        if (!state.card || state.card.source !== 'strom') break;
        if (actorId !== state.card.inviteId) break;
        state.card.declined = state.card.declined || [];
        if (!state.card.declined.includes(actorId)) state.card.declined.push(actorId);
        state.card.inviteId = null;
        break;
      }
      case 'strom': {
        if (state.phase !== 'playing' || !canControl(state, actorId)) break;
        pushHistory(state);
        drawStrom(state);
        break;
      }
      case 'silence': {
        if (state.phase !== 'playing' || !canControl(state, actorId)) break;
        pushHistory(state);
        drawSilence(state);
        break;
      }
      case 'next': {
        if (state.phase !== 'playing' || !canControl(state, actorId)) break;
        if (state.ritual) break; // släpps med beginDive, inte med Skicka vidare
        if (state.ascent) {
          state.ascent.done += 1;
          if (state.ascent.done > state.ascent.total) { finishGame(state); break; }
          advanceTurn(state);
          drawAscent(state);
          break;
        }
        pushHistory(state);
        advanceTurn(state);
        drawNext(state);
        break;
      }
      case 'reflection': {
        if (state.phase !== 'playing' || !canControl(state, actorId)) break;
        pushHistory(state);
        drawReflection(state);
        break;
      }
      case 'inkblot': {
        if (state.phase !== 'playing' || !canControl(state, actorId)) break;
        pushHistory(state);
        drawInkblot(state);
        break;
      }
      case 'skip': {
        if (state.phase !== 'playing' || !canControl(state, actorId)) break;
        pushHistory(state);
        // Byt fråga ger ett nytt kort av SAMMA slag, samma tur. Står man på en
        // spegling vill man ha en ny spegling, inte plötsligt ett vanligt kort.
        const src = state.card && state.card.source;
        if (src === 'reflection') drawReflection(state);
        else if (src === 'inkblot') drawInkblot(state);
        else if (src === 'strom') drawStrom(state);
        else if (src === 'silence') drawSilence(state);
        else drawCard(state);
        break;
      }
      case 'back': {
        // Ångra senaste kortbyte, tillbaka till föregående fråga, tur och djup.
        if (state.phase !== 'playing' || !canControl(state, actorId)) break;
        if (!state.history || !state.history.length) break;
        const h = state.history.pop();
        state.card = h.card;
        state.turnId = h.turnId;
        state.cardsRevealed = h.cardsRevealed;
        state.levelId = h.levelId;
        break;
      }
      case 'followup': {
        if (!state.card || !canControl(state, actorId)) break;
        // Kortets egen, skräddarsydda följdfråga, faller tillbaka på poolen om kortet saknar en.
        const f = state.card.followupText || DECK.followups[Math.floor(Math.random() * DECK.followups.length)];
        state.card.followup = f;
        break;
      }
      case 'setLevel': {
        if (state.phase === 'playing' && !isHost(state, actorId)) break;
        if (state.phase === 'playing') pushHistory(state);
        state.levelId = levelById(action.levelId).id;
        state.deepest = Math.max(state.deepest || 0, levelIndexOf(state.levelId));
        if (state.phase === 'playing') drawCard(state);
        break;
      }
      case 'closing': {
        if (!isHost(state, actorId)) break;
        pushHistory(state);
        const pool = (state.duet && (DECK.closingDuet || []).length) ? DECK.closingDuet : DECK.closing;
        const c = pool[Math.floor(Math.random() * pool.length)];
        state.card = { text: c, followupText: null, levelId: state.levelId, source: 'closing', followup: null };
        state.cardsRevealed += 1;
        break;
      }
      case 'finish': {
        // Avsluta dyket. Med fler än en dykare inleds Uppstigningen, ett
        // avslutningsvarv där var och en får säga något innan ytan. Andra
        // gången (eller ensam) går vi direkt till sammanfattningen.
        if (state.phase !== 'playing' || !isHost(state, actorId)) break;
        if (state.ascent) { finishGame(state); break; }
        if (connectedCount(state) >= 2) {
          pushHistory(state);
          state.ascent = { total: connectedCount(state), done: 1 };
          state.turnId = firstConnected(state);
          drawAscent(state);
        } else {
          finishGame(state);
        }
        break;
      }
      // Skicka vidare: vem som helst får knuffa turen (säkerhetsventil om någon lämnat/är borta).
      case 'passTurn': {
        if (state.phase !== 'playing') break;
        advanceTurn(state);
        break;
      }
      // Ge tillbaka turen till föregående: vem som helst, ångrar en felaktig knuff.
      case 'turnBack': {
        if (state.phase !== 'playing') break;
        regressTurn(state);
        break;
      }
      case 'restart': {
        if (!isHost(state, actorId)) break;
        state.phase = 'lobby';
        state.card = null;
        state.queues = {};
        state.cardsRevealed = 0;
        state.history = [];
        state.summary = null;
        state.ritual = false;
        state.pause = null;
        state.ascent = null;
        break;
      }
      case 'rename': {
        const p = state.players.find((x) => x.id === actorId);
        if (p && action.name) p.name = String(action.name).slice(0, 24);
        break;
      }
      default:
        break;
    }
    return state;
  }

  function orderedConnected(state) {
    return state.order.filter((id) => {
      const p = state.players.find((x) => x.id === id);
      return p && p.connected;
    }).concat(state.order.filter((id) => {
      const p = state.players.find((x) => x.id === id);
      return p && !p.connected;
    }));
  }

  const Game = { create, apply, addPlayer, setConnected, levelById, publicLevels, DECK };
  if (typeof module !== 'undefined' && module.exports) module.exports = Game;
  if (typeof window !== 'undefined') window.Game = Game;
})(typeof window !== 'undefined' ? window : globalThis);

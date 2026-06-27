# CLAUDE.md — Vitalisera djupdyk

> **🟢 Aktuellt:** statisk webbapp, deployas till **`vitalisera-djupdyk.surge.sh`**. Repo: `Vitalisera/vitalisera-djupdyk` (publikt).

## Vem du är
**djupdyk-PROGRAMMERAREN**, jobbar DIREKT med Robert (han ÄR projektledaren — ingen separat ÖPL, inga
[PROPOSAL]/[BLOCKED], ingen loop, ingen tmux). Arbetssätt: skriv kod i `web/` → `node build-single.js` →
testa lokalt (`npm start`) → deploya till surge → verifiera live. Svensk text med å/ä/ö överallt.

## Vad det är
Ett **serverlöst flerspelar-samtalsspel**. Deltagarna sitter i samma rum men följer spelet var och en på sin
egen mobil; alla telefoner visar samma kort, turordning och spelgång i realtid. 150 originalfrågor i fem djup
(Ytan → Djuphavet), "dyk djupare"-följdfrågor, avslutningskort, installerbar PWA, offline-skal, inga konton.

## Arkitektur
- **Helt serverlöst, peer-to-peer via WebRTC (PeerJS).** Den som skapar dyket blir **värd** och äger den
  auktoritativa spelstaten (peer-id = rumskoden); övriga ansluter, skickar handlingar, får hela staten tillbaka.
  Tål tappad uppkoppling (auto-reconnect + återupptar plats vid omladdning). STUN/TURN → funkar över olika nätverk.
- **Ren statisk app i `web/`** (HTML/CSS/JS, inget byggsteg för utveckling):
  | Fil | Ansvar |
  |-----|--------|
  | `index.html` | skal |
  | `styles.css` | djuphavstema, glas, animationer |
  | `app.js` | gränssnitt + rendering |
  | `game.js` | ren auktoritativ spellogik (reducer) |
  | `net.js` / `net-ws.js` | P2P-lager (WebRTC/PeerJS) resp. WebSocket-relä |
  | `ocean.js` / `inkblot.js` | levande undervattensscen (canvas) |
  | `sw.js`, `manifest.webmanifest` | PWA (offline-skal + installera) |
  | `data/questions.js` | frågebanken (150 frågor, 5 djup) |
  | `vendor/peerjs.min.js` | PeerJS lokalt (inget CDN-beroende) |
- **`server.js`** — liten beroendefri Node-server BARA för lokal förhandsvisning (`npm start` → port 5173).
- **`server/`** — valfri Cloudflare Worker (WebSocket-relä, `wrangler.toml`). Spelet funkar utan den (ren P2P).
- **`build-single.js`** — bygger publiceringsversionen: bäddar in CSS + alla skript + loggan (data-URI) i en enda
  HTML, kopierar PWA-syskonfiler (manifest, sw.js, icons). Allt landar i **`dist/`** (`index.html` +
  `vitalisera-djupdyk.html` = samma fil; för mapp- resp. enfils-host). Beroendefritt (bara `fs`/`path`).

## Bygg & deploy
```bash
node build-single.js                                   # web/ → dist/
npm start                                              # lokal förhandsvisning (http://localhost:5173)
npx --yes surge ./dist vitalisera-djupdyk.surge.sh     # deploy (kräver surge-login, se nedan)
./deploy.sh                                            # bygger + deployar + verifierar
```
- **Surge-auth (en gång per dator):** Robert kör `npx surge login` i terminalen (mejl
  `robert.kraft@vitalisera.se`). Sedan behövs ingen token — auth sparas i `~/.netrc`/`~/.surge`.
- **Verifiera efter deploy:** `curl -s https://vitalisera-djupdyk.surge.sh/index.html | md5` ska matcha
  `md5 -q dist/index.html` (annars ligger en gammal version uppe — CDN kan släpa någon minut).

## Gotchas
- **Bygget speglar `web/`, INTE `dist/`.** Ändra alltid i `web/`, kör `build-single.js`, deploya `dist/`. Att
  redigera `dist/` direkt skrivs över vid nästa bygge.
- `build-single.js` matchar specifika markörer i `index.html` (`<!-- Spelets skript`, `<script src="app.js">`,
  `<link rel="stylesheet" href="styles.css" />`). Ändrar du dessa rader i `index.html` → uppdatera build-skriptet.
- Historik: projektet skapades via Claude web på branchen `claude/dialogdyk-multiplayer-game-n8rg4m` i privata
  `Vitalisera/reolink` och bröts ut hit 2026-06-27 (reolink har AWS-hemligheter, fick ej bli publikt).

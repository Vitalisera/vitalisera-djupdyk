# Vitalisera djupdyk

Ett samtalsspel där ni dyker allt djupare tillsammans — från **Ytan** till **Djuphavet**.
Ni sitter i samma rum men följer spelet var och en på sin **egen mobiltelefon**. Alla
telefoner visar exakt samma kort, vems tur det är och spelets gång i realtid.

> 150 originalformulerade frågor i fem djup · turordning · "dyk djupare"-följdfrågor ·
> avslutningskort · installerbar app (PWA) · fungerar offline-skal · helt utan konton.

## Spela

**På webben:** öppna [djupdyk.vitalisera.se](https://djupdyk.vitalisera.se), skriv ditt namn och tryck
**Skapa nytt dyk**. Dela den fyrteckens **rumskoden** (eller inbjudningslänken) med de andra
— de skriver in koden och är med direkt. Välj startdjup och tryck **Starta dyket**.

1. Den vars tur det är läser frågan högt och svarar först — sedan får alla prata.
2. **Nästa fråga** går vidare och skickar turen till nästa person.
3. **Dyk djupare** lägger till en följdfråga på samma kort.
4. **Byt** ger ett nytt kort utan att byta tur.
5. I menyn (⋯) kan ni byta djup mitt i, dra ett **avslutningskort**, skicka turen vidare
   eller gå tillbaka till lobbyn.

Lägg till appen på hemskärmen för helskärmsläge — den funkar som en app.

## Så fungerar tekniken

Spelet är **helt serverlöst**. Det är en statisk webbapp (ren HTML/CSS/JS, inget byggsteg)
som synkar telefonerna **peer-to-peer via WebRTC** (PeerJS):

- Den som skapar dyket blir **värd** och äger den auktoritativa spelstaten. Värdens enhet
  får ett peer-id av rumskoden; övriga telefoner ansluter dit, skickar sina handlingar och
  får hela staten tillbaka. Därför ser alla exakt samma sak.
- Tål tappad uppkoppling: telefoner återansluter automatiskt med backoff, och en telefon som
  laddas om **återupptar** sin plats i spelet (spelar-id och session sparas lokalt).
- Eftersom signaleringen går via internet kan ni även spela på **olika nätverk**, inte bara
  samma WiFi (STUN/TURN ingår för att ta sig genom brandväggar).

Inga konton, ingen databas, ingen molntjänst — bara statiska filer.

## Projektstruktur

```
djupdyk/
  web/                     ← den statiska appen (källkod)
    index.html
    styles.css             djuphavstema, glas, mjuka animationer
    app.js                 gränssnitt + rendering
    game.js                ren, auktoritativ spellogik (reducer)
    net.js                 peer-to-peer-lager (WebRTC/PeerJS)
    net-ws.js              alternativt nätlager: WebSocket mot realtidsservern
    ocean.js               levande undervattensscen på canvas (reagerar på djup)
    inkblot.js             bläckfisk-/bläckanimation
    sw.js                  service worker (app-skal offline)
    manifest.webmanifest   PWA-manifest
    data/questions.js      frågebanken (150 frågor i 5 djup)
    vendor/peerjs.min.js   PeerJS lokalt (inget körtidsberoende av CDN)
    icons/                 app-ikoner
  build-single.js          bygger web/ → dist/ (enfils + PWA-syskonfiler)
  dist/                    byggoutput som publiceras (skapas av build-single.js)
  server.js                liten beroendefri server för lokal förhandsvisning
  server/                  valfri Cloudflare Worker (realtidsrelä, behövs ej för ren P2P)
  deploy.sh                bygger + deployar + verifierar
  package.json
```

## Publicering (Cloudflare Pages)

Spelet ligger live på **[djupdyk.vitalisera.se](https://djupdyk.vitalisera.se)** — egen subdomän
med giltigt SSL. Hostas av **Cloudflare Pages**, kopplat till GitHub-repot
`Vitalisera/vitalisera-djupdyk`: varje **push till `main`** bygger om automatiskt och deployar.
Ingen manuell deploy behövs.

- Pages-projekt: `vitalisera-djupdyk` · build-kommando `node build-single.js` · output-mapp `dist`
- Råadress (utan subdomän): `vitalisera-djupdyk.pages.dev`
- DNS: subdomänen är en **CNAME** hos Loopia (`djupdyk` → `vitalisera-djupdyk.pages.dev`)

Den gamla adressen `vitalisera-djupdyk.surge.sh` vidarebefordrar till den nya (se `surge-redirect/`).
Alla sökvägar i appen är relativa, så den fungerar oförändrad på vilken statisk host som helst.

## Köra lokalt

Kräver bara Node (≥16), inga beroenden att installera:

```bash
cd djupdyk
npm start        # startar förhandsvisning på http://localhost:5173
```

## Lägga till eller ändra frågor

Redigera `web/data/questions.js`. Varje nivå har `id`, `name`, `depth`, `color`, `subtitle`,
`intro` och en lista `cards`. Spara — inget byggsteg behövs.

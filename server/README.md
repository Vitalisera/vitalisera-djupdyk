# Vitalisera djupdyk, realtidsserver

En Cloudflare Worker med ett Durable Object per rum. Objektet ligger alltid
uppe och äger spelets state genom att köra exakt samma reducer som klienten
(`../web/game.js`). Spelarna är tunna WebSocket-klienter (`../web/net-ws.js`).
Att en spelare byter app stör inte de andra: servern finns kvar.

## Driftsätt

```bash
cd dialogdyk/server
npm install
npx wrangler login        # öppnar webbläsaren, logga in på Cloudflare
npx wrangler deploy
```

Eller med en API-token (utan webbläsarinloggning):

```bash
CLOUDFLARE_API_TOKEN=<token> npx wrangler deploy
```

Efter deploy får du en adress, t.ex. `https://djupdyk-room.<konto>.workers.dev`.
Peka klienten dit genom att sätta `VD_WS_URL` (wss://...) vid bygget av
enfilsversionen, eller `window.VD_WS_URL` i sidan.

## Lokalt test (ingen Cloudflare-inloggning krävs)

```bash
npx wrangler dev --port 8787
```

## Kostnad

Ett Durable Object per aktivt rum, SQLite-backat (gratisnivå-vänligt). För ett
spel i den här skalan är kostnaden försumbar. Dubbelkolla aktuell prissättning
på cloudflare.com innan produktion.

# Publicera Vitalisera djupdyk på webben

Spelet är klart och testat. Det är en statisk webbapp, så det kan ligga på vilken
statisk webbhost som helst. Här är de enklaste vägarna.

> Obs: Den här `reolink`-koden är privat och innehåller hemligheter (AWS-nycklar m.m.)
> och får **inte** göras publik. Publicera därför spelet separat enligt nedan.

---

## Alternativ A — Eget publikt GitHub-repo (permanent adress, gratis) ← du valde detta

1. Skapa ett nytt **publikt** repo på github.com, t.ex. `vitalisera-djupdyk`.
2. Ladda upp **innehållet i mappen `dialogdyk/web/`** så att `index.html` hamnar i
   repots rot (i GitHubs webbgränssnitt: "Add file → Upload files", dra in alla filer
   och mappen `data/`, `vendor/`, `icons/`).
3. Gå till **Settings → Pages**. Under *Build and deployment*:
   - Source: **Deploy from a branch**
   - Branch: **main** / **/ (root)** → Save.
4. Efter ~1 minut ligger spelet på:
   **`https://vitalisera.github.io/vitalisera-djupdyk/`**

Klart. Dela adressen — alla öppnar den på sina telefoner, en skapar dyk och delar
rumskoden.

> Vill du hellre att jag pushar filerna åt dig? Skapa det tomma publika repot och ge
> mig åtkomst till det, så lägger jag upp allt med en gång.

---

## Alternativ B — Snabbast av allt (30 sek, ingen Git)

Filen `dialogdyk/dist/vitalisera-djupdyk.html` är **hela spelet i en enda fil**.

- Gå till **https://app.netlify.com/drop** och dra in filen `dist/index.html`
  (eller hela `dist/`-mappen). Du får direkt en publik adress.
- Eller lägg filen på valfri webbserver/host du redan har.

---

## Alternativ C — Aktivera Pages på detta repo (kräver betald plan)

Workflowen `.github/workflows/pages.yml` finns redan och publicerar `dialogdyk/web/`
automatiskt. Den kräver att GitHub Pages är aktiverat och att repot ligger på en plan
som tillåter Pages för privata repon (Pro/Team/Enterprise). Aktivera under
**Settings → Pages → Source: GitHub Actions**, så kör den vid nästa push.

---

## Bra att veta

- Allt går **peer-to-peer** i webbläsaren (WebRTC/PeerJS). Ingen server, ingen databas.
- Fungerar både i samma rum och mellan olika nätverk.
- Lägg till appen på hemskärmen för helskärmsläge (PWA) — gäller flerfilsversionen i `web/`.

# Djupdyk — komplett instruktionsvideo (ledstjärna: hela handboken, 10 avsnitt)

Mål: http://localhost:5173 (lokal förhandsvisning). Headed Playwright (headless:false, canvas blir annars blank), viewport 1280x720, deviceScaleFactor 2. Driv per SELEKTOR.
Språk: svenska. Ton: varm, lugn, inbjudande (handbokens röst). INGA tankstreck.
GOTCHA: intro-rutan "Så funkar det" öppnas vid första besök → stäng FÖRST med `#btn-intro-start`.
Uppställning för att nå alla specialkort: starta "Runt bordet" med 3 spelare (Sara, Astrid, Per), längd Dyk, läge "Nära vänner", startdjup Revet. Specialkort dras via menyn (`#btn-menu` → knapp) på begäran.

| # | Bild (capture-recept) | Speaker-rad (svenska) |
|---|------------------------|------------------------|
| 01 | Hemskärm `#screen-home` (stäng intro först) | Djupdyk är ett samtalsspel där ni dyker djupare tillsammans, ett kort i taget. |
| 02 | Hemskärm (håll kvar) | Det finns inga rätta svar, ingen tävling och ingen brådska. Du delar det du vill, och får alltid säga pass. |
| 03 | Hemskärm, de tre valen synliga | Ni kan spela var och en på sin egen mobil, eller tillsammans runt en enda telefon. |
| 04 | Hemskärm, koddelen (`#code-input`, `#btn-create`) | En av er skapar ett dyk och delar en fyrteckens kod eller en länk, så hamnar de andra direkt i samma rum. |
| 05 | `#btn-local` → setup `#screen-local` (fyll tre `.local-name`: Sara, Astrid, Per) | Runt bordet räcker det med en telefon. Skriv in vilka som är med. |
| 06 | Setup, längd-chips `#local-session-chips` | Välj hur lång stund ni har: en snorkling, ett dyk, eller en hel expedition. |
| 07 | Setup, läge-chips `#local-mode-chips` | Och vilka ni är för varandra, vilket varsamt finjusterar hur nära korten vågar föra er. |
| 08 | Setup, djup `#local-level-options` (välj Revet) | Välj sedan startdjup. Ni kan börja var ni vill och byta när som helst. |
| 09 | `#btn-local-start` → ev. ritual `#btn-begin-dive` → frågekort `#card`, "Din tur, läs frågan högt" | Den vars tur det är läser kortet högt och svarar först. Sedan pratar ni fritt, helt utan tidsgräns. |
| 10 | `#btn-followup` (följdfrågan framme) | Vill ni gå djupare fördjupar en följdfråga samma kort. |
| 11 | Kontrollraden (`#btn-skip` "Byt fråga" synlig) | Byt fråga ger ett nytt kort med turen kvar, och en knapp tar er tillbaka till föregående. |
| 12 | `#btn-menu` → `#sheet-levels` (de fem djupen) | Spelet har fem djup, från ytans uppvärmning ner till djuphavets stillhet. Spelledaren kan byta djup när som helst. |
| 13 | `#btn-quote` → diskussionskort (citat) | Då och då dyker ett annat slags kort upp. Ett citat att samtala kring. |
| 14 | `#btn-menu` → `#btn-parable` → visdomsberättelse | En liten visdomsberättelse, med en eftertanke att bära med sig. |
| 15 | `#btn-menu` → `#btn-reflection` → spegling | En spegling, där du målar upp en inre scen och anar vad den kan säga om dig. |
| 16 | `#btn-menu` → `#btn-inkblot` → bläckbild | En bläckbild som var och en tolkar tyst, och sedan delar ni vad ni såg. |
| 17 | `#btn-menu` → `#btn-strom` → välj partner (`#strom-pick-row .strom-opt`) → parat kort | Para ihop två, där två av er får ett kort bara för er, medan de andra håller utrymmet. |
| 18 | `#btn-menu` → `#btn-silence` → tystnadskort | Eller en kort stund tillsammans, helt utan ord. |
| 19 | `#btn-next` → överlämning `#handoff` | Runt bordet räcker ni vidare, och telefonen lämnas lugnt till nästa. |
| 20 | `#btn-handoff-show` → spel, sedan `#btn-buoy` (bojen) | Behöver någon en paus räcker det att hissa bojen, helt anonymt. Vem som helst kan simma vidare igen. |
| 21 | `#btn-menu` → `#btn-closing` (avslutningskort) eller `#btn-finish` → uppstigning | När stunden känns fullbordad rundar ni av, och var och en får säga något innan ni stiger upp. |
| 22 | Hemskärm / site-länk (eller avslutningskort) | Djupdyk är skapat av Vitalisera. Dyk djupare på djupdyk.vitalisera.se. |

Röst: behåll George (premade, varm berättarröst), voice_id `JBFqnCBsd6RMkjVDRZzb`.
Montage: bygg i ETT ffmpeg-pass med concat-FILTRET (inte demuxern) så ljudet blir en kontinuerlig ström utan AAC-priming-glapp. apad whole_dur per bild (1 s paus), mjuka fades, 1920x1080, aac 48 kHz stereo.

---

# V3 (2026-07-05) — uppdatering mot nya UI:t + nya funktioner

## v3.0 NU (återanvänd ALLT befintligt ljud — replikerna är fortfarande sanna):
Omspela ENDAST klipp vars UI ändrats. Övriga klipp (01-11, 19-22) behålls som de är.
| # | NYTT capture-recept (ersätter gamla) | Ljud |
|---|---|---|
| 12 | Djupbyte sker nu via TOPBAREN: tryck `#depth-meter` (knappen uppe till vänster) → `#depthpick` öppnas med de fem djupen (`#depthpick-levels`). Välj Djupvatten, se nedsänknings-effekten. Spotlight på #depth-meter först, sedan väljaren. | audio/12.mp3 OFÖRÄNDRAT (nämner ej menyn) |
| 13 | Menyn är nu HAMBURGER `#btn-menu` (☰) med grupperad layout: "Krydda samtalet" = ikon-rutnät `.sheet-grid` med `.sheet-card`-knappar. Öppna ☰ → tryck `#btn-quote` → diskussionskort. | audio/13.mp3 |
| 14 | ☰ → `#btn-parable` → visdomsberättelse | audio/14.mp3 |
| 15 | ☰ → `#btn-reflection` → spegling | audio/15.mp3 |
| 16 | PULSMEKANIKEN (nätflöde visas via state-injektion, se recept nedan): bild tonar fram ur oskärpa → ordfas (`#blot-words` med input + "2 av 3 har låst in") → samtidig avtäckning med ord-chips (`#blot-all-words`). | audio/16.mp3 ("tolkar tyst, sedan delar ni" = fortfarande sant) |
| 17 | ☰ → `#btn-strom` → välj partner | audio/17.mp3 |
| 18 | ☰ → `#btn-silence` → tystnad | audio/18.mp3 |

RECEPT state-injektion för 16 (Runt bordet kör klassiskt flöde, nätflödet fejkas transportfritt —
samma teknik som UI-E2E): i sidan kör
  const G=window.Game; let st=G.create('TEST','h1');
  G.addPlayer(st,{id:'h1',name:'Sara'}); G.addPlayer(st,{id:'p2',name:'Astrid'}); G.addPlayer(st,{id:'p3',name:'Per'});
  st=G.apply(st,{type:'start',levelId:'revet',session:'dyk',mode:'vanner',duet:false},'h1');
  st=G.apply(st,{type:'beginDive'},'h1'); st=G.apply(st,{type:'inkblot'},'h1');
  window.Net.role='client'; window.Net.code='TEST'; window.Net.me={id:'h1',name:'Sara'};
  window.Net.handlers.state(st);                  // ordfas: filma bild+input ~4s
  st=G.apply(st,{type:'inkblotWord',text:'en fladdermus'},'h1'); window.Net.handlers.state(st);  // "1 av 3"
  st=G.apply(st,{type:'inkblotWord',text:'två dansare'},'p2'); window.Net.handlers.state(st);    // "2 av 3"
  st=G.apply(st,{type:'inkblotWord',text:'ett gammalt träd'},'p3'); window.Net.handlers.state(st); // AVTÄCKT
OBS: gör detta i EGEN sida/flik (inte mitt i Runt bordet-inspelningen) — Net.role/me skrivs över.

## v3.1 VÄNTELISTA (kräver ELEVENLABS_API_KEY — Robert: railway login eller export):
Nya repliker (George `JBFqnCBsd6RMkjVDRZzb`, samma ton), nya klipp:
| # | Bild | Ny speaker-rad |
|---|---|---|
| 09B (ersätter 09-ljudet) | befintligt 09-klipp | Den vars tur det är läser kortet högt och svarar först. Sedan är ordet fritt: alla får svara och flika in. Ett samtal, ingen förhörsrunda. |
| 16B (ersätter 16-ljudet) | v3.0:s nya 16-klipp | En bläckbild tonar fram, och var och en låser i smyg in vad den ser. När alla är klara avtäcks orden samtidigt, och skillnaderna blir samtalet. |
| 23 (NYTT, efter 19) | TV-panelen (☰ → 📺 Visa på TV → kod-panelen) + display-vyn (?visa-state-injektion) med QR | Vill ni se korten stort på en TV eller dator? Ett tryck ger er en kod, och skärmen följer dyket medan telefonerna styr. Den som kommer sent skannar bara QR-koden. |
| 24 (NYTT, efter 20/bojen) | ☰ → 🔒 Lås dyket (Spelledaren-gruppen) + toast | Och när samtalet är som skörast kan värden låsa dyket, så att inga nya ansluter mitt i. |

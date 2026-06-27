#!/bin/bash
# Launcher för Vitalisera djupdyk-projektet. Enkel, ingen tmux/loop/ÖPL.
# Dubbelklicka → öppnar Claude Code i projektmappen med en startprompt som läser CLAUDE.md.
cd "$(dirname "$0")"

PROMPT="Du är djupdyk-PROGRAMMERAREN och jobbar DIREKT med Robert (han är projektledaren — ingen separat ÖPL-agent, inga [PROPOSAL]/[BLOCKED], ingen loop, ingen tmux). Arbetssätt: skriv kod i web/ → kör 'node build-single.js' → testa lokalt ('npm start') → deploya till surge → verifiera live. Svensk text med å/ä/ö överallt.

LÄS FÖRST, i ordning: (1) CLAUDE.md i denna mapp (vad projektet är, arkitektur, bygg/deploy, gotchas), (2) README.md (spelregler + teknik). Spelet ligger live på https://vitalisera-djupdyk.surge.sh. Ändra ALLTID i web/ (aldrig dist/ direkt — det är byggoutput). Fråga Robert om nästa steg, eller fortsätt på det ni senast pratade om."

exec claude --dangerously-skip-permissions --chrome "$PROMPT"

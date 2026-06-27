#!/bin/bash
# Bygger djupdyk + deployar dist/ till surge + verifierar att rätt version ligger uppe.
# Kräver att surge är inloggat (engångs: `npx surge login`, mejl robert.kraft@vitalisera.se).
set -e
cd "$(dirname "$0")"

echo "→ Bygger (web/ → dist/)…"
node build-single.js

echo "→ Deployar till vitalisera-djupdyk.surge.sh…"
npx --yes surge ./dist vitalisera-djupdyk.surge.sh

echo "→ Verifierar live mot bygget…"
LOCAL=$(md5 -q dist/index.html)
sleep 3
LIVE=$(curl -s "https://vitalisera-djupdyk.surge.sh/index.html?cb=$RANDOM" | md5 -q)
echo "  lokal: $LOCAL"
echo "  live:  $LIVE"
if [ "$LOCAL" = "$LIVE" ]; then
  echo "✅ Rätt version ligger uppe."
else
  echo "⚠️ Live matchar inte bygget än (CDN kan släpa någon minut — kör om verifieringen)."
fi

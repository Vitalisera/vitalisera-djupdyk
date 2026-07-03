// Bygger Vitalisera djupdyk för publicering.
// CSS och alla skript bäddas in i index.html så att själva appen är en enda fil.
// Manifest, service worker och ikoner kopieras med som syskonfiler så att appen
// blir en installerbar PWA (ikon på hemskärmen, offline-skal). Allt landar i dist/.

const fs = require('fs');
const path = require('path');

const web = path.join(__dirname, 'web');
const read = (p) => fs.readFileSync(path.join(web, p), 'utf8');

// Bygg-version (UTC-tidsstämpel). Stämplas in i sw.js cache-namn (→ ny service worker
// vid varje deploy, slut på cache-staleness) och visas i appens meny så att man kan
// bekräfta vilken version som faktiskt laddats. Ändras varje bygge.
const _bd = new Date();
const _p = (n) => String(n).padStart(2, '0');
const buildVer = `${_bd.getUTCFullYear()}-${_p(_bd.getUTCMonth() + 1)}-${_p(_bd.getUTCDate())} ${_p(_bd.getUTCHours())}:${_p(_bd.getUTCMinutes())}`;

const css = read('styles.css');
// Bädda in Vitalisera-loggan (PNG) som data-URI. För att inte dubblera den stora
// strängen läggs den i en CSS-variabel som alla url(icons/vitalisera-logo.png) pekar mot.
const logo = fs.readFileSync(path.join(web, 'icons/vitalisera-logo.png'));
const logoDataUri = 'data:image/png;base64,' + logo.toString('base64');
let cssInlined = (':root{--logo-img:url("' + logoDataUri + '")}\n' + css)
  .split('url(icons/vitalisera-logo.png)').join('var(--logo-img)');
// Bädda in display-fonterna (woff2) som data-URI så bygget blir självförsörjande (offline, inget CDN).
for (const font of ['fraunces-400.woff2', 'fraunces-600.woff2']) {
  const fontDataUri = 'data:font/woff2;base64,' + fs.readFileSync(path.join(web, 'fonts', font)).toString('base64');
  cssInlined = cssInlined.split('url(fonts/' + font + ')').join('url("' + fontDataUri + '")');
}
// Bädda in topbar-ikonen (SVG) som data-URI så den inte beror på en separat filhämtning
// (undviker service-worker-/cache-strul; samma mönster som loggan och fonterna).
const iconSvgUri = 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(web, 'icons/icon.svg')).toString('base64');
cssInlined = cssInlined.split('url(icons/icon.svg)').join('url("' + iconSvgUri + '")');
// Bädda in topbar-loggans mark (riktiga Vitalisera-symbolen, beskuren utan ordmärke) som data-URI.
const markUri = 'data:image/png;base64,' + fs.readFileSync(path.join(web, 'icons/vitalisera-mark.png')).toString('base64');
cssInlined = cssInlined.split('url(icons/vitalisera-mark.png)').join('url("' + markUri + '")');

const scripts = ['data/questions.js', 'game.js', 'net-ws.js', 'ocean.js', 'inkblot.js', 'vendor/qr.js', 'app.js']
  .map((f) => `<script>\n${read(f)}\n</script>`)
  .join('\n');

let html = read('index.html');

// Bädda in stilmallen. Manifest, ikoner och apple-touch-icon lämnas orörda och
// pekar på syskonfilerna vi kopierar nedan, så att PWA-installation fungerar.
html = html.replace('<link rel="stylesheet" href="styles.css" />', `<style>\n${cssInlined}\n</style>`);

// Ersätt hela skript-blocket (från skript-kommentaren till app.js) med inbäddade skript.
const startMarker = '  <!-- Spelets skript';
const endMarker = '<script src="app.js"></script>';
const startIdx = html.indexOf(startMarker);
const endIdx = html.indexOf(endMarker) + endMarker.length;
html = html.slice(0, startIdx) + scripts + html.slice(endIdx);

// Stämpla in bygg-versionen (visas i menyn).
html = html.split('__BUILD__').join(buildVer);

const outDir = path.join(__dirname, 'dist');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, 'icons'), { recursive: true });

const outFile = path.join(outDir, 'vitalisera-djupdyk.html');
fs.writeFileSync(outFile, html);
fs.writeFileSync(path.join(outDir, 'index.html'), html); // samma fil, för mappbaserade hostar

// PWA-syskonfiler.
fs.copyFileSync(path.join(web, 'manifest.webmanifest'), path.join(outDir, 'manifest.webmanifest'));
fs.writeFileSync(path.join(outDir, 'sw.js'), read('sw.js').split('__BUILD__').join(buildVer));
for (const icon of ['icon-192.png', 'icon-512.png', 'maskable-512.png', 'apple-touch-icon.png', 'icon.svg']) {
  fs.copyFileSync(path.join(web, 'icons', icon), path.join(outDir, 'icons', icon));
}

// Instruktionsfilmen + poster kopieras som syskonfiler (bäddas EJ in, ~7 MB skulle
// spränga enfilsbygget). Manualerna länkar till media/*.mp4 relativt.
const mediaDir = path.join(web, 'media');
if (fs.existsSync(mediaDir)) {
  fs.mkdirSync(path.join(outDir, 'media'), { recursive: true });
  for (const f of fs.readdirSync(mediaDir)) {
    fs.copyFileSync(path.join(mediaDir, f), path.join(outDir, 'media', f));
  }
}

console.log('Skrev', outFile, '(' + Math.round(html.length / 1024) + ' kB) · version ' + buildVer + ' + dist/index.html + PWA-filer (manifest, sw.js, icons/, media/)');

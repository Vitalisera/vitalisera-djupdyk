// Bygger Vitalisera djupdyk för publicering.
// CSS och alla skript bäddas in i index.html så att själva appen är en enda fil.
// Manifest, service worker och ikoner kopieras med som syskonfiler så att appen
// blir en installerbar PWA (ikon på hemskärmen, offline-skal). Allt landar i dist/.

const fs = require('fs');
const path = require('path');

const web = path.join(__dirname, 'web');
const read = (p) => fs.readFileSync(path.join(web, p), 'utf8');

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

const scripts = ['data/questions.js', 'game.js', 'net-ws.js', 'ocean.js', 'inkblot.js', 'app.js']
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

const outDir = path.join(__dirname, 'dist');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, 'icons'), { recursive: true });

const outFile = path.join(outDir, 'vitalisera-djupdyk.html');
fs.writeFileSync(outFile, html);
fs.writeFileSync(path.join(outDir, 'index.html'), html); // samma fil, för mappbaserade hostar

// PWA-syskonfiler.
fs.copyFileSync(path.join(web, 'manifest.webmanifest'), path.join(outDir, 'manifest.webmanifest'));
fs.copyFileSync(path.join(web, 'sw.js'), path.join(outDir, 'sw.js'));
for (const icon of ['icon-192.png', 'icon-512.png', 'maskable-512.png', 'apple-touch-icon.png', 'icon.svg']) {
  fs.copyFileSync(path.join(web, 'icons', icon), path.join(outDir, 'icons', icon));
}

console.log('Skrev', outFile, '(' + Math.round(html.length / 1024) + ' kB) + dist/index.html + PWA-filer (manifest, sw.js, icons/)');

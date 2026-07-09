// Renderar delningsbilden (Open Graph) för djupdyk: 1200x630 djuphavs-card.
// Dev-verktyg (körs sällan). Kräver: npm i -D playwright && npx playwright install chromium
// (playwright hålls UTANFÖR package.json med flit — dess postinstall laddar ~300 MB
//  webbläsare och skulle sakta ner Cloudflare Pages-bygget.)
// Kör: node demo/make-og.js  →  web/media/og-image.jpg
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const logoB64 = fs.readFileSync(path.join(root, 'web/icons/vitalisera-logo-white.png')).toString('base64');

const html = `<!doctype html><html lang="sv"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500&family=Fraunces:ital,opsz,wght@1,9..144,400&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:1200px; height:630px; }
  body {
    position:relative; overflow:hidden;
    font-family:'Fraunces',Georgia,serif;
    background:
      radial-gradient(120% 90% at 28% -10%, #12586b 0%, rgba(18,88,107,0) 55%),
      radial-gradient(90% 120% at 90% 120%, #0a3a48 0%, rgba(10,58,72,0) 60%),
      linear-gradient(160deg, #0c4453 0%, #06222c 55%, #03151b 100%);
  }
  /* mjuk ljusstråle uppifrån */
  .rays { position:absolute; inset:0;
    background:radial-gradient(60% 80% at 50% -20%, rgba(150,220,235,.14), rgba(150,220,235,0) 60%); }
  /* vinjett */
  .vig { position:absolute; inset:0;
    box-shadow: inset 0 0 220px 40px rgba(0,0,0,.45); }
  /* svaga bubblor */
  .b { position:absolute; border-radius:50%;
    background:radial-gradient(circle at 35% 35%, rgba(200,235,242,.5), rgba(200,235,242,.06) 60%, transparent 70%);
    box-shadow:0 0 18px rgba(180,225,235,.15); }
  .b1{ width:16px;height:16px; left:150px; top:470px; }
  .b2{ width:9px;height:9px; left:250px; top:520px; }
  .b3{ width:22px;height:22px; left:930px; top:120px; opacity:.7; }
  .b4{ width:7px;height:7px; left:1010px; top:210px; }
  .b5{ width:12px;height:12px; left:1080px; top:470px; opacity:.8; }

  .wrap { position:absolute; inset:0; display:flex; align-items:center; gap:64px; padding:0 92px; }
  .logo { width:400px; height:400px; flex:0 0 auto;
    /* teal-loggan → ren vit, alfa bevaras */
    filter:brightness(0) invert(1) drop-shadow(0 6px 30px rgba(0,0,0,.35));
    background:url('data:image/png;base64,${logoB64}') center/contain no-repeat; }
  .col { display:flex; flex-direction:column; justify-content:center; }
  h1 { font-size:132px; line-height:.92; font-weight:300; color:#fbfeff;
    letter-spacing:-.01em; text-shadow:0 4px 40px rgba(0,0,0,.35); }
  .rule { width:78px; height:3px; margin:40px 0 26px 6px; border-radius:2px;
    background:linear-gradient(90deg,#5fd0e0,#2f8fa0); }
  .tag { font-size:33px; font-style:italic; font-weight:400; color:#d7edf1;
    line-height:1.32; max-width:560px; padding-left:6px; }
  .url { margin-top:30px; padding-left:6px; font-size:22px; letter-spacing:.26em;
    text-transform:uppercase; color:#79b0bc; font-weight:500;
    font-family:Georgia,serif; }
</style></head>
<body>
  <div class="rays"></div>
  <div class="b b1"></div><div class="b b2"></div><div class="b b3"></div>
  <div class="b b4"></div><div class="b b5"></div>
  <div class="wrap">
    <div class="logo"></div>
    <div class="col">
      <h1>djupdyk</h1>
      <div class="rule"></div>
      <div class="tag">Dyk djupare i samtalet, var och en på sin telefon.</div>
      <div class="url">djupdyk.vitalisera.se</div>
    </div>
  </div>
  <div class="vig"></div>
</body></html>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const out = path.join(root, 'web/media/og-image.jpg');
  await page.screenshot({ path: out, type: 'jpeg', quality: 92 });
  await browser.close();
  console.log('Skrev', out);
})();

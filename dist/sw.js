// Vitalisera djupdyk, service worker.
// Den driftsatta appen är en enda fil (allt inbäddat i index.html), så vi cachar
// skalet plus ikoner och manifest. Då startar appen direkt och fungerar offline.
// Realtidsspelet kräver förstås internet (WebSocket mot servern).
const CACHE = 'vd-2026-07-11 19:32';  // 2026-07-11 19:32 stämplas av build-single.js → ny SW vid varje deploy
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Navigeringar: nätet först så nya versioner alltid hämtas, med cachen som
// reserv när man är offline. Övriga filer: cache först.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // servern/WebSocket går direkt till nätet
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put('./index.html', copy));
        return res;
      }).catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }
  e.respondWith(caches.match(req).then((r) => r || fetch(req)));
});

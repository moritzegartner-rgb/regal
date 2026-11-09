// Service Worker: App funktioniert auch ohne Netz, Cover werden zwischengespeichert
const VERSION = 'regal-v22';
const COVERS = 'regal-covers';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './css/jewel.css',
  './js/app.js',
  './js/db.js',
  './js/util.js',
  './js/gemini.js',
  './js/musicbrainz.js',
  './js/spotify.js',
  './js/jewel.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' – sonst landet evtl. eine alte Datei aus dem Browser-Zwischenspeicher im neuen Paket
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== COVERS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Eigene Dateien: zuerst aus dem Netz (damit Updates ankommen), sonst aus dem Speicher
  if (url.origin === self.location.origin) {
    e.respondWith(
      // no-cache: beim Server nachfragen, ob sich die Datei geändert hat (sonst passen neue und alte Dateien nicht zusammen)
      fetch(req, { cache: 'no-cache' })
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./index.html'))),
    );
    return;
  }

  // Cover und Poster: einmal laden, dann aus dem Speicher
  if (/(^|\.)coverartarchive\.org$|(^|\.)archive\.org$|^i\.scdn\.co$/.test(url.hostname)) {
    e.respondWith(
      caches.open(COVERS).then(async (c) => {
        const hit = await c.match(req.url);
        if (hit) return hit;
        try {
          const res = await fetch(req.url, { mode: 'cors' });
          if (res.ok) c.put(req.url, res.clone());
          return res;
        } catch {
          // Bildserver ohne CORS (z. B. Logos): trotzdem zwischenspeichern
          const res = await fetch(req);
          if (res.ok || res.type === 'opaque') c.put(req.url, res.clone());
          return res;
        }
      }),
    );
  }
});

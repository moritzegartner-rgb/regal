// Service Worker: App funktioniert auch ohne Netz, Cover werden zwischengespeichert
const VERSION = 'regal-v5';
const COVERS = 'regal-covers';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/util.js',
  './js/gemini.js',
  './js/musicbrainz.js',
  './js/tmdb.js',
  './js/video.js',
  './js/wikidata.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
      fetch(req)
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
  if (/(^|\.)coverartarchive\.org$|(^|\.)archive\.org$|^image\.tmdb\.org$|^(upload|thumb)\.wikimedia\.org$/.test(url.hostname)) {
    e.respondWith(
      caches.open(COVERS).then(async (c) => {
        const hit = await c.match(req.url);
        if (hit) return hit;
        try {
          const res = await fetch(req.url, { mode: 'cors' });
          if (res.ok) c.put(req.url, res.clone());
          return res;
        } catch {
          return fetch(req);
        }
      }),
    );
  }
});

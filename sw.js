// Minimaler Service Worker: App-Shell cachen (OCR/Senden brauchen Internet)
const CACHE = 'paletten-v1';
const SHELL = ['./index.html', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // API-Aufrufe nie cachen
  if (url.hostname.includes('anthropic.com')) return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).catch(() =>
      e.request.mode === 'navigate' ? caches.match('./index.html') : undefined
    ))
  );
});

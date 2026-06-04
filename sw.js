// LLV Resell Toolkit — minimal service worker
// Satisfies PWA install requirements. No offline caching (added later if needed).

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => e.respondWith(fetch(e.request)));

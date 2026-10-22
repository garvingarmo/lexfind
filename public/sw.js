// Service worker: makes the site installable as an app. Pages are personal (sign-in, members-only
// content), so nothing is cached except a small "you're offline" page shown when there's no connection.
const CACHE = 'offline-v3';
const OFFLINE = ['/offline.html', '/css/style.css', '/icons/icon-192.png?v=2'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(OFFLINE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return; // everything else goes straight to the network
  event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')));
});

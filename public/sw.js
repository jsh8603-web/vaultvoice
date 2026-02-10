// VaultVoice Service Worker v2
const CACHE_NAME = 'vaultvoice-v2';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Install: pre-cache static assets
self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE_NAME; })
            .map(function (k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

// Fetch strategy
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);

  // API calls: network-first, offline fallback to 503
  if (url.pathname.startsWith('/api')) {
    e.respondWith(
      fetch(e.request).catch(function () {
        return new Response(
          JSON.stringify({ error: 'Offline — 네트워크 연결을 확인하세요' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  // Static assets: cache-first
  e.respondWith(
    caches.match(e.request).then(function (cached) {
      if (cached) return cached;
      return fetch(e.request).then(function (response) {
        // Cache successful GET responses for same-origin
        if (response.ok && e.request.method === 'GET' && url.origin === self.location.origin) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(e.request, clone);
          });
        }
        return response;
      });
    })
  );
});

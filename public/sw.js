// VaultVoice Service Worker v2
const CACHE_NAME = 'vaultvoice-v2.3';
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
    // iOS Safari bug: POST body is lost when intercepted by Service Worker
    // Only intercept GET requests; let POST/PUT/DELETE pass through natively
    if (e.request.method !== 'GET') {
      return;
    }
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

  // Static assets: network-first with cache fallback
  // Ensures updates are picked up quickly while still working offline
  e.respondWith(
    fetch(e.request).then(function (response) {
      if (response.ok && e.request.method === 'GET' && url.origin === self.location.origin) {
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function (cache) {
          cache.put(e.request, clone);
        });
      }
      return response;
    }).catch(function () {
      return caches.match(e.request);
    })
  );
});

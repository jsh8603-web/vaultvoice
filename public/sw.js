// VaultVoice Service Worker v3
const CACHE_VERSION = 'v3.2';
const CACHE_NAME = 'vaultvoice-' + CACHE_VERSION;
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app.css',
  '/app.js',
  '/offline-db.js',
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

// Activate: delete ALL old caches whose name differs from CACHE_NAME
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

// Push notification handler (iOS — title+body+icon only)
self.addEventListener('push', function (e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(
    self.registration.showNotification(data.title || 'VaultVoice', {
      body: data.body || '',
      icon: '/icons/icon-192.png'
    })
  );
});

// Background Sync: replay offline queue
self.addEventListener('sync', function (e) {
  if (e.tag === 'sync-vaultvoice-queue') {
    e.waitUntil(
      self.clients.matchAll().then(function (clients) {
        clients.forEach(function (c) { c.postMessage({ type: 'PROCESS_QUEUE' }); });
      })
    );
  }
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url && list[i].focus) return list[i].focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});

// Fetch strategy
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);

  // API calls: network-first, cache fallback for GET, 503 for others
  if (url.pathname.startsWith('/api')) {
    if (e.request.method !== 'GET') return; // let POST/PUT/DELETE pass natively (iOS body bug)
    e.respondWith(
      fetch(e.request).then(function (response) {
        // Cache successful GET API responses for offline fallback
        if (response.ok) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(e.request, clone); });
        }
        return response;
      }).catch(function () {
        return caches.match(e.request).then(function (cached) {
          return cached || new Response(
            JSON.stringify({ error: 'Offline — 네트워크 연결을 확인하세요' }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          );
        });
      })
    );
    return;
  }

  // Static assets: pure cache-first (no background network on cache hit)
  e.respondWith(
    caches.match(e.request).then(function (cached) {
      if (cached) return cached; // cache hit → skip network
      return fetch(e.request).then(function (response) {
        if (response.ok && e.request.method === 'GET' && url.origin === self.location.origin) {
          caches.open(CACHE_NAME).then(function (cache) { cache.put(e.request, response.clone()); });
        }
        return response;
      });
    })
  );
});

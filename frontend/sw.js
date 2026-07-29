const CACHE_NAME = 'qforge-v1';
const ASSETS = [
  './index.html',
  './dashboard.html',
  './admin.html',
  './exam.html',
  './results.html',
  './question-gen.html',
  './css/style.css',
  './js/api.js',
  './js/login.js',
  './js/dashboard.js',
  './js/admin.js',
  './js/exam.js',
  './js/results.js',
  './manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('/api/')) return; // Don't cache API calls
  e.respondWith(
    caches.match(e.request).then((response) => {
      return response || fetch(e.request);
    })
  );
});

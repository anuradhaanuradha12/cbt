const CACHE_NAME = 'qforge-v28';
const ASSETS = [
  '/',
  '/dashboard',
  '/admin',
  '/exam',
  '/results',
  '/question-gen',
  './css/style.css',
  './js/alerts.js',
  './js/api.js',
  './js/login.js',
  './js/dashboard.js',
  './js/admin.js',
  './js/exam.js',
  './js/results.js',
  './manifest.json'
];

// API routes are served from root paths by the Worker (e.g. /auth/login,
// /questions, /exams) — they must never be served from cache.
const API_PREFIXES = [
  '/auth',
  '/users',
  '/questions',
  '/exams',
  '/attempts',
  '/submissions',
  '/analytics',
  '/images',
  '/forge',
  '/health'
];

const IS_DEV = ['localhost', '127.0.0.1', '::1'].includes(self.location.hostname);

if (IS_DEV) {
  // ── Local dev guard ────────────────────────────────────────────────────────
  // The dev server is stopped and restarted constantly. A cache-first worker
  // turns a stopped server into a hard ERR_FAILED for every navigation and
  // keeps serving stale HTML/JS after a restart, so on localhost we unregister
  // entirely instead of caching.
  //
  // Note: deliberately no forced reload here. The pages re-register sw.js on
  // every load, so navigating clients would re-run install → activate → reload
  // forever.
  self.addEventListener('install', () => self.skipWaiting());

  self.addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        await self.registration.unregister();
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      })()
    );
  });
} else {
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
    const req = e.request;

    // Only same-origin GETs are cacheable; let everything else hit the network.
    if (req.method !== 'GET') return;

    let url;
    try {
      url = new URL(req.url);
    } catch {
      return;
    }
    if (url.origin !== self.location.origin) return;
    if (API_PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(p + '/'))) return;

    // Network-first: always prefer the live server, fall back to cache offline.
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) => cached || caches.match('/'))
        )
    );
  });
}

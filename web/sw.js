/* translatasm service worker: offline shell + auto-update */
const CACHE_VERSION = 'translatasm-v0.5.3';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const ASSET_CACHE = `${CACHE_VERSION}-assets`;

const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/css/app.css',
  '/js/main.js',
  '/js/pwa.js',
  '/js/ui/app.js',
  '/js/ui/urlstate.js',
  '/js/ui/files.js',
  '/js/detect/langdetect.js',
  '/js/engine/registry.js',
  '/js/engine/types.js',
  '/js/engine/bergamot.js',
  '/js/engine/bergamot-firefox.js',
  '/js/engine/incremental.js',
  '/js/engine/pairs.js',
  '/js/engine/align.js',
  '/js/engine/segment.js',
  '/js/dict/registry.js',
  '/js/dict/packs.js',
  '/js/dict/lookup.js',
  '/js/dict/vocab.js',
  '/js/dict/glossary.js',
  '/js/dict/drawer.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/fonts/bricolage-700.woff2',
  '/fonts/plex-latin-400.woff2',
  '/fonts/plex-latin-600.woff2',
  '/fonts/plex-cyrillic-400.woff2',
  '/fonts/plex-cyrillic-600.woff2',
  '/fonts/plex-greek-400.woff2',
  '/fonts/plex-greek-600.woff2',
  '/icons/favicon.ico',
  '/vendor/bergamot/translator.js',
  '/vendor/bergamot/worker/translator-worker.js',
  '/models/registry.json',
  '/catalog.json',
  '/dicts/registry.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await cache.addAll(PRECACHE);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith('translatasm-') && !key.startsWith(CACHE_VERSION))
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'GET_VERSION') {
    event.source && event.source.postMessage({ type: 'SW_VERSION', version: CACHE_VERSION });
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') {
    return;
  }

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname === '/sw.js') {
    event.respondWith(networkOnly(req));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(req, SHELL_CACHE));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, SHELL_CACHE, '/index.html'));
    return;
  }

  if (
    url.pathname.startsWith('/models/') ||
    url.pathname.startsWith('/dicts/') ||
    url.pathname.startsWith('/vendor/') ||
    url.pathname.startsWith('/fonts/') ||
    url.pathname.startsWith('/icons/')
  ) {
    event.respondWith(cacheFirst(req, ASSET_CACHE));
    return;
  }

  event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
});

async function networkOnly(req) {
  return fetch(req);
}

async function networkFirst(req, cacheName, fallbackPath) {
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      const cache = await caches.open(cacheName);
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(req);
    if (cached) {
      return cached;
    }
    if (fallbackPath) {
      const fallback = await cache.match(fallbackPath);
      if (fallback) {
        return fallback;
      }
    }
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) {
    return cached;
  }
  const fresh = await fetch(req);
  if (fresh && fresh.ok) {
    cache.put(req, fresh.clone());
  }
  return fresh;
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((fresh) => {
      if (fresh && fresh.ok) {
        cache.put(req, fresh.clone());
      }
      return fresh;
    })
    .catch(() => cached);
  return cached || network;
}

/* Loci demo — service worker.
   Cache-first app shell. Bump CACHE_VERSION whenever any shell file changes. */
const CACHE_VERSION = 'v6';
const CACHE_NAME = 'loci-shell-' + CACHE_VERSION;

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './data.js',
  './live-data.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Coming+Soon&display=swap';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // cache:'reload' bypasses the HTTP cache, so a version bump can never precache the old build
    await cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
    // Fonts are best-effort: the shell must still install if Google Fonts is unreachable.
    try {
      const res = await fetch(FONT_CSS, { mode: 'cors', cache: 'reload' });
      if (res.ok) {
        await cache.put(FONT_CSS, res.clone());
        const css = await res.text();
        const urls = [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com[^)]+)\)/g)].map(m => m[1]);
        await Promise.all(urls.map(async (u) => {
          try { const r = await fetch(u, { mode: 'cors' }); if (r.ok) await cache.put(u, r); } catch (_) {}
        }));
      }
    } catch (_) {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('loci-shell-') && k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !isFont) return;

  // Captures and the parent-app API are live backend data, not app shell.
  // Audio comes back as a byte-range 206, which the Cache API refuses to store, and a cached
  // 200 answering a later range request breaks seeking in Safari. A cached /api/parent/<id>
  // would also defeat live-data.js's whole point by freezing the feed at its first load.
  // So these never go through the cache at all — plain network, browser-handled.
  if (sameOrigin && (url.pathname.startsWith('/uploads/') || url.pathname.startsWith('/api/'))) return;

  // data.js is the demo's content file: an edit must show on the very next reload,
  // so it is network-first and only falls back to the cache when offline.
  const contentFirst = sameOrigin && url.pathname.endsWith('/data.js');

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    const fromNetwork = async () => {
      // Fetch fonts as CORS so the status is inspectable: an opaque error page must never be cached.
      const res = isFont ? await fetch(new Request(req.url, { mode: 'cors' })) : await fetch(req);
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    };

    // Single-page app: every navigation is the same document, whatever the hash.
    if (req.mode === 'navigate') {
      const shell = (await cache.match('./index.html', { ignoreSearch: true })) || (await cache.match('./'));
      if (shell) return shell;
      return fetch(req);
    }

    if (contentFirst) {
      try { return await fromNetwork(); } catch (err) {
        const cached = await cache.match(req, { ignoreSearch: true });
        if (cached) return cached;
        throw err;
      }
    }

    // Everything else is cache-first and makes no network request once installed:
    // bump CACHE_VERSION to ship a new app.js / styles.css / index.html.
    const cached = await cache.match(req, { ignoreSearch: sameOrigin });
    if (cached) return cached;
    return fromNetwork();
  })());
});

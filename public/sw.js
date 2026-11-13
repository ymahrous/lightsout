// Service worker: keeps the app's files on the device so it opens instantly from the home
// screen and one-phone games work with no connection. Online games still need the server.
//
// The server replaces __VERSION__ with a hash of every file listed below, so a deploy that
// changes any of them produces a new cache, and the old one is deleted once it takes over.
const VERSION = '__VERSION__';
const CACHE = 'lom-' + VERSION;
const SHELL = [
  '/', '/styles.css', '/manifest.webmanifest', '/favicon.svg',
  '/js/app.js', '/js/scene.js', '/js/sound.js', '/js/net.js', '/js/install.js', '/shared/engine.js',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
  '/vendor/three/three.module.js', '/vendor/three/three.core.js',
  '/vendor/fonts/bodoni-moda.woff2', '/vendor/fonts/bodoni-moda-italic.woff2', '/vendor/fonts/manrope.woff2',
  '/vendor/fonts/dm-mono-400.woff2', '/vendor/fonts/dm-mono-500.woff2'
];
const LIVE = new Set(['/ws', '/healthz', '/readyz', '/metrics']);

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('lom-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// The page asks for this only when no game is in progress.
self.addEventListener('message', e => { if (e.data === 'skip') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || LIVE.has(url.pathname)) return;
  if (req.mode === 'navigate') {
    // Every page is the same app. Serve the cached one at once; it works offline and never waits on the network.
    e.respondWith(caches.match('/').then(hit => hit || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req)));
});

/* Offline shell for the trip app. tools/build_pwa.py fills the build id and the asset list.
   data.json / files.json and the weather go past the worker: boot.js keeps them in IndexedDB and localStorage. */
const CACHE_NAME = 'china-trip-shell-bb60824049';
const SHELL_ASSETS = ["./", "./index.html", "./boot.js", "./boot.css", "./manifest.json", "./icon-192.png", "./icon-512.png", "./fonts/fonts.css", "./fonts/GolosText-465785f8.woff2", "./fonts/GolosText-83cb19f9.woff2", "./fonts/JetBrainsMono-028edbf5.woff2", "./fonts/JetBrainsMono-0a7197f9.woff2", "./fonts/NotoSerif-928e6acd.woff2", "./fonts/NotoSerif-e22bf423.woff2"];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME)
    .then(cache => cache.addAll(SHELL_ASSETS.map(u => new Request(u, {cache: 'reload'})))));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || /\/(data|files)\.json$/.test(url.pathname)) return;
  // cache first: the app opens instantly in a plane or the metro; a new build replaces the cache on the next start
  if (req.mode === 'navigate') {
    event.respondWith(caches.match('./index.html').then(c => c || fetch(req)));
    return;
  }
  event.respondWith(caches.match(req, {ignoreSearch: true}).then(c => c || fetch(req)));
});

const STATIC = 'shikuang-static-2.0.0-preview.3';
const MODELS = 'shikuang-models-v2-20261010';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './core.js', './inference.js', './storage.js', './engine-worker.js', './media.js', './history.js', './model-manifest.json', './icon-192.png', './icon-512.png', './icon-maskable.png', './version.json', './data/sources.js', './config.js', './icon.svg', './manifest.webmanifest', './data/classes.js', './data/minerals.js', './data/imagenet.js', './vendor/lucide.min.js', './vendor/ort.min.js', './vendor/ort-wasm-simd-threaded.mjs'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(STATIC).then(async cache => { await cache.addAll(ASSETS); await self.skipWaiting(); }));
});
self.addEventListener('message', event => { if(event.data?.type==='ACTIVATE_UPDATE')self.skipWaiting(); });
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(names => Promise.all(names.filter(name => name.startsWith('shikuang-') && ![STATIC, MODELS].includes(name)).map(name => caches.delete(name)))));
  self.clients.claim();
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url), scope = new URL(self.registration.scope);
  if (event.request.method !== 'GET' || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const isModel = url.pathname.includes('/models/') || url.pathname.endsWith('.wasm');
  event.respondWith((async () => {
    const cache = await caches.open(isModel ? MODELS : STATIC);
    const cached = await cache.match(event.request, {ignoreSearch:true});
    if (cached) return cached;
    try {
      const response = await fetch(event.request);
      if (response.ok) event.waitUntil(cache.put(event.request, response.clone()).catch(() => {}));
      return response;
    } catch (error) {
      if (event.request.mode === 'navigate') return await caches.match(new URL('./index.html', scope).href) || Response.error();
      return Response.error();
    }
  })());
});

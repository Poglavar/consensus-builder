const VERSION = 'groundwork-shell-v1';
const SHELL = ['./', 'styles.css', 'app.mjs', 'model.mjs', 'storage.mjs', 'viewer.mjs', 'strings.mjs', 'manifest.webmanifest', 'icon.svg'];
const scope = new URL(self.registration.scope).pathname;
const shellCache = `${VERSION}:${scope}`;
const imageCache = `groundwork-images:${scope}`;
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(shellCache);
  await cache.addAll(SHELL.map(path => new URL(path, self.registration.scope).href));
  await self.skipWaiting();
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('groundwork-shell-') && key.endsWith(`:${scope}`) && key !== shellCache) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(scope)) return;
  const path = url.pathname.slice(scope.length);
  if (path.startsWith('api/') || path === 'health') return;
  if (path.startsWith('images/')) {
    event.respondWith((async () => (await (await caches.open(imageCache)).match(event.request)) || fetch(event.request))());
  } else if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(async () => (await caches.open(shellCache)).match(new URL('./', self.registration.scope).href)));
  } else if (SHELL.includes(path)) {
    event.respondWith(fetch(event.request).catch(async () => (await caches.open(shellCache)).match(event.request)));
  }
});

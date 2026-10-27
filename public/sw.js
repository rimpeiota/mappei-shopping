const CACHE = 'shopping-shell-v2';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('shopping-shell-') && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const req = event.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || /signin|signout|callback/.test(url.pathname)) return;
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && new URL(res.url).pathname === '/') (await caches.open(CACHE)).put('/', res.clone());
        return res;
      } catch {
        return (await caches.match('/')) || new Response('オフラインです。接続後にもう一度開いてください。', {status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
      }
    })());
  } else if (/\.(js|css|svg|woff2?)$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok) (await caches.open(CACHE)).put(req,res.clone());
      return res;
    })());
  }
});

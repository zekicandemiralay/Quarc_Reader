// Quarc Reader service worker.
//  - Page loads (navigations): network first, so a deploy shows up on the
//    next open instead of the one after; the cached shell when offline.
//  - Built assets (/assets/*, content-hashed): cache first, they never change.
//  - Everything else from this origin: stale-while-revalidate.
//  - API calls are never cached (the library lives in IndexedDB for offline use).
//  - The share target (manifest `share_target`): a PDF shared to the installed app arrives as a POST to
//    /share-target; it is kept in the INCOMING cache and the app (lib/openWith.js) picks it up from there.
// v2: /assets/ is cached for good, and a response a misconfigured server had sent with the wrong type (pdf.js' worker as a
// generic download) would have stayed broken; a new name drops every old cache when this worker takes over.
const CACHE_NAME = 'quarc-reader-v2';
const INCOMING = 'quarc-reader-incoming';

async function receiveShared(request) {
  try {
    const form = await request.formData();
    const cache = await caches.open(INCOMING);
    let n = 0;
    for (const file of form.getAll('pdf')) {
      if (typeof file === 'string') continue;
      const headers = { 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent(file.name || 'document.pdf') };
      await cache.put(new Request(`/shared-file/${Date.now()}-${n++}`), new Response(file, { headers }));
    }
  } catch {
    // Nothing usable arrived: the app opens anyway.
  }
  return Response.redirect('/?shared=1', 303);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(['/', '/index.html', '/logo.png', '/manifest.json']).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME && k !== INCOMING).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method === 'POST' && url.origin === self.location.origin && url.pathname === '/share-target') {
    event.respondWith(receiveShared(request));
    return;
  }
  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      // 'no-cache': ask the server whether index.html changed instead of trusting the browser's own HTTP cache (which would
      // keep serving the old build after a deploy until a hard reload); the server answers 304 when it did not.
      fetch(request, { cache: 'no-cache' })
        .then((response) => {
          if (response.ok) caches.open(CACHE_NAME).then((c) => c.put('/index.html', response.clone()));
          return response;
        })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok) caches.open(CACHE_NAME).then((c) => c.put(request, response.clone()));
            return response;
          })
      )
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

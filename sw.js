// Cache names include scope: sibling releases cannot evict each other.
const PREFIX = "qr27:" + self.registration.scope + ":";
const CACHE = PREFIX + "2.7.1";
const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./style.css",
  "./jsQR.js",
  "./pako.min.js",
  "./manifest.json",
  "./decoder.worker.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "../shared/protocol.js",
  "../shared/capacity.js",
  "../shared/transfer.js",
  "../shared/theme.css",
];
const URLS = new Set(
  ASSETS.map((path) => new URL(path, self.location.href).href),
);
self.addEventListener("install", (event) =>
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS))),
);
// Let a running receiver finish on its current version; update on the next visit.
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith(PREFIX) && name !== CACHE)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || !URLS.has(event.request.url)) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    }),
  );
});

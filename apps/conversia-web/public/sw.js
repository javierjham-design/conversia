/* Service Worker de Conversia — PWA instalable (A9).
 * ARMAZÓN y estáticos en caché; la API vive en otro dominio (NEXT_PUBLIC_API_URL) y NUNCA
 * se cachea (datos siempre frescos). Página offline decente. Sin skipWaiting automático.
 */
const CACHE = "conversia-shell-v1";
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).catch(() => undefined));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

function isStatic(url) {
  return url.pathname.startsWith("/_next/static") || url.pathname === "/icon.svg" || url.pathname === "/manifest.webmanifest";
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Solo gestionamos el propio origen (la API es otro dominio → red directa).
  if (url.origin !== self.location.origin) return;

  // NAVEGACIÓN: red primero, cae a caché, y por último a la página offline.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE);
          cache.put(req, fresh.clone()).catch(() => undefined);
          return fresh;
        } catch (_) {
          return (await caches.match(req)) || (await caches.match(OFFLINE_URL)) || Response.error();
        }
      })(),
    );
    return;
  }

  // ESTÁTICOS del armazón: cache-first con refresco en segundo plano.
  if (isStatic(url)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        const network = fetch(req)
          .then((res) => {
            caches.open(CACHE).then((c) => c.put(req, res.clone())).catch(() => undefined);
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })(),
    );
  }
});

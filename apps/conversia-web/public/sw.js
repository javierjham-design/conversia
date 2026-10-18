/* Service Worker de Conversia — PWA instalable (A9).
 * ARMAZÓN y estáticos en caché; la API vive en otro dominio (NEXT_PUBLIC_API_URL) y NUNCA
 * se cachea (datos siempre frescos). Página offline decente. Sin skipWaiting automático.
 */
const CACHE = "conversia-shell-v2";
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/icon.svg", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];
const STATIC_FILES = new Set(["/icon.svg", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png"]);

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

// ---- Web Push (M2) ----
// El payload lo arma el worker (canal web_push): {title, body, link, tag, eventKey}.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { title: "Conversia", body: event.data ? event.data.text() : "" };
  }
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    data: { link: data.link || "/conversaciones", eventKey: data.eventKey || null },
  };
  event.waitUntil(self.registration.showNotification(data.title || "Conversia", options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "/conversaciones";
  event.waitUntil(
    (async () => {
      const clientsArr = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Ventana abierta: enfocarla y AVISARLE a dónde ir por mensaje (en iOS client.navigate
      // no funciona; por eso la app navega sola al recibir el mensaje "navigate").
      for (const client of clientsArr) {
        try {
          if (new URL(client.url).origin !== self.location.origin) continue;
        } catch (_) {
          continue;
        }
        try {
          client.postMessage({ type: "navigate", link });
        } catch (_) {
          /* noop */
        }
        try {
          await client.focus();
        } catch (_) {
          /* noop */
        }
        client.navigate?.(link);
        return;
      }
      if (self.clients.openWindow) await self.clients.openWindow(link);
    })(),
  );
});

function isStatic(url) {
  return url.pathname.startsWith("/_next/static") || STATIC_FILES.has(url.pathname);
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

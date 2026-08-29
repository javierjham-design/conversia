/* Service Worker de TuBot — PWA + Web Push.
 * Principio: ARMAZÓN y estáticos en caché; DATOS SIEMPRE FRESCOS desde la red
 * (nunca se cachea /backend). Página offline decente. Actualización avisada, sin
 * romper lo que el usuario esté haciendo (no hace skipWaiting automático).
 */
const CACHE = "tubot-shell-v2";
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/brand/tubot-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).catch(() => undefined));
  // NO skipWaiting: la versión nueva espera y el cliente avisa "actualización disponible".
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

// El cliente pide activar la versión nueva (tras avisar al usuario).
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

function isStatic(url) {
  return url.pathname.startsWith("/_next/static") || url.pathname.startsWith("/brand/") || url.pathname === "/manifest.webmanifest";
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // DATOS: nunca cachear el API — siempre red (una bandeja vieja es peor que nada).
  if (url.pathname.startsWith("/backend")) return;

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
  if (url.origin === self.location.origin && isStatic(url)) {
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

// ---- Web Push ----
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { title: "TuBot", body: event.data ? event.data.text() : "" };
  }
  const options = {
    body: data.body || "",
    icon: "/brand/tubot-icon.png",
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    data: { link: data.link || "/inbox", eventKey: data.eventKey || null },
  };
  event.waitUntil(self.registration.showNotification(data.title || "TuBot", options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "/inbox";
  event.waitUntil(
    (async () => {
      const clientsArr = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Ventana de la app ya abierta: enfocarla y AVISARLE a dónde ir por mensaje.
      // (En iOS Safari client.navigate() NO funciona; por eso la app navega sola al recibir el mensaje.)
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
        client.navigate?.(link); // en Chrome ayuda; en iOS lo cubre el postMessage
        return;
      }
      // No hay ventana abierta: abrir una nueva directo en el link.
      if (self.clients.openWindow) await self.clients.openWindow(link);
    })(),
  );
});

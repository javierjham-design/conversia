/* Service Worker de TuBot.
 * Bloque 3: Web Push (recibir y abrir). El caché de armazón/offline y el aviso de
 * actualización se agregan en el bloque PWA (block 4). Mantener este archivo apto
 * para ambas responsabilidades.
 */

self.addEventListener("install", () => {
  // Activa de inmediato la versión nueva (el aviso de update se maneja en block 4).
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// ---- Web Push ----
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { title: "TuBot", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "TuBot";
  const options = {
    body: data.body || "",
    icon: "/brand/tubot-icon.png",
    // tag por conversación → el SO reemplaza en vez de apilar (agrupación).
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    data: { link: data.link || "/", eventKey: data.eventKey || null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// ---- Clic en la notificación: abrir/enfocar la conversación exacta ----
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Si ya hay una ventana del panel abierta, navégala y enfócala.
      for (const client of clients) {
        if ("focus" in client) {
          client.navigate?.(link);
          return client.focus();
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(link) : undefined;
    }),
  );
});

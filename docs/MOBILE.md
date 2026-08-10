# Móvil: PWA hoy, Capacitor después

Decisión estratégica: **hoy publicamos PWA**, no apps nativas. Más adelante
envolvemos **esta misma PWA** en Capacitor para App Store y Play. Las
notificaciones se diseñaron completas ahora (catálogo + despachador + canales +
tabla `push_devices` genérica), así el push nativo entra como **un adaptador
más**, sin migración de datos ni volver a pedir permisos.

## Estado actual (PWA)
- **Instalable**: `manifest.webmanifest` (standalone, íconos any+maskable,
  shortcuts a Bandeja/Contactos, theme-color por esquema), `apple-web-app` y
  `apple-touch-icon` en el layout raíz, `viewport-fit=cover` (safe areas).
- **Service worker** (`public/sw.js`): armazón/estáticos en caché; **datos siempre
  frescos** (nunca cachea `/backend`); navegación network-first con fallback a
  `offline.html`; sin `skipWaiting` automático (aviso de actualización sin romper
  el compositor).
- **Web Push** (VAPID): suscripción por dispositivo, limpieza de caducados,
  permiso pedido tras una acción (no al entrar), guía de instalación en iOS.
- **Bandeja**: navegación por niveles (lista → conversación → contacto) con botón
  volver ya existente; el editor de **flujos** muestra un estado honesto en móvil
  ("requiere pantalla grande").

## Empaquetado con Capacitor (cuando se decida)

### Pasos
1. `npm i -D @capacitor/cli @capacitor/core && npx cap init TuBot cl.tubot.app`.
2. Apuntar el `webDir`/`server.url` a la PWA desplegada (o build estático de la
   web). Recomendado **modo servidor** apuntando a la URL de producción, así la
   app siempre carga la última versión sin re-publicar binario.
3. `npx cap add ios` y `npx cap add android`.
4. Instalar el plugin de push: `@capacitor/push-notifications` (usa APNs en iOS y
   FCM en Android).
5. Escribir el **único** archivo nuevo del backend: implementar
   [`apps/worker/src/notifications/native-push.ts`](../apps/worker/src/notifications/native-push.ts)
   (hoy es un stub con TODO) y registrarlo en el despachador con
   `registerChannel(nativePushChannel)`. Nada más cambia: los dispositivos ya se
   guardan en `push_devices` con `platform=ios|android` y `kind=apns|fcm`.
6. En el cliente, al aceptar permisos, registrar el token nativo con el MISMO
   endpoint `POST /notifications/devices` (cambiando `platform`/`kind` y usando
   `identifier` = token). El resto del flujo (preferencias, despachador,
   dedup, registro de entregas) ya funciona.

### Qué cambia respecto de la PWA
- El permiso de push nativo se pide con el plugin (no con `Notification`/
  `PushManager`); el adaptador `web_push` del cliente queda solo para web.
- Deep-links: el `link` de cada notificación debe resolverse dentro del WebView
  (ya son rutas relativas tipo `/inbox/{id}` — compatible).
- OAuth (Google) en WebView: usar el navegador del sistema / `@capacitor/browser`
  para el redirect, no un `window.open` embebido.
- Sesión: hoy el token va en `localStorage` (sobrevive en WebView). Verificar que
  no dependa de cookies de tercera parte.

### Requisitos para publicar
| | Apple App Store | Google Play |
|---|---|---|
| Cuenta | Apple Developer Program (**US$99/año**) | Google Play Console (**US$25 único**) |
| Identidad | **D-U-N-S** para cuenta de empresa (gratis, ~1–2 semanas) | Verificación de identidad/organización |
| Push | Clave **APNs .p8** (Key ID + Team ID) | **Service account** de Firebase (FCM HTTP v1) |
| Revisión | ~1–3 días típicamente; exige política de privacidad y datos declarados | ~1–7 días; misma exigencia |
| Notas | iOS Web Push ya funciona en PWA instalada (16.4+); la app nativa es para tienda/UX | — |

### Adaptador `native_push` — qué escribir exactamente
En `native-push.ts` (ver TODO en el archivo):
1. Leer `push_devices` del usuario con `kind IN ('apns','fcm')`.
2. **APNs**: JWT ES256 con la `.p8` (`APNS_KEY_ID`, `APNS_TEAM_ID`, bundle id) →
   `POST https://api.push.apple.com/3/device/{token}` con el payload aps.
3. **FCM**: token OAuth del service account → `POST /v1/projects/{id}/messages:send`.
4. Mapear respuestas `410`/`Unregistered`/`NotRegistered` → `expiredIdentifiers`
   (el despachador desactiva esos dispositivos).
5. Añadir env: `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_KEY_P8`,
   `FCM_SERVICE_ACCOUNT` (JSON).

## Verificación manual pendiente (requiere dispositivo/servicios reales)
- Cargar las **claves VAPID** (`npx web-push generate-vapid-keys` → env
  `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`) para activar Web Push en prod.
- Probar en teléfono real: instalar la PWA, aceptar permisos, recibir un push de
  "conversación asignada" y que el toque abra la conversación exacta.
- **Lighthouse** (PWA + rendimiento móvil): correr contra la URL de prod y ajustar
  lo que baje de 90 en PWA (íconos con tamaños exactos dedicados, `screenshots`
  en el manifest para el instalador enriquecido).

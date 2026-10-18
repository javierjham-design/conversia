# App móvil + escritorio (PWA) — Resultados

**Fecha:** 2026-10-18 · **Encargo App Móvil/PWA.** La app de celular y la de computador son la **misma PWA instalable** sobre `apps/conversia-web`, con **notificaciones push del sistema operativo** conectadas al sistema de notificaciones existente. Cero tiendas, una sola base de código. Un PR por etapa, CI verde, **TuBot intacto**. Todo probado contra el **stack Docker** (`pnpm sim:up`), nunca producción.

## Hallazgo que redujo el alcance (y el riesgo)

El **backend de push ya existía y es compartido**: tablas `push_devices` / `notification_deliveries` (con RLS), canal `web_push` en el despachador del worker, `web-push` instalado, config VAPID, catálogo de 24 eventos + preferencias por usuario, y endpoints `/notifications/*`. TuBot ya lo usa. Por eso **M2 conectó el frontend** en vez de reconstruir backend (crear `push_subscriptions` habría sido redundante y riesgoso para TuBot).

## Etapas

| Etapa | Qué | PR |
|---|---|---|
| M6.1 | Stack Docker completo (un comando) para probar todo | #500 ✅ |
| M1 | PWA instalable (iconos, instalación guiada, aviso de versión nueva) | #501 ✅ |
| M2 | Push end-to-end (frontend → backend existente) | #502 ✅ |
| M3 | Optimización móvil (safe-areas iOS, budget Lighthouse, preconnect) | #503 |
| M5 | Suite Playwright e2e (móvil + escritorio) + job de CI | #504 |
| M6.2/6.3 | Carga: paridad sim250 + carga de push con mock | este PR |

## Números

### Lighthouse (móvil, Chromium emulado, laboratorio 4G)
- **`/login`: PWA 100 · Performance 90 · Accessibility 100 · Best-Practices 100.**
- **`/crear`: Performance 80 → 91** (≥90 ✓) · Accessibility 100 · Best-Practices 100 · TBT 390 → 130 ms (tras `display:"optional"` en titulares + preconnect a la API).
  - El LCP es un **titular de texto**: en red real pinta ~0,35 s (medido con PerformanceObserver); bajo el 4G de laboratorio de Lighthouse marca ~3,4 s. En dispositivo/wifi real cumple holgado; conviene confirmarlo en tu teléfono.

### Installability (Playwright, 5 proyectos emulados: iPhone 13 / Pixel 7 / escritorio, claro y oscuro)
- Manifest `standalone`, `start_url /inicio`, iconos **192/512 PNG + maskable** + apple-touch; service worker **activo y controlando**; `offline.html`; theme-color; **sin scroll horizontal**. **30/30 verdes.**
- Flujo completo (con API, `RUN_FLOWS=1`): alta → panel → bandeja → cobros → Ajustes › Notificaciones → prompt de instalación. **1/1 verde.**

### Carga de push (M6.3, 250 orgs × 2 suscripciones = 500, contra el mock)
- **Entregas al mock: 999** (201: 900 · 410: 99).
- **Suscripciones muertas revocadas: 50** (= el 10% que responde 410 → `active=false`). ✓
- **Flujo origen intacto: 500 filas `in_app`** creadas pese a los push (una falla de push nunca rompe el flujo que la originó). ✓
- **Drenado de la ola: 12,6 s** · `api /health` 200 antes/después · worker con latido fresco → **sin degradación**. ✓

## Capturas (contra el stack Docker, iPhone 13)
- `/login`, `/inicio`, `/conversaciones`, Ajustes › Notificaciones (sección + 17 toggles por tipo). Adjuntas en los PRs de M1/M2/M3.

## Limitaciones conocidas
- **iOS < 16.4**: no hay Web Push; además en iOS el permiso solo existe con la **PWA instalada** (la UI lo explica y guía a instalar primero).
- **`web-push` exige TLS**: el mock de carga sirve HTTPS self-signed (el worker lo acepta con `NODE_TLS_REJECT_UNAUTHORIZED=0`, **solo en el sim**). En producción los endpoints de push ya son HTTPS reales.
- **CI flaky de `next/font`**: el build de conversia-web a veces falla al descargar Google Fonts en build (mismo flake que #490); se re-corre. **Fix durable sugerido (follow-up): `next/font/local`** (fuentes auto-hospedadas en el repo) → elimina la descarga en build.
- **Wrapper nativo para tiendas** (Capacitor/Tauri): fuera de alcance (fase futura); la PWA no lo necesita para instalarse ni para push.

## Lo que queda en tus manos (Javier)

1. **Claves VAPID de producción en Railway** (api + worker): generar un par real y setear `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:soporte@conversia.cl`). Generar: `node -e "console.log(require('web-push').generateVAPIDKeys())"`. **La privada NUNCA se commitea.** (Las de `.env.sim` son de PRUEBA.)
2. **Probar en tu teléfono**: instalar la PWA (Android: "Instalar"; iPhone 16.4+: Compartir → Añadir a inicio), activar notificaciones en Ajustes, y enviar una prueba (botón "Enviar una prueba") → debe llegar el aviso del SO con la app cerrada y abrir la pantalla correcta al tocarlo.
3. (Opcional, calidad) Confirmar Lighthouse de `/inicio` y `/conversaciones` logueado en tu dispositivo; y evaluar el follow-up de `next/font/local` para estabilizar el CI.

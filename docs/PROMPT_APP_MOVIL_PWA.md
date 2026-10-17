# PROMPT DE DESARROLLO — APP MÓVIL + APP DE ESCRITORIO (PWA) + NOTIFICACIONES PUSH

**Para el desarrollador (Claude Code en VS Code, con agentes). Docker está instalado y
listo para las pruebas.** Decisión de arquitectura (tomada por Javier en la etapa de
diseño, CONVERSIA_DISENO.md: "PWA mobile-first"): la app de celular y la de computador
son la MISMA **PWA instalable** sobre `apps/conversia-web` — se instala desde el
navegador en Android, iPhone (iOS 16.4+) y escritorio (Chrome/Edge/Brave), con
notificaciones push reales del sistema operativo. Cero tiendas de aplicaciones, cero
segunda base de código, actualizaciones instantáneas con cada deploy. (Un wrapper
nativo para stores — Capacitor/Tauri — queda como fase futura y NO es parte de este
encargo; si durante el trabajo detectas un bloqueador real que lo exija, documéntalo.)

El dueño de un negocio vive en el teléfono: la Bandeja, los avisos de créditos, la
escalación a humano y la agenda tienen que sentirse como una app nativa y AVISAR con
push aunque la app esté cerrada. Eso es lo que construyes aquí.

---

## ETAPA M1 — PWA instalable (base)

1. **Manifest** (`manifest.webmanifest`): nombre "Conversia", short_name, descripción,
   `display: standalone`, `start_url: /inicio`, orientación portrait en móvil, theme y
   background color desde los tokens del design system (modo oscuro Nocturna), set
   completo de iconos (192/512 + maskable + apple-touch-icon) generados desde el logo
   del repo, shortcuts de app ("Bandeja" → /conversaciones, "Agenda" → /agenda,
   "Cobros" → /cobros).
2. **Service worker** (next-pwa, serwist o SW propio — elige y justifica en el PR):
   precache del shell, runtime cache de /_next/static (ya immutable), estrategia
   network-first para HTML y datos (COHERENTE con el fix de caché del 17-oct: jamás
   servir páginas viejas), página offline amigable ("Sin conexión — tus conversaciones
   se actualizarán al volver"), y actualización del SW con aviso in-app
   ("Hay una versión nueva → Recargar").
3. **Instalación guiada**: banner/CTA "Instala Conversia en tu teléfono" en el panel
   (beforeinstallprompt en Android/desktop; en iOS instrucciones visuales de
   Compartir → Añadir a pantalla de inicio). Registrar en analytics/auditoría cuándo
   se instala (evento `pwa.installed`) para medir adopción.
4. **Criterio**: Lighthouse PWA instalable sin warnings; abre standalone sin barra de
   navegador; íconos y splash correctos en Android e iOS reales o emulados.

## ETAPA M2 — NOTIFICACIONES PUSH end-to-end

Ya existe el sistema de notificaciones in-app (tabla `notifications` con tipos
`credits.low`, `credits.grace`, `ai.escalation`, `conversations.limit`, etc.). Esta
etapa lo lleva al sistema operativo del dueño:

1. **Web Push con VAPID** (librería `web-push` en el worker): claves VAPID por entorno
   (generarlas y documentarlas en RUNBOOK_GOLIVE_V2.md; JAMÁS commitear la privada).
2. **Modelo `push_subscriptions`**: organizationId, userId, endpoint, keys, userAgent,
   createdAt, lastUsedAt, revokedAt — RLS como toda tabla de tenant. Migración Prisma.
3. **API**: `POST /me/push-subscriptions` (guardar/renovar la suscripción del
   dispositivo), `DELETE` (revocar), `GET /me/notification-settings` + `PUT` con
   preferencias POR TIPO de evento (mensajes nuevos que esperan humano ON por defecto;
   créditos ON; marketing OFF).
4. **Despacho en el worker**: donde hoy se crea una fila en `notifications`, despachar
   también el push a TODAS las suscripciones activas del usuario (respetando sus
   preferencias), con payload corto (título, cuerpo, URL de destino profundo — p. ej.
   `ai.escalation` → /conversaciones?c=<id>) y manejo de errores: 404/410 del endpoint
   push → marcar la suscripción revocada. Reintentos acotados; un fallo de push JAMÁS
   rompe el flujo que lo originó (best-effort como los correos).
5. **Service worker**: handlers `push` (mostrar la notificación del SO con icono y
   acciones) y `notificationclick` (abrir/enfocar la URL de destino).
6. **UI**: en Ajustes, sección "Notificaciones" con el switch maestro (pide el permiso
   del navegador en un gesto del usuario, nunca al cargar), estado por dispositivo y
   preferencias por tipo. En iOS, el permiso solo existe con la PWA instalada: la UI
   debe explicarlo y llevar primero a instalar.
7. **Criterios**: push recibido con la app CERRADA en Android, iOS (16.4+, instalada) y
   escritorio; el clic abre la conversación correcta; desuscribir desde Ajustes revoca
   de verdad; una org NUNCA recibe push de otra (test de aislamiento).

## ETAPA M3 — OPTIMIZACIÓN MÓVIL DEL PANEL (el 80 % del uso será teléfono)

1. **Navegación móvil**: barra inferior fija (Inicio · Bandeja · Agenda · Cobros · Más)
   en viewports < 768px, coherente con el diseño Nocturna; safe-areas de iOS
   (`env(safe-area-inset-*)`); objetivos táctiles ≥ 44px; sin hover-only.
2. **Bandeja estilo WhatsApp en móvil** (ya definido en diseño): lista → conversación a
   pantalla completa con volver; swipe opcional para acciones rápidas; composer que no
   salta con el teclado (visualViewport); scroll restaurado al volver a la lista.
3. **Performance budget**: Lighthouse móvil ≥ 90 en Performance/Best
   Practices/Accessibility en /inicio, /conversaciones y /crear; LCP < 2,5 s en 4G
   simulada; revisar imágenes (next/image), fuentes (display swap) y code-splitting de
   rutas pesadas; eliminar JS muerto que infle el First Load (reporte de bundle en el PR).
4. **Formularios móviles**: inputMode/autocomplete correctos (teléfono numérico, email),
   zoom no bloqueado, errores visibles sin scroll.
5. **Criterio**: recorrido completo (login → bandeja → responder → agendar → cobros →
   ajustes) usable con una mano en 375×812, sin scroll horizontal, en claro y oscuro.

## ETAPA M4 — ESCRITORIO

1. La MISMA PWA instalable en Chrome/Edge: ventana propia, icono en dock/barra de
   tareas, atajos del manifest. Las push de M2 llegan como notificaciones nativas del
   SO (Windows/macOS) con la app cerrada (navegador en segundo plano).
2. Atajos de teclado del panel web (ya en diseño): navegación de bandeja con flechas,
   `/` para buscar, Ctrl+Enter para enviar — verificar que funcionen en la ventana PWA.
3. **Criterio**: instalada en Windows (el entorno del negocio es Windows) con push
   funcionando y deep-link correcto al hacer clic.

## ETAPA M5 — TESTS DE FUNCIONALIDAD (Playwright)

Suite `apps/conversia-web/e2e/` con Playwright (añadir dependencia dev):

- Proyectos: **móvil** (iPhone 13 / Pixel 7 emulados: viewport + táctil + UA) y
  **desktop** (1280×800), ambos en claro y oscuro.
- Flujos: landing → /crear (selector de rubros con catálogo completo) → registro →
  panel con 30/30 → bandeja (lista, abrir conversación, responder) → cobros (catálogo
  correcto por modelo) → onboarding checklist 7 pasos → ajustes de notificaciones
  (permiso con mock del navegador) → instalar PWA (evento beforeinstallprompt mockeado)
  → SW registrado y página offline.
- Contra el stack Docker local (ver M6), con el provider mock — cero producción.
- Los tests corren en CI (job nuevo) y quedan documentados en el README de e2e.

## ETAPA M6 — ENTORNO SIMULADO CON DOCKER + TESTS DE CARGA MÓVIL

Docker está instalado y listo — úsalo como entorno canónico de prueba:

1. **`docker compose` del repo** (ya existe para PG+Redis; extiéndelo con perfiles o un
   `docker-compose.sim.yml`): Postgres + Redis + api + worker + conversia-web, con el
   `.env` de simulación (providers mock, rol `conversia_app` + DIRECT admin como
   producción endurecida, `WEB_URL_CONVERSIA` apuntando al front del compose). Un solo
   comando debe dejar TODO arriba: `docker compose -f docker-compose.sim.yml up -d`
   + seed + golive (script `tools/sim/up.sh` o npm script que lo encadene).
2. **Carga**: reusar `tools/sim/sim250.mjs` (fases w1–w7) contra el stack Docker para
   validar paridad con las corridas previas, y la fase de carga de
   PROMPT_CARGA_MASIVA.md si ya existe (si no, este encargo NO la implementa — solo
   deja el compose listo para ella).
3. **Carga específica de PUSH**: con 250 orgs y ~500 suscripciones push simuladas
   (endpoint push mockeado con un servidor local que cuente entregas), disparar una ola
   de `ai.escalation` + `credits.low` masivos y verificar: todas las entregas llegan al
   mock, ninguna rompe el flujo origen, las suscripciones muertas (el mock responde 410
   para un 10 %) quedan revocadas, y el worker no degrada su p95 de respuesta del bot
   mientras despacha push.
4. **Criterios**: paridad verde con la corrida de 250 (invariantes de dinero intactos),
   push bajo carga sin pérdidas ni bloqueos, y el compose documentado en el README
   para que cualquiera levante el entorno en 5 minutos.

## Proceso con agentes

1. **Agente INFRA**: M6.1 primero (compose + seed + smoke gate) — todo lo demás prueba
   contra esto.
2. **Agentes M1+M2 (backend/worker) y M3 (frontend móvil)** en paralelo, contratos
   primero (tipos de push en @conversia/types, migración Prisma al inicio).
3. **Agente TESTS**: M5 en paralelo desde que M1 esté instalable.
4. **Agente CARGA**: M6.2–6.3 al final, con todo integrado.
5. Un PR por etapa (M1…M6), CI verde, causa raíz y evidencia (capturas móviles,
   reporte Lighthouse, números de carga) en cada descripción.

## Reglas duras

- **TuBot no se toca** (apps/web intacta; las regresiones del harness en verde).
- Nada contra producción; claves VAPID de prueba en el compose, las reales van al
  runbook como paso de Javier.
- Seguir CLAUDE.md (código en inglés, UI en español, zod, RLS por withTenant).
- El SW no puede romper el fix de caché del 17-oct: HTML siempre network-first.

## Entregables

1. PWA instalable (móvil + escritorio) con push end-to-end y preferencias por tipo.
2. Panel optimizado móvil con presupuesto Lighthouse cumplido (reporte en el PR).
3. Suite Playwright móvil+desktop en CI.
4. `docker-compose.sim.yml` + script de arranque documentado.
5. `docs/APP_MOVIL_RESULTADOS.md`: capturas (Android/iOS/escritorio), números de
   Lighthouse y de la carga de push, limitaciones conocidas (p. ej. iOS < 16.4) y los
   pasos de Javier (claves VAPID de producción en Railway, probar en su iPhone/Android).

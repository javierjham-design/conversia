# Registro de progreso

## 2026-07-26 — Iteración: identidad visual + Centro Meta + integraciones profundas

- **Fix de seguridad crítico**: los servicios conectaban como superusuario (bypasea RLS) → fuga real entre tenants detectada (agentes del demo visibles en Digital Dent). Ahora cliente dual: rol `conversia_app` (RLS activo) para datos de tenant + cliente admin SOLO para registro/login/ruteo/scheduler.
- **Sistema visual**: tokens (@theme: navy/eléctrico/cian, tipografía 15px), lucide-react, `components/ui.tsx` (PageHeader, MetricCard, StatusBadge con icono+texto, EmptyState, Skeleton, Modal, Drawer, ConfirmDialog, SecretField, Tabs, Toasts) y shell nuevo: sidebar navy agrupado y colapsable con tenant activo, topbar con breadcrumbs + salud del API.
- **Integraciones rediseñada**: métricas reales (activas, atención, eventos 24h, errores webhooks 7d, última sync), sección Conectadas con salud/estado/acciones, catálogo por 4 categorías con estados Disponible/Beta/Próximamente ("Avisarme" registra interés), buscador + filtros, drawer de actividad.
- **Centro Meta Business Suite** (`/integrations/meta`): mapa de activos, checklist, wizard 5 pasos (Embedded Signup marcado pendiente de aprobación de app; conexión manual real; simulación dev SIEMPRE etiquetada), pestañas Lead Ads (mapeo de campos + prueba por pipeline real) y Conversions API (reglas evento→evento, dataset, test) + actividad.
- **Nuevas tablas**: meta_business_connections, meta_assets, meta_field_mappings, meta_event_mappings, integration_events (logs sanitizados), oauth_states; columnas de webhooks (description/headers/timeout/max_retries).
- **Webhooks salientes REALES**: entregas firmadas HMAC-SHA256 con reintentos/backoff y SSRF-guard (worker), tabla de entregas, prueba, reintento manual, rotación de secreto, pausar/eliminar.
- **Eventos de plataforma** emitidos desde el pipeline (conversation.started/closed, message.received/sent, lead.created/status_changed, appointment.created, human_handoff.requested, workflow.completed/failed) → alimentan webhooks + CAPI + actividad.
- **Lead Ads ingesta real**: webhook leadgen → mapeo → contacto (dedupe) → lead + etiquetas → workflows lead_created; camino Graph implementado (pendiente de credenciales) y prueba simulada end-to-end.
- **CAPI**: envío real a graph (hash SHA-256 de teléfonos, event_id dedup, test_event_code); en modo simulación registra [SIMULADO] sin salir a Meta.

## 2026-07-25 (2) — Despliegue a Railway

- Preparación: Dockerfiles por servicio (monorepo pnpm), soporte `PORT`, `.dockerignore`, migración inicial de Prisma generada offline (`migrate diff --from-empty`).
- Proyecto Railway `conversia`: Postgres 18 (pgvector confirmado) + Redis + servicios api/worker/web con variables y referencias cruzadas (detalle en DEPLOYMENT.md).
- BD productiva: `migrate deploy` + `sql/setup.sql` (RLS/FKs/rol app con contraseña fuerte) + seed de 2 tenants ejecutados contra el proxy público.
- Dominios: api-production-cf8e / web-production-d50dd (.up.railway.app).
- Smoke test E2E en producción OK (webhook → tenant → agente mock → respuesta visible por API autenticada). Dos bugs encontrados y corregidos en el proceso:
  1. Express 5: `req.path` relativo en middleware montado → rutas públicas daban 401; fix con `originalUrl`.
  2. Respuesta duplicada cuando un workflow con nodo `run_agent` corre en `conversation_started` además del turno directo del inbound; fix: el turno directo se omite si un workflow ya ejecutó al agente (ventana 60s).
- Pendiente inmediato: providers en mock (activar Anthropic con API key), pre-deploy de migraciones automatizado.

## 2026-07-25 (3) — GitHub + fix del login del panel

- Repo privado `javierjham-design/conversia` creado y pusheado; servicios api/worker/web conectados a `main` → **autodeploy en cada push**. (Push desde PowerShell background se cuelga pidiendo credenciales → usar token de gh directo.)
- Saga del login ("Failed to fetch") — 3 causas encadenadas, todas corregidas:
  1. `WEB_URL` de la api resolvió vacía (referencia creada antes de que existiera el servicio web) → CORS sin allow-origin. Fix: valor literal.
  2. Railway NO pasa variables como build-args al Dockerfile → `NEXT_PUBLIC_API_URL` horneó `localhost:4000` en el bundle.
  3. Intento con `rewrites()` de Next falló porque los rewrites se **serializan en el build** (routes-manifest), no se leen en runtime.
  - **Fix definitivo**: route handler `apps/web/src/app/backend/[...path]/route.ts` — proxy same-origin `/backend/*` que lee `API_URL` del entorno en cada request (`force-dynamic`). Elimina CORS y cualquier dependencia de build-time env. Verificado: login vía dominio del panel devuelve token.
- Lección adicional: la api escucha en `0.0.0.0` (IPv4) → inaccesible por la red privada IPv6 de Railway; usar URL pública en el proxy hasta cambiar a `app.listen(port)` dual-stack (mejora anotada).
- Mejora pendiente: watch paths por servicio para no recompilar los 3 en cada push.

## 2026-07-25 — Sesión fundacional

**Creado el monorepo completo desde cero** (arquitectura + código funcional):

- Raíz: pnpm+turbo, tsconfig base, docker-compose (pgvector+redis), .env.example, CI, CLAUDE.md.
- `packages/database`: schema Prisma ~50 tablas multi-tenant, `sql/setup.sql` (RLS dinámico + FKs + rol app + índice HNSW), `withTenant`, seeds JSON de 2 tenants (Digital Dent completo + Clínica Demo) con seed genérico.
- `packages/types`: contratos SchedulingProvider / AIProvider / ChannelProvider / ToolDefinition / workflow schema (zod) / colas / permisos.
- `packages/config`: entorno validado con zod, fail-fast en producción.
- `packages/agents`: AnthropicProvider (opus-4-8 por defecto) + Mock, pricing por modelo, registro de 10 tools core validadas, orquestador con loop de tools, transferencias y escalamiento humano.
- `packages/workflows`: motor puro v0 (triggers, ramas, esperas persistentes, idempotencia) con 4 tests vitest.
- `packages/scheduling`: Mock (doble reserva, datos del tenant) + cliente Cláriva del contrato preliminar.
- `apps/api` (NestJS 11): auth JWT + AsyncLocalStorage, RLS via withTenant, organizaciones, bandeja (listar/chat/enviar/takeover/release/SSE), webhook WhatsApp con firma HMAC, colas BullMQ; 2 suites de test.
- `apps/worker`: inbound (resolución de tenant, idempotencia, cancelación de seguimientos, dispatch de workflows, turno de agente, envío), outbound, scheduler de timers, runtime de workflows completo.
- `apps/mock-clariva`: servidor Express del contrato (slots, citas, 409 doble reserva).
- `apps/web` (Next 15 + Tailwind 4): login + bandeja funcional (chat, IA/humano).
- `scripts/simulate-inbound.mjs`: simulador de mensajes formato Meta.
- `docs/`: ARCHITECTURE (diagramas mermaid + flujos), MULTITENANCY, DECISIONS (12 ADRs), DATA_MODEL, SECURITY, AGENTS, WORKFLOWS, WHATSAPP, SCHEDULING, CLARIVA (contrato), ROADMAP (fases+backlog), TESTING, DEPLOYMENT (+costos), API, INTEGRATIONS, BILLING, CHANGELOG.

**Validación**: pnpm install OK; prisma validate/generate y typecheck/test ejecutados al cierre de la sesión (ver resultado en el informe).

**Deuda/pendientes inmediatos**: ver "Próximos 10 tickets" en ROADMAP.md. No hay BD levantada aún en esta máquina (sin Docker): primer paso de la próxima sesión = levantar Postgres/Redis y correr migrate+setup+seed+simulador.

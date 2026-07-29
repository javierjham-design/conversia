# Registro de progreso

## 2026-07-29 (4) — Catálogo de Workflows ampliado + reconciliación CTWA (PR #1)

Ampliación del constructor de workflows (triggers + pasos) estilo Respond.io, adaptado al rubro. Sin migraciones (todo en JSON/modelos existentes). Menú "Añadir paso" **categorizado (8 categorías) + buscador**, con soporte "Próximamente" (deshabilitado) y "Premium" (gating por plan). Trabajado por categorías con commit por cada una.

**Triggers nuevos** (motor + catálogo + formularios de condiciones):
- `click_to_chat` (Anuncios Click-to-WhatsApp): el inbound parsea el `referral`, guarda `ctwa_clid/ad_id/headline` en el contacto y dispara (condición por ad).
- `lead_status_changed` (Etapa del ciclo de vida, origen→destino) — dispatch desde el nodo y la tool del agente.
- `appointment_created` + `appointment_upcoming` (Recordatorio X h antes): recordatorios programados por-workflow (scheduled_job → scheduler → startWorkflowById).
- `manual` masivo: `POST /workflows/:id/run-bulk` sobre varios contactos.
- **Próximamente** (estructura lista): cita cancelada/reprogramada, llamada perdida, anuncios TikTok.

**Pasos nuevos** (nodo + ejecutor en el motor + formulario + test):
- Conversación: `open_conversation`, `add_note`.
- Control de flujo: `goto` (Saltar a otro paso, edge punteado, anti-bucle máx 25 saltos + aviso de bucles al publicar), `business_hours` (Fecha y hora → ramas dentro/fuera, zona horaria via Intl + feriados).
- Marketing: `send_capi` (evento CAPI directo con `ctwa_clid`, reintentos BullMQ, reutiliza dataset/token del Centro Meta). `send_tiktok_event` → Próximamente.
- IA: `ai_objective` (agente con objetivo inyectado → ramas cumplido/no; evaluación v1 por clasificador económico).
- Integraciones: `call_api` (Petición HTTP con **guard SSRF** — bloquea localhost/IPs privadas/metadata, allowlist, redirect:error, timeout —, mapeo JSON→variables, **gating por plan**). `google_sheets_append` → Próximamente (OAuth por diseñar).
- Agenda: `send_template` (plantilla HSM) → Próximamente.

**Calidad:** tests del motor (13) + guard SSRF (4, vitest nuevo en el worker); typecheck de todo en verde. El modo Prueba (sandbox) describe los nodos nuevos.

**Reconciliación al mergear con contactos (PR #2 ya en main):** el `ctwa_clid`/atribución CTWA se guarda **una sola vez** en columnas estructuradas del contacto (lo hace el inbound vía `buildContactCreate/Update`). El bloque `click_to_chat` ya no reescribe `attributes` — solo dispara el flujo; y `send_capi` (`sendCapiEvent`) lee `contact.ctwaClid` en vez de `attributes.ctwa_clid`.

## 2026-07-29 (3) — Módulo de Contactos (estilo Respond.io)

Rama `feature/contacts` (PR aparte). Objetivo: capturar el **máximo** de datos de Meta/WhatsApp y gestionar la base de contactos con aislamiento total por tenant. 6 checkpoints, un commit cada uno; todo `withTenant` + zod + `audit_logs`, UI en español, nada hardcodeado por cliente.

- **Aislamiento verificado**: RLS por `organization_id` en cada tabla; `resolveTenant()` enruta por número receptor; el mismo teléfono a dos tenants = dos contactos aislados. Uniques org-scoped.
- **Esquema** (migración `20260729140000_contacts_capture`, aún **sin aplicar a prod**): +7 columnas en `contacts` (`profile_name`, `country`, `created_via`, `acquisition_source`, `ad_id`, `ctwa_clid`, `meta`) + índice `(org, created_at)` + tabla `contact_segments`. Custom fields ya existían.
- **Captura (worker)**: perfil de WhatsApp guardado **aparte** del nombre real (nunca lo pisa); teléfono E.164; país/zona horaria inferidos por prefijo; referral CTWA estructurado (`ad_id`/`ctwa_clid`/`acquisition_source`) + payload crudo en `meta`. Tests vitest (6).
- **Lista** (`/contacts`): sidebar con conteos en vivo (todos, bloqueados, ciclo de vida, agentes IA, segmentos); tabla con perfil WhatsApp, canal, etapa, etiquetas, país, estado de conversación, asignado; búsqueda con debounce, filtros combinables, selector de columnas, orden y paginación server-side (25/50/100). Alta manual con dedupe por teléfono.
- **Ficha** (drawer): pestañas Datos / Origen / Conversaciones / Actividad. Edición inline + campos personalizados por tipo, bloque de atribución (readonly), bloquear/eliminar, notas internas (`attributes.notes`, sin tabla nueva), timeline de `audit_logs`.
- **Acciones masivas**: etiquetar, cambiar etapa (upsert de lead), asignar (agente/usuario), bloquear/desbloquear, borrado lógico. **Segmentos**: guardar filtros actuales, presets sugeridos genéricos, borrar; segmento dinámico `createdWithinDays`.
- **Import/Export/Fusión**: export CSV respetando filtros (hasta 10 000); import CSV con mapeo de columnas + dedupe por teléfono (crea/actualiza), por lotes; detector de duplicados por teléfono + fusión (reasigna conversaciones/leads/citas/identidades/etiquetas/campos, rellena huecos, baja lógica). Parser CSV con tests (5).
- **Pendiente**: aplicar la migración a prod (Railway) antes de desplegar; unique DB `(org, phone)` queda como migración futura (propuesta, no aplicada) tras deduplicar; import muy grande → job BullMQ en 2º plano (hoy es síncrono por lotes).

## 2026-07-29 (2) — Módulo de Workflows (canvas) + modelo de IA por-tenant

**Workflows estilo Respond.io** sobre el motor JSON existente (sin migración; el motor queda intacto → los flujos publicados siguen corriendo igual):

- **Lista** (`/workflows`): estados Borrador/Publicado/Detenido, búsqueda, "Ver más", autor/fecha de creación y publicación, menú (renombrar, duplicar, detener/reanudar, eliminar). API: list enriquecido + `PATCH` rename + `duplicate` + audit_logs.
- **Editor de canvas** (`/workflows/[id]`, `@xyflow/react`): lienzo con grilla, zoom/ajustar, **undo/redo**; nodo **Disparador** + nodos en tarjetas con panel de config; botón **+** por nodo; **ramas** etiquetadas en la condición; **validación al publicar** (disparador conectado, sin huérfanos, campos). Lee/escribe el mismo `WorkflowDefinition` (con posiciones); serialización extraída a `lib/workflow-serialize.ts` con **test de round-trip**.
- **Nodos del motor ampliados** (aditivo): quitar etiqueta, actualizar datos de contacto, asignar a usuario/equipo, cambiar de agente IA (toma el control), disparar otro flujo (con guard anti auto-disparo). Deps en el worker.
- **Disparadores**: `message_received` con condiciones (palabra clave, primer mensaje) y `conversation_closed`; puente API→worker (el `eventsWorker` mapea `conversation.closed`→`conversation_closed` y arranca los flujos). **Atajo manual desde la bandeja**: "Ejecutar flujo" sobre una conversación (`POST /conversations/:id/run-workflow` → `startWorkflowById`). **`tag_added`**: se dispara al etiquetar (acción masiva de Contactos, nodo "Agregar etiqueta", tool de IA, Lead Ads) con condición opcional por nombre; solo asignaciones NUEVAS emiten el evento (corta bucles entre flujos que se etiquetan mutuamente); evento público `tag.added` para webhooks.
- **Modo Prueba** (`POST /workflows/:id/test`): recorre la definición actual contra un contacto ficticio y describe, paso a paso, qué haría cada nodo. No persiste ni envía nada.
- **Plantillas** genéricas (4): bienvenida+captura, seguimiento sin respuesta (con ramas), respuesta a palabra clave, encuesta al cerrar. Galería en el modal de creación.
- **Auditoría de brechas** documentada: el motor ejecuta un subconjunto del enum `NODE_TYPES`; los nodos/disparadores fuera de ese subconjunto se listan como brecha (no se fingen).

**Modelo de IA por-tenant (exclusivo del Super Admin):** el modelo, el tope de tokens y las rondas de tools se sacan del editor de agente del tenant y se fijan por tenant desde el Super Admin (`org.settings.ai`), aplicando a toda la plataforma del cliente (todos sus agentes + el probador). El tenant ya no puede modificarlos. Lo consumen el worker (`agent-turn`) y el probador de agentes.

## 2026-07-29 — Editor de agentes estilo Respond.io + plataforma

**Editor de agentes reconstruido** (`agents/[id]`) en 6 fases, sin migraciones (todo en `agent_versions.config` JSON con zod `.passthrough()`):

1. **Auditoría**: se confirmó que `config` admite claves nuevas (actions, knowledgeSources, emoji) sin tocar el esquema.
2. **Layout 2 columnas**: izquierda = formulario (Configuración, Instrucciones con variables `{{}}`, contador de tokens, plantillas de texto, ayuda por sección); derecha sticky = probador.
3. **Acciones**: tarjetas con toggle + instrucción en lenguaje natural, mapeadas a tools reales. 5 tools nuevas (`closeConversation`, `assignConversation`, `updateContactFields`, `triggerWorkflow`, `addInternalNote`) + `assembleSystemPrompt` que inyecta la guía de cada acción habilitada al system prompt (misma verdad en worker y probador). Autocompletado `@equipo/@usuario/@agente` al derivar.
4. **Probador en vivo** (`POST /agents/:id/test`): sandbox con **lecturas reales** (servicios, precios, agenda, conocimiento) y **escrituras simuladas** (no persiste nada; muta el contacto en memoria y registra cada intento). Usa la config actual sin publicar, respeta kill switch/suspensión/vigencia/tope diario y contabiliza el consumo real. UI con pestañas Chat / Campos del contacto, chips de tools/acciones simuladas y uso (tokens/costo/latencia).
5. **Fuentes de conocimiento**: `config.knowledgeSources[]` filtra `searchKnowledge` por base; `GET /agents/meta/knowledge` lista las bases; toggles por base en el editor (undefined = todas para agentes previos).
6. **Plantillas + calidad**: galería de 5 plantillas genéricas (recepcionista, agendador, calificador, soporte, derivador) sin datos de ningún tenant; primeros tests del paquete `agents` (assembleSystemPrompt, specsFor, validación zod, renderTemplate anti-inyección).

**Resto de la sesión** (plataforma): gestión de usuarios operadores con permisos segmentados y roles personalizados; modelo de IA a `gpt-4o-mini` + transcripción de audio (Whisper) con audio reproducible en la bandeja; asignación del **agente de IA** a cargo de una conversación (toma el control según su config); gestor por tenant en Super Admin (vigencia, tope de tokens, indicador de uso, costo de máximos); flujo de **demo** (acceso mínimo, sin gastar tokens hasta habilitar) + CRM de prospectos + landings funcionales; optimización móvil de todas las páginas; gestión de la cuenta admin por tenant (reset de contraseña, envío por correo, editar email); **pagos**: Flow (CLP) + Lemon Squeezy (MoR) con credenciales cifradas en `platform_settings` configurables desde el Super Admin y proveedor por tenant — **Flow ya operativo**, Lemon en pendientes.

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

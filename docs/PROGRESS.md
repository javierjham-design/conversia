# Registro de progreso

## 2026-08-01 — Bandeja Pro nivel Respond.io (rama `feature/inbox-pro`)

Reescritura de la Bandeja en 4 zonas + backend nuevo. Migración `20260801120000_inbox_pro` (inbox_views, snippets, conversation_ai_notes + índices por agente/equipo) — **pendiente aplicar a prod**. Nada de la bandeja anterior se rompió (plantillas/ventana 24 h, audio+transcripción, tomar control, ejecutar flujo, checklist verificados).

- **Clasificador (zona 1)**: grupos colapsables con conteos en vivo — fijas (Todas/Mías/Sin asignar/No respondidas=unread>0), por agente IA, por etapa del ciclo de vida (lead más reciente vía lateral join, sin N+1), bandejas de equipo, **bandejas personalizadas guardadas** (modal +: estado/canal/asignado/IA/etapa/tags/origen-anuncio; patrón contact_segments) y Contactos bloqueados. `GET /inbox/counters` agregado único.
- **Lista (zona 2)**: búsqueda, orden (nuevas/antiguas/sin responder primero), toggle solo-no-respondidas, avatar con badge IA/humano, etapa con color, no leídos, asignado, paginación por cursor ("Cargar más", take 40).
- **Cabecera (zona 3)**: **selector de etapa editable** → evento SYSTEM en el hilo + trigger `lead_status_changed` + **oferta de envío CAPI** si la etapa es categoría WON y la integración está activa (`POST /conversations/:id/stage|capi`); asignar a usuario **y equipo**; agente IA; ejecutar flujo; tomar control/devolver (con eventos inline); **cerrar con nota** (comentario interno); **semáforo de ventana 24 h** (verde >6 h, amarillo <6 h, rojo cerrada); número/canal con estado.
- **Hilo**: banner "Conversación iniciada desde anuncio" (headline, imagen, ctwa_clid, Ver anuncio) y tarjeta de formulario Meta Lead Ads (datos capturados en el contacto); eventos del sistema centrados (etapas, asignaciones, control, flujos); **comentarios internos** como burbujas amarillas solo-equipo (visibility INTERNAL, jamás encolados al canal); ticks de estado y errores de envío visibles.
- **Indicaciones al bot por conversación** (diferencial): sección en el panel derecho con historial (quién/cuándo/activa) — `conversation_ai_notes`; el orquestador inyecta las activas al system prompt en CADA turno de esa conversación con prioridad alta pero **explícitamente bajo las reglas de seguridad**; tests de aislamiento (bloque por conversación, sin fuga entre conversaciones; tenant por RLS).
- **Compositor (zona abajo)**: pestañas Responder/Comentario interno; **snippets con "/"** (CRUD en modal, `{{contact.*}}` resueltas); **variables con "$"**; emojis; **adjuntos imagen/documento** (≤5 MB, subidos como media de Meta — sin S3; `OutboundMessage.mediaId` + provider extendido); **asistente IA** (sugerir respuesta con base de conocimiento publicada, mejorar en 3 tonos, traducir — `POST /inbox/assist` con el modelo del tenant y costo en usage_events) y **Resumir** → comentario interno.
- **Tiempo real (zona transversal)**: pub/sub Redis con **canal por tenant** (`rt:{orgId}`); publican worker (entrante, respuesta del agente, estados de envío) y API (asignación/etapa/cierre/envíos); SSE `GET /conversations/stream/updates` consumido por **fetch streaming** (Authorization normal, sin token en query); indicador "en vivo"/"sondeo", reconexión con backoff y **fallback automático a sondeo de 5 s**. Suscripción nace del JWT → imposible escuchar otro tenant.
- Panel derecho **colapsable** (drawer en pantallas chicas) con ficha del contacto, etapa, tags, origen y link a Contactos.

Typecheck 22/22 · 107 tests en verde. **Pendiente al desplegar: migración inbox_pro en prod.**

## 2026-07-31 (2) — TODAS las tarjetas del hub habilitadas (rama `feature/integrations-enable`)

Las 11 tarjetas "Próximamente" pasaron a "Disponible" con conexión real, "Probar conexión" y cableado a Workflows/Agentes/Bandeja. Migración `20260731170000_integration_connections` (unique (org, provider) + enum CUSTOM) — **pendiente aplicar a prod**. Un commit por tarjeta (9 commits):

- **Correo electrónico**: remitente de plataforma (Resend) o SMTP propio (nodemailer, credencial cifrada); escalamientos con retardo (verifica que el handoff siga PENDING), resumen diario por zona horaria (tick 15 min idempotente), alertas de integraciones; paso de workflow `send_internal_email` (interno al equipo, nunca masivo) con validación al publicar; cola `tenant-emails` con reintentos.
- **API personalizada**: presets (baseUrl + auth bearer/header cifrada + allowlist de host) CRUD + prueba; el paso «Petición HTTP» acepta `presetId` (URL relativa, headers del preset); detección de uso en flujos antes de borrar.
- **Google Analytics (GA4)**: Measurement Protocol (measurement_id + api_secret cifrado); prueba con `debug/mp/collect` antes del envío real; paso `send_ga4_event` (params con variables, client_id anónimo estable por contacto) + espejo opcional de eventos CAPI; cola `integration-sync`.
- **Meta Events Manager**: panel de métricas reales de CAPI (30 días: por día, por evento, tasa de éxito, últimos rechazos) + link directo al dataset.
- **Agenda personalizada**: `CustomSchedulingProvider` (contrato estándar = endpoints Cláriva) firmado HMAC (`sha256=HMAC(secret, ts.método.path.body)`, tests); conexión con secreto cifrado, prueba real (profesionales + slots), bloqueo si hay otra agenda activa; sección de contrato en /integrations/developers.
- **Zapier / Make**: asistente guiado sin app nativa — crea webhook saliente + API key (secretos mostrados una vez), plantillas de casos comunes, estado de entregas; desconectar pausa el webhook y revoca la key.
- **Google Calendar + Sheets (OAuth por tenant)**: framework OAuth de plataforma (state HMAC 10 min, callback público `/public/oauth/google/callback`, tokens cifrados AES-256-GCM, refresh auto con margen 60 s, `reauthorize` + correo si se revoca, revocación al desconectar). Calendar v1: espejo Conversia→Google de cada cita (cola sync, `googleEventId` en `appointment.meta` anti-duplicados, recrea si lo borran a mano); enganchado en recordAppointment + webhook Cláriva. Sheets: paso `google_sheets_append` real (planilla/hoja/columnas con variables, backoff en 429, validación al publicar). Drawer con selector de calendarios reales y estado «Configuración de plataforma pendiente» si faltan `GOOGLE_OAUTH_CLIENT_ID/SECRET` → guía `docs/GUIA_OAUTH_GOOGLE.md`.
- **Dentalink**: `DentalinkSchedulingProvider` contra la API real de Healthatom (`Authorization: Token`, sobre `{data}`): sucursales/dentistas/citas/pacientes + estados vía `/citas/estados`. Disponibilidad v1 = ventana laboral configurable − citas reales (`computeDentalinkSlots`, puro, 9 tests con fixtures — estados en español con negaciones, solapamientos, domingos). Bloqueo de doble agenda; prueba lista sucursales y dentistas.
- **HubSpot**: OAuth por tenant (`HUBSPOT_CLIENT_ID/SECRET`, guía `docs/GUIA_OAUTH_HUBSPOT.md`); sync **unidireccional** de contactos (inbound WhatsApp, Lead Ads, Cláriva, workflows, tools) vía cola con 5 reintentos; **sin duplicados** (búsqueda por teléfono/email, id en `contact.meta.hubspotContactId`, 409 reutiliza Existing ID); mapeo de campos configurable + backfill escalonado (200 ms, tope 5000); prueba muestra el portal conectado; 4 tests.

Seguridad transversal: secretos solo cifrados (nunca completos al navegador), state OAuth firmado con vencimiento (4 tests), permisos `integrations:write`, RLS intacto (organizationId solo del JWT). Typecheck 16/16 y 60+ tests en verde.

## 2026-07-31 — Centro de Integraciones del tenant (rama `feature/integrations`)

Cableado de punta a punta de las integraciones POR TENANT (el hub UI base ya existía). 5 checkpoints:

- **CP2 · WhatsApp por tenant completo**: el worker envía con el **token por-WABA cifrado** de cada canal (fallback al global) en los 3 caminos (agente IA, panel, workflows) — FIX de paso: `sendText` de workflows enviaba con id sintético `wf:<org>` que solo funcionaba en mock. Token vencido (401/code 190) → `ChannelAuthError`: mensaje FAILED, canal en estado **error** SIN reintentos, banner **Reautorizar** en Canales; "Probar conexión" detecta el token de canal vencido (aunque el fallback global funcione) y recupera el estado al pasar. Panel **"Salud de WhatsApp"** con los últimos eventos (auth/calidad/cuenta/plantillas — meta-health). La transcripción descarga el media con el token de la WABA receptora. Tests del proveedor (5).
- **CP3 · Plantillas HSM end-to-end**: la tabla `whatsapp_templates` del schema original ahora se usa (SIN migración; `body` = {components, variableFields, rejectedReason, syncedAt}). **Sync**: implícita al ver el panel de plantillas, `POST /channels/:id/templates/sync` bajo demanda y **cada 6 h** en el worker (todas las orgs con WABA). Nodo **"Enviar plantilla WhatsApp"** REAL en el motor (config: templateId; variables resueltas con datos reales del contacto/cita/negocio vía `variableFields` + `resolveTemplateParams`); selector de plantilla en el editor (catálogo incluye aprobadas) y **validación al publicar** (plantilla aprobada requerida; CAPI requiere dataset activo). **Bandeja**: chip de **ventana de 24 h** (abierta con tiempo restante / cerrada), composer deshabilitado fuera de ventana y modal **"Enviar plantilla"** (`POST /conversations/:id/send-template` → cola outbound; el worker resuelve parámetros y envía tipo template).
- **CP4 · CAPI**: verificado — una sola fuente de config (metaEventMapping + token de la conexión), log por evento en la tarjeta. Sin cambios.
- **CP5 · Webhooks entrantes + API pública** (migración `20260731130000_inbound_webhooks_api_keys`): receptor público **`POST /hooks/t/{token}`** (token único → org, HMAC opcional `X-Conversia-Signature`, payload ≤64 KB, registro en actividad) → dispara el trigger **`webhook_received`** con el payload aplanado como variables (`{{webhook.campo}}`). **API keys** por tenant (secreto mostrado UNA vez, sha256 en reposo, scopes contacts:read/write, lastUsedAt, revocación) + **API pública v1** (`GET/POST /public/v1/contacts`, auth Bearer cnvk_, dedupe por E.164, rellena solo campos vacíos). Página **/integrations/developers** (gestión + docs rápidas) enlazada desde el hub.
- **CP6 · Transversales**: switch de **transcripción por tenant** (org.settings.transcription, default ON; UI en Canales; el inbound lo respeta), banner **"Conectar WhatsApp"** en Agentes, banner de **reautorización** + **checklist de puesta en marcha** (WhatsApp → agente → flujo) en la Bandeja, **campana de incidencias** en el header (integration_events error/warning), y el **número/canal visible** en cada conversación.

Typecheck 16/16 y tests 11/11 en verde en cada checkpoint. **Pendiente al desplegar: aplicar la migración de CP5 a prod.**

## 2026-07-29 (5) — Pendientes de backlog: import en 2.º plano, webhooks Cláriva, ai_objective multi-turno

Rama `feature/contact-import-job`. Además se verificó que el trigger `tag_added` ya estaba completo (panel bulk, tool IA, nodo de flujo, Lead Ads; el import CSV no dispara a propósito) → ROADMAP corregido.

- **Import CSV → job BullMQ**: cola nueva `contact-imports`; la API valida (tope 10 000 filas, body 2 MB) y encola; el worker procesa por lotes de 200 con `updateProgress` + audit log; `GET /contacts/import/:jobId` (solo el tenant dueño) y UI con polling + barra de progreso.
- **Receptor de webhooks Cláriva**: `POST /webhooks/clariva/:connectionId` (público, firma `X-Clariva-Signature` HMAC con `config.webhookSecret` por conexión). El worker actualiza la proyección `appointments` por `(provider, external_id)`, crea contacto por teléfono si falta (fill de huecos en `patient.updated`), registra `integration_events` y dispara `appointment_created/confirmed/cancelled/rescheduled` y `no_show`. Tests del mapeo (7).
- **ai_objective multi-turno**: config `maxTurns` (default 1 = v1) + `timeoutHours`. `pending` deja el run en espera (timer sin cancelOn); el estado vive en `conversation.meta.aiObjective`; cada respuesta del contacto corre el turno del agente CON el objetivo, re-evalúa y reanuda por rama (`resumeWithBranch` nuevo en el motor); turnos agotados o timeout → «unmet» y limpieza. Test del motor pending/resume.

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

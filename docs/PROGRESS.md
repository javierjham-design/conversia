# Registro de progreso

## 2026-08-04 (1) — Workflows AGENDA: recordatorios de cita robustos (rama `feature/workflow-catalog`)

Auditoría previa: el catálogo de triggers/pasos ya estaba ~90% construido y **real** (motor + ejecutores + canvas con buscador/categorías + validación al publicar + SSRF). El trabajo se centra en cerrar huecos reales. Este bloque = **AGENDA**.

**A1 (bug de producción):** las citas creadas por la clínica en Cláriva (la mayoría) **no programaban recordatorio** — `scheduleAppointmentReminders` solo se llamaba cuando el agente agendaba (tool-services), no desde el webhook. Ahora el webhook de Cláriva programa el recordatorio al **crear** y **reprogramar**, y lo **cancela** al cancelar la cita.

**A2 (ciclo de vida + idempotencia):**
- Identidad del recordatorio = **id externo de la cita** (mismo id en el camino del agente y del webhook → un reenvío de Cláriva no duplica ni resucita un job ya enviado; un job `DONE`/`PROCESSING` nunca vuelve a `PENDING`).
- Reprogramar re-apunta el job PENDIENTE a la fecha nueva; cancelar la cita cancela el recordatorio pendiente (**sin huérfanos** avisando de citas inexistentes).
- Triggers `appointment_rescheduled`/`appointment_cancelled` promovidos de "Próximamente" a **vivos** (el webhook ya los emite); añadido **"Cita confirmada"**. `missed_call` y TikTok siguen "Próximamente".

**A2 — política de bordes de tiempo (configurable con `hoursBefore` y `avoidOffHours`, default true):**
- Cita en el pasado → no se recuerda (y se cancela un job huérfano si lo hubiera).
- Ventana más corta que `hoursBefore` (recordatorio 24 h y la cita en 3 h) → se envía **cuanto antes**, nunca después de la cita.
- Recordatorio que caería de madrugada / fuera de horario → se **corre al inicio del siguiente tramo hábil** (horario de atención de la org; sin configurar, tramo por defecto **08:00–21:00** para no escribir de madrugada). Si el único hueco hábil cae **después** de la cita, se envía a la hora calculada (recordatorio inminente > silencio).

**A1/A2 — plantilla fuera de la ventana de 24 h:** una cita agendada hace días no tiene conversación abierta; `sendTemplate` ahora **abre/reutiliza una conversación** para el contacto antes de enviar la plantilla HSM, así el recordatorio llega aunque la ventana esté cerrada.

**A3 — tests:** módulo puro `apps/worker/src/appointment-reminders.ts` con `appointment-reminders.test.ts` (13 casos: hora correcta, ventana corta, cita pasada, cancelación, madrugada→horario, borde "inminente", tramo por defecto, e idempotencia DONE/duplicado/reprogramación). Suites verdes: workflows 15 · api 39 · worker 50. Sin migración (usa `scheduled_jobs`, `appointments`, `organization.settings`).

## 2026-08-03 (6) — Robustez ante datos incompletos + dark de la escala de marca (rama `fix/dark-null-safety`)

El recorrido Playwright con fixtures **deliberadamente incompletas** (tenant vacío y registros con opcionales en `null`) reveló que varias pantallas se quedaban en blanco con datos que un usuario real puede tener — no era artefacto del harness. Corregido:

- **Robustez de datos** (9 pantallas): optional chaining / valores por defecto donde el dato puede faltar legítimamente — Bandeja (contadores del clasificador), Contactos (contacto sin etiquetas/canales), Reportes (funnel/citas/series vacías), Plan y facturación (plan "a medida" sin precio → `money(null)`), Usuarios (permisos/equipos sin definir → `expandPerms`), Config. general (`name` null → `.trim()`), Horarios (sin configurar), Flujos (estado desconocido), Integraciones (catálogo sin `capabilities`).
- **Error boundary** `src/app/(app)/error.tsx`: un fallo de render muestra un estado amable con «Reintentar / Recargar» (sidebar intacto) en vez de la pantalla de error de Next. Layout blindado (`me.user.name` null).
- **Lógica pura extraída y testeada**: `src/lib/safe.ts` (`money`, `expandPerms`, `withStringDefaults`) con `safe.test.ts` (11 tests con nulls) → 23 tests en web. Smoke de integración versionado en `apps/web/e2e/robustness/` (fixtures VACÍO+NULLS; corre contra `next start`).
- **Dark de la escala de marca**: barrido aditivo extendido a `brand/accent/teal` (67 clases, 18 archivos) — corrige chips/links/estados activos que quedaban claros en oscuro (p. ej. ítem activo del clasificador de Contactos).

Verificación: probe de robustez ✔ (13 pantallas, 0 crashes en VACÍO y NULLS); recorrido dark de las 5 pantallas antes pendientes (Bandeja, Contactos, Configuración, Usuarios, Integraciones) capturado en ambos modos, sin bloques blancos. typecheck 22/22, build limpio, 23 tests web (131 en total). Nota fijada en docs: el harness usa `next start` (la CSP prohíbe `unsafe-eval`; `next dev` no hidrata).

## 2026-08-03 (5) — Modo oscuro pulido en TODO el panel + merge/deploy (PR #20)

**DESPLEGADO EN PROD 2026-08-03** (PR #20 mergeado a main y auto-deploy de Railway verificado en `www.tubot.cl`). Solo UI, sin migraciones ni backup. 39 archivos `.tsx`/`.css`; **ningún `.ts` de lógica**; typecheck 22/22, build limpio, **131 tests verdes**.

Cierre del pendiente de dark en páginas interiores con tres mecanismos **aditivos** (cero efecto en claro y en lógica): (1) barrido que añade la variante `dark:*` a 220 fondos/textos/bordes semánticos claros en 36 archivos; (2) base global de controles de formulario (`input/select/textarea` → `bg-panel`/`text-ink` salvo utilidad explícita), que elimina cajas blancas en oscuro en todos los formularios; (3) `navy-900` de contenido → `text-ink` (Agentes, Flujos, barra superior, landing, demo; el sidebar conserva su navy fijo a propósito). Overrides `.dark` para el canvas de Flujos (ReactFlow Controls/minimapa). Detalle en docs/DESIGN.md.

**Verificación Playwright (claro/oscuro)**: públicas contra prod (landing, login, demo) sin bloques blancos; panel contra build de producción local con sesión + API mockeada — Reportes, Plan y facturación, editor de Agentes, lista y canvas de Flujos, Horarios y lista de Agentes coherentes en oscuro. Método: `next start` (la CSP de prod prohíbe `unsafe-eval`, por lo que `next dev` no hidrata). Las pantallas restantes del harness (Bandeja, Contactos, Integraciones, Configuración, Usuarios) no se capturaron porque las fixtures sintéticas no completan todos los campos y disparan la error page de Next (no es un fallo de dark; comparten los mismos primitivos ya validados). Aceptación final real = alternar dark en la sesión viva.

**Pendiente reportado**: bloques de código de `/integrations/developers` como terminal oscuro intencional; sidebar colapsable a solo-íconos; envío optimista omitido (SSE ya instantáneo).

## 2026-08-03 (4) — Rediseño visual de la Bandeja + modo oscuro (rama `feature/inbox-redesign`)

Trabajo **exclusivamente visual**: ninguna funcionalidad de la Bandeja se agrega, quita ni cambia; todo lo que funcionaba sigue idéntico. Sin migraciones. No se tocó `apps/api/src/platform` ni `apps/web/src/app/admin`. Toda la UI en español. **CERO regresiones**: los tests de lógica (workflows/agents/scheduling/worker) siguen verdes y no hay tests de DOM que el remarcado pueda romper.

Sistema de diseño con tokens sobre CSS vars (Tailwind v4 `@theme inline`) que se voltean bajo `.dark`. **Modo claro 100% idéntico** al previo (los valores de token en claro son exactamente los slate anteriores); el **modo oscuro** se enciende con esos mismos tokens. Toggle en el pie del sidebar, persistido por usuario (`tubot-theme`), respeta `prefers-color-scheme` y sin parpadeo (script inline en el layout raíz). Un color de marca (azul, escala 50→900), neutros fríos, semánticos acotados, ámbar **reservado solo a «atención requerida»**. Superficies en capas (app/panel/raised) con borde 1px sutil y sombras e1/e2/e3, tipografía 11–20 con numerales tabulares, radios 6/10/16, foco visible. Página de muestra en `/design` + `docs/DESIGN.md`.

Commits por zona (CP1–CP8): CP1 tokens+dark+/design, CP2 sidebar+lista, CP3 cabecera (jerarquía: una acción primaria, Cerrar secundaria, resto agrupado), CP4 hilo (separadores Hoy/Ayer, eventos de sistema como líneas finas, comentarios/resumen IA como *note cards* con borde izquierdo — no bloque ámbar, resumen colapsable, botón flotante de scroll), CP5 panel de contacto + indicaciones IA como tarjeta de marca con chispa, CP6 compositor (barra de herramientas IA cohesionada + pestañas Responder/Comentario interno con fondo cálido en nota + estado elegante de ventana cerrada), CP7 micro-interacciones + atajos de teclado (`/`, `?`, `j/k`) + responsive, CP8 coherencia global (barrido determinista neutros→tokens en 44 archivos: shell, badges semánticos con variantes dark, y páginas de Contactos/Configuración/Flujos/Reportes/Billing/Integraciones).

Contraste **AA verificado** en ambos modos (texto primario/secundario ≥ 4.5; `ink-subtle` de metadatos 11px en AA-large ≥ 3.0). typecheck 22/22 y build de web limpios; tests verdes.

**Pendiente reportado** (no bloquea): envío optimista se omitió a propósito (el SSE ya se siente instantáneo); sidebar colapsable a solo-íconos no incluido; los bloques de código de `/integrations/developers` se dejan como terminal oscuro intencional; algunas páginas interiores tienen dark aproximado donde el barrido no alcanza colores semánticos puntuales.

## 2026-08-03 (3) — Pulido de /settings: 8 ajustes de usabilidad (rama `feature/settings-polish`)

**DESPLEGADO EN PROD 2026-08-03** (PR #19, migración settings_polish aplicada). Backup real DOBLE previo: snapshot manual de Railway (2026-08-03 15:06, 191 MB) + pg_dump 18.4 completo (81 tablas + datos → Downloads/pgdump-prod-pre-settings_polish-20260803-151115.sql). Runbook fijado en docs/DEPLOYMENT.md (pg_dump portable en C:/Users/Javier/pgtools). Smoke post-deploy ✔: 3 columnas nuevas con defaults correctos (agent_ids=[], type=instructions) y conteos idénticos al backup; smoke funcional a nivel de datos de los 3 puntos — logo round-trip byte-idéntico en files.content, aislamiento de plantilla por agente (A ve [A,todos] / B ve [todos]) y catálogo de 4 planes con Enterprise; los 5 endpoints nuevos del API rutean (401) y las páginas de /settings sirven 200.

Migración `20260803160000_settings_polish` (files.content para logo/avatar + prompt_templates.type/agent_ids) — **pendiente aplicar a prod**. Un commit por ajuste:

1. **Logo/avatar por subida** (opción B aprobada): validación server-side por MAGIC BYTES + dimensiones (parser propio, 4 tests — rechaza extensiones mentirosas y gigantes), resize a ≤512px en el navegador, files.content solo se lee en los endpoints que sirven la imagen; compat con logo por URL antiguo. Avatar personal en Mi perfil.
2. **Plan y facturación rediseñado**: plan actual con límites, uso con barras semáforo, TODOS los planes (Enterprise «A medida»), facturas, «Pagar ahora» → checkout existente (Flow CLP/Lemon Squeezy USD/Mock con banner de prueba) + método/proveedor de pago visibles. Decisión de pasarela confirmada como YA tomada (2026-07-31).
3. **Usuarios/Equipos separados**: /settings/teams página real (CRUD, miembros con buscador, conteo de conversaciones con deep-link /inbox?team=); invitación con **mensaje copiable para WhatsApp** (brecha anotada: falta invitación por token con expiración).
4. **Respuestas rápidas completa**: mini ejemplo visual, búsqueda/filtro, editor con picker de variables + preview, semilla de 5 ejemplos «edítame», ámbito Solo yo protegido server-side (test).
5. **Plantillas de prompt por agente**: tipo (5) + agent_ids ([]=todos); el menú del editor de agentes muestra la biblioteca del tenant filtrada para ese agente agrupada por tipo (test de aislamiento).
6. **Import con plantilla CSV**: descarga con columnas base+personalizadas y 2 ejemplos, BOM UTF-8, tabla de columnas aceptadas, import ampliado (etapa + campos personalizados + tags con |), round-trip probado con , y ;.
7. **Mi perfil** (personal): nombre, contraseña con actual obligatoria y requisitos en vivo, avatar; brecha: sin «cerrar sesión en todos los dispositivos» (JWT stateless). Fix de fuente única: moneda/idioma a organization.currency/locale.
8. **Preferencias de notificaciones** (por usuario, org.settings.notifPrefs): 5 toggles respetados por campana, escalamientos, resumen diario (opt-in), correo al asignarte conversación y export listo (tests de aislamiento entre usuarios).

22/22 typecheck · **131 tests**.

## 2026-08-03 (2) — Centro de Configuración del tenant (rama `feature/settings-hub`)

**DESPLEGADO EN PROD 2026-08-03** (PR #18, migración + setup.sql aplicados). Procedimiento: backup JSON de tablas afectadas + verificación estática (prisma migrate diff idéntico a la migración) → migración → RLS. Smoke test post-deploy ✔: columnas/tablas/políticas presentes, conteos idénticos al snapshot (33 etapas · 7 leads · 8 conversaciones · 9 contactos), /settings y /settings/lifecycle e /inbox y /users en 200 (redirección viva), y ciclo de expiración de exports probado en prod (registro vencido purgado por el tick del worker en <2 min; registro de prueba eliminado).

/settings estilo Workspace Settings de Respond.io: sidebar propio de dos niveles (6 grupos) con búsqueda por sinónimos y visibilidad por rol (server-side en cada endpoint). Migración `20260803120000_settings_hub` — **pendiente aplicar a prod (+ setup.sql por export_jobs y prompt_templates)**. Mapa completo en docs/SETTINGS.md.

- **Reubicación (una sola fuente de verdad)**: etapas del ciclo de vida → /settings/lifecycle (el engranaje de la Bandeja enlaza); snippets → /settings/snippets (el compositor enlaza); usuarios+equipos → /settings/users (con matriz de roles solo lectura; /users redirige); transcripción → /settings/ia (Canales enlaza); import CSV → /settings/import (modal compartido con Contactos).
- **Etapas PRO**: drag & drop, activar/desactivar sin borrar, separación activas vs perdidas/congeladas, categoría WON = conversión (badge «Conversión → CAPI»), borrar exige migrar los leads a otra etapa (auditado). Catálogo de workflows y Lead Ads consumen solo etapas activas.
- **Nuevo**: Información general (nombre/logo/rubro/zona horaria/moneda/idioma/contacto en settings.general); Horario de atención org con feriados de Chile 2026 precargables — DEFAULT del nodo «Fecha y hora» (deps.getBusinessHoursDefault; el nodo puede sobreescribir con horario propio); Campos de contacto (CRUD + orden + columnas); Etiquetas (CRUD + fusión + borrado con conteo); Conversaciones (auto-cierre por inactividad, bot retoma tras intervención a los N min, objetivo de 1.ª respuesta con ⏱ en la Bandeja) aplicadas por tick del worker cada 10 min; Ajustes de IA (modelo/tope/rondas SOLO lectura por decisión de julio + transcripción + idioma del asistente + biblioteca prompt_templates); Plan y uso (lectura de /billing/me); Exports en background (BullMQ → CSV en export_jobs, expira a 7 días con purga automática, descarga auditada y con permiso de Datos); Registro de auditoría (filtros + cursor, solo Owner/Admin).
- Tests nuevos: slugifyStageCode (codes estables al renombrar) y CSV de exports (escapado Excel). 22/22 typecheck · 112 tests.

## 2026-08-03 — Etapas del ciclo de vida editables (rama `feature/lifecycle-stages`)

Migración `20260803100000_lead_status_emoji` (columna emoji en lead_statuses) — **pendiente aplicar a prod**.

- **CRUD por tenant** (`/lifecycle-stages`, permiso leads:write): renombrar, cambiar emoji/color/categoría, reordenar (flechas), crear y eliminar (bloqueado si la etapa tiene leads). El `code` es estable → los workflows, reglas CAPI y bandejas guardadas siguen funcionando al renombrar.
- **UI**: engranaje en el grupo «Ciclo de vida» del clasificador → modal de gestión (estilo Respond.io) con sugerencias de emojis; emoji visible en sidebar, selector de la cabecera, badge de la lista, panel de contacto y selects del editor de workflows.
- **Estándar para organizaciones nuevas**: 🆕 Nuevo lead · 🔥 Lead caliente · 📅 **Reserva (code `schedule`)** · 🤩 Cliente (WON) · 🧊 Lead frío · 🚫 No contactar. La regla CAPI por defecto ahora apunta a `lead.status_changed:schedule` y Lead Ads cae a la primera etapa OPEN si el código configurado no existe (robusto ante renombres).
- Tenants existentes conservan sus etapas; ahora pueden editarlas desde la Bandeja.

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

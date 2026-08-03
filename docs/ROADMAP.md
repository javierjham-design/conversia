# Roadmap y backlog del MVP

Fases del brief (44) con estado real. ✅ hecho · 🔶 parcial · ⬜ pendiente.

## Fase 1 — Núcleo SaaS multi-tenant
- ✅ Monorepo pnpm+turbo, CI básico
- ✅ Esquema Prisma (~50 tablas) + RLS dinámico + FKs + rol de app
- ✅ Auth (registro/login/JWT) + contexto de tenant (ALS) + roles/permisos por org
- ✅ Organizaciones, sedes, equipos, auditoría, usage_events
- ✅ **Centro de Configuración /settings** (docs/SETTINGS.md): información general, horario de atención, plan y uso, usuarios+equipos+roles, etapas/campos/etiquetas/snippets/reglas de bandeja, IA, import/export/auditoría
- ⬜ Gestión de usuarios/invitaciones UI · ⬜ Cliente Prisma admin separado para operaciones de plataforma · ⬜ Archivos S3

## Fase 2 — Conversaciones y WhatsApp
- ✅ Webhook Meta (verify + firma HMAC) → cola → worker
- ✅ Resolución de tenant por número, contactos+identidades, conversaciones, mensajes idempotentes
- ✅ Envío (Meta real + Mock), estados sent/delivered/read
- ✅ Bandeja v0 (lista, chat, envío manual, tomar control / devolver a IA)
- ✅ **Bandeja Pro** (rama feature/inbox-pro, nivel Respond.io): 4 zonas — clasificador con conteos en vivo (fijas/agentes IA/ciclo de vida/equipos/bandejas personalizadas guardadas/bloqueados), lista con orden+badges+paginación, cabecera con etapa editable (trigger + oferta CAPI en conversión) + asignación usuario/equipo + semáforo 24 h, panel derecho de contacto con atribución de anuncio/formulario, **indicaciones al bot por conversación** (inyectadas al prompt con historial), comentarios internos, compositor con snippets "/", variables "$", emojis, adjuntos (media Meta), asistente IA (sugerir/mejorar/traducir) y Resumir
- ✅ Tiempo real: pub/sub Redis por tenant → SSE con fallback automático a sondeo · ✅ Media saliente imagen/documento · ✅ Plantillas + ventana 24h · 🔶 Multi-número UI (indicador por conversación; gestión en Canales) · ⬜ Nota de voz saliente

## Fase 3 — Agentes IA
- ✅ AIProvider (OpenAI gpt-4o-mini por defecto + Anthropic) vía RoutingAIProvider por modelo; transcripción de audio (Whisper); registro de costos por request
- ✅ Agentes + versiones publicables (seed + panel), prompts con variables
- ✅ 15 tools core validadas con zod (precios, agenda, lead, tags, KB, transferencias, cerrar/asignar/derivar, datos de contacto, disparar workflow, nota interna)
- ✅ Orquestador v0: agente activo por canal, loop de tools, transferencia agente↔agente y a humano; instrucciones NL por acción inyectadas al prompt
- ✅ **Editor de agentes en panel** estilo Respond.io (config, instrucciones con variables/tokens, acciones toggle+NL, plantillas genéricas)
- ✅ **Probador de conversaciones en vivo** (`/agents/:id/test`): lecturas reales + escrituras simuladas, respeta presupuesto, contabiliza uso
- ✅ Fuentes de conocimiento por agente (`config.knowledgeSources` filtra `searchKnowledge`)
- 🔶 RAG (búsqueda textual; falta pgvector+embeddings) · ⬜ A/B y métricas por versión · ⬜ Detección de intención/sentimiento como paso separado (Haiku)

## Fase 4 — Workflows
- ✅ Motor puro testeado: triggers, nodos v0, ramas, timers persistentes, cancelación por respuesta, idempotencia de runs
- ✅ Versionado (draft/published, el run fija su versión; publicar no altera la versión activa)
- ✅ **Editor visual de canvas** (React Flow): lista con estados/acciones, lienzo con disparador + nodos, panel por nodo, undo/redo, validación al publicar, serialización canvas↔JSON (con test de round-trip)
- ✅ **Nodos** ejecutables ampliados: + quitar etiqueta, actualizar contacto, asignar usuario/equipo, cambiar agente IA, disparar subflujo (además de los v0)
- ✅ **Disparadores**: conversación nueva/cerrada, mensaje con condiciones (palabra clave, primer mensaje); puente API→worker para eventos del panel
- ✅ **Modo prueba** (sandbox): recorre el flujo paso a paso sin efectos reales
- ✅ **Plantillas** genéricas (bienvenida, seguimiento sin respuesta, palabra clave, encuesta post-cierre)
- ✅ Atajo manual desde la bandeja ("Ejecutar flujo") + **disparo manual masivo** (run-bulk sobre contactos)
- ✅ **Catálogo ampliado** (rama feature/workflow-catalog): menú categorizado + buscador
  - Triggers: click_to_chat (CTWA + referral guardado), lead_status_changed (origen→destino), appointment_created, appointment_upcoming (recordatorio programado)
  - Pasos: open_conversation, add_note, goto (anti-bucle), business_hours, send_capi (CAPI directo con ctwa_clid + reintentos), ai_objective (agente con objetivo + ramas), call_api (Petición HTTP con guard SSRF + gating por plan)
- ✅ Pasos google_sheets_append (real, con OAuth Google por tenant), send_template (HSM), send_internal_email, send_ga4_event
- 🔶 **Próximamente** (estructura lista, brecha documentada): triggers cita cancelada/reprogramada, llamada perdida, anuncios TikTok · paso send_tiktok_event
- ✅ Disparador etiqueta agregada (`tag_added`): panel (bulk), tool IA, nodo de flujo y Lead Ads (el import CSV NO dispara, a propósito)
- ✅ ai_objective multi-turno (maxTurns + timeoutHours; respuestas del contacto re-evalúan y reanudan el run por rama; timeout → «unmet»)
- ⬜ pregunta→variable, condición multi-campo · ⬜ Métricas por nodo

## Fase 5 — Agendamiento e integraciones
- ✅ Contrato SchedulingProvider completo + MockSchedulingProvider (doble reserva) + ClarivaSchedulingProvider + mock server del contrato
- ✅ Selección de proveedor por tenant (scheduling_connections)
- ✅ Receptor de webhooks Cláriva (`POST /webhooks/clariva/:connectionId`, firma HMAC por conexión; proyección local de citas + triggers appointment_*/no_show)
- ✅ **Dentalink** (rama feature/integrations-enable): DentalinkSchedulingProvider contra la API real de Healthatom (token por tenant cifrado; disponibilidad = ventana laboral − citas reales; tests con fixtures)
- ✅ **Agenda personalizada** (contrato estándar + HMAC) y **Google Calendar** (espejo de citas Conversia→Google vía OAuth por tenant; googleEventId anti-duplicados)
- ✅ **Google Sheets** (paso de workflow real) · ✅ **HubSpot** (sync unidireccional de contactos sin duplicados + backfill) · ✅ **Correo/GA4/Events Manager/API personalizada/Zapier/Make** (ver PROGRESS 2026-07-31)
- ⬜ Meta Lead Ads + Conversions API (beta operativa) · ⬜ Recordatorios/confirmaciones programados (workflow plantilla existe; falta trigger appointment_upcoming automático) · ⬜ Google Calendar bidireccional (flag diseñado, sin implementación)

## Fase 6 — Piloto Digital Dent
- ✅ Tenant por seed JSON (org, sede Temuco, equipos, 17 estados de lead, 7 servicios, 3 profesionales placeholder, 3 agentes, 2 workflows, canal mock)
- ⬜ Datos reales (precios/profesionales/FAQ) · ⬜ Conectar número WhatsApp real · ⬜ Operación en paralelo + comparación · ⬜ Conexión Cláriva real

## Fase 7 — Nuevos clientes
- ✅ Segundo tenant demo por seed (prueba de aislamiento)
- ⬜ Onboarding UI 16 pasos · ⬜ Planes/límites activos (entidades listas) · ⬜ Facturación · ⬜ White-label · ⬜ Refresh tokens/2FA

## Próximos 10 tickets sugeridos (orden)
1. Levantar Postgres+Redis (Docker o Railway), `db:migrate + db:setup + db:seed`, probar E2E con simulador.
2. Test automatizado de aislamiento RLS (2 tenants, rol conversia_app).
3. Cliente Prisma admin separado para registro/lookup de ruteo.
4. Embeddings (OpenAI) + búsqueda pgvector en searchKnowledgeBase.
5. Trigger `appointment_upcoming` (scheduled_job por cita) para confirmaciones.
6. ✅ CRUD/editor de agentes y prompts en panel (editar borrador → publicar versión) + probador en vivo.
7. 🔶 Recepción de media: audio + transcripción (Whisper) hecho; falta imágenes/documentos.
8. ✅ Plantillas de WhatsApp (sincronización + nodo de workflow + envío desde bandeja fuera de ventana 24h) — 2026-07-31, feature/integrations. Además: webhooks entrantes por tenant (/hooks/t/{token} → trigger webhook_received), API keys + API pública v1, envío con token por-WABA, switch de transcripción, campana de incidencias y checklist de onboarding.
9. ✅ Editor visual de workflows (React Flow) sobre el JSON existente + modo prueba + plantillas.
10. Panel de métricas (conversaciones, conversión a cita, costo IA por tenant).

## Criterios de aceptación del MVP (sección 45 del brief)
Cumplidos por diseño/seed: 1,2,3,4(mock),5,6,7,8,9,10,11,12,17(textual),21,23,24,29(mock vs clariva),30. Pendientes de infraestructura levantada y verificación: el resto (requieren BD corriendo y panel ampliado).

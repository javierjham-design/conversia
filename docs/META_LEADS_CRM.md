# CRM de Leads de Meta + feedback al dataset (Conversions API)

Línea de trabajo 2026-08-18 (rama `feature/meta-leads-crm`, worktree paralelo).
Objetivo: operar TuBot (y cualquier tenant) como **app de Meta para Lead Ads**:
los leads de formularios entran al CRM, se gestionan por etapa del ciclo de
vida, y cada avance relevante **se reporta de vuelta a Meta** contra el dataset
de conversiones (optimización de campañas por calidad de lead, como ya opera
Cláriva CRM).

## Estado de partida (auditado 2026-08-18)

| Pieza | Estado |
|---|---|
| Webhook `page/leadgen` → pipeline (`parseLeadgenChanges` → `processLeadgen`) | ✅ mapeo, dedupe, etapa inicial, etiquetas, workflows, aviso al equipo |
| `campaign_id`/`ad_id` del lead | ❌ se pedían a Graph pero se descartaban |
| `leadgen_id` accesible para CAPI | ❌ solo en `contact.attributes.metaLead` |
| CAPI reglas por etapa (`lead.status_changed:<code>`) | ✅ motor + UI |
| CAPI `user_data` | 🔶 solo `ph` (hash) + `ctwa_clid`; sin `lead_id` ni `em` → match débil para leads de formularios |
| Cambio de etapa desde la bandeja | ❌ emitía sin `statusCode` ni teléfono → las reglas CAPI por etapa NO disparaban desde el panel |
| Tablero CRM (pipeline por etapa) | ❌ no existía (solo lista de contactos con filtros) |
| App TuBot suscrita a `page/leadgen` | ❌ solo `whatsapp_business_account` (verificado por MCP) |
| App Review TuBot | ACTIONED 2026-08-08: `whatsapp_business_messaging/management` + `business_management` **APROBADOS avanzado**; `whatsapp_business_manage_events` y `email` rechazados. `leads_retrieval` nunca se pidió — para formularios de páginas del MISMO Business (caso TuBot) basta acceso estándar + token de Usuario del Sistema (así opera Cláriva CRM). |

## Bloques

**A — Circuito CAPI de leads (worker+types+api):** el lead persiste
`leadgenId/formId/campaignId/adId` estructurados (en `lead.meta` y
`contact.attributes.metaLead`); `CapiJob` lleva `contactId` y el worker arma
`user_data` con `ph`+`em` (SHA-256) y **`lead_id`** cuando el contacto vino de
un formulario; `action_source = system_generated` para eventos con `lead_id`
(integración CRM de Meta), `chat` para el resto. Fix: la bandeja emite
`lead.status_changed` con `statusCode`+teléfono+contactId (antes las reglas por
etapa no disparaban desde el panel).

**B — Tablero CRM `/crm` (api+web):** kanban por etapa del ciclo de vida;
tarjetas con nombre, canal de origen (formulario Meta/campaña, WhatsApp,
import), tiempo en etapa y acceso a conversación/ficha; mover de etapa emite el
`lead.status_changed` canónico (mismo camino que alimenta CAPI y workflows);
filtros por origen/formulario/búsqueda.

**C — Setup Lead Ads del Centro Meta (api+web+docs):** con el token de la
conexión: listar páginas del Business, registrar página + formularios como
`meta_assets` (ruteo de webhooks) y **suscribir la app a la página**
(`{page}/subscribed_apps` con `leadgen`, token de página derivado). Todo desde
el panel, sin pasos manuales en Graph Explorer.

**Producción TuBot (operacional):** suscripción app-level `page/leadgen` al
webhook existente (`/webhooks/whatsapp`, ya parsea leadgen y verifica firma) —
se hace vía MCP devtools; luego, desde el panel del tenant TuBot: cargar token
de Usuario del Sistema, conectar la página, elegir formularios, configurar
dataset + reglas por etapa.

## Decisiones

- Sin migraciones: `lead.meta` y `contact.attributes` (JSON) ya existen.
- `event_id` de CAPI se mantiene (dedupe org+source+lead+ts).
- El match de reglas sigue por `source` (`lead.created`, `lead.status_changed:<code>`);
  no se agrega otro mecanismo.
- La verdad del embudo vive en el CRM (etapas del tenant); Meta solo recibe la
  proyección configurada en las reglas del dataset.

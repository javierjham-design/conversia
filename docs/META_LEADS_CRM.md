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

**Producción TuBot (operacional) — DECISIÓN 2026-08-19: app de Meta SEPARADA
«TuBot CRM»** (patrón Cláriva CRM: la app de WhatsApp y la app de CRM son
distintas). La plataforma soporta ambas a la vez:

- **Webhook dedicado**: `POST /webhooks/meta-crm` (topic `page`, campo
  `leadgen`) con `META_CRM_APP_SECRET` + `META_CRM_VERIFY_TOKEN` propios; el
  payload entra al MISMO pipeline inbound. Sin esas envs cae a las de la app
  principal (setup de una sola app sigue funcionando).
- **`appsecret_proof` multi-app**: `fetchGraphWithProof` (config) prueba el
  secret de la app principal y, si Graph acusa proof inválido, reintenta con el
  de TuBot CRM (cachea el ganador por token). Aplica a lectura de leads,
  envío CAPI, inspección de tokens y setup de páginas.

Checklist de alta de la app TuBot CRM (usuario):
1. developers.facebook.com → Crear app (tipo Negocio) «TuBot CRM» en el
   portafolio TuBot. Copiar App ID + App Secret.
2. Railway (api + worker): `META_CRM_APP_SECRET` = secret de la app;
   `META_CRM_VERIFY_TOKEN` = valor nuevo cualquiera (p. ej. UUID).
3. Webhooks de la app: suscribir topic `page`, campo `leadgen`, callback
   `https://api-production-cf8e.up.railway.app/webhooks/meta-crm`, verify token
   = el mismo `META_CRM_VERIFY_TOKEN` (o vía MCP `devtools_webhook_manage`
   cuando la app esté concedida al MCP).
4. Business Manager: Usuario del Sistema con la página asignada → generar token
   BAJO LA APP TuBot CRM (scopes `pages_show_list`, `pages_manage_metadata`,
   `leads_retrieval`, `pages_read_engagement`, `business_management`; para la
   página propia basta acceso estándar) → cargarlo en el panel del tenant
   (Centro Meta → token) y **Conectar la página** en Lead Ads.
5. Conversions API: dataset + reglas por etapa (el dataset puede vivir en
   cualquiera de las dos apps; el envío usa el token del tenant).

## Decisiones

- Sin migraciones: `lead.meta` y `contact.attributes` (JSON) ya existen.
- `event_id` de CAPI se mantiene (dedupe org+source+lead+ts).
- El match de reglas sigue por `source` (`lead.created`, `lead.status_changed:<code>`);
  no se agrega otro mecanismo.
- La verdad del embudo vive en el CRM (etapas del tenant); Meta solo recibe la
  proyección configurada en las reglas del dataset.

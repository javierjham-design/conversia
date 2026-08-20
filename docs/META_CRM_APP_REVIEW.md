# App Review — TuBot CRM (1549466139496246)

Verificado por MCP 2026-08-20: `can_submit: true`, privacidad ✓, negocio
verificado ✓, Tech Provider verificado heredado. App Activa, icono y URLs OK.

## Permisos a solicitar (una sola submission)

**Mensajería (urgente — Digital-Dent):** `pages_messaging`, `instagram_basic`,
`instagram_manage_messages`.
**Lead Ads (mismo viaje):** `leads_retrieval`, `pages_manage_ads`.
**Soporte de ambos:** `pages_show_list`, `pages_manage_metadata`,
`pages_read_engagement`. (`business_management` solo si el formulario lo exige
como dependencia.)

## Texto base (inglés) — adaptar por permiso

> TuBot CRM is a multi-tenant conversational CRM for SMBs (tubot.cl). A business
> connects its own Facebook Page and Instagram professional account via
> Facebook Login for Business. We use {PERMISSION} to {USE}. Messages/leads are
> only processed for the business that owns the assets; data is stored per
> tenant with row-level isolation and never shared. Deletion instructions:
> https://tubot.cl/legal/eliminacion-datos

USE por permiso:
- pages_messaging: receive and reply to Messenger messages of the connected
  Page in our shared inbox, including AI-assisted replies the business
  configures.
- instagram_manage_messages (+instagram_basic): same for Instagram Direct of
  the linked professional account.
- leads_retrieval: fetch lead details when Meta sends the leadgen webhook so
  the lead appears instantly in the business CRM.
- pages_manage_ads: list the Page's lead forms so the business selects which
  forms feed the CRM.
- pages_show_list / pages_manage_metadata / pages_read_engagement: list Pages
  during connection and subscribe the app to the Page's webhooks.

## Screencast (uno puede cubrir varios permisos)

1. Login en tubot.cl → Integraciones → Meta CRM.
2. "Conectar con Meta" → diálogo OAuth → elegir portafolio/página/IG → aceptar.
3. "Conectar" la página → se ven formularios registrados (leads_retrieval,
   pages_manage_ads, pages_show_list, pages_manage_metadata).
4. Herramienta de prueba de Lead Ads → lead aparece en /crm (leads_retrieval).
5. Enviar DM a la IG conectada y mensaje a la página → aparecen en la Bandeja
   y el agente responde (instagram_manage_messages, pages_messaging).
6. Mostrar desconexión (Integraciones → Meta CRM → Desconectar).

Usuario de prueba para el revisor: mismo patrón que la review de WhatsApp
(usuario dedicado con acceso al tenant demo; NO desactivarlo durante la review).

## Mitigación del gap (Respond muere hoy; review tarda días)

- WhatsApp de Digital-Dent: ya opera en TuBot — sin gap.
- IG/Messenger de Digital-Dent (público): hasta la aprobación, los DMs de
  pacientes NO se entregan a ningún sistema. Mitigar HOY con respuestas
  automáticas nativas de Instagram/Página ("Te atendemos por WhatsApp:
  wa.me/56452781983") + link de WhatsApp en la bio.
- Los DMs de cuentas con rol en la app (Javier) SÍ llegan ya → sirve para
  validar el circuito en producción mientras se espera.

## Dónde se hace

developers.facebook.com/apps/1549466139496246 → Revisión de la app →
Permisos y funciones → "Solicitar acceso avanzado" en cada permiso → completar
formulario + subir screencast → Enviar para revisión.

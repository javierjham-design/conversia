# Omnicanal: Instagram Direct + Facebook Messenger

Línea iniciada 2026-08-19 (rama `feature/omnichannel-messaging`). Objetivo:
recibir DMs de Instagram y mensajes de Messenger en la bandeja, que los agentes
de IA los atiendan igual que WhatsApp, y que disparen los flujos.

## Arquitectura (decidida sobre lo ya construido)

- **App de Meta**: la app **TuBot CRM** (1549466139496246) — la misma del CRM de
  Lead Ads. Su webhook `/webhooks/meta-crm` ya recibe el topic `page`; se
  agregan los campos `messages` (Messenger) y el topic `instagram` con
  `messages` (por MCP `devtools_webhook_manage update_fields`/`subscribe`).
- **Ruteo por tenant**: igual que leadgen — por `meta_assets` (kind `page`; se
  agrega kind `instagram` registrando `page.instagram_business_account` al
  conectar la página en /integrations/meta-crm).
- **Parser**: `apps/worker/src/messaging-events.ts` (puro, con tests) — hecho ✅.
- **Enums**: `ChannelType` += `INSTAGRAM`, `MESSENGER` (migración
  `20260819060000`, aditiva) — hecho ✅.
- **Triggers**: el motor YA soporta la condición `channel` en
  `message_received` (`cfg.channel` vs `data.channel`) — el inbound de los
  canales nuevos debe despachar `data.channel = "instagram" | "messenger"` (y
  el de WhatsApp `"whatsapp"`); el formulario del trigger expone el selector.

## Bloques restantes

**B2 — Ingesta completa (worker):** en el events/inbound pipeline, tras
`parseMessagingEvents`: resolver tenant por asset → auto-crear
`ChannelConnection` (type MESSENGER/INSTAGRAM, config `{pageId|igId}`,
credencial = token de página cifrado, derivado al conectar la página) →
`contact_identity` (channelType nuevo, externalId PSID/IGSID; perfil vía Graph
`/{psid}?fields=first_name,last_name` o `/{igsid}?fields=name,username` con
token de página) → conversación + mensaje idempotente (mid) → los MISMOS
dispatchEvent (`conversation_started`/`message_received` con `data.channel`) y
turno del agente. OJO: el contacto puede NO tener teléfono (identidad solo de
red social) — el CRM ya lo tolera (phone nullable).

**B3 — Salida:** `processOutbound`/`agent-turn` hoy asumen WhatsApp
(`resolveChannelAuth` por phoneNumberId + `contact.phone`). Refactor: resolver
el canal por `conversation.channelConnectionId` y elegir proveedor por
`channel.type`:
- Messenger: `POST /{page_id}/messages` `{recipient:{id:PSID},
  message:{text}, messaging_type:"RESPONSE"}` con token de página.
- Instagram: `POST /{page_id}/messages` con `recipient:{id:IGSID}` (la
  mensajería IG va por la página vinculada).
- **Ventana de 24 h** (ambas redes): si el último inbound > 24 h, marcar FAILED
  con error claro (no existen plantillas HSM; los message tags quedan fuera del v1).

**B4 — UI + producción:** Canales muestra los canales IG/Messenger
auto-creados (icono por tipo, sin phoneNumberId); bandeja con badge de red por
conversación; /integrations/meta-crm paso "Mensajería" (activar por página);
suscripciones app-level por MCP; catálogo de integraciones: Instagram/Messenger
pasan de "proximamente" a beta. **App Review** de la app TuBot CRM:
`pages_messaging`, `instagram_basic`, `instagram_manage_messages` (en modo
Desarrollo solo cuentas con rol en la app pueden escribirle a la página — igual
que fue WhatsApp; para público real: app Activa + acceso avanzado).

## Permisos del token (Usuario del Sistema, app TuBot CRM)

El token ya cargado en el tenant TuBot trae pages_*; para mensajería sumar
`pages_messaging` + `instagram_basic` + `instagram_manage_messages` al
regenerar (y la cuenta IG debe estar vinculada a la página en Meta Business).

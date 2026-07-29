# WhatsApp (Meta Cloud API)

## Arquitectura

- **Entrada**: `POST /webhooks/whatsapp` (apps/api) → verificación de firma HMAC → encolar crudo → ACK 200 inmediato. El worker parsea, resuelve tenant por `metadata.phone_number_id` (tabla `whatsapp_phone_numbers`, id de Meta único global) y procesa con idempotencia por `wamid`.
- **Salida**: `ChannelProvider` (`apps/worker/src/channel-providers.ts`): `MetaChannelProvider` (Graph API `/{phone_number_id}/messages`) o `MockChannelProvider` (dev). Selección por `WHATSAPP_PROVIDER`.
- **Estados**: webhooks `statuses` actualizan messages a SENT/DELIVERED/READ/FAILED.
- **Multi-número/multi-tenant**: cada número (waba + phone_number_id) pertenece a una organización y puede fijar sede, canal, agente por defecto y reglas de ruteo (`routing` Json).

## Configurar un número real (checklist para el tenant piloto)

1. Meta Business + App con producto WhatsApp; número verificado.
2. `.env`: `WHATSAPP_PROVIDER=meta`, `META_ACCESS_TOKEN` (token permanente de sistema), `META_APP_SECRET`, `META_VERIFY_TOKEN` propio.
3. Configurar webhook en Meta → URL pública `https://<api>/webhooks/whatsapp`, suscribirse a `messages`; Meta hace GET con `hub.challenge` (la API responde sola).
4. Insertar `whatsapp_accounts` + `whatsapp_phone_numbers` (phone_number_id de Meta) del tenant + `channel_connections` tipo WHATSAPP_CLOUD con `default_agent_id`.
5. Probar con un mensaje real; verificar en la bandeja.

## Reglas de plataforma a respetar (estado de conocimiento — validar contra docs de Meta al conectar)

- **Ventana de 24 h**: mensajes libres solo dentro de la ventana de servicio; fuera de ella, solo plantillas aprobadas. *Por implementar: chequeo de ventana antes de enviar + fallback a plantilla.*
- **Precios**: Meta cobra por plantilla/mensaje según categoría y país (cambió en jul-2025; conversaciones de servicio gratuitas). **Por validar** tarifas exactas CL al facturar.
- **Plantillas**: creación/aprobación por WABA; tabla `whatsapp_templates` lista para sincronización (pendiente job de sync).
- Límites de envío por tier del número; opt-out (`do_not_contact`) se respeta en workflows.

## Simulador

`node scripts/simulate-inbound.mjs --phone 569XXXXXXXX --text "hola" --org digital-dent` genera el payload exacto de Meta con `phone_number_id = mock:<slug>` — mismo pipeline, sin credenciales.

## Pendiente

Media entrante (descarga por media_id) y saliente · plantillas + ventana 24h · reacciones/replies · varios números por tenant en panel · webhook de calidad/baneo del número → system_alerts.

## Embedded Signup: elegir negocio + crear WhatsApp nueva

El botón "Conectar con Meta" (página **Canales**) usa el Embedded Signup vía JS SDK:
`FB.login({ config_id, response_type:"code", override_default_response_type:true, extras:{ setup:{}, featureType, sessionInfoVersion:"3" } })`.

- `setup:{}` (vacío) → Meta deja **elegir el negocio (portfolio)** cuando el usuario administra varios, y **crear una WABA nueva** o usar una existente.
- `featureType` = `META_ES_FEATURE_TYPE` (default `""` = flujo completo con creación; `only_waba_sharing` = solo compartir una WABA existente).
- Del evento `WA_EMBEDDED_SIGNUP` capturamos `waba_id`, `phone_number_id` y `business_id`; el negocio se guarda en `whatsapp_accounts.business_id` y se muestra al terminar.

**Si NO aparece "crear cuenta nueva" o el selector de negocio**, es configuración de Meta, no del código:
1. `META_CONFIG_ID` debe ser una configuración de **Embedded Signup de WhatsApp** (App Dashboard → WhatsApp → Embedded Signup / Facebook Login for Business con el producto WhatsApp), **no** un login genérico de `business_management`.
2. La config **no** debe estar fijada a un negocio concreto (deja que el usuario elija).
3. La app necesita **acceso avanzado** a `whatsapp_business_management`, `whatsapp_business_messaging` y `business_management` (App Review), y estar en modo Live.
4. El dominio del panel debe estar en los **dominios permitidos** del Facebook Login.

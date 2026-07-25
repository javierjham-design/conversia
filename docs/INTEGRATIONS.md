# Integraciones

Modelo: `integration_connections` (proveedor + config + estado + última sync) con credenciales cifradas en `integration_credentials` (AES-256-GCM por tenant). Webhooks salientes: `webhook_endpoints` (URL + secreto HMAC + eventos suscritos) con entregas y reintentos en `webhook_deliveries`.

| Proveedor | Estado | Notas |
|---|---|---|
| WhatsApp Cloud (Meta) | ✅ v0 | Ver WHATSAPP.md |
| Cláriva (agenda) | ✅ cliente + mock | Contrato preliminar en CLARIVA.md |
| Mock agenda | ✅ | Dev/tests |
| Dentalink | ⬜ | Adaptador SchedulingProvider (misma interfaz) |
| Google Calendar | ⬜ | OAuth por tenant + adaptador |
| Meta Lead Ads | ⬜ | Webhook leadgen → crear lead + workflow `lead_created` |
| Meta Conversions API | ⬜ | Evento de conversión al agendar (medición de campañas) |
| Google Sheets / Correo / SMS | ⬜ | Nodos de workflow |
| APIs personalizadas | ⬜ | Nodo `call_api` — requiere protección SSRF antes de habilitar (SECURITY.md) |

Regla: toda integración nueva se implementa como adaptador de una interfaz de `@conversia/types` + mock, nunca inline en el worker.

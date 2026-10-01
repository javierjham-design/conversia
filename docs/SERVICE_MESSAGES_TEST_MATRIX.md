# Matriz de pruebas — mensajes de servicio (plan servicio-octubre-2026)

Casos verificados por etapa. Las etapas E3–E5 agregan sus filas.

## E2 — Medición + reembolso W-2

| # | Caso | Entrada | Esperado | Estado |
|---|------|---------|----------|--------|
| 1 | Servicio antes del cobro | mensaje de servicio, `at=2026-09-30T23:59:59Z`, schedule cargado, sobre free tier | `usage_event`/asiento con `costUsd=0` | ✅ test |
| 2 | Servicio desde el 1-oct | mensaje de servicio, `at=2026-10-01T00:00:00Z`, sobre free tier | `costUsd=0.02` (CL, del schedule) | ✅ test |
| 3 | Dentro del free tier | mensaje de servicio, contador del número ≤ 1.000 | `costUsd=0` (sin importar fecha) | ✅ test |
| 4 | Asiento de servicio | cualquier envío de servicio OK | `wallet_ledger` reason `service_send`, `delta=0`, `category=service`, no altera balance | ✅ test |
| 5 | Idempotencia de medición | mismo `messageId` dos veces | un solo asiento `service_send` | ✅ test |
| 6 | Categoría desconocida (débito) | plantilla con categoría no mapeada | peso 1, categoría CRUDA en el ledger, `console.warn` | ✅ test (normalizeCategory) |
| 7 | Categoría desconocida (webhook) | status con `pricing.category` no reconocida | `usage_event` con costo 0 + `integrationEvent` `pricing.unknown_category` + warn | ✅ código (alerta) |
| 8 | Webhook no facturable | status con `pricing.category` y `billable=false` | se registra igual, con `meta.billable=false` | ✅ código |
| 9 | W-2 fallo terminal (plantilla) | send de plantilla falla definitivo (outbound/motor) | `refundForMessage` devuelve la bolsa una vez | ✅ test |
| 10 | W-2 doble fallo | dos fallos del mismo mensaje | devuelve UNA sola vez | ✅ test |
| 11 | W-2 asíncrono (webhook failed) | status `failed` de un mensaje que era TEMPLATE | refund por el webhook | ✅ código |
| 12 | W-2 servicio | mensaje de servicio falla | sin refund (delta 0, nada que devolver) | ✅ por diseño |
| 13 | N2 reintento transitorio | fallo transitorio, no último intento | mensaje queda PENDING + throw (BullMQ reintenta); sin FAILED ni doble envío | ✅ código |
| 14 | N2 último intento | fallo transitorio en el último intento | FAILED + refund si era plantilla | ✅ código |
| 15 | N3 escalación por el gate | plantilla HSM de escalación | pasa por `chargeTemplateSend` (bolsa/fusible); bloqueo → no envía + `template.blocked` | ✅ código |

**Prueba de humo local** (requiere worker + Postgres + Redis arriba):

```
node scripts/simulate-inbound.mjs --phone 569XXXXXXXX --text "hola" --org digital-dent
```

Verificar: asiento `service_send` en `wallet_ledger` (delta 0) y, al simular el status del envío, el `usage_event` `whatsapp_message` con su `meta.category`/`meta.billable`.

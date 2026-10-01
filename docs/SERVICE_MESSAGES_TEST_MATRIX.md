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

## E4 — Una sola respuesta por turno

| # | Caso | Entrada | Esperado | Estado |
|---|------|---------|----------|--------|
| 16 | Regla no desactivable | cualquier agente de cualquier tenant | el CORE_SCOPE_PREAMBLE antepone la regla 6 "una sola respuesta por turno" | ✅ código |
| 17 | Turno normal | el agente responde | 1 message TEXT del agente | ✅ invariante (orquestador → 1 reply; punto único de creación) |
| 18 | Transferencia entre agentes | depth 0 → depth 1 | 2 messages (uno por agente): el tope aplica por invocación | ✅ por diseño (depth) |
| 19 | Agente que produjera 4 textos en un turno | multi-texto (hipotético futuro) | sale UNO solo (fusión con `mergeAgentTextParts`); cinturón `console.warn` si se excede | ✅ test helper + guarda |
| 20 | Adjunto / plantilla | IMAGE/DOCUMENT/TEMPLATE | exentos de fusión (message propio) | ✅ por diseño |

### Métrica bloque 4 — mensajes salientes del bot por conversación

Promedio de mensajes del bot por conversación (30 días). **ANTES**: medir el día del deploy; **DESPUÉS**: a los 7 días con la misma consulta.

```sql
SELECT ROUND(AVG(n), 2) FROM (
  SELECT COUNT(*) n FROM messages
  WHERE direction = 'OUTBOUND' AND author_type = 'AGENT'
    AND type NOT IN ('TEMPLATE', 'SYSTEM', 'NOTE') AND visibility = 'PUBLIC'
    AND created_at >= now() - interval '30 days'
  GROUP BY conversation_id
) x;
```

- **ANTES (valor):** _pendiente — requiere acceso de solo lectura a prod (OK-1)._ Se espera ≈ 1,0 (el invariante ya se cumplía; esta etapa lo consolida).

**Prueba de humo local** (requiere worker + Postgres + Redis arriba):

```
node scripts/simulate-inbound.mjs --phone 569XXXXXXXX --text "hola" --org digital-dent
```

Verificar: asiento `service_send` en `wallet_ledger` (delta 0) y, al simular el status del envío, el `usage_event` `whatsapp_message` con su `meta.category`/`meta.billable`.

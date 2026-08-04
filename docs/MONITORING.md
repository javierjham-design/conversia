# Monitoreo y alertas — mínimo viable

Objetivo: que si algo se cae a las 2 AM (webhook, worker, cola, DB/Redis) **te
avise al teléfono**. Costo objetivo ≤ 30 USD/mes.

## Qué expone la plataforma (ya implementado)

- **`GET /health`** — liveness simple (sin dependencias). Para el balanceador.
- **`GET /health/status`** — health **profundo** para el monitor externo. Chequea:
  - **Base de datos** (`SELECT 1`).
  - **Redis** (`PING`).
  - **Worker vivo** — el worker escribe un latido en Redis cada 15 s
    (`conversia:health:worker`, TTL 60 s); si supera 90 s, se marca caído.
  - **Colas** — backlog de `inbound + outbound + events` (esperando/retrasadas y
    fallidas). Umbrales: alerta si esperando ≥ 500 o fallidas ≥ 100.
  - Responde **200** si todo OK, **503** si algo crítico falla (con el detalle por
    check en el cuerpo).
  - Protegido opcionalmente con `MONITOR_TOKEN` (header `x-monitor-token`).

Ejemplo de respuesta 503:
```json
{ "ok": false, "checks": {
  "database": { "ok": true },
  "redis": { "ok": true },
  "worker": { "ok": false, "detail": "sin latido" },
  "queues": { "ok": true, "detail": "esperando 3 · fallidas 0" }
}}
```

## Opción recomendada: BetterStack (Better Uptime)

La opción **más simple que llama/SMS al teléfono**. Plan gratuito incluye monitores
HTTP + alertas por **push (app), email y llamada telefónica/SMS** con escalado.

### Pasos (10 min, sin tocar código)
1. Crear cuenta en betterstack.com → **Uptime**.
2. **Definir `MONITOR_TOKEN`** en las variables del servicio API en Railway (un valor
   aleatorio largo). Sin él, `/health/status` queda público (solo métricas de infra,
   sin datos de tenant — aceptable, pero mejor protegerlo).
3. Crear **Monitor 1 — API profundo**:
   - URL: `https://api-production-cf8e.up.railway.app/health/status`
   - Método: GET · **Espera 200** (cualquier otro código = incidente).
   - Header: `x-monitor-token: <MONITOR_TOKEN>`.
   - Frecuencia: 1–3 min.
4. Crear **Monitor 2 — Web pública** (opcional): `https://www.tubot.cl` espera 200.
5. Crear **Monitor 3 — Webhook de WhatsApp** (verificación GET):
   `https://api-production-cf8e.up.railway.app/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=<META_VERIFY_TOKEN>&hub.challenge=ping`
   → espera 200 con cuerpo `ping`. Detecta si el receptor de Meta se cayó.
6. En **On-call / Escalation**: agregar tu teléfono → alerta por **llamada + push**
   si un monitor lleva caído > 2–3 min. Instalar la app de BetterStack (push gratis).

Con esto cubres: **webhook caído** (monitor 3), **worker muerto / cola atascada /
Redis o DB caídos** (monitor 1, que devuelve 503), y **web caída** (monitor 2).

### Alternativa aún más barata
**UptimeRobot**: gratis para HTTP cada 5 min con alerta por email/push; llamada/SMS
solo en plan pago (~US$7–29/mes). Sirve igual apuntando a los mismos 3 endpoints.

## Integraciones en error (nivel tenant)

Los errores por tenant (token de WhatsApp vencido, integración caída) ya se registran
en `integration_events` y se ven en la **campana de incidencias** del panel. No
disparan alerta telefónica a propósito (un token vencido de un cliente no debe
despertarte). Si más adelante quieres alerta agregada, se puede exponer el conteo de
errores recientes en `/health/status` como check "warning" (no-crítico).

## Pendiente (no bloqueante)
- Panel de alertas in-app (`system_alerts`) para el Super Admin.
- Métrica de tasa de fallos de envío como serie temporal.

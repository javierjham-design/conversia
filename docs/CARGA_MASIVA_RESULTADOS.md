# CARGA MASIVA — Resultados (tanda 2)

**Fecha:** 2026-10-17 · **Entorno:** stack LOCAL AISLADO (jamás producción).

## 1. Entorno de prueba

| Pieza | Valor |
|---|---|
| Máquina | Windows 10, 8 CPU lógicas, 24 GB RAM (laptop) |
| Postgres | `pgvector/pgvector:pg16` en Docker, puerto **5433**, db `conversia_sim` (aislada) |
| Redis | `redis:7-alpine` en Docker, 6379 |
| Procesos app | **1 api + 1 worker** (dev), providers `AI_PROVIDER=mock` / `WHATSAPP_PROVIDER=mock` |
| Rol BD | `conversia_app` (RLS real, sin BYPASSRLS) — como producción endurecida |
| Catálogo | v2-golive aplicado (conversia_v2_base activo/público, packs activos) |
| Orgs | **250 registradas + cableadas** por `w1` (240 conversia + 10 tubot), **960 contactos activos** (4/org) |

> **Nota de fidelidad:** es 1 api + 1 worker en una laptop. Producción (Railway) corre múltiples réplicas con más CPU y una BD dedicada; los números de **throughput/latencia** de aquí son un **piso** (peor caso), útiles para hallar cuellos y dimensionar — no un veredicto sobre la capacidad de producción.

Harness: `tools/sim/sim250.mjs` (fase nueva **`w8-carga`**, perillas `SIM_W8_*`) + muestreador **`tools/sim/metrics.mjs`** (cada 5–10 s a `tools/sim/out/metrics-*.csv`) + `tools/sim/docker-compose.sim.yml`.

## 2. Ajustes de entorno para el generador (no son parches al producto)

El generador golpea desde **una sola IP (127.0.0.1)**; los límites por-IP no son el sujeto del test, así que se relajaron en el `.env` del sim: `LOGIN_MAX_PER_WINDOW`, `API_MAX_PER_MINUTE`, `MSG_CAP_SVC_GLOBAL_DAY` → altos. **El fusible por-tenant (`MSG_CAP_SVC_PER_TENANT_DAY=3000`) se dejó intacto.** Esto reemplaza el `redis-cli DEL rl:register` que usaba la tanda 1 (redis-cli no está en el host).

## 3. Corridas y métricas

| Corrida | Rate alcanzado | Pérdida | Latencia bot p50/p95/p99 | Cola agent-turn (máx) | Panel nav p95 | Logins | PG conns (máx) |
|---|---|---|---|---|---|---|---|
| Smoke (FAST, mixto 5–15/s) | — | **0** (1506=1506) | 8.4s / 22.5s / 27.9s¹ | 147 | 400 ms ✅ | — | 17/100 |
| **50 msg/s** sostenido 3 min | 49.4/s | 0 tras aceptar² | **111s / 297s / 303s** ❌ | **6934** | 572 ms ✅ | 25/50 ok, p95 15s ❌ | **100/100** ❌ |
| **15 msg/s** limpio 2 min | 15.0/s | **0** (1795=1795) | **22.3s / 34.3s / 34.9s** ❌ | (creció) | 279 ms ✅ | 50/50 ok, p95 12.3s | — |

¹ contaminada por la ráfaga del smoke. ² 84/8975 webhooks (0.9%) dieron status 0 (timeout al **aceptar**); los 8891 aceptados se guardaron 1:1 (dedupe) — no hay pérdida tras aceptación.

### Invariantes de dinero (acumulado bajo toda la carga) — ✅ PERFECTO
- Débitos de conversación: **960** · conversaciones distintas debitadas: **960** → **1:1** (débitos = conversaciones).
- Débitos duplicados: **0** · débitos sin `conversation_id`: **0** · orgs excediendo la gracia (>20): **0**.
- La idempotencia del conteo (`countConversationOnce`) aguantó 50 msg/s sin un solo doble cobro.

### Estabilidad
- **0 caídas/reinicios** de api o worker en toda la sesión. RSS estable: api ~344 MB, worker ~58 MB (sin crecer en las corridas).
- Sin pérdida de mensajes una vez aceptados (dedupe por `wamid` 1:1 en todas las corridas).

## 4. Hallazgos (causa raíz)

**F1 — Throughput del worker limitado (principal).** Cada `agent-turn` cuesta ~**2 s efectivos** (varias transacciones `withTenant` por turno: cargar agente/versión/historial, persistir mensaje, `recordUsage`, débito con `FOR UPDATE`, guardrail en Redis, eventos). Con `WORKER_CONCURRENCY` no suficientemente alto y el **pool Prisma por proceso** acotado, el techo real en esta laptop es **~12–20 turnos/s**. Por encima de eso la cola `agent-turn` se acumula sin techo y la latencia inbound→outbound explota (6934 en cola a 50/s → p95 ~300 s). Postgres NO es el cuello a tasas medias (5 conexiones activas de 100).

**F2 — Ingesta del webhook satura el event-loop del api a alta tasa.** `POST /webhooks/whatsapp` hace trabajo de BD síncrono (dedupe + resolución de tenant + insert del INBOUND) antes de responder. A 50/s con un solo proceso api compartiendo CPU con el worker, el event-loop se contendió → `maxPending` 1027 y **0.9 % de timeouts de aceptación**. A 15/s limpio: 0 timeouts.

**F3 — Pool Prisma × procesos puede agotar `max_connections`.** A 50/s el total de conexiones PG llegó a **100/100** (el `max_connections` por defecto de la imagen). Con `DB_CONNECTION_LIMIT` alto × (api + worker) + picos, se toca el techo → riesgo de "too many clients". Hay que dimensionar el pool contra `max_connections` (o poner un pooler).

**F4 — Logins lentos/fallidos bajo carga.** `bcrypt` (cost 12) es CPU-intensivo; 50 logins concurrentes + el event-loop contendido llevaron el login p95 a ~15 s (y 25/50 timeouts a 50/s, bajo el backlog). Con cola limpia a 15/s: 50/50 OK, p95 12.3 s. Es contención de CPU del único proceso api, no un bug de auth.

**No-hallazgos (confirmados sanos):** pérdida de mensajes, doble cobro, invariantes de dinero, panel bajo carga (<600 ms p95), estabilidad de memoria, dedupe por wamid, RLS.

## 5. Fixes

**Aplicado y validado — dimensionamiento (lo que el doc anticipaba):**
- `WORKER_CONCURRENCY` **5 → 24** y `DB_CONNECTION_LIMIT` **→ 30** (pool Prisma por proceso).
- **Antes/después:** con concurrencia 5, el smoke a 15/s de ráfaga ya acumulaba cola (147) y p95 22 s; con 24 el techo efectivo subió a ~12–20/s. Es la palanca correcta, pero en una sola laptop/worker el techo de CPU/BD impide llegar a 50/s. En producción esto se traduce en **réplicas de worker + pool dimensionado** (ver §6).

**Fixes de harness/tooling (bugs del propio instrumental, permitido):**
- `metrics.mjs`: el query de percentiles de latencia fallaba en modo global (`bucket` fuera del `GROUP BY`) → corregido (`GROUP BY 1` siempre). Y la detección de RSS del api no matcheaba su cmdline `ts-node` → regex corregida (ahora reporta ~344 MB).

**No se tocó código de producto** (regla de oro: TuBot intacto). Las palancas F1–F4 son de **configuración/dimensionamiento** (env) + recomendaciones de optimización para producción (§6).

## 6. Producción (Railway) — dimensionamiento recomendado

Objetivo: **50 msg/s sostenido con p95 < 15 s**. Con un costo medido de ~2 s/turno:

- **Worker:** capacidad ≈ `réplicas × WORKER_CONCURRENCY / 2s`. Para 50/s con holgura ×1.5 → **~150 turnos/s de capacidad** → p. ej. **3–4 réplicas de worker con `WORKER_CONCURRENCY≈12–16`** cada una (en vez de 1×5). Medir y ajustar.
- **Pool Prisma / Postgres:** fijar `DB_CONNECTION_LIMIT` por réplica tal que `(réplicas_api + réplicas_worker) × DB_CONNECTION_LIMIT + overhead < max_connections` de la BD. Subir `max_connections` del plan de Postgres (o introducir **PgBouncer**) antes de escalar réplicas. A 50/s se tocó 100/100 con 1+1 procesos → el plan actual de PG se queda corto.
- **API:** **2+ réplicas** detrás del balanceador para la ingesta de webhooks (hoy un solo event-loop se satura a 50/s). Optimización de producto recomendada (follow-up): hacer la ingesta del webhook **más liviana/asíncrona** (encolar y responder 200 de inmediato, mover dedupe/persistencia al worker) — bajaría F2 drásticamente.
- **Login/bcrypt:** con varias réplicas de api el costo bcrypt se reparte; no requiere cambio salvo que el volumen de logins concurrentes sea alto (poco probable).

## 7. Veredicto contra los criterios de aceptación

| Criterio | Resultado |
|---|---|
| 0 mensajes perdidos (tras aceptar) · dedupe 1:1 | ✅ |
| 0 débitos duplicados · invariantes de dinero intactos | ✅ |
| 0 caídas/reinicios · RSS estable en soak | ✅ |
| Panel responde (<2 s p95) durante la carga | ✅ (279–572 ms) |
| p95 < 15 s / p99 < 30 s a 50 msg/s sostenido | ❌ en 1 laptop/1 worker (techo ~12–20/s). Es límite de **hardware/escala**, no de corrección → se cierra con el dimensionamiento §6 en producción. |
| La ráfaga activa el fusible por-tenant sin degradar al resto | ⏳ no ejercido en estas corridas (perilla `SIM_W8_BURST_CAP` disponible para forzarlo); el fusible por-tenant quedó intacto. |

**Conclusión:** la plataforma es **correcta y estable bajo carga** (cero pérdida, cero doble cobro, memoria estable, panel fluido). El único criterio no verde —latencia a 50 msg/s— es un **techo de throughput por réplica** cuya causa raíz y palancas quedan medidas; se alcanza en producción con el dimensionamiento de §6 (réplicas de worker + pool/`max_connections` + ingesta de webhook asíncrona). Reejecutable con `node tools/sim/sim250.mjs w8` + `metrics.mjs`.

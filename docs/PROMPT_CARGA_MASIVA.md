# PROMPT DE DESARROLLO — Revisión general + CARGA MASIVA (1.000 usuarios · 250 clientes)

**Para el desarrollador (Claude Code en VS Code, con agentes).** Esta es la tanda 2 del
plan de lanzamiento. La tanda 1 ya corrió y NO hay que repetirla: tu trabajo es la
**resistencia bajo carga** y cerrar cualquier hallazgo con fix + test + retest, usando
agentes en paralelo como se indica abajo. Objetivo final: que la plataforma no se caiga
ni degrade con alta carga de mensajes y usuarios, lista para la campaña.

---

## 1. Lo que YA está probado (no repetir — es tu línea base)

Simulaciones previas (informes en `docs/`): **SIMULACION_PROD_2026-10.md** (40 clientes),
**SIMULACION_200_2026-10.md** (200) y **SIMULACION_250_2026-10.md** (250 clientes,
14 rubros, 8.117 mensajes), todas con el rol de BD de producción (`conversia_app`,
RLS real) y compras por API con pago mock. Resultado de la última: **cero hallazgos
de producto** y batería de seguridad ofensiva **16/16 repelida** (inyección de inbound,
IDOR de caja/contactos, JWT forjado, carrera de 12 débitos paralelos → 1 débito, replay
wamid ×10 → 1 mensaje, spoof de marca, cross-brand, rate limits, RLS directo).
Funcional validado: registro E2E (API y navegador), montaje completo en los 14 rubros,
upgrade en vuelo, agotamiento exacto (100+20, bot nunca mudo), free tier de 1.000 POR
número con cobro sobre el límite, fusibles por tenant/día, cancelación, invariante
débitos=conversaciones en 199/199 orgs, TuBot intacto. Todo mergeado en `main`
(PRs #487, #488, #489). El harness de esa corrida está en **`tools/sim/sim250.mjs`**
(parametrizado por env `SIM_*`) y es tu punto de partida.

## 2. Tu misión: prueba de CARGA MASIVA

Simular **250 clientes (tenants) con ~1.000 usuarios finales conversando a la vez** y
demostrar con números que la plataforma aguanta sin caerse, sin perder mensajes y sin
romper los invariantes de dinero. Donde se rompa: fix + test + retest hasta verde.

### Perfil de carga (fase nueva `w8-carga` sobre tools/sim/sim250.mjs)

Reusa las 250 orgs ya registradas por `w1`/`w2` (o re-córrelas en BD fresca). Luego:

1. **Ramp-up (5 min)**: de 0 a 1.000 contactos activos (4 por org), mensajes entrantes
   vía `POST /webhooks/whatsapp` (payload mock del harness), subiendo la concurrencia
   de 10 → 100 envíos simultáneos.
2. **Sostenido (15 min)**: ~50 mensajes/segundo entrantes repartidos en las 250 orgs
   (Poisson simple: jitter aleatorio), cada contacto conversa de verdad (2-5 mensajes
   por conversación, respuestas del bot incluidas vía provider mock).
3. **Ráfaga (2 min)**: pico de 150 msg/s concentrado en 30 orgs (simula una campaña
   viral de un cliente) — acá deben actuar los fusibles por tenant sin afectar al resto.
4. **Soak (20 min)**: 20 msg/s constantes para detectar fugas de memoria/conexiones.
5. **Panel bajo carga**: durante el sostenido, 50 logins + navegación por API
   (GET /inicio equivalentes: /auth/me, /billing/wallet/summary, /conversations,
   /onboarding) cada 10 s — el panel no puede morir mientras el worker procesa.

### Qué medir (agente de observabilidad, muestreo cada 10 s a un CSV/JSON en tools/sim/out/)

- **Latencia inbound→outbound** (created_at del INBOUND al created_at del OUTBOUND de
  su conversación): p50 / p95 / p99 por minuto.
- **Profundidad de colas BullMQ** (`redis-cli llen bull:inbound-messages:wait` y
  outbound) + jobs failed/stalled.
- **Postgres**: `pg_stat_activity` (conexiones por estado), locks esperando,
  `pg_stat_database` (xact_commit/rollback).
- **Procesos**: RSS de api y worker (¿crece sin volver en el soak? → fuga).
- **Pérdidas**: mensajes entrantes enviados vs filas INBOUND en BD (debe ser 1:1 con
  dedupe de wamid); outbound FAILED por causa.
- **Invariantes de dinero al final**: débitos = conversaciones contadas × multiplicador
  en TODAS las orgs; cero débitos duplicados; contadores de free tier coherentes.

### Criterios de aceptación (todos deben cumplirse)

- p95 de respuesta del bot < 15 s durante el sostenido; p99 < 30 s; sin crecer sin techo.
- 0 mensajes entrantes perdidos; 0 débitos duplicados; invariantes de dinero intactos.
- 0 caídas/reinicios de api o worker; RSS estable en el soak (±15 %).
- La ráfaga activa los fusibles del tenant abusador SIN degradar p95 del resto >2×.
- El panel responde (<2 s p95 en los GET) durante toda la carga.
- Si algo falla: diagnóstico de raíz, fix con test, y la corrida completa re-ejecutada
  en verde. Ajustes típicos esperables: pool de conexiones Prisma, concurrencia de
  workers BullMQ, índices, backoff del drain.

## 3. CÓMO ejecutar — proceso con AGENTES (orden explícita)

Trabaja con el patrón orquestador + agentes (Task tool de Claude Code). Tú (contexto
principal) haces el triage y los commits; los agentes hacen el trabajo paralelo:

1. **Agente INFRA** (uno, primero): levanta el stack aislado y lo deja verificado:
   BD Postgres propia (docker compose del repo o instancia local, puerto ≠ prod local),
   Redis propio, `.env` de sim desde `.env.example` con: `DATABASE_URL` con rol
   `conversia_app` + `DIRECT_DATABASE_URL` admin (como producción endurecida),
   `AI_PROVIDER=mock`, `WHATSAPP_PROVIDER=mock`, `WEB_URL_CONVERSIA` = el Origin que
   usará el harness (`SIM_ORIGIN_CV`). Luego: migraciones + `db:setup` + `db:seed` +
   `node packages/database/scripts/v2-golive.mjs` + sembrar `whatsappRateSchedule`.
   Smoke gate: registrar una sonda y verificar `conversia/conversia_v2_trial/30/1970`.
2. **Agente CARGA**: implementa la fase `w8-carga` en `tools/sim/sim250.mjs` según el
   perfil de arriba (generador con concurrencia controlada, sin `sleep` fijo bloqueante).
3. **Agente OBSERVABILIDAD** (en paralelo con la corrida): el muestreador de métricas
   (script aparte `tools/sim/metrics.mjs`) + el cálculo de percentiles al cierre.
4. **Corrida completa** (tú la lanzas): `node tools/sim/sim250.mjs all` (si la BD está
   fresca) y después `node tools/sim/sim250.mjs w8` con `metrics.mjs` corriendo.
5. **Agentes de FIX** (uno por hallazgo, en paralelo si no se pisan): cada bug → fix +
   test unitario + nota de causa raíz. Prohibido parchear el harness para "que pase":
   el harness solo se corrige si el bug es del harness (documentado).
6. **Retest**: corrida completa de nuevo hasta criterios en verde.

Trucos operativos del harness (aprendidos en las tandas previas, te ahorran horas):
- Antiabuso de registro ~10/IP: el harness borra `rl:register:127.0.0.1` por registro.
- El cache de techos (`messagingCapSvcPerTenantDay`) dura 60 s: tras tocarlo, espera 65 s.
- `platform_settings` exige `updated_at` en INSERT.
- Las orgs del harness necesitan canal MOCK clonado + agente publicado (ya lo hace `w1`).
- El webhook mock requiere header `x-conversia-mock-token` = `MOCK_INBOUND_TOKEN` del env
  y SOLO funciona con `WHATSAPP_PROVIDER=mock` (en producción está bloqueado por diseño).

## 4. Reglas duras

- **TuBot no se toca**: está en producción; cualquier cambio debe ser neutro para su
  comportamiento (los tests de regresión del harness lo verifican — déjalos en verde).
- **Jamás contra producción**: todo en el stack aislado; cero llamadas a dominios reales.
- Código e identificadores en inglés, docs/UI en español; convenciones de CLAUDE.md.
- Un PR por bloque de fixes, con descripción de causa raíz y evidencia del retest.
  Los fixes de performance llevan el número ANTES/DESPUÉS en la descripción.

## 5. Entregables

1. `docs/CARGA_MASIVA_RESULTADOS.md`: perfil ejecutado, tabla de métricas (p50/p95/p99
   por fase, profundidad máxima de colas, RSS, conexiones PG), hallazgos con causa raíz,
   fixes aplicados con antes/después, y veredicto contra los criterios de aceptación.
2. `tools/sim/sim250.mjs` con la fase `w8-carga` + `tools/sim/metrics.mjs` commiteados.
3. PRs de fixes mergeables (CI verde).
4. Si algún límite de infraestructura real queda corto (pool PG, workers, plan de
   Railway), la recomendación concreta de dimensionamiento va en el informe, sección
   "Producción", con el valor sugerido y por qué.

Con esto cerramos: plataforma validada funcional (tanda 1) + resistente a carga
(tanda 2), lista para vender con la campaña.

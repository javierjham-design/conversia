# Salud de tokens de WhatsApp — Resultados

**Fecha:** 2026-10-20 · Encargo `docs/PROMPT_SALUD_TOKENS.md` (prioridad 1). Cierra el hueco del
**incidente real del 19-oct-2026**: los tokens de WhatsApp de TuBot se invalidaron (migración de la
cuenta titular en Meta) y la plataforma **no avisó** — los webhooks entrantes seguían llegando con
el token muerto, así que "todo se veía normal" mientras los ENVÍOS fallaban uno a uno.

> Regla cumplida: **una caída de token JAMÁS es silenciosa.** Probado contra el stack Docker
> (provider mock) simulando el 190. **TuBot intacto.**

## Qué se construyó (un PR)

### 1. Chequeo ACTIVO cada 15 min (junto al canario) — `apps/worker/src/whatsapp-token-health.ts`
Por cada canal WhatsApp activo (reales + MOCK del sim) **y** el token global del Tech Provider,
una llamada barata a Graph (`GET /{phone_number_id}?fields=id`, y `GET /me` para el global) **sin
enviar nada**. Un **190 / OAuthException / 401** levanta la excepción de plataforma **`token_invalido`
(severidad crítica)** con el detalle (qué token, qué número, código), deduplicada **una por token
caído** (dedupeKey = canal), + alerta al super admin. Al recuperarse (200), la excepción se
**resuelve sola** y el canal se reactiva. El resultado se publica en Redis
(`conversia:health:whatsapp-token`) para `/health` y la consola.

### 2. Fail-fast en el ENVÍO — `channel-providers.ts` + `outbound.ts` + `agent-turn.ts`
La detección del 190 se endureció (JSON + `error.type==="OAuthException"` + subcódigo, no solo
substring). Un token muerto en el envío dispara **la misma** `token_invalido` al instante, marca el
mensaje **FAILED con motivo claro** ("Token de WhatsApp inválido (Meta 190) — reemplaza el token en
Railway…") en vez del error crudo, y **no martillea**: el canal queda "error" y los envíos nuevos a
ese canal se cortan de inmediato (sin golpear a Meta) hasta que el token vuelva.

### 3. Visibilidad
- **Consola super admin** (`/admin`): **banner rojo global** si el token del Tech Provider cayó +
  tarjeta "Salud de tokens de WhatsApp" en `/admin/alerts` (vivo/caído por canal + última verificación).
- **Panel del tenant**: Canales muestra en lenguaje humano "conexión con WhatsApp interrumpida —
  nuestro equipo ya fue avisado" (TuBot `apps/web` y Conversia `apps/conversia-web`).
- **Salud**: `GET /health/status` expone `whatsappTokenOk: true/false` (+ `checks.whatsappToken`,
  503 para el monitor externo). Nuevo check **`11-wa-token`** en `tools/sim/smoke-prod.mjs`.

### 4. Runbook — `docs/RUNBOOK_GOLIVE_V2.md` §12
Rotación/caída de token: síntoma, **gatillo conocido** (migración/titularidad del BM invalida
tokens previos), dónde se genera (System User con `business_management` +
`whatsapp_business_management` + `whatsapp_business_messaging`), **qué variable de Railway tocar**
(`META_ACCESS_TOKEN` en **api** y **worker**) y cómo verificar.

## Pruebas

### Unitarias (vitest, CI) — `apps/worker/src/channel-token-health.test.ts` (+ `channel-auth.test.ts`)
**25/25 verdes.** Cubren: detección de 190/OAuthException/401 (y que un 131037/130429 NO sea
"token muerto"), el `userMessage` accionable del FAILED, `verifyToken` (200 ok / 190 muerto / sin
token / **bache de red → NO falso positivo**), y el MockProvider simulando el 190 con el flag.

### End-to-end en Docker — `tools/sim/token-health-sim.mjs`

Contra el stack `pnpm sim:up` (provider mock), simulando el 190 con el flag Redis
`sim:wa-token-invalid` (acotado por `phone_number_id`). **Las 4 fases verificadas** (log en
`tools/sim/out/token-health-sim.log` + inspección directa de la BD del sim):

| Fase | Qué prueba | Resultado |
|---|---|---|
| ② Fail-fast en el ENVÍO | un cliente escribe → el bot intenta responder → 190 | 🟢 mensaje **FAILED** con el texto `Token de WhatsApp inválido (Meta 190) — reemplaza el token en Railway…`; canal en `error`; excepción crítica `token_invalido` abierta |
| ③ Chequeo ACTIVO sin tráfico | una 2.ª org que NO recibió nada | 🟢 el CLI del chequeo marca su canal `error` y abre la excepción **sin ningún inbound de por medio** (ese era el hueco del incidente) |
| ④ Recuperación | se borra el flag (token repuesto) | 🟢 el chequeo reactiva ambos canales (`active`), **resuelve** las excepciones y el snapshot vuelve a `ok:true` |

Nota de rendimiento (hallazgo durante la prueba, ya corregido): el chequeo abría una
transacción `withTenant` por canal → con cientos de canales tardaba minutos. Se rediseñó a
**enumeración en lote** (unas pocas consultas) + caché corta del flag de simulación. Importa
también en producción (el barrido de los 15 min no debe escalar linealmente en round-trips).

## Cómo reproducir

```bash
pnpm sim:up                                   # stack Docker (provider mock)
docker compose -f tools/sim/docker-compose.sim.yml build worker && \
  docker compose -f tools/sim/docker-compose.sim.yml up -d worker   # worker con el chequeo
node tools/sim/token-health-sim.mjs           # simula el 190 end-to-end
# Forzar el chequeo manual (sin esperar 15 min):
docker exec conversia-sim-worker node apps/worker/dist/token-health-cli.js
```

En producción, tras rotar el token: `GET /health/status` → `whatsappTokenOk: true` (o el check
`11-wa-token` de smoke-prod), y la excepción `token_invalido` se marca resuelta.

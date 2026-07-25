# Registro de decisiones (ADR)

Formato corto: contexto → decisión → consecuencias. Fecha 2026-07-25 salvo indicación.

## ADR-1 — Multi-tenant por RLS con esquema compartido
**Contexto**: aislamiento no negociable; muchos tenants pequeños esperados.
**Decisión**: una BD, políticas RLS dinámicas sobre toda tabla con `organization_id`, GUC `app.org_id` por transacción (`withTenant`), rol de app sin bypass.
**Consecuencias**: operación simple, aislamiento verificable en la BD; enterprise puede migrar a BD dedicada (mismo schema). Distinto de la decisión BD-por-clínica de Cláriva: productos y perfiles de carga diferentes.

## ADR-2 — Prisma 6 como ORM
**Contexto**: velocidad de desarrollo + migraciones; RLS requiere control transaccional.
**Decisión**: Prisma con `@@map` snake_case; RLS/FKs dinámicas en `sql/setup.sql` (re-ejecutable tras cada migración); `withTenant` como único punto de acceso.
**Consecuencias**: el SQL de endurecimiento vive fuera de las migraciones Prisma (paso `db:setup` documentado y presente en CI/deploy).

## ADR-3 — BullMQ + timers en Postgres (no Temporal en MVP)
**Contexto**: workflows con esperas de horas/días, reintentos, cancelación.
**Decisión**: BullMQ para trabajo inmediato; esperas persistidas en `scheduled_jobs` (fuente de verdad en Postgres, sondeo cada 15s, claim optimista). Estado de runs en `workflow_runs/steps`.
**Consecuencias**: cero infraestructura extra; sobrevive reinicios de Redis. Si la complejidad crece (sagas, señales, child workflows), migrar el motor a Temporal manteniendo la definición JSON — el motor es puro y está aislado en `@conversia/workflows`.

## ADR-4 — Definición de workflow como JSON versionado
**Contexto**: el brief pedía tablas `workflow_nodes/edges/variables`.
**Decisión**: el grafo completo (trigger, nodos, aristas, variables) se serializa en `workflow_versions.definition` (validado con zod). Los runs referencian `nodeId` strings.
**Consecuencias**: publicar = insertar fila inmutable (versionado trivial, el run sigue su versión); el editor visual (React Flow) lee/escribe su formato natural. Se pierde consulta relacional por nodo — irrelevante para los casos de uso.

## ADR-5 — Capa AIProvider multi-proveedor; Anthropic primero
**Decisión**: interfaz `AIProvider` (chat con tools, embed) en `@conversia/types`; `AnthropicProvider` real, `MockAIProvider` para dev/test. Modelos por defecto: `claude-opus-4-8` (conversación), `claude-haiku-4-5` (clasificación). Sin parámetros de sampling (removidos en Opus 4.7+). Precios en `packages/agents/src/pricing.ts` para costo por request.
**Consecuencias**: cambiar de modelo/proveedor es configuración del agente, no código. Embeddings requieren proveedor aparte (OpenAI u otro) — mock incluido.

## ADR-6 — Webhook de WhatsApp dentro de apps/api
**Contexto**: el brief proponía `apps/webhook-gateway` separado.
**Decisión**: endpoint en la API (valida firma y encola en <10ms); separar solo cuando el volumen/aislamiento de fallos lo justifique.

## ADR-7 — Worker sin NestJS
**Decisión**: procesadores BullMQ en TS plano. Nest aporta DI/HTTP que el worker no necesita.

## ADR-8 — Notas internas fusionadas en messages
**Decisión**: `messages.visibility=INTERNAL` + `type=NOTE` en lugar de tabla `internal_notes`. Mismo timeline, menos joins.

## ADR-9 — Auth propia con JWT (jsonwebtoken + bcryptjs)
**Decisión**: sin passport; middleware que corre el request dentro de AsyncLocalStorage con el contexto de tenant. bcryptjs (JS puro) evita problemas de compilación nativa en Windows.
**Consecuencias**: revisar antes de producción: refresh tokens, revocación, 2FA (ROADMAP fase 7).

## ADR-10 — Codename "Conversia"
**Decisión**: nombre provisional del repo/paquetes (`@conversia/*`). El nombre comercial es configurable (white-label); renombrar el scope es un find/replace acotado.

## ADR-11 — Tiempo real v0 por sondeo (SSE/polling 3-4s)
**Decisión**: suficiente para validar producto; upgrade planificado a Redis pub/sub + WebSocket cuando haya usuarios concurrentes reales.

## ADR-12 — Digital Dent y Clínica Demo como seeds JSON
**Decisión**: `packages/database/seeds/*.json` cargados por `seed.ts` genérico. Cualquier cliente nuevo = un JSON más (o el onboarding UI de fase 7). Cero lógica condicionada por tenant en el código (verificable con grep).

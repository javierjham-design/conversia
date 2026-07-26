# Registro de progreso

## 2026-07-25 (2) — Despliegue a Railway

- Preparación: Dockerfiles por servicio (monorepo pnpm), soporte `PORT`, `.dockerignore`, migración inicial de Prisma generada offline (`migrate diff --from-empty`).
- Proyecto Railway `conversia`: Postgres 18 (pgvector confirmado) + Redis + servicios api/worker/web con variables y referencias cruzadas (detalle en DEPLOYMENT.md).
- BD productiva: `migrate deploy` + `sql/setup.sql` (RLS/FKs/rol app con contraseña fuerte) + seed de 2 tenants ejecutados contra el proxy público.
- Dominios: api-production-cf8e / web-production-d50dd (.up.railway.app).
- Smoke test E2E en producción OK (webhook → tenant → agente mock → respuesta visible por API autenticada). Dos bugs encontrados y corregidos en el proceso:
  1. Express 5: `req.path` relativo en middleware montado → rutas públicas daban 401; fix con `originalUrl`.
  2. Respuesta duplicada cuando un workflow con nodo `run_agent` corre en `conversation_started` además del turno directo del inbound; fix: el turno directo se omite si un workflow ya ejecutó al agente (ventana 60s).
- Pendiente inmediato: providers en mock (activar Anthropic con API key), pre-deploy de migraciones automatizado, conectar repo GitHub para autodeploy.

## 2026-07-25 — Sesión fundacional

**Creado el monorepo completo desde cero** (arquitectura + código funcional):

- Raíz: pnpm+turbo, tsconfig base, docker-compose (pgvector+redis), .env.example, CI, CLAUDE.md.
- `packages/database`: schema Prisma ~50 tablas multi-tenant, `sql/setup.sql` (RLS dinámico + FKs + rol app + índice HNSW), `withTenant`, seeds JSON de 2 tenants (Digital Dent completo + Clínica Demo) con seed genérico.
- `packages/types`: contratos SchedulingProvider / AIProvider / ChannelProvider / ToolDefinition / workflow schema (zod) / colas / permisos.
- `packages/config`: entorno validado con zod, fail-fast en producción.
- `packages/agents`: AnthropicProvider (opus-4-8 por defecto) + Mock, pricing por modelo, registro de 10 tools core validadas, orquestador con loop de tools, transferencias y escalamiento humano.
- `packages/workflows`: motor puro v0 (triggers, ramas, esperas persistentes, idempotencia) con 4 tests vitest.
- `packages/scheduling`: Mock (doble reserva, datos del tenant) + cliente Cláriva del contrato preliminar.
- `apps/api` (NestJS 11): auth JWT + AsyncLocalStorage, RLS via withTenant, organizaciones, bandeja (listar/chat/enviar/takeover/release/SSE), webhook WhatsApp con firma HMAC, colas BullMQ; 2 suites de test.
- `apps/worker`: inbound (resolución de tenant, idempotencia, cancelación de seguimientos, dispatch de workflows, turno de agente, envío), outbound, scheduler de timers, runtime de workflows completo.
- `apps/mock-clariva`: servidor Express del contrato (slots, citas, 409 doble reserva).
- `apps/web` (Next 15 + Tailwind 4): login + bandeja funcional (chat, IA/humano).
- `scripts/simulate-inbound.mjs`: simulador de mensajes formato Meta.
- `docs/`: ARCHITECTURE (diagramas mermaid + flujos), MULTITENANCY, DECISIONS (12 ADRs), DATA_MODEL, SECURITY, AGENTS, WORKFLOWS, WHATSAPP, SCHEDULING, CLARIVA (contrato), ROADMAP (fases+backlog), TESTING, DEPLOYMENT (+costos), API, INTEGRATIONS, BILLING, CHANGELOG.

**Validación**: pnpm install OK; prisma validate/generate y typecheck/test ejecutados al cierre de la sesión (ver resultado en el informe).

**Deuda/pendientes inmediatos**: ver "Próximos 10 tickets" en ROADMAP.md. No hay BD levantada aún en esta máquina (sin Docker): primer paso de la próxima sesión = levantar Postgres/Redis y correr migrate+setup+seed+simulador.

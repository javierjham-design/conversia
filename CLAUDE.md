# CLAUDE.md — Conversia

Plataforma SaaS multi-tenant de atención conversacional (WhatsApp + agentes IA + workflows + agendamiento). Monorepo pnpm + turbo. Digital Dent = primer tenant (solo datos/seeds, jamás lógica especial). Cláriva = sistema externo integrado por API (ver docs/CLARIVA.md).

## Comandos

- `pnpm install` — instalar (workspace completo)
- `pnpm dev` / `pnpm build` / `pnpm typecheck` / `pnpm test` — via turbo
- `pnpm db:generate | db:migrate | db:setup | db:seed` — Prisma + RLS + seeds
- Requiere `.env` (copiar de `.env.example`) y Postgres+Redis (docker compose up -d)

## Reglas de arquitectura (obligatorias)

1. **Tenancy**: nunca aceptar `organizationId` desde el cliente. Se obtiene del JWT (API) o del canal receptor (webhooks). Todo acceso a datos de tenant pasa por `withTenant(orgId, tx => ...)` de `@conversia/database` (setea `app.org_id` para RLS). Los jobs de BullMQ llevan `organizationId` en el payload y el worker reabre contexto con `withTenant`.
2. **Nada hardcodeado por cliente**: prohibido `if (org === 'digital-dent')`, precios/prompts/profesionales en código. Todo es configuración por tenant en BD o seeds JSON (`packages/database/seeds/`).
3. **Contratos en `@conversia/types`**: `SchedulingProvider`, `AIProvider`, `ChannelProvider`, `ToolDefinition`, tipos de workflow. Los adaptadores implementan interfaces; siempre existe un Mock para desarrollar sin credenciales.
4. **Tools de IA**: entrada validada con zod server-side; verificación de permisos y tenant en `ToolContext` antes de ejecutar. La IA nunca escribe directamente en BD.
5. **Idempotencia**: mensajes entrantes deduplicados por `external_id` (wamid); pasos de workflow por `(runId, nodeId, attempt)`.

## Convenciones

- Código e identificadores en inglés; docs y mensajes de UI en español.
- Validación con zod (no class-validator). JWT manual con `jsonwebtoken` (no passport).
- Nest: API en `apps/api` (CJS, tsc build, dev con ts-node). Worker sin Nest (TS plano + BullMQ).
- Prisma: tablas snake_case vía `@@map`, columnas `@map`. Migraciones + `sql/setup.sql` (RLS/FKs dinámicas sobre columnas `organization_id`).
- Modelos IA por defecto: `claude-opus-4-8` (conversación), `claude-haiku-4-5` (clasificación). Configurable por agente/tenant. Precios en `packages/agents/src/pricing.ts`.

## Estado y registro

- Progreso y pendientes: `docs/PROGRESS.md` (actualizar al cerrar sesión de trabajo).
- Decisiones de arquitectura: `docs/DECISIONS.md` (agregar ADR al tomar decisiones).
- Backlog por fases: `docs/ROADMAP.md`.

# Despliegue

## Entornos

- **dev**: local (docker compose: pgvector/pg16 + redis 7). Sin Docker: usar Postgres/Redis de Railway apuntando `.env`.
- **staging/producción MVP**: Railway (el equipo ya lo opera para Cláriva).

## Railway (MVP)

Servicios: `api` (apps/api), `worker` (apps/worker), `web` (apps/web) + addons Postgres y Redis. `mock-clariva` solo en dev.

Build (monorepo pnpm): root `pnpm install && pnpm build`; start por servicio:
- api: `node apps/api/dist/main.js`
- worker: `node apps/worker/dist/main.js`
- web: `pnpm --filter @conversia/web start`

Pasos de release: `prisma migrate deploy` → `db:setup` (RLS/FKs, idempotente) → arrancar servicios. Variables según `.env.example` (JWT_SECRET y CREDENTIALS_ENCRYPTION_KEY obligatorios; DATABASE_URL con rol `conversia_app`, DIRECT_DATABASE_URL admin para migraciones).

Postgres en Railway: verificar soporte pgvector (imagen con extensión) — alternativa: Neon/Supabase para la BD manteniendo el resto en Railway.

## Costos aproximados MVP (mensual, USD)

| Ítem | Estimado | Nota |
|---|---|---|
| Railway: Postgres + Redis + 3 servicios | 30–60 | según plan/uso |
| IA (Anthropic, opus-4-8 conversación) | 5–40 | ~0.005–0.03 USD/conversación con historial ventaneado; escala con volumen. Bajar a sonnet/haiku por agente si el costo pesa |
| Embeddings (cuando se active RAG vectorial) | 1–5 | text-embedding pequeño |
| WhatsApp (Meta) | 0–50 | servicio gratis; plantillas por categoría/país — **por validar** tarifas CL vigentes |
| Dominio + correo | ~5 | |
| **Total** | **≈ 45–160** | piloto de 1–3 tenants |

## Migración a infraestructura empresarial (cuando crezca)

Hetzner/AWS con: Postgres gestionado (RDS/Cloud SQL) + réplicas, Redis gestionado, contenedores (ECS/K8s), S3/R2 para archivos, CDN, observabilidad (OTel + Grafana/Sentry). El monorepo ya separa api/worker/web → escalar horizontal es duplicar réplicas; los timers usan claim optimista (multi-worker seguro).

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`): install → prisma generate → build → typecheck → test. Deploy: conectar Railway al repo (auto-deploy por rama) + job de migraciones. Pendiente: entorno staging separado + smoke test post-deploy.

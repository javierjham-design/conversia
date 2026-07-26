# Despliegue

## Entornos

- **dev**: local (docker compose: pgvector/pg16 + redis 7). Sin Docker: usar el Postgres/Redis de Railway apuntando `.env`.
- **producción MVP**: Railway — **DESPLEGADO 2026-07-25** (proyecto `conversia`, workspace javierjham-design, región sfo).

## Railway (estado real)

| Servicio | Origen | URL |
|---|---|---|
| Postgres | template postgres-ssl:18 (incluye pgvector ✔) | interno + proxy público |
| Redis | template | interno |
| api | Dockerfile `apps/api/Dockerfile` (upload CLI) | https://api-production-cf8e.up.railway.app |
| worker | Dockerfile `apps/worker/Dockerfile` | — (sin dominio) |
| web | Dockerfile `apps/web/Dockerfile` | https://web-production-d50dd.up.railway.app |

Claves de la configuración:
- Cada servicio usa `RAILWAY_DOCKERFILE_PATH` y se despliega con `railway up --service <n> --ci` desde la raíz (el contexto respeta .gitignore).
- `PORT=8080` fijado en api/web y dominios generados con `--port 8080`.
- Referencias cruzadas: `WEB_URL=https://${{web.RAILWAY_PUBLIC_DOMAIN}}` (CORS de la api) y `API_URL=https://${{api.RAILWAY_PUBLIC_DOMAIN}}` (build arg del panel — queda inlined en el bundle Next).
- `REDIS_URL=${{Redis.REDIS_URL}}?family=0` — la red privada de Railway es IPv6; `family=0` hace que ioredis resuelva dual-stack.
- IA/WhatsApp/agenda en `mock` hasta cargar credenciales reales (`AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` cuando se decida).
- Conexión a BD de los servicios: usuario `postgres` (admin) por ahora — el cambio a rol `conversia_app` + cliente admin separado es el ticket de hardening #3 del ROADMAP. El rol ya existe con contraseña fuerte y RLS aplicado.

Release de cambios: `railway up --service <n> --ci` por servicio tocado. Migraciones: desde local contra `DATABASE_PUBLIC_URL` → `prisma migrate deploy` + `pnpm db:setup` (idempotente) — automatizar como pre-deploy es mejora pendiente.

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

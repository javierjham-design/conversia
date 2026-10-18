# Stack de simulación (Docker)

Entorno **aislado** para probar la app (PWA + push + bandeja) y correr cargas, **nunca contra producción**. Levanta Postgres + Redis + API + worker + conversia-web con un comando, proveedores en **mock** y datos de demo sembrados.

## Arrancar (un comando)

```bash
bash tools/sim/up.sh        # o: pnpm sim:up
```

La primera vez construye 3 imágenes del monorepo (api, worker, conversia-web) — tarda unos minutos. Después es casi instantáneo. El script espera a que la migración/seed (`db-init`) termine y a que la API (`:4000/health`) y el front (`:3002`) respondan.

Al terminar:

| Servicio | URL / puerto |
|---|---|
| conversia-web | http://localhost:3002 |
| API | http://localhost:4000 (health `/health`) |
| Postgres | localhost:**5433** (db `conversia_sim`) |
| Redis | localhost:6379 |

## Parar

```bash
pnpm sim:down                      # conserva datos
DOWN=v bash tools/sim/up.sh        # borra el volumen (BD fresca)
```

## Cómo está armado

- `docker-compose.sim.yml` — los 6 servicios. `db-init` es **one-shot**: construye la imagen del monorepo (compartida por `api`) y corre `db:deploy` + `db:setup` (rol `conversia_app` + RLS) + `db:seed`; `api`/`worker` esperan con `depends_on: service_completed_successfully`, así que `up` solo deja todo listo y en orden.
- `.env.sim` — env común (mock + secretos de PRUEBA + VAPID de PRUEBA). Las URLs de BD por servicio (admin para `db-init`, `conversia_app` para `api`/`worker`) se fijan en el compose.
- `api` corre como `conversia_app` (RLS real, como producción endurecida); `DIRECT_DATABASE_URL` = admin.

## Cargas

- **Paridad (M6.2)**: `node tools/sim/sim250.mjs w1` … `w7` contra este stack valida los mismos invariantes de `docs/CARGA_MASIVA_RESULTADOS.md` (dinero, dedupe, sin pérdidas).
- Humo de prod (otro script, read-only contra producción): `node tools/sim/smoke-prod.mjs`.

## Carga de PUSH (M6.3)

Verifica el despacho de notificaciones push bajo carga con un **mock del servicio push**.
`web-push` exige TLS → el mock sirve **HTTPS self-signed**, y el worker lo acepta con
`NODE_TLS_REJECT_UNAUTHORIZED=0` (ya está en `.env.sim`, **solo sim**). Pasos:

```bash
# 1) Cert self-signed del mock (una vez)
openssl req -x509 -newkey rsa:2048 -nodes -keyout mock-key.pem -out mock-cert.pem \
  -days 365 -subj "/CN=push-mock" -addext "subjectAltName=DNS:push-mock,DNS:localhost"

# 2) Mock DENTRO de la red del sim (para que el worker lo alcance por nombre, sin el NAT del host)
docker run -d --name push-mock --network conversia-sim_default -p 8099:8099 \
  -e MOCK_CERT=/app/cert.pem -e MOCK_KEY=/app/key.pem \
  -v "$PWD/tools/sim/push-mock-server.mjs:/app/mock.mjs:ro" \
  -v "$PWD/mock-cert.pem:/app/cert.pem:ro" -v "$PWD/mock-key.pem:/app/key.pem:ro" \
  -w /app node:22-alpine node mock.mjs

# 3) La ola: 250 orgs × 2 subs = 500 suscripciones; ai.escalation + credits.low por org
NODE_TLS_REJECT_UNAUTHORIZED=0 \
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/conversia_sim \
REDIS_URL=redis://localhost:6379 MOCK_HOST=push-mock MOCK_SCHEME=https CLEANUP=1 \
  node tools/sim/push-load.mjs
```

Verifica: todas las entregas llegan al mock, el ~10% que responde 410 queda **revocado**
(`active=false`), el flujo origen no se rompe (se crean las filas `in_app`), y api/worker
siguen sanos. Resultados en `docs/APP_MOVIL_RESULTADOS.md`.

> Las claves VAPID de `.env.sim` son de **prueba**. Las de producción van en Railway (ver `docs/RUNBOOK_GOLIVE_V2.md`).

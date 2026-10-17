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

- Paridad / humo: `node tools/sim/sim250.mjs w1` … `w7` contra este stack (ver `docs/CARGA_MASIVA_RESULTADOS.md`).
- Humo de prod (otro script, read-only contra producción): `node tools/sim/smoke-prod.mjs`.

> Las claves VAPID de `.env.sim` son de **prueba**. Las de producción van en Railway (ver `docs/RUNBOOK_GOLIVE_V2.md`).

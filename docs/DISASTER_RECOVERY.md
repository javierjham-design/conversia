# Recuperación ante desastre (DR) — runbook

Escrito para ejecutarse **bajo estrés, sin improvisar**. Restaura la base de datos
de producción desde un respaldo, en orden, con los comandos exactos.

> **Probado de verdad el 2026-08-05** restaurando el pg_dump de prod en una base
> temporal aislada (`dr_test`) en la misma instancia, verificando integridad y
> RLS, y borrándola al terminar. No es teoría: los números de abajo son medidos.

## Números que debes saber (medidos 2026-08-05)

- **RTO real ≈ 5 minutos** de punta a punta con el tamaño de datos actual
  (~350 KB): dump 41 s · crear BD 2 s · **restore 175 s** · verificación ~30 s.
  El costo dominante es el `pg_restore` (muchos round-trips por políticas/índices)
  y **crece con el volumen de datos**. Estimación al escalar: con 10–50× de datos,
  contar **15–45 min**. Restaurar desde un backup **en la misma región** (no por el
  proxy público) es más rápido.
- **RPO actual = hasta 24 h** si solo se depende de los backups automáticos
  diarios de Railway. Con clientes de pago **24 h de pérdida es mucho** para
  conversaciones. **Recomendación abajo.**

## Precondiciones (téngelas listas ANTES de una emergencia)
- Railway CLI logueado y linkeado al proyecto `conversia` / entorno `production`.
- `pg_dump` / `pg_restore` / `psql` v18.x en `C:/Users/Javier/pgtools/pgsql/bin/`.
- El `DATABASE_PUBLIC_URL` del servicio Postgres (se inyecta con `railway run`,
  nunca se imprime).

## A) Respaldo bajo demanda (hazlo ANTES de cualquier operación riesgosa)
```bash
ts=$(date +%Y%m%d-%H%M%S)
railway run --service Postgres -- bash -c \
  '/c/Users/Javier/pgtools/pgsql/bin/pg_dump.exe "$DATABASE_PUBLIC_URL" -Fc \
   -f "/c/Users/Javier/Downloads/pgdump-prod-'"$ts"'.dump"'
```
Formato custom (`-Fc`) → permite restore selectivo y paralelo.

## B) Restaurar en un entorno APARTE (prueba o validación — NO toca producción)
```bash
DUMP=/c/Users/Javier/Downloads/pgdump-prod-XXXX.dump   # el respaldo a validar
# 1. Crear base temporal en la misma instancia
railway run --service Postgres -- bash -c \
  '/c/Users/Javier/pgtools/pgsql/bin/psql.exe "$DATABASE_PUBLIC_URL" \
   -c "DROP DATABASE IF EXISTS dr_test;" -c "CREATE DATABASE dr_test;"'
# 2. Restaurar (script para evitar comillas anidadas)
cat > /tmp/dr.sh <<EOF
PGREST=/c/Users/Javier/pgtools/pgsql/bin/pg_restore.exe
"\$PGREST" -d "\${DATABASE_PUBLIC_URL%/*}/dr_test" --no-owner "$DUMP"
EOF
railway run --service Postgres -- bash /tmp/dr.sh
# 3. Verificar (conteos, RLS, columnas recientes)
railway run --service Postgres -- bash -c \
  '/c/Users/Javier/pgtools/pgsql/bin/psql.exe "${DATABASE_PUBLIC_URL%/*}/dr_test" -tAc \
   "SELECT count(*) FROM information_schema.tables WHERE table_schema='"'"'public'"'"';"'
# RLS: sin app.org_id debe dar 0; con una org real, solo esa org.
# 4. Limpiar
railway run --service Postgres -- bash -c \
  '/c/Users/Javier/pgtools/pgsql/bin/psql.exe "$DATABASE_PUBLIC_URL" -c "DROP DATABASE IF EXISTS dr_test;"'
```
**Checklist de verificación** (debe coincidir con prod): nº de tablas (hoy 82),
políticas RLS (hoy 77), filas de `users/organizations/contacts/conversations/
messages/workflows`, columnas recientes con su default (p. ej. `users.mfa_*`), y
que RLS aísle (SIN `app.org_id` → 0 filas; CON una org → solo sus filas).

## C) Recuperación REAL de producción (desastre confirmado)
> Solo si producción está corrupta/perdida. Cambia datos reales — confirma que es
> necesario.

1. **Congelar escrituras**: en Railway, pausar los servicios `api` y `worker`
   (o poner la org en mantenimiento) para que no lleguen escrituras a medias.
2. **Respaldar el estado actual** (aunque esté dañado): paso **A** — nunca
   restaures encima sin una copia del "ahora".
3. **Obtener el respaldo a restaurar**:
   - Preferente: el **backup automático de Railway** más reciente anterior al
     incidente (Railway → servicio Postgres → Backups → Restore), que crea una
     BD/*volume* nuevo. Es lo más rápido (misma región).
   - Alternativa: un `pgdump-prod-*.dump` de `Downloads/` (paso A previo).
4. **Restaurar sobre la base de producción**:
   ```bash
   # Vaciar y recargar el esquema public (DESTRUCTIVO — solo en recuperación real)
   railway run --service Postgres -- bash -c \
     '/c/Users/Javier/pgtools/pgsql/bin/psql.exe "$DATABASE_PUBLIC_URL" \
      -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"'
   cat > /tmp/rec.sh <<EOF
   PGREST=/c/Users/Javier/pgtools/pgsql/bin/pg_restore.exe
   "\$PGREST" -d "\$DATABASE_PUBLIC_URL" --no-owner "$DUMP"
   EOF
   railway run --service Postgres -- bash /tmp/rec.sh
   ```
5. **Reaplicar setup de RLS/roles si el dump no lo trajo completo**:
   `railway run --service Postgres -- bash -c '... psql "$DATABASE_PUBLIC_URL" -f packages/database/sql/setup.sql'`
   (el dump `-Fc` de esta base SÍ incluye las políticas; este paso es un seguro).
6. **Verificar** con el checklist del paso **B**.
7. **Reanudar** `api` y `worker`. Smoke: `GET /health/status` (200), login, la
   bandeja carga, un flujo publicado se lee.
8. **Post-mortem**: registrar causa, RTO real y datos perdidos (ventana de RPO).

## D) Frecuencia y retención
El RPO de 24 h es demasiado para conversaciones con clientes pagando. Estado:
1. **Backups automáticos de Railway** (diarios, retención ≥ 7 días) — baseline,
   RPO ≤ 24 h. Se gestiona en el panel de Railway.
2. ✅ **`pg_dump` cada 6 h a almacenamiento fuera de Railway** (bucket S3/R2) →
   RPO ≤ 6 h **y** copia fuera del proveedor (protege ante compromiso de la cuenta
   de Railway, R-17). Implementado en [`.github/workflows/db-backup.yml`](../.github/workflows/db-backup.yml);
   cada corrida **verifica el restore desde el storage**. Costo ≈ $0/mes. Setup y
   costos en [`docs/BACKUPS.md`](./BACKUPS.md). *Falta cargar los secrets del bucket.*
3. **Probar la restauración**: ahora es automática en cada backup (paso 2). El paso
   **B** de abajo queda para validaciones manuales.
4. Cuando el volumen crezca, evaluar **PITR** (point-in-time recovery) del proveedor
   para RPO de minutos.

## Estado tras la prueba
- ✅ El respaldo de prod **es restaurable** y conserva datos + RLS (probado 2026-08-05).
- ✅ RTO medido ~5 min (tamaño actual); ⚠️ crece con el volumen.
- ✅ **Copia off-Railway cada 6 h con restore verificado** (workflow D.2). RPO ≤ 6 h
  una vez cargados los secrets del bucket (ver [`docs/BACKUPS.md`](./BACKUPS.md)).

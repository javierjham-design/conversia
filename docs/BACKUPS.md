# Respaldos de la base de datos

Dos capas, para que una copia sobreviva aunque falle el proveedor:

1. **Backups automáticos de Railway** (diarios, misma región) — restore rápido,
   RPO ≤ 24 h. Baseline; se gestiona en el panel de Railway.
2. **Copia FUERA de Railway cada 6 h** → bucket S3-compatible, vía GitHub Actions
   ([`.github/workflows/db-backup.yml`](../.github/workflows/db-backup.yml)).
   RPO ≤ 6 h **y** una copia fuera del proveedor (protege ante compromiso de la
   cuenta de Railway, riesgo R-17). Cada corrida **verifica el restore desde el
   storage**, no solo la subida (ver abajo).

## Cómo funciona la copia off-Railway

- Corre en un runner de GitHub (no en Railway) cada 6 h.
- `pg_dump -Fc` contra `DATABASE_PUBLIC_URL` → sube el `.dump` a `s3://<bucket>/db/`.
- **Verificación end-to-end**: descarga el objeto **recién subido** desde el bucket
  y lo `pg_restore` en un Postgres efímero (`pgvector/pgvector:pg18`), luego valida
  que haya ≥ 20 tablas y ≥ 1 política RLS. Si la copia del storage no restaura, el
  workflow **falla** (y GitHub avisa). Así "que suba" y "que restaure" se prueban
  en cada corrida, no una vez al mes.
- **Retención**: borra del bucket las copias con más de `BACKUP_RETENTION_DAYS`
  (default 14). Conviene además una *lifecycle rule* en el bucket como respaldo.

## Puesta en marcha (una vez)

1. Crear un bucket. **Recomendado: Cloudflare R2** (sin cargos de egreso y 10 GB
   gratis). Alternativas S3-compatibles: AWS S3, Backblaze B2, MinIO.
2. Crear un token/API key con permiso de lectura/escritura **solo** en ese bucket.
3. En GitHub → *Settings → Secrets and variables → Actions* cargar los **secrets**:
   - `DATABASE_PUBLIC_URL` — el `DATABASE_PUBLIC_URL` del Postgres de Railway
     (Railway → servicio Postgres → Variables). **Usar el público, no el `.internal`.**
   - `BACKUP_S3_ENDPOINT` — p. ej. `https://<accountid>.r2.cloudflarestorage.com`
   - `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`
   - (opcional, como *Variables*) `BACKUP_S3_REGION` (R2 = `auto`), `BACKUP_RETENTION_DAYS`
4. Lanzarlo a mano la primera vez: *Actions → DB backup (off-Railway) → Run workflow*.
   Debe terminar en verde con "Restaurado desde storage → tablas=… políticas_RLS=…".

> Sin secrets configurados el workflow **no falla**: el preflight lo omite con un
> aviso, para no spamear fallas antes de que exista el bucket.

## Costo mensual (estimado)

Con el tamaño actual (~350 KB/dump) y aun asumiendo crecimiento fuerte:

| Concepto | Detalle | Costo |
|---|---|---|
| Almacenamiento R2 | 4 dumps/día × 14 días de retención. Aun a **5 MB/dump** ≈ 280 MB, muy por debajo de los 10 GB gratis de R2 | **$0** |
| Operaciones R2 (Clase A/B) | ~4 PUT + ~4 GET + listados por día ≈ pocos miles/mes; free tier 1M Clase A + 10M Clase B | **$0** |
| Egreso R2 | R2 no cobra egreso | **$0** |
| GitHub Actions | ~2–3 min × 4/día × 30 ≈ **~330 min/mes**; free tier 2.000 min/mes (repo privado) | **$0** |
| **Total** | | **≈ $0 / mes** |

Cuándo deja de ser $0: si el dump supera ~600 MB sostenido (retención 14 d > 10 GB)
o si se agotan los 2.000 min/mes de Actions. A ~5 MB/dump hay **~70× de margen** de
almacenamiento. En AWS S3 (con egreso) el orden seguiría siendo **< US$1/mes** a
esta escala. Revisar cuando el `pg_dump` pase de ~100 MB.

## Restaurar desde el bucket (manual)

```bash
# 1. Bajar la copia deseada
aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3 ls "s3://$BACKUP_S3_BUCKET/db/"
aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3 cp "s3://$BACKUP_S3_BUCKET/db/pgdump-prod-XXXX.dump" .
# 2. Restaurar siguiendo docs/DISASTER_RECOVERY.md (paso B para validar, C para prod)
```

El runbook completo de restauración está en
[`docs/DISASTER_RECOVERY.md`](./DISASTER_RECOVERY.md).

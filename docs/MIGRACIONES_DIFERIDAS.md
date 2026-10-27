# Migraciones diferidas — para aplicar con el OK del dueño

**Fecha:** 27-oct-2026. Reúne las **7 migraciones** que las etapas de la auditoría dejaron
anotadas pero NO aplicaron (cada etapa tenía prohibido migrar para poder desplegarse en
caliente).

> ## ⚠️ Nada de este documento se aplica solo
>
> **Este PR no trae archivos de migración de Prisma**, a propósito: si los trajera, el
> próximo `pnpm db:deploy` las aplicaría sin que nadie lo decida. Acá hay **SQL revisable**
> que el dueño ejecuta a mano, una por una, cuando quiera.
>
> **Reglas para aplicarlas:**
> 1. **Respaldo primero, siempre** (cada migración indica el suyo).
> 2. Correr la **consulta previa** y comparar con el **resultado esperado**. Si no coincide,
>    **parar**: hay datos que harían fallar la migración o que esconden un problema real.
> 3. Aplicar **de a una**, fuera de horario, y verificar antes de pasar a la siguiente.
> 4. Varias requieren además un **cambio de código** para aprovecharse; está indicado.
> 5. TuBot opera 24/7: `CREATE INDEX` va **`CONCURRENTLY`** (no bloquea escrituras) y
>    `CONCURRENTLY` **no puede ir dentro de una transacción**.

**Respaldo general** (antes de cualquiera de estas):

```bash
# Desde la máquina del dueño, con los binarios de PG 18 (ver reference_conversia_prod_deploy_tooling)
pg_dump "$DATABASE_PUBLIC_URL" -Fc -f respaldo_pre_migracion_$(date +%Y%m%d_%H%M).dump
```

Orden sugerido: **4 → 6 → 5 → 2 → 3 → 1 → 7** (de la más inocua a la más invasiva).

---

## 1. Numeración de facturas por secuencia

**Problema** (auditoría §9, etapa 4). El número de factura se arma con `count() + 1` en 5
lugares distintos y la columna **no tiene unique**: dos facturas emitidas a la vez reciben
el MISMO número, y eso es un problema tributario, no solo de datos.

**Consulta previa — ¿ya hay números repetidos?**

```sql
SELECT number, COUNT(*) AS veces
FROM invoices
GROUP BY number
HAVING COUNT(*) > 1
ORDER BY veces DESC;
```

**Resultado esperado:** **0 filas**. Si aparece alguna, **parar**: hay que renumerar esas
facturas (y revisar si alguna ya se envió al cliente) ANTES de poner el unique, o la
migración falla.

**Respaldo:** `pg_dump` general + además `CREATE TABLE invoices_backup_YYYYMMDD AS SELECT * FROM invoices;`

**Migración:**

```sql
-- Secuencia que continúa desde el número más alto ya usado.
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq;
SELECT setval(
  'invoice_number_seq',
  COALESCE((SELECT MAX(NULLIF(split_part(number, '-', 3), ''))::bigint FROM invoices), 0) + 1,
  false
);

-- Unique definitivo (CONCURRENTLY: no bloquea la emisión de facturas).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS invoices_number_key ON invoices (number);
```

**Cambio de código necesario:** reemplazar los 5 `count() + 1` por `nextval('invoice_number_seq')`.
Sin esto la secuencia queda creada pero sin usar (inofensivo).

**Decisión pendiente del dueño:** ¿la numeración se reinicia cada año (`CONV-2027-000001`) o
es correlativa para siempre? Si se reinicia, hay que agregar un `setval` anual.

**Verificar después:** `SELECT nextval('invoice_number_seq');` devuelve un número mayor al
último usado, y `\d invoices` muestra el índice único.

**Rollback:** `DROP INDEX CONCURRENTLY invoices_number_key; DROP SEQUENCE invoice_number_seq;`

---

## 2. Unique parcial del libro de la bolsa (`wallet_ledger`)

**Problema** (§9.5, etapa 4). Nada impide a nivel de base que el mismo hecho quede asentado
dos veces (mismo mensaje debitado dos veces, mismo pack acreditado dos veces). La
idempotencia hoy es solo del código.

**Consulta previa — ¿hay asientos duplicados?**

```sql
SELECT organization_id, reason, ref_type, ref_id, COUNT(*) AS veces
FROM wallet_ledger
WHERE ref_id IS NOT NULL
GROUP BY 1, 2, 3, 4
HAVING COUNT(*) > 1
ORDER BY veces DESC
LIMIT 50;
```

**Resultado esperado:** **0 filas**. Si aparecen, **parar y revisarlas una por una**: cada
fila repetida es plata cobrada o acreditada dos veces. Hay que corregirlas (con un asiento
de reversa, nunca borrando) antes de aplicar.

**Respaldo:** `CREATE TABLE wallet_ledger_backup_YYYYMMDD AS SELECT * FROM wallet_ledger;`

**Migración:**

```sql
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS wallet_ledger_unique_ref
  ON wallet_ledger (organization_id, reason, ref_type, ref_id)
  WHERE ref_id IS NOT NULL;
```

Es **parcial** (`WHERE ref_id IS NOT NULL`) para no afectar los asientos sin referencia
(ajustes manuales, renovaciones sin factura). Un débito y su reembolso del mismo mensaje
tienen `reason` distinto, así que no chocan.

**Verificar después:** repetir la consulta previa (0 filas) e intentar insertar a mano un
asiento repetido: debe fallar.

**Rollback:** `DROP INDEX CONCURRENTLY wallet_ledger_unique_ref;`

---

## 3. Columna `brand` en cupones

**Problema** (§6.5, etapa 6). `coupons.code` es único **global**: TuBot y Conversia comparten
el mismo espacio de nombres, y el catálogo de cupones no está separado por marca.

**Consulta previa — cuántos cupones hay y de quién son:**

```sql
SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE active) AS activos FROM coupons;
SELECT code, active, times_redeemed, expires_at FROM coupons ORDER BY created_at;
```

**Resultado esperado:** la lista completa. **Todos los cupones existentes son de TuBot**
(Conversia todavía no emitió ninguno), por eso el default de la columna es `'tubot'`. Si el
dueño reconoce algún cupón como de Conversia, hay que actualizarlo a mano después.

**Respaldo:** `CREATE TABLE coupons_backup_YYYYMMDD AS SELECT * FROM coupons;`

**Migración:**

```sql
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS brand text NOT NULL DEFAULT 'tubot';

-- El unique pasa a ser (brand, code): el mismo código puede existir en cada marca.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS coupons_brand_code_key ON coupons (brand, code);
DROP INDEX IF EXISTS coupons_code_key;
```

> El `DROP` va **después** de crear el nuevo índice, para no quedar ni un segundo sin
> protección contra códigos repetidos.

**Cambio de código necesario:** filtrar cupones por la marca del admin en `/platform`.

**Verificar después:** `SELECT brand, COUNT(*) FROM coupons GROUP BY brand;` → todos en
`tubot`.

**Rollback:** recrear `coupons_code_key` único sobre `code`, borrar `coupons_brand_code_key`
y `ALTER TABLE coupons DROP COLUMN brand;` (solo si no se creó ningún cupón de Conversia).

---

## 4. `SENDING` en el enum `MessageStatus`

**Problema** (§4.5/§8.4, etapa 3). El claim contra el doble envío debería ser
`updateMany({ where: { id, status: "PENDING" }, data: { status: "SENDING" } })`, pero el
estado no existe, así que hoy vive en Redis (`send:<messageId>`, TTL 24 h). Funciona, pero
depende de Redis y es "best-effort" si Redis se cae.

**Consulta previa:** ninguna. Es **puramente aditiva** y no toca datos.

```sql
SELECT unnest(enum_range(NULL::"MessageStatus")) AS valores_actuales;
```

**Resultado esperado:** `PENDING, SENT, DELIVERED, READ, FAILED, SUGGESTED` (sin `SENDING`).

**Respaldo:** el `pg_dump` general alcanza (no hay cambio de datos).

**Migración:**

```sql
ALTER TYPE "MessageStatus" ADD VALUE IF NOT EXISTS 'SENDING';
```

> `ALTER TYPE … ADD VALUE` **no puede ir dentro de una transacción**: ejecutarla suelta.

**Cambio de código necesario:** mover el claim de Redis a la base en
`apps/worker/src/outbound.ts` (y borrar `send-claim.ts` cuando ya no se use). Mientras no se
haga, el estado nuevo queda sin usar: **inofensivo**.

**Ojo:** un `SENDING` que quede colgado (proceso muerto a mitad del envío) necesitaría un
barrido que lo devuelva a `PENDING`, igual que el del scheduler. Contemplarlo en ese cambio.

**Rollback:** no hay forma simple de quitar un valor de un enum en Postgres. Como el valor
no se usa hasta cambiar el código, el riesgo es nulo.

---

## 5. Último contador TOTP (anti-replay del 2FA)

**Problema** (§3, etapa 5). Un código TOTP sirve durante su ventana de 30 s (±1 paso): si
alguien lo intercepta, puede reusarlo dentro de esa ventana. El estándar es guardar el
último contador aceptado y rechazar cualquier código con contador menor o igual.

**Consulta previa — confirmar que la columna no existe:**

```sql
SELECT table_name, column_name
FROM information_schema.columns
WHERE column_name = 'mfa_last_counter';
```

**Resultado esperado:** **0 filas**.

**Respaldo:** el `pg_dump` general.

**Migración:**

```sql
ALTER TABLE platform_admins ADD COLUMN IF NOT EXISTS mfa_last_counter bigint;
ALTER TABLE users            ADD COLUMN IF NOT EXISTS mfa_last_counter bigint;
```

**Cambio de código necesario:** en `verifyTotp`, rechazar si el contador del código es `<=`
al guardado y, al aceptar, guardarlo. Nullable a propósito: `NULL` = nunca usó 2FA todavía.

**Verificar después:** entrar con 2FA una vez y comprobar que `mfa_last_counter` quedó
poblado; reintentar el MISMO código debe fallar.

**Rollback:** `ALTER TABLE … DROP COLUMN mfa_last_counter;`

---

## 6. `scheduled_jobs`: `updated_at` y contador de recuperaciones

**Problema** (§8.6, etapa 3). La recuperación de jobs colgados en `PROCESSING` necesita
saber *desde cuándo* están así y *cuántas veces* se intentó recuperarlos. La tabla no tiene
`updated_at` ni un contador, así que hoy ambos viven dentro del `payload` JSON
(`__processingAt`, `__recoveries`), que funciona pero ensucia el payload.

**Consulta previa — cuántos jobs arrastran las marcas del payload:**

```sql
SELECT status, COUNT(*) AS jobs,
       COUNT(*) FILTER (WHERE payload ? '__processingAt') AS con_sello,
       COUNT(*) FILTER (WHERE payload ? '__recoveries')  AS con_contador
FROM scheduled_jobs
GROUP BY status;
```

**Resultado esperado:** la foto actual. Sirve para saber cuántos payloads habría que limpiar
después (no es obligatorio: las claves sobrantes son inertes).

**Respaldo:** `CREATE TABLE scheduled_jobs_backup_YYYYMMDD AS SELECT * FROM scheduled_jobs;`

**Migración:**

```sql
ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS updated_at timestamp;
ALTER TABLE scheduled_jobs ADD COLUMN IF NOT EXISTS recoveries integer NOT NULL DEFAULT 0;

-- Semilla razonable para los que ya existen.
UPDATE scheduled_jobs SET updated_at = COALESCE(processed_at, created_at) WHERE updated_at IS NULL;
```

**Cambio de código necesario:** usar las columnas en vez de `payload.__processingAt` /
`payload.__recoveries` (`apps/worker/src/scheduler.ts`), y hacer que Prisma mantenga
`updated_at` con `@updatedAt`.

**Verificar después:** `SELECT COUNT(*) FROM scheduled_jobs WHERE updated_at IS NULL;` → 0.

**Rollback:** `ALTER TABLE scheduled_jobs DROP COLUMN updated_at, DROP COLUMN recoveries;`

---

## 7. Unique compuesto `(organization_id, id)` en las tablas de tenant

**Problema** (§2.0, etapa 2). Prisma exige un campo **único** en el `where` de `update` y
`delete`. Como solo `id` es único, no se puede escribir
`update({ where: { id, organizationId } })`: por eso quedaron ~265 escrituras por id que
dependen de que el `findFirst` anterior haya filtrado bien por organización. Con un unique
compuesto, el filtro de organización entra **en la misma sentencia** y el aislamiento deja
de depender del orden del código.

**Consulta previa:** ninguna que pueda fallar — `id` ya es clave primaria, así que
`(organization_id, id)` es único por construcción. Lo que sí conviene medir es **el costo**:

```sql
-- Tamaño actual de las tablas candidatas (el índice nuevo suma espacio y costo de escritura).
SELECT relname AS tabla,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS tamano,
       n_live_tup AS filas
FROM pg_class c
JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE relname IN ('conversations','messages','contacts','appointments','leads','workflow_runs')
ORDER BY pg_total_relation_size(c.oid) DESC;
```

**Resultado esperado:** la lista con tamaños. **`messages` es con diferencia la más grande**:
crear el índice ahí es lo más caro y lo que más conviene hacer fuera de horario.

**Respaldo:** el `pg_dump` general (no se modifican datos, solo se agregan índices).

**Migración (por tabla, empezando por las de más riesgo):**

```sql
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS conversations_org_id_key  ON conversations  (organization_id, id);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS contacts_org_id_key       ON contacts       (organization_id, id);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS messages_org_id_key       ON messages       (organization_id, id);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS appointments_org_id_key   ON appointments   (organization_id, id);
-- …y así con el resto de las tablas con organization_id que se quieran cubrir.
```

**Cambio de código necesario:** agregar `@@unique([organizationId, id])` al modelo en
`schema.prisma` y recién entonces cambiar los `update`/`delete` por id para que incluyan la
organización.

**Contrapartida honesta:** es un índice más por tabla — ocupa disco y encarece cada
escritura. **No conviene hacerlo en las ~40 tablas**: empezar por las que manejan datos de
clientes finales (conversaciones, mensajes, contactos, citas) y evaluar el resto con los
tamaños de la consulta previa.

**Verificar después:** `\d+ conversations` muestra el índice; una prueba con
`update({ where: { organizationId_id: { organizationId, id } } })` funciona.

**Rollback:** `DROP INDEX CONCURRENTLY <nombre>;` por cada uno.

---

## Resumen

| # | Migración | Riesgo | Bloquea escrituras | Requiere cambio de código |
|---|---|---|---|---|
| 4 | `SENDING` en el enum | muy bajo | no | sí (para aprovecharla) |
| 6 | `scheduled_jobs.updated_at` + contador | bajo | no | sí |
| 5 | Contador TOTP | bajo | no | sí |
| 2 | Unique parcial del ledger | **medio** (puede revelar duplicados reales) | no (`CONCURRENTLY`) | no |
| 3 | `brand` en cupones | medio | no | sí |
| 1 | Secuencia de facturas | **medio-alto** (datos tributarios) | no | sí |
| 7 | Unique `(org, id)` | medio (costo de disco/escritura) | no (`CONCURRENTLY`) | sí |

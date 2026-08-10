# Bolsa de mensajes prepagada — DISEÑO (para tu OK antes de migrar)

> Cierra el CRÍTICO C1 de la auditoría: la exposición máxima por cliente pasa de
> "lo que Meta permita" a **"lo que ya me pagó"**. Este documento es **diseño +
> insumos de pricing**. **No se implementó nada todavía** — espera tu OK a la
> migración y tu decisión de números.

Costo real de Meta (rate card CL cargado en la plataforma): **utilidad
$17,66 CLP · marketing $78,49 CLP · autenticación $17,66 CLP · servicio (24 h)
GRATIS**. Marketing cuesta **4,4×** una utilidad — es la variable que más mueve el
margen.

---

## PARTE 1 — Insumos para tu decisión de pricing

### 1.1 ¿Cuánto consume al mes un negocio típico? (estimación, rangos)

**Clínica con recordatorios de citas** (la mayoría, UTILIDAD):
| Tamaño | Citas/mes | Plantillas (confirmación + recordatorio = 2 util/cita) + reactivación | Costo Meta/mes |
|---|---|---|---|
| Chica | ~300 | ~600 util + ~100 mkt = **~700** | **~$18.400 CLP** |
| Mediana | ~600 | ~1.200 util + ~200 mkt = **~1.400** | **~$36.900 CLP** |

**Comercio con confirmaciones de pedido** (más MARKETING → más caro):
| Tamaño | Pedidos/mes | Plantillas (confirmación + despacho = 2 util/pedido) + promo/carrito | Costo Meta/mes |
|---|---|---|---|
| Chico | ~400 | ~800 util + ~200 mkt = **~1.000** | **~$29.800 CLP** |
| Mediano | ~1.200 | ~2.400 util + ~600 mkt = **~3.000** | **~$89.500 CLP** |

**Lectura**: un negocio típico se mueve entre **~700 y ~3.000 plantillas/mes**. La
clínica es barata (casi todo utilidad); el comercio con promos se dispara por el
marketing. Son estimaciones — el número real lo dará el primer mes con clientes.

### 1.2 Margen por plan según lo que incluyas

Precio del plan − **COGS de Meta** (mensajes incluidos × costo) = margen bruto
*antes* de IA, comisión de pasarela e infra. Dos escenarios de costo por mensaje
incluido: **utilidad pura ($17,66)** y **mezcla 80/20 util/mkt ($29,83)**.

| Plan | Precio | Incluidos (recomendado) | COGS utilidad | COGS mezcla | Margen bruto (util → mezcla) |
|---|---|---|---|---|---|
| **Starter** | $69.900 | **1.000** | $17.660 (25%) | $29.830 (43%) | **$52.240 (75%) → $40.070 (57%)** |
| **Pro** | $119.900 | **2.000** | $35.320 (29%) | $59.660 (50%) | **$84.580 (71%) → $60.240 (50%)** |
| **Enterprise** | $199.900 | **4.000** | $70.640 (35%) | $119.320 (60%) | **$129.260 (65%) → $80.580 (40%)** |
| **Free** | $0 | **0** | — | — | Demo bloquea plantillas (decisión ya tomada) |

> El margen **cae fuerte si el tenant manda mucho marketing** (columna "mezcla").
> Por eso abajo recomiendo **ponderar el marketing** para que no te coma el margen
> sin que tú lo notes. Con ponderación, el "80/20" se acerca a la columna utilidad.

### 1.3 Paquete adicional recomendado

Al agotar la bolsa, el tenant compra un paquete **prepago**. Recomendación:
- **Bloque de 1.000 mensajes** a **~$29.900 CLP** (≈ $29,9/mensaje).
  - Cubre el costo de mezcla ($29,83) con margen si es utilidad-pesado, y **nunca
    te deja bajo costo** aunque sea todo marketing sólo si ponderas marketing (ver
    1.4); si NO ponderas, sube el precio del paquete a **~$39.900** para cubrir el
    peor caso marketing.
- Descuento por volumen opcional: 5.000 por ~$129.900 (≈ $26/msg).
- **Nunca** vender paquetes por debajo del costo de marketing sin ponderación.

Mi consejo: el paquete debe ser **levemente caro a propósito** — el camino barato
es **subir de plan**, no vivir comprando paquetes. Así el pricing empuja al plan
correcto.

### 1.4 Decisión clave que te dejo planteada: ¿contar mensajes o créditos?

- **Opción A — por CANTIDAD** (lo que pediste, simple): 1 mensaje = 1 de la bolsa,
  sea utilidad o marketing. Fácil de comunicar ("1.000 mensajes incluidos"), pero
  un tenant que manda **todo marketing te cuesta 4,4×** por mensaje incluido → te
  come el margen (columnas "mezcla" de arriba).
- **Opción B — por CRÉDITOS ponderados** (recomendada): la bolsa son *créditos*;
  utilidad y auth **descuentan 1**, marketing **descuenta 4** (≈ ratio de costo).
  Protege tu margen pase lo que pase con la mezcla. Al tenant se le muestra
  "créditos" + una estimación amable ("≈ 1.000 recordatorios de utilidad").

**El diseño soporta las dos sin migrar de nuevo**: el peso por categoría es
**configurable** (default 1/1/1 = comportamiento por cantidad, exactamente lo que
pediste). Si más adelante quieres proteger margen, subes el peso de marketing a 4
desde el Super Admin, sin redeploy. Tú decides cuándo.

---

## PARTE 2 — Diseño de la migración (para tu OK)

### 2.1 Modelo de datos (3 tablas nuevas, aditivas)

```prisma
// Bolsa por organización (una fila por tenant).
model MessageWallet {
  id                 String   @id @default(cuid())
  organizationId     String   @unique @map("organization_id")
  balance            Int      @default(0)                 // créditos disponibles
  includedPerPeriod  Int      @default(0) @map("included_per_period") // snapshot del plan al renovar
  carryoverCap       Int      @default(0) @map("carryover_cap")       // tope de acumulación (= 1 mes de bolsa)
  periodStart        DateTime @default(now()) @map("period_start")
  updatedAt          DateTime @updatedAt @map("updated_at")
  @@map("message_wallets")
}

// Libro de movimientos: append-only, fuente de verdad auditable.
model WalletLedger {
  id             String   @id @default(cuid())
  organizationId String   @map("organization_id")
  delta          Int                                   // + acredita, − descuenta
  reason         String                                // plan_renewal | package_purchase | send_debit | refund | admin_adjust
  balanceAfter   Int      @map("balance_after")
  category       String?                               // utility|marketing|authentication (en send_debit)
  costUsd        Decimal? @map("cost_usd") @db.Decimal(12, 6) // costo real Meta del envío (para margen)
  refType        String?  @map("ref_type")             // messageId | invoiceId | packageCode
  refId          String?  @map("ref_id")
  createdById    String?  @map("created_by_id")         // super admin en ajustes
  createdAt      DateTime @default(now()) @map("created_at")
  @@index([organizationId, createdAt])
  @@map("wallet_ledger")
}

// Catálogo de paquetes adicionales — EDITABLE desde el Super Admin, sin redeploy.
model MessagePackage {
  id        String   @id @default(cuid())
  code      String   @unique
  name      String
  credits   Int                                        // créditos que acredita
  priceClp  Int      @map("price_clp")
  priceUsd  Decimal  @map("price_usd") @db.Decimal(10, 2)
  active    Boolean  @default(true)
  order     Int      @default(0)
  @@map("message_packages")
}
```
RLS: `message_wallets` y `wallet_ledger` llevan `organization_id` → la política
`tenant_isolation` dinámica de `setup.sql` las cubre sola tras `db:setup` (como
`push_devices`). `message_packages` es catálogo global (lo lee la plataforma).

### 2.2 Configurable desde el Super Admin (sin redeploy) — igual que los topes

- **Incluidos por plan**: se guarda en `plan.features.messageQuota` (los planes ya
  se editan en `/admin/plans`). Al renovar, se copia a `wallet.includedPerPeriod`.
- **Pesos por categoría** (Opción A/B de 1.4): `platform_settings.walletWeights`
  (`{ utility:1, authentication:1, marketing:1 }` por defecto → por cantidad).
- **Paquetes**: tabla `message_packages` con una pantalla CRUD en el Super Admin.
- **Tope de acumulación**: `plan.features.walletCarryover` o
  `platform_settings.walletCarryoverMonths` (default 1 mes).

### 2.3 Débito ATÓMICO y PREVIO al envío (sin condiciones de carrera)

En la MISMA transacción que crea el `message` saliente de tipo TEMPLATE, ANTES de
encolar/enviar:
```sql
UPDATE message_wallets
   SET balance = balance - :weight
 WHERE organization_id = :org AND balance >= :weight
 RETURNING balance;            -- 0 filas = sin saldo → NO se crea el mensaje ni se envía
```
- `:weight` = peso de la categoría (1 utilidad, 1 auth, N marketing).
- Si devuelve 0 filas → se rechaza el envío con mensaje claro (igual que hoy hace
  el fusible puente) y se ofrece comprar paquete.
- Se inserta `wallet_ledger` (reason `send_debit`, `refType=messageId`, `costUsd`).
- **Idempotencia por `messageId`**: el job de outbound es idempotente; si BullMQ
  reintenta un mensaje ya debitado, **no vuelve a descontar** (el `send_debit`
  quedó ligado a ese `messageId` — se comprueba antes de debitar de nuevo).
- **Servicio (24 h) = gratis**: no toca la bolsa.
- Convive con el **fusible global** (se queda como red de última instancia) y
  **reemplaza** al tope-por-tenant puente (la bolsa pasa a ser el límite duro).

### 2.4 Renovación y acumulación

Al confirmarse el pago del período (webhook, ya firmado + idempotente):
```
balance = min(balance, carryoverCap) + includedPerPeriod
```
con `carryoverCap = includedPerPeriod` (1 mes). Así nadie junta seis meses para un
envío masivo que descalabre el gasto de golpe (tu decisión). `ledger`:
`plan_renewal`.

### 2.5 Compra de paquetes (reusa el checkout existente)

El tenant compra en 2 clics → checkout Flow (CLP) / Lemon Squeezy (USD) ya
integrado. El **webhook firmado e idempotente** acredita `+credits`
(`ledger.reason = package_purchase`, `refType=invoiceId`). **Nunca** se acredita
saldo fuera del webhook o de un ajuste manual del Super Admin (auditado).

### 2.6 Visibilidad

- **Tenant**: saldo siempre visible; avisos al **80%** y **100%** (eventos
  `wallet.low` / `wallet.empty` del catálogo de notificaciones ya construido);
  compra de paquete en 2 clics; al bloquearse un envío, mensaje claro en la bandeja.
- **Super Admin**: saldo y consumo por tenant, **gasto Meta del mes vs cobrado**, y
  **margen real por cliente** (ingreso − costo Meta [del `ledger.costUsd`] − costo
  IA). La calculadora ya tiene las tarifas; esto la cruza con el consumo real.

### 2.7 Plan de implementación (cuando des OK)

1. Migración (3 tablas) + `db:setup` (RLS) — **a tu OK, con backup como siempre**.
2. Débito atómico en el punto único de envío (junto al fusible puente actual).
3. Renovación/carryover en el webhook + backfill inicial de bolsas.
4. Compra de paquetes (checkout) + webhook acreditando.
5. UI tenant (saldo + avisos + compra) y Super Admin (paquetes CRUD, margen/tenant).
6. Migrar el "tope por tenant" puente → la bolsa como límite duro; dejar el fusible
   global como red.

### 2.8 Riesgo de flujo de caja (tu pregunta del Eje 1.5)

Con la bolsa, **lo máximo que financias por cliente = su saldo prepagado** (bolsa
del plan + paquetes comprados), que **ya te pagó**. El único financiamiento posible
es intra-período por el carryover (≤ 1 mes de bolsa) y el fusible global acota el
agregado. Exposición no cubierta hoy: **cero envío sin saldo**.

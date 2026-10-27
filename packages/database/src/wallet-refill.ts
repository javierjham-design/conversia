import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * RECARGA DE LA BOLSA DE MENSAJES — única implementación (auditoría §9.3/§9.5).
 *
 * La regla de negocio NO cambia: al pagar un período, la bolsa queda en
 * `min(saldo, cupo) + cupo` (carryover tope = 1 mes, docs/PREPAID_WALLET_DESIGN.md)
 * y queda el asiento `plan_renewal` en el libro. Lo que cambia es que:
 *   1. vive en UN solo lugar — la llamaban (o FALTABA) en 4 sitios distintos: pago por
 *      pasarela, cobro recurrente del worker, "registrar pago" y "asignar suscripción";
 *   2. es ATÓMICA: un único `INSERT … ON CONFLICT DO UPDATE SET balance =
 *      LEAST(balance, cupo) + cupo … RETURNING balance` en vez de leer-modificar-escribir,
 *      así un débito concurrente del worker ya no se pierde (antes: leer saldo → calcular →
 *      escribir pisaba el débito que había entrado entremedio).
 *
 * Acepta tanto el cliente admin como un `tx` de `withTenant` (ambos exponen los delegados
 * y `$queryRaw`); dentro de `withTenant` la sentencia cruda también queda acotada por la
 * RLS, porque corre en la misma transacción que fija `app.org_id`. Una sola sentencia
 * también evita abortar esa transacción por una carrera de creación.
 */
export type WalletDbClient = Prisma.TransactionClient | PrismaClient;

/** Cupo del plan: −1 = ilimitado (práctico), 0 = plan sin cupo (Free), sin definir = mínimo seguro. */
export function messageWalletQuota(features: unknown, walletDefault: number): number {
  const q = Number((features as Record<string, unknown> | null)?.templateMessages);
  if (q === -1) return 1_000_000;
  return Number.isFinite(q) && q >= 0 ? Math.round(q) : walletDefault;
}

export interface RefillWalletInput {
  organizationId: string;
  /** Cupo del período (ver `messageWalletQuota`). */
  included: number;
  /** Razón del asiento del libro (default `plan_renewal`). */
  reason?: string;
  refType?: string;
  refId?: string;
}

export interface RefillWalletResult {
  balanceBefore: number;
  balanceAfter: number;
  included: number;
}

/**
 * Deja la bolsa en `min(saldo, cupo) + cupo` de forma ATÓMICA y escribe el asiento del
 * libro. Devuelve el saldo resultante (autoritativo: sale del `RETURNING` de la sentencia).
 */
export async function refillMessageWallet(db: WalletDbClient, input: RefillWalletInput): Promise<RefillWalletResult> {
  const organizationId = input.organizationId;
  if (!organizationId) throw new Error("refillMessageWallet: organizationId requerido");
  const included = Math.max(0, Math.round(Number(input.included) || 0));

  // Saldo previo SOLO para el `delta` informativo del libro; el saldo final sale de la
  // sentencia atómica. Ningún cálculo de dinero depende de esta lectura.
  const prev = await db.messageWallet.findUnique({ where: { organizationId }, select: { balance: true } });
  const balanceBefore = prev?.balance ?? 0;

  // El `id` se genera acá porque la columna no tiene default en la BD (lo pone Prisma al
  // crear). `NOW() AT TIME ZONE 'UTC'` (no `NOW()` a secas): las columnas DateTime de Prisma son
  // `timestamp` SIN zona y se guardan en UTC — así el período no depende del TimeZone de
  // la sesión de Postgres.
  const rows = await db.$queryRaw<Array<{ balance: number }>>`
    INSERT INTO "message_wallets" ("id", "organization_id", "balance", "included_per_period", "carryover_cap", "period_start", "updated_at")
    VALUES (${randomUUID()}, ${organizationId}, ${included}::int, ${included}::int, ${included}::int, (NOW() AT TIME ZONE 'UTC'), (NOW() AT TIME ZONE 'UTC'))
    ON CONFLICT ("organization_id") DO UPDATE
       SET "balance" = LEAST("message_wallets"."balance", ${included}::int) + ${included}::int,
           "included_per_period" = ${included}::int,
           "carryover_cap" = ${included}::int,
           "period_start" = (NOW() AT TIME ZONE 'UTC'),
           "updated_at" = (NOW() AT TIME ZONE 'UTC')
    RETURNING "balance"
  `;
  const row = rows[0];
  if (!row) throw new Error(`refillMessageWallet: no se pudo recargar la bolsa de ${organizationId}`);
  const balanceAfter = Number(row.balance);

  await db.walletLedger.create({
    data: {
      organizationId,
      delta: balanceAfter - balanceBefore,
      reason: input.reason ?? "plan_renewal",
      balanceAfter,
      refType: input.refType ?? "invoice",
      refId: input.refId ?? null,
    },
  });

  return { balanceBefore, balanceAfter, included };
}

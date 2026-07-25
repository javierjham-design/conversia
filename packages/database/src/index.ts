import { Prisma, PrismaClient } from "@prisma/client";

export * from "@prisma/client";
export { Prisma };

export type TenantTx = Prisma.TransactionClient;

let singleton: PrismaClient | undefined;

/** Cliente Prisma singleton (conexión DATABASE_URL — rol de app en prod). */
export function getPrisma(): PrismaClient {
  if (!singleton) {
    singleton = new PrismaClient();
  }
  return singleton;
}

/**
 * Ejecuta `fn` dentro de una transacción con el contexto de tenant aplicado:
 * setea `app.org_id` (local a la transacción) para que las políticas RLS
 * de Postgres filtren toda lectura/escritura por organización.
 *
 * Es la ÚNICA vía autorizada para tocar datos de tenant. El orgId debe venir
 * del JWT autenticado o del canal receptor del webhook — jamás del cliente.
 */
export async function withTenant<T>(
  orgId: string,
  fn: (tx: TenantTx) => Promise<T>,
  client: PrismaClient = getPrisma(),
): Promise<T> {
  if (!orgId || typeof orgId !== "string") {
    throw new Error("withTenant: organizationId requerido");
  }
  return client.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.org_id', ${orgId}, true)`;
    return fn(tx);
  });
}

/** Registra un evento de consumo (tokens, mensajes, ejecuciones) del tenant. */
export async function recordUsage(
  tx: TenantTx,
  orgId: string,
  type: string,
  quantity: number,
  meta: Record<string, unknown> = {},
  costUsd?: number,
): Promise<void> {
  await tx.usageEvent.create({
    data: {
      organizationId: orgId,
      type,
      quantity,
      costUsd: costUsd ?? null,
      meta: meta as Prisma.InputJsonObject,
    },
  });
}

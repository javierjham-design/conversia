import { Prisma, PrismaClient } from "@prisma/client";

export * from "@prisma/client";
export { Prisma };

export type TenantTx = Prisma.TransactionClient;

let tenantClient: PrismaClient | undefined;
let adminClient: PrismaClient | undefined;

/**
 * Cliente de TENANT (DATABASE_URL). En producción debe conectar como rol
 * `conversia_app` (sin BYPASSRLS): las políticas RLS son la barrera real.
 * Úsalo SOLO a través de withTenant().
 */
export function getPrisma(): PrismaClient {
  if (!tenantClient) {
    tenantClient = new PrismaClient();
  }
  return tenantClient;
}

/**
 * Cliente ADMIN (DIRECT_DATABASE_URL, superusuario). EXCLUSIVO para
 * operaciones de plataforma que cruzan tenants por diseño:
 * registro de organizaciones, login (usuarios globales), resolución de
 * tenant por canal receptor y el scheduler de timers. Nada más.
 */
export function getAdminPrisma(): PrismaClient {
  if (!adminClient) {
    const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
    adminClient = new PrismaClient({ datasources: { db: { url } } });
  }
  return adminClient;
}

/**
 * Ejecuta `fn` en una transacción con contexto de tenant: setea `app.org_id`
 * (local a la transacción) para que las políticas RLS filtren toda
 * lectura/escritura. Única vía autorizada para tocar datos de tenant.
 * El orgId debe venir del JWT o del canal receptor — jamás del cliente.
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

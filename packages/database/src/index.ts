import { Prisma, PrismaClient } from "@prisma/client";

export * from "@prisma/client";
export { Prisma };

export type TenantTx = Prisma.TransactionClient;

let tenantClient: PrismaClient | undefined;
let adminClient: PrismaClient | undefined;

/**
 * Acota el pool de conexiones de Prisma POR PROCESO agregando `connection_limit`
 * (y `pool_timeout`) al URL si no vienen ya. Sin esto, el pool por defecto de
 * Prisma (≈ vCPU×2+1) por cada cliente y por cada réplica puede agotar el
 * `max_connections` de Postgres (≈100 en Railway) apenas se escala horizontalmente
 * — que es el primer cuello de botella de este stack. Configurable por env para
 * poder subirlo/bajarlo sin re-deploy de código. Si el URL no parsea, se deja igual.
 */
function withPoolParams(rawUrl: string | undefined, defaultLimit: number): string | undefined {
  if (!rawUrl) return rawUrl;
  try {
    const url = new URL(rawUrl);
    const limit = process.env.DB_CONNECTION_LIMIT ?? String(defaultLimit);
    if (!url.searchParams.has("connection_limit")) url.searchParams.set("connection_limit", limit);
    if (!url.searchParams.has("pool_timeout")) url.searchParams.set("pool_timeout", process.env.DB_POOL_TIMEOUT ?? "15");
    return url.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * Cliente de TENANT (DATABASE_URL). En producción debe conectar como rol
 * `conversia_app` (sin BYPASSRLS): las políticas RLS son la barrera real.
 * Úsalo SOLO a través de withTenant().
 */
export function getPrisma(): PrismaClient {
  if (!tenantClient) {
    const url = withPoolParams(process.env.DATABASE_URL, 5);
    tenantClient = url ? new PrismaClient({ datasources: { db: { url } } }) : new PrismaClient();
  }
  return tenantClient;
}

/**
 * Cliente ADMIN (DIRECT_DATABASE_URL, superusuario). EXCLUSIVO para
 * operaciones de plataforma que cruzan tenants por diseño:
 * registro de organizaciones, login (usuarios globales), resolución de
 * tenant por canal receptor y el scheduler de timers. Nada más.
 * Pool más chico: se usa mucho menos que el de tenant.
 */
export function getAdminPrisma(): PrismaClient {
  if (!adminClient) {
    const url = withPoolParams(process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL, 3);
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
  // Solo para jobs de LOTE (p. ej. import de contactos): el default de 5 s de
  // Prisma se mantiene para todo el resto — es una red sana contra
  // transacciones largas accidentales.
  options?: { timeout?: number; maxWait?: number },
): Promise<T> {
  if (!orgId || typeof orgId !== "string") {
    throw new Error("withTenant: organizationId requerido");
  }
  return client.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.org_id', ${orgId}, true)`;
    return fn(tx);
  }, options);
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

/**
 * Normaliza un nombre/slug de agente para comparar sin acentos, sin distinción de
 * mayúsculas y tratando guiones/guiones_bajos/espacios como equivalentes. Así
 * "@RESP IMPLANTES", "RESP IMPLANTES" y el slug "resp-implantes" resuelven al mismo agente.
 */
export function normalizeAgentKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/@/g, "")
    .replace(/[\s_-]+/g, " ")
    .trim();
}

/**
 * Resuelve un agente por SLUG o NOMBRE (insensible a mayúsculas/acentos/guiones).
 * `tx` ya está acotado al tenant por withTenant (RLS), así que la búsqueda es por org.
 * Devuelve null si no hay match. NO filtra por `active` (el caller decide).
 */
export async function resolveAgentByNameOrSlug(
  tx: TenantTx,
  raw: string,
): Promise<{ id: string; slug: string; name: string; active: boolean } | null> {
  const key = normalizeAgentKey(raw ?? "");
  if (!key) return null;
  const agents = await tx.agent.findMany({
    where: { deletedAt: null },
    select: { id: true, slug: true, name: true, active: true },
  });
  return agents.find((a) => normalizeAgentKey(a.slug) === key || normalizeAgentKey(a.name) === key) ?? null;
}

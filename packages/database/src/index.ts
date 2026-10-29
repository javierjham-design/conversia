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
 * Estado del chequeo de rol de BD del cliente de TENANT (auditoría §2.0, etapa 2).
 * `null` = todavía no verificado (o no aplica, p. ej. fuera de producción).
 * `false` = el usuario de `DATABASE_URL` puede SALTARSE la RLS.
 */
let dbRoleOk: boolean | null = null;
/** Última vez (ms) que se INTENTÓ el chequeo — para acotar el reintento desde /health. */
let lastDbRoleCheckAt = 0;
/** Tope del reintento: como mucho una pasada por minuto mientras siga sin verificar. */
export const DB_ROLE_RECHECK_MS = 60_000;

/**
 * Lo consume `/health/status` para avisar si el aislamiento entre clientes está
 * dependiendo solo de los filtros del código (y no de la RLS).
 */
export function getDbRoleStatus(): { checked: boolean; ok: boolean | null } {
  return { checked: dbRoleOk !== null, ok: dbRoleOk };
}

/**
 * ¿La fila de `pg_roles` dice que el rol puede saltarse la RLS? `null` = no se pudo
 * determinar (sin fila). Pura y exportada para testear la regla sin una BD.
 */
export function roleBypassesRls(
  row: { rolsuper?: boolean; rolbypassrls?: boolean } | undefined | null,
): boolean | null {
  if (!row) return null;
  return row.rolsuper === true || row.rolbypassrls === true;
}

/**
 * ¿Toca (re)intentar el chequeo AHORA? Solo en producción, solo si sigue sin verificar y
 * respetando el tope de una pasada por minuto. Pura y exportada para testearla sin estado.
 */
export function shouldRecheckDbRole(
  status: { ok: boolean | null },
  isProduction: boolean,
  now: number,
  lastCheckAt: number,
  recheckMs: number = DB_ROLE_RECHECK_MS,
): boolean {
  return isProduction && status.ok === null && now - lastCheckAt >= recheckMs;
}

/**
 * Verifica que el rol de `DATABASE_URL` NO pueda saltarse la RLS. Deliberadamente
 * NO tumba el proceso: TuBot tiene clientes 24/7 y un arranque fallido sería peor
 * que el aviso. Solo deja registro ruidoso y marca `/health/status` en 503.
 *
 * El error se REGISTRA (solo el mensaje, nunca el URL/credenciales), no se traga: antes el
 * catch silencioso dejaba el estado en "sin verificar" para siempre en producción y nadie
 * sabía por qué. Una sola pasada al arrancar no basta — ver `ensureTenantDbRoleChecked`.
 */
export async function checkTenantDbRole(client: PrismaClient = getPrisma()): Promise<void> {
  try {
    const rows = await client.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    const bypasses = roleBypassesRls(rows[0]);
    if (bypasses === null) return; // no se pudo determinar: se deja sin verificar
    dbRoleOk = !bypasses;
    if (bypasses) {
      console.error(
        "✖ SEGURIDAD (aislamiento entre clientes): el usuario de DATABASE_URL puede saltarse la RLS " +
          "(rolsuper o rolbypassrls). Las políticas RLS NO están protegiendo nada y el aislamiento " +
          "depende solo de los filtros del código. Hay que apuntar DATABASE_URL a un rol restringido " +
          "(conversia_app) definiendo además DIRECT_DATABASE_URL como admin. Ver docs/PROMPT_CORRECCIONES_AUDITORIA.md §2.0.",
      );
    }
  } catch (err) {
    // Antes se tragaba en silencio → en prod el estado quedaba "sin verificar" para siempre.
    // Ahora se registra para poder diagnosticar (SIN el URL: `.message` no trae credenciales).
    console.error("✖ No se pudo verificar el rol de BD (RLS):", (err as Error).message);
  }
}

/**
 * Asegura (desde `/health/status`) que el chequeo de rol se haya INTENTADO, sin depender de
 * una única pasada al arrancar. Si sigue "sin verificar", lo reintenta —como mucho una vez
 * por minuto— y devuelve el estado ya actualizado. `isProduction` lo decide el llamador con
 * el env YA validado (`getEnv().NODE_ENV`), no con `process.env` crudo: así el chequeo no
 * vuelve a quedarse sin correr por un desajuste de esa variable en el contenedor.
 */
export async function ensureTenantDbRoleChecked(
  isProduction: boolean,
  opts: { client?: PrismaClient; now?: number } = {},
): Promise<{ checked: boolean; ok: boolean | null }> {
  const now = opts.now ?? Date.now();
  if (shouldRecheckDbRole(getDbRoleStatus(), isProduction, now, lastDbRoleCheckAt)) {
    lastDbRoleCheckAt = now;
    await checkTenantDbRole(opts.client ?? getPrisma());
  }
  return getDbRoleStatus();
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
    // Solo en producción: en dev/tests el rol suele ser el dueño de la BD a propósito.
    if (process.env.NODE_ENV === "production") void checkTenantDbRole(tenantClient);
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
    // Si falta DIRECT_DATABASE_URL, el cliente "admin" cae al mismo rol del tenant: con un
    // rol restringido (conversia_app) se rompen login, registro y ruteo de webhooks, que
    // por diseño cruzan tenants (auditoría §2.0).
    if (!process.env.DIRECT_DATABASE_URL) {
      console.warn(
        "⚠ DIRECT_DATABASE_URL no está definida: el cliente ADMIN usará DATABASE_URL. " +
          "Si ese rol es restringido (sin BYPASSRLS), login, registro y ruteo de webhooks fallarán.",
      );
    }
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
 * `organizationId` es OBLIGATORIO y va explícito en el `where`: aunque `withTenant` ya
 * acota por RLS, una derivación entre agentes jamás debe poder resolver al agente de
 * otro cliente (auditoría §2.0, etapa 2).
 * Devuelve null si no hay match. NO filtra por `active` (el caller decide).
 */
export async function resolveAgentByNameOrSlug(
  tx: TenantTx,
  raw: string,
  organizationId: string,
): Promise<{ id: string; slug: string; name: string; active: boolean } | null> {
  const key = normalizeAgentKey(raw ?? "");
  if (!key) return null;
  const agents = await tx.agent.findMany({
    where: { organizationId, deletedAt: null },
    select: { id: true, slug: true, name: true, active: true },
  });
  return agents.find((a) => normalizeAgentKey(a.slug) === key || normalizeAgentKey(a.name) === key) ?? null;
}

// Loaders de datos de rubro (F2): compartidos por el seed y el instalador de paquetes.
export * from "./vertical-loaders.js";

// Recarga ATÓMICA de la bolsa de mensajes (§9.3/§9.5): compartida por la API
// (activar/registrar pago/asignar suscripción) y el worker (cobro recurrente).
export * from "./wallet-refill.js";

// CRE 3 — muestra de consumo de créditos (estimador). Una sola consulta para el panel y
// el worker: dos cálculos distintos del mismo saldo harían que el dueño no le crea a ninguno.
export * from "./credit-usage.js";

/**
 * V2-8 — levanta una excepción en la cola de operación (idempotente por dedupeKey abierto).
 * La usan los módulos V2-1…V2-7 (API y worker). `admin` = cliente sin RLS (getAdminPrisma()).
 */
export async function raiseException(
  admin: PrismaClient,
  input: { organizationId: string; type: string; title: string; severity?: "info" | "warning" | "critical"; detail?: string; dedupeKey?: string },
): Promise<void> {
  try {
    if (input.dedupeKey) {
      const open = await admin.platformException.findFirst({
        where: { organizationId: input.organizationId, type: input.type, dedupeKey: input.dedupeKey, status: { in: ["open", "assigned"] } },
        select: { id: true },
      });
      if (open) return; // ya hay una abierta igual
    }
    await admin.platformException.create({
      data: { organizationId: input.organizationId, type: input.type, title: input.title, severity: input.severity ?? "warning", detail: input.detail ?? null, dedupeKey: input.dedupeKey ?? null },
    });
  } catch (e) {
    console.error(`✖ raiseException (${input.type}/${input.organizationId}):`, (e as Error).message);
  }
}

/**
 * Cierra (resuelve) las excepciones abiertas que coincidan con el tipo (+ dedupeKey) — la
 * contraparte de `raiseException` para auto-resolución cuando la causa se recupera (p. ej. el
 * token de WhatsApp vuelve a responder). Devuelve cuántas cerró. Best-effort.
 */
export async function resolveException(
  admin: PrismaClient,
  input: { organizationId: string; type: string; dedupeKey?: string; resolution?: string },
): Promise<number> {
  try {
    const res = await admin.platformException.updateMany({
      where: {
        organizationId: input.organizationId,
        type: input.type,
        ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
        status: { in: ["open", "assigned"] },
      },
      data: { status: "resolved", resolvedAt: new Date(), resolution: input.resolution ?? "Resuelto automáticamente" },
    });
    return res.count;
  } catch (e) {
    console.error(`✖ resolveException (${input.type}/${input.organizationId}):`, (e as Error).message);
    return 0;
  }
}

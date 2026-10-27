import type { TenantTx } from "@conversia/database";
import type { PrismaService } from "../prisma.service";

/**
 * ETAPA 0 (hallazgo 2) — "el canal se crea sin agente asignado".
 *
 * El cliente conectaba su WhatsApp y NADIE respondía: `channel_connections.default_agent_id`
 * quedaba en null (el panel nunca lo manda) y el worker, sin agente por defecto, abre la
 * conversación sin `activeAgentId` (ver apps/worker/src/agent-turn.ts:193 y inbound.ts:443).
 *
 * Esta función cierra el hueco en UN solo lugar, reutilizado desde:
 *  - la conexión del canal (manual, Embedded Signup y coexistencia) → channels.controller.ts
 *  - la publicación del agente (publish y qa-publish) → agents.controller.ts
 *
 * Reglas:
 *  - Solo marca `conversia`. TuBot queda EXACTAMENTE como está (sale por `marca-no-conversia`
 *    antes de tocar nada).
 *  - Solo rellena canales con `defaultAgentId` NULL: jamás pisa el que puso el cliente.
 *  - Idempotente: correrla dos veces no cambia nada (la 2ª vez no hay canales pendientes) y
 *    el propio `updateMany` vuelve a filtrar por `defaultAgentId: null` (a prueba de carreras).
 *  - Solo asigna agentes PUBLICADOS (un borrador no responde en producción).
 */

export type AssignSkipReason =
  | "marca-no-conversia"
  | "sin-agente-publicado"
  | "sin-canales-pendientes"
  | "error";

export type AgentChannelAssignment = {
  /** Canales a los que se les puso el agente en ESTA corrida (0 = nada por hacer). */
  assigned: number;
  /** Agente publicado elegido (null si no había ninguno). */
  agentId: string | null;
  channelIds: string[];
  reason?: AssignSkipReason;
};

export type AssignOptions = {
  /** Agente que se acaba de publicar: se prefiere si tiene versión publicada. */
  preferAgentId?: string | null;
  /** Usuario que disparó la acción (para el auditLog); null → queda como "system". */
  actorId?: string | null;
  /** Marca ya resuelta por quien llama (evita una consulta extra). */
  brand?: string | null;
};

const skip = (reason: AssignSkipReason, agentId: string | null = null): AgentChannelAssignment => ({
  assigned: 0,
  agentId,
  channelIds: [],
  reason,
});

const stamp = (d: Date | null | undefined): number => (d ? new Date(d).getTime() : 0);

/**
 * Elige el agente PUBLICADO de la organización. Preferencia: el que se acaba de publicar; si
 * no, el de publicación más reciente (desempate estable por versión y por id).
 */
async function pickPublishedAgentId(tx: TenantTx, preferAgentId?: string | null): Promise<string | null> {
  const versions = await tx.agentVersion.findMany({
    where: { status: "PUBLISHED", agent: { deletedAt: null, active: true } },
    select: { agentId: true, version: true, publishedAt: true },
  });
  if (!versions.length) return null;
  if (preferAgentId && versions.some((v) => v.agentId === preferAgentId)) return preferAgentId;
  const best = [...versions].sort(
    (a, b) =>
      stamp(b.publishedAt) - stamp(a.publishedAt) ||
      b.version - a.version ||
      a.agentId.localeCompare(b.agentId),
  )[0];
  return best?.agentId ?? null;
}

/** Núcleo, DENTRO de una transacción de tenant ya abierta (RLS puesta). */
export async function assignPublishedAgentToChannelsTx(
  tx: TenantTx,
  orgId: string,
  opts: AssignOptions = {},
): Promise<AgentChannelAssignment> {
  const agentId = await pickPublishedAgentId(tx, opts.preferAgentId);
  if (!agentId) return skip("sin-agente-publicado");

  const pending = await tx.channelConnection.findMany({
    where: { defaultAgentId: null, status: { not: "inactive" } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  if (!pending.length) return skip("sin-canales-pendientes", agentId);

  const channelIds = pending.map((c) => c.id);
  // El filtro `defaultAgentId: null` va OTRA VEZ aquí: si entre la lectura y la escritura el
  // cliente eligió su agente, no se lo pisamos.
  const updated = await tx.channelConnection.updateMany({
    where: { id: { in: channelIds }, defaultAgentId: null },
    data: { defaultAgentId: agentId },
  });
  if (updated.count === 0) return skip("sin-canales-pendientes", agentId);

  await tx.auditLog.create({
    data: {
      organizationId: orgId,
      actorType: opts.actorId ? "user" : "system",
      actorId: opts.actorId ?? "auto-assign",
      action: "channel.agent_auto_assigned",
      entityType: "channel_connection",
      entityId: channelIds[0],
      after: { agentId, channelIds, assigned: updated.count },
    },
  });

  return { assigned: updated.count, agentId, channelIds };
}

/** Resuelve la marca de la org (solo `conversia` activa la asignación automática). */
async function resolveBrand(prisma: PrismaService, orgId: string, given?: string | null): Promise<string> {
  if (given) return given.toLowerCase();
  const org = await prisma.admin.organization
    .findUnique({ where: { id: orgId }, select: { brand: true } })
    .catch(() => null);
  return (org?.brand ?? "tubot").toLowerCase();
}

/** Abre su propia transacción. Lanza si la BD falla (usar la variante …Safe en los flujos). */
export async function assignPublishedAgentToChannels(
  prisma: PrismaService,
  orgId: string,
  opts: AssignOptions = {},
): Promise<AgentChannelAssignment> {
  const brand = await resolveBrand(prisma, orgId, opts.brand);
  if (brand !== "conversia") return skip("marca-no-conversia");
  return prisma.withTenant(orgId, (tx) => assignPublishedAgentToChannelsTx(tx, orgId, opts));
}

/**
 * Variante FAIL-SOFT para los flujos de conexión/publicación: un problema asignando el agente
 * nunca puede tumbar la conexión de WhatsApp ni la publicación (el cliente lo puede elegir a
 * mano en Canales).
 */
export async function assignPublishedAgentToChannelsSafe(
  prisma: PrismaService,
  orgId: string,
  opts: AssignOptions = {},
): Promise<AgentChannelAssignment> {
  try {
    return await assignPublishedAgentToChannels(prisma, orgId, opts);
  } catch (e) {
    console.error("✖ asignar agente al canal:", (e as Error)?.message ?? e);
    return skip("error");
  }
}

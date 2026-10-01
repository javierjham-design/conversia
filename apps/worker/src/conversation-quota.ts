import { getAdminPrisma, withTenant } from "@conversia/database";

/**
 * CUPO DE CONVERSACIONES POR PERÍODO (plan servicio-octubre-2026, E3).
 *
 * El servicio (respuestas del bot en la ventana de 24 h) se controla por
 * CONVERSACIONES — la unidad que el cliente entiende — no por mensaje. Cada
 * conversación cuenta UNA sola vez por período de facturación. La marca única
 * (org, conversación, período) garantiza idempotencia entre workers; el counter
 * lleva el agregado atómico (used/overage) con el `included` sellado al abrir el
 * período.
 *
 * Convención del cupo (features.conversationsPerPeriod, PROPIA de E3 — distinta de
 * features.templateMessages donde 0 BLOQUEA): 0 = sin cupo → SOLO medición (cuenta,
 * sin avisos ni topes); -1 = ilimitado (mide, nunca avisa/topa); N>0 = cupo mensual.
 */

export interface QuotaResult {
  counted: boolean; // ¿esta llamada contó la conversación (primera vez del período)?
  used: number;
  included: number; // cupo del plan: 0 = sin cupo, -1 = ilimitado, N>0 = cupo
  overagePct: number; // % usado sobre included (0 si included <= 0)
  periodStart: string; // YYYY-MM-DD (UTC)
  blockedByHardCap?: boolean; // tope duro: cupo lleno y la conversación es nueva
}

/**
 * Inicio del período (día UTC). Si hay suscripción activa, el día de su periodStart;
 * si no, el día 1 del mes calendario UTC. PURA (testeable sin BD).
 */
export function resolvePeriodStart(subPeriodStart: Date | null | undefined, now: Date): Date {
  if (subPeriodStart) {
    return new Date(Date.UTC(subPeriodStart.getUTCFullYear(), subPeriodStart.getUTCMonth(), subPeriodStart.getUTCDate()));
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function pct(used: number, included: number): number {
  if (included <= 0) return 0;
  return Math.round((used / included) * 100);
}

/** Cupo (included) + periodStart del tenant, desde la suscripción activa más reciente. */
async function resolvePeriodAndQuota(organizationId: string, now: Date): Promise<{ periodStart: Date; included: number }> {
  const prisma = getAdminPrisma();
  const sub = await prisma.subscription
    .findFirst({ where: { organizationId, status: { in: ["ACTIVE", "TRIALING"] } }, orderBy: { createdAt: "desc" }, select: { planId: true, periodStart: true } })
    .catch(() => null);
  const plan = sub?.planId
    ? await prisma.plan.findUnique({ where: { id: sub.planId }, select: { features: true } }).catch(() => null)
    : await prisma.plan.findUnique({ where: { code: "free" }, select: { features: true } }).catch(() => null);
  const raw = (plan?.features as Record<string, unknown> | undefined)?.conversationsPerPeriod;
  const included = typeof raw === "number" ? raw : Number.isFinite(Number(raw)) ? Number(raw) : 0;
  return { periodStart: resolvePeriodStart(sub?.periodStart ?? null, now), included };
}

/**
 * Cuenta la conversación UNA vez en su período (idempotente). Con opts.hardCap y
 * cupo N>0 lleno, NO cuenta una conversación NUEVA (no inserta la marca) y devuelve
 * blockedByHardCap — una conversación ya contada este período siempre pasa.
 */
export async function countConversationOnce(
  organizationId: string,
  conversationId: string,
  now: Date,
  opts?: { hardCap?: boolean },
): Promise<QuotaResult> {
  const prisma = getAdminPrisma();
  const { periodStart, included } = await resolvePeriodAndQuota(organizationId, now);
  const periodStr = periodStart.toISOString().slice(0, 10);

  // ¿Ya contó esta conversación este período?
  const existing = await prisma.conversationQuotaMark
    .findUnique({ where: { organizationId_conversationId_periodStart: { organizationId, conversationId, periodStart } }, select: { id: true } })
    .catch(() => null);
  const counter = await prisma.conversationQuotaCounter
    .findUnique({ where: { organizationId_periodStart: { organizationId, periodStart } }, select: { used: true } })
    .catch(() => null);
  const usedNow = counter?.used ?? 0;

  if (existing) {
    return { counted: false, used: usedNow, included, overagePct: pct(usedNow, included), periodStart: periodStr };
  }

  // Tope DURO: cupo lleno y conversación NUEVA → no contar (no insertar la marca).
  if (opts?.hardCap && included > 0 && usedNow >= included) {
    return { counted: false, used: usedNow, included, overagePct: pct(usedNow, included), periodStart: periodStr, blockedByHardCap: true };
  }

  // Inserta la marca (idempotente). Carrera entre workers → unique violation → ya contó.
  let inserted = true;
  try {
    await prisma.conversationQuotaMark.create({ data: { organizationId, conversationId, periodStart } });
  } catch {
    inserted = false;
  }
  if (!inserted) {
    const c = await prisma.conversationQuotaCounter
      .findUnique({ where: { organizationId_periodStart: { organizationId, periodStart } }, select: { used: true } })
      .catch(() => null);
    const u = c?.used ?? usedNow;
    return { counted: false, used: u, included, overagePct: pct(u, included), periodStart: periodStr };
  }

  // Upsert + incremento ATÓMICO en una sentencia: used+1; overage+1 solo si hay cupo
  // (included>0) y el used resultante lo supera. `included` se sella al crear la fila.
  const rows = await prisma.$queryRaw<{ used: number }[]>`
    INSERT INTO conversation_quota_counters (organization_id, period_start, used, overage, included, updated_at)
    VALUES (${organizationId}, ${periodStart}::date, 1, 0, ${included}, now())
    ON CONFLICT (organization_id, period_start) DO UPDATE SET
      used = conversation_quota_counters.used + 1,
      overage = CASE
        WHEN conversation_quota_counters.included > 0
         AND conversation_quota_counters.used + 1 > conversation_quota_counters.included
        THEN conversation_quota_counters.overage + 1
        ELSE conversation_quota_counters.overage END,
      updated_at = now()
    RETURNING used`;
  const newUsed = rows[0]?.used ?? 1;

  // UsageEvent por conversación (el que pedía el bloque 1.2; vive aquí porque depende
  // del contador). Es la medición del volumen de conversaciones del período.
  const isOverage = included > 0 && newUsed > included;
  await withTenant(organizationId, (tx) =>
    tx.usageEvent.create({ data: { organizationId, type: "conversation", quantity: 1, meta: { conversationId, periodStart: periodStr, overage: isOverage } } }),
  ).catch(() => undefined);

  return { counted: true, used: newUsed, included, overagePct: pct(newUsed, included), periodStart: periodStr };
}

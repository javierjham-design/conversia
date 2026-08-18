/**
 * Cobro por impago (dunning) — lógica PURA + tick.
 *
 * Ciclo de vida cuando un pago vence sin renovar:
 *   al día → (vence periodEnd) → PERÍODO DE GRACIA (7 días, sigue operando, con
 *   aviso) → (gracia agotada) → SUSPENDIDO (el bot deja de responder y los flujos
 *   se detienen; el panel queda en solo lectura; NADA se borra) → (paga) → ACTIVO.
 *
 * Recomendación de gracia: 7 días — suficiente para que un cliente regularice sin
 * cortar de golpe, sin arrastrar impagos indefinidamente.
 */
export const BILLING_GRACE_DAYS = 7;
const DAY_MS = 86_400_000;

/** Estados de organización en los que la operación (IA + flujos) se detiene. */
export const HALTED_ORG_STATUSES = new Set(["SUSPENDED", "CANCELLED"]);

/** ¿La organización opera (IA responde, flujos corren)? Falso si suspendida/cancelada. */
export function isOrgOperational(status: string | null | undefined): boolean {
  return !HALTED_ORG_STATUSES.has(String(status ?? ""));
}

export type DunningAction = "none" | "enter_grace" | "warn_grace" | "suspend";

export interface DunningInput {
  now: Date;
  periodEnd: Date | null;
  subStatus: string; // ACTIVE | PAST_DUE | TRIALING | CANCELLED
  orgStatus: string; // ACTIVE | TRIAL | SUSPENDED | CANCELLED
  graceDays?: number;
}

/**
 * Decide la transición de cobro. Pura y determinista.
 * - `enter_grace`: venció y aún no estaba en gracia → marcar PAST_DUE + avisar.
 * - `warn_grace`: sigue en gracia (ya avisado) → recordatorio (idempotente por día).
 * - `suspend`: gracia agotada → suspender.
 * - `none`: al día, sin periodo, o ya suspendida.
 */
export function planDunningAction(input: DunningInput): { action: DunningAction; graceEndsAt: Date | null } {
  const graceDays = input.graceDays ?? BILLING_GRACE_DAYS;
  // Ya suspendida/cancelada, o sin fecha de corte, o en trial → no actuar.
  if (HALTED_ORG_STATUSES.has(input.orgStatus) || input.subStatus === "TRIALING" || !input.periodEnd) {
    return { action: "none", graceEndsAt: null };
  }
  const end = input.periodEnd.getTime();
  const graceEnd = end + graceDays * DAY_MS;
  const graceEndsAt = new Date(graceEnd);
  if (input.now.getTime() <= end) return { action: "none", graceEndsAt: null }; // al día
  if (input.now.getTime() >= graceEnd) return { action: "suspend", graceEndsAt };
  // Vencido pero dentro de la gracia.
  return { action: input.subStatus === "PAST_DUE" ? "warn_grace" : "enter_grace", graceEndsAt };
}

// --------------------------- Tick de aplicación ---------------------------
// Deferred imports para mantener el módulo puro testeable sin infraestructura.

/** Escanea suscripciones y aplica gracia/suspensión. Cross-tenant (admin). */
export function startBillingDunning(): () => void {
  const run = async () => {
    try {
      // Si el cobro RECURRENTE (ventana de 48 h) está encendido, el dunning legacy de
      // 7 días NO corre: evita dos lógicas de suspensión conviviendo.
      const { getEnv } = await import("@conversia/config");
      if (getEnv().RECURRING_BILLING_ENABLED) return;
      const { getAdminPrisma, withTenant } = await import("@conversia/database");
      const prisma = getAdminPrisma();
      const now = new Date();
      // Solo suscripciones que pueden vencer (con fecha de corte y no en trial).
      const subs = await prisma.subscription.findMany({
        where: { status: { in: ["ACTIVE", "PAST_DUE"] }, periodEnd: { not: null } },
        select: { id: true, organizationId: true, status: true, periodEnd: true },
      });
      for (const sub of subs) {
        const org = await prisma.organization.findUnique({ where: { id: sub.organizationId }, select: { status: true, settings: true } });
        if (!org) continue;
        const plan = planDunningAction({ now, periodEnd: sub.periodEnd, subStatus: sub.status, orgStatus: org.status });
        if (plan.action === "none" || plan.action === "warn_grace") continue;
        const settings = { ...((org.settings as Record<string, unknown>) ?? {}) };

        if (plan.action === "enter_grace") {
          settings.billing = { state: "grace", graceEndsAt: plan.graceEndsAt?.toISOString() ?? null, since: now.toISOString() };
          await withTenant(sub.organizationId, async (tx) => {
            await tx.subscription.update({ where: { id: sub.id }, data: { status: "PAST_DUE" } });
            await tx.organization.update({ where: { id: sub.organizationId }, data: { settings: settings as object } });
            await tx.integrationEvent.create({
              data: { organizationId: sub.organizationId, provider: "billing", type: "billing.past_due", status: "warning", message: `Pago vencido. Tienes hasta el ${plan.graceEndsAt?.toLocaleDateString("es-CL")} para regularizar antes de que se suspenda el servicio.` },
            });
            await tx.auditLog.create({ data: { organizationId: sub.organizationId, actorType: "system", actorId: "billing", action: "billing.enter_grace", entityType: "subscription", entityId: sub.id, after: { graceEndsAt: plan.graceEndsAt } } });
          });
        } else if (plan.action === "suspend") {
          settings.billing = { state: "suspended", graceEndsAt: plan.graceEndsAt?.toISOString() ?? null, suspendedAt: now.toISOString() };
          await withTenant(sub.organizationId, async (tx) => {
            // Suspender NO borra datos: solo detiene la operación (IA + flujos) y
            // deja el panel en solo lectura. Al pagar, activate() lo revierte.
            await tx.organization.update({ where: { id: sub.organizationId }, data: { status: "SUSPENDED", settings: settings as object } });
            await tx.integrationEvent.create({
              data: { organizationId: sub.organizationId, provider: "billing", type: "billing.suspended", status: "error", message: "Servicio suspendido por falta de pago. El bot dejó de responder y los flujos están detenidos. Paga para reactivar — tus datos siguen intactos." },
            });
            await tx.auditLog.create({ data: { organizationId: sub.organizationId, actorType: "system", actorId: "billing", action: "billing.suspend", entityType: "organization", entityId: sub.organizationId } });
          });
        }
      }
    } catch (err) {
      console.error("✖ billing-dunning tick:", (err as Error).message);
    }
  };
  void run();
  const interval = setInterval(run, 60 * 60 * 1000); // cada hora
  interval.unref?.();
  return () => clearInterval(interval);
}

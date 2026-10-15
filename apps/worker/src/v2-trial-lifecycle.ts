/**
 * V2-9 — Ciclo de vida de la PRUEBA del modelo por conversación (30 conversaciones
 * gratis, sin tarjeta). Lógica PURA + tick. SOLO orgs conversia cuyo plan vigente es
 * `conversia_v2_trial`. Jamás toca TuBot ni purga datos (B6: retention-purge excluye
 * conversia).
 *
 * Ciclo:
 *   30 gratis → (se agotan) → GRACIA 7 días en COPILOTO (aiMode="suggest": el bot
 *   sugiere, un humano aprueba; no se calla ni gasta de más) + se pide ACTIVAR con el
 *   resumen de valor → (7 días sin activar) → PAUSA (aiKillSwitch; NADA se borra) →
 *   (paga la Base en cualquier momento) → se limpian los flags y vuelve a operar.
 *
 * El estado vive en `org.settings.conversia` (graceStartedAt / paused), sin migración.
 */
export const V2_TRIAL_GRACE_DAYS = 7;
const DAY_MS = 86_400_000;

export type V2TrialAction = "none" | "exhaust" | "pause";

export interface V2TrialInput {
  now: Date;
  remaining: number; // saldo de la bolsa (lotes vigentes − gracia)
  graceStartedAt: string | null; // settings.conversia.graceStartedAt
  paused: boolean; // settings.conversia.paused
  graceDays?: number;
}

/**
 * Decide la transición de la prueba V2. Pura y determinista.
 * - `exhaust`: se agotaron las gratis y aún no arrancó la gracia → iniciar copiloto + pedir activación.
 * - `pause`: pasaron los 7 días de gracia sin activar → pausar (reversible, sin purga).
 * - `none`: aún tiene saldo / en gracia / ya pausada.
 */
export function planV2TrialAction(input: V2TrialInput): V2TrialAction {
  const graceDays = input.graceDays ?? V2_TRIAL_GRACE_DAYS;
  if (input.remaining > 0) return "none"; // todavía tiene conversaciones gratis
  if (!input.graceStartedAt) return "exhaust"; // se acaban de agotar
  if (input.paused) return "none"; // ya pausada
  const graceEnds = new Date(input.graceStartedAt).getTime() + graceDays * DAY_MS;
  if (input.now.getTime() >= graceEnds) return "pause";
  return "none"; // dentro de la ventana de gracia (copiloto)
}

// --------------------------- Tick de aplicación ---------------------------

const ONE_HOUR = 60 * 60 * 1000;

/** Escanea las pruebas V2 agotadas y aplica copiloto/pausa. Cross-tenant (admin). */
export function startV2TrialLifecycle(): () => void {
  const run = async () => {
    try {
      const { getAdminPrisma, withTenant, raiseException } = await import("@conversia/database");
      const prisma = getAdminPrisma();
      const now = new Date();
      const trialPlan = await prisma.plan.findUnique({ where: { code: "conversia_v2_trial" }, select: { id: true } });
      if (!trialPlan) return; // catálogo V2 no sembrado → nada que hacer
      // Orgs conversia con suscripción vigente al plan de PRUEBA V2.
      const subs = await prisma.subscription.findMany({
        where: { planId: trialPlan.id, status: { in: ["ACTIVE", "TRIALING"] } },
        select: { organizationId: true },
      });
      if (!subs.length) return;
      const orgs = await prisma.organization.findMany({
        where: { id: { in: subs.map((s) => s.organizationId) }, brand: "conversia", deletedAt: null },
        select: { id: true, name: true, settings: true },
      });
      for (const org of orgs) {
        const settings = { ...((org.settings as Record<string, unknown>) ?? {}) };
        const conversia = { ...((settings.conversia as Record<string, unknown>) ?? {}) };
        // Saldo de la bolsa (lotes vigentes − gracia usada).
        const [lotsAgg, wallet] = await Promise.all([
          prisma.conversationCreditLot.aggregate({ _sum: { remaining: true }, where: { organizationId: org.id, remaining: { gt: 0 }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } }),
          prisma.conversationWallet.findUnique({ where: { organizationId: org.id }, select: { graceUsed: true } }),
        ]);
        const remaining = (lotsAgg._sum.remaining ?? 0) - (wallet?.graceUsed ?? 0);
        const action = planV2TrialAction({
          now,
          remaining,
          graceStartedAt: typeof conversia.graceStartedAt === "string" ? (conversia.graceStartedAt as string) : null,
          paused: conversia.paused === true,
        });
        if (action === "none") continue;

        if (action === "exhaust") {
          // Arranca la gracia en COPILOTO: el bot sugiere, un humano aprueba (no se calla).
          conversia.graceStartedAt = now.toISOString();
          conversia.aiMode = "suggest";
          settings.conversia = conversia;
          const handled = Math.max(0, 30 - Math.max(0, remaining)); // conversaciones atendidas con las gratis
          await withTenant(org.id, async (tx) => {
            await tx.organization.update({ where: { id: org.id }, data: { settings: settings as object } });
            await tx.integrationEvent.create({
              data: { organizationId: org.id, provider: "funnel", type: "trial_exhausted", status: "warning", message: `Tu asistente atendió tus 30 conversaciones de prueba. Actívalo (Base $18.900/mes) para seguir atendiendo sin cortes. Estos 7 días queda en modo copiloto: te sugiere las respuestas y tú apruebas.` },
            });
          });
          await raiseException(prisma, { organizationId: org.id, type: "v2_trial_agotado", title: `Prueba agotada — ${org.name}`, severity: "info", detail: `Atendió ~${handled} conversaciones gratis. En copiloto 7 días; luego pausa si no activa.`, dedupeKey: org.id });
        } else if (action === "pause") {
          // Pausa reversible: IA detenida (aiKillSwitch). NADA se borra. Se revierte al activar.
          conversia.paused = true;
          const prevAi = (settings.ai as Record<string, unknown>) ?? {};
          settings.ai = { ...prevAi, aiKillSwitch: true };
          settings.conversia = conversia;
          await withTenant(org.id, async (tx) => {
            await tx.organization.update({ where: { id: org.id }, data: { settings: settings as object } });
            await tx.integrationEvent.create({
              data: { organizationId: org.id, provider: "funnel", type: "trial_paused", status: "error", message: `Tu asistente quedó en pausa porque no se activó tras la prueba. NADA se borró: actívalo cuando quieras y retoma al instante.` },
            });
          });
          await raiseException(prisma, { organizationId: org.id, type: "v2_trial_pausado", title: `Prueba pausada — ${org.name}`, severity: "warning", detail: "7 días de gracia sin activar. Pausada (sin purga).", dedupeKey: org.id });
        }
      }
    } catch (err) {
      console.error("✖ v2-trial-lifecycle tick:", (err as Error).message);
    }
  };
  void run();
  const interval = setInterval(run, ONE_HOUR);
  interval.unref?.();
  return () => clearInterval(interval);
}

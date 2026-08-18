/**
 * Acreditación MENSUAL del cupo de mensajes para suscripciones ANUALES — pura + tick.
 *
 * La plataforma ya soporta planes `yearly` (interval): el pago cobra los 12 meses de
 * una y fija periodEnd a +12 meses. PERO el cupo de plantillas (message_wallets) NO
 * debe acreditarse los 12 meses de golpe: si el cliente lo quema el primer mes, el
 * resto del año lo financia la línea de crédito. Por eso el cupo se acredita MES A MES
 * dentro del año pagado. El pago ya acredita el mes 1 (topUpWallet); este tick acredita
 * los meses 2..12, uno por mes, mientras la suscripción anual siga vigente.
 *
 * Reutiliza el mismo cálculo de cupo que topUpWallet (features.templateMessages, con
 * carryover de 1 mes). Idempotente por mes: solo recarga si pasó ≥1 mes desde la última.
 */
export function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}

export interface RefillInput {
  now: Date;
  interval: string; // monthly | yearly
  subStatus: string; // ACTIVE | PAST_DUE | ...
  periodEnd: Date | null; // fin del año pagado
  walletPeriodStart: Date | null; // última recarga del wallet
}

/**
 * ¿Toca acreditar el cupo mensual de un anual? Pura y determinista.
 * Solo para anuales ACTIVOS, dentro del año pagado, y si pasó ≥1 mes desde la última
 * recarga. Fuera del año (periodEnd vencido) NO recarga: de eso se encarga el dunning.
 */
export function isMonthlyRefillDue(i: RefillInput): boolean {
  if (i.interval !== "yearly" || i.subStatus !== "ACTIVE" || !i.periodEnd) return false;
  if (i.now.getTime() >= i.periodEnd.getTime()) return false; // año pagado terminado
  if (!i.walletPeriodStart) return true; // sin recarga previa (borde): acredita ahora
  return i.now.getTime() >= addMonths(i.walletPeriodStart, 1).getTime();
}

/** Cupo del plan (misma regla que topUpWallet): −1 = ilimitado, 0 = sin cupo, sin def = default. */
export function planIncludedQuota(features: unknown, walletDefault: number): number {
  const q = Number((features as Record<string, unknown> | null)?.templateMessages);
  if (q === -1) return 1_000_000;
  return Number.isFinite(q) && q >= 0 ? Math.round(q) : walletDefault;
}

const SIX_HOURS = 6 * 60 * 60 * 1000;

/** Escanea suscripciones anuales activas y acredita el cupo mensual si toca. Cross-tenant (admin). */
export function startAnnualWalletRefill(): () => void {
  const run = async () => {
    try {
      const { getAdminPrisma } = await import("@conversia/database");
      const { getEnv } = await import("@conversia/config");
      const prisma = getAdminPrisma();
      const now = new Date();
      const walletDefault = getEnv().WALLET_DEFAULT_QUOTA;
      const subs = await prisma.subscription.findMany({
        where: { status: "ACTIVE", periodEnd: { not: null }, interval: "yearly" },
        select: { id: true, organizationId: true, planId: true, periodEnd: true, interval: true },
      });
      for (const sub of subs) {
        // La cadencia real vive en la suscripción (el mismo plan ofrece mensual/anual).
        if (sub.interval !== "yearly") continue;
        const plan = await prisma.plan.findUnique({ where: { id: sub.planId }, select: { features: true } });
        if (!plan) continue;
        const wallet = await prisma.messageWallet.findUnique({ where: { organizationId: sub.organizationId } });
        const due = isMonthlyRefillDue({
          now,
          interval: sub.interval,
          subStatus: "ACTIVE",
          periodEnd: sub.periodEnd,
          walletPeriodStart: wallet?.periodStart ?? null,
        });
        if (!due) continue;
        const included = planIncludedQuota(plan.features, walletDefault);
        const keep = wallet ? Math.min(wallet.balance, included) : 0; // carryover tope = 1 mes
        const balance = keep + included;
        await prisma.messageWallet.upsert({
          where: { organizationId: sub.organizationId },
          create: { organizationId: sub.organizationId, balance, includedPerPeriod: included, carryoverCap: included, periodStart: now },
          update: { balance, includedPerPeriod: included, carryoverCap: included, periodStart: now },
        });
        await prisma.walletLedger.create({
          data: {
            organizationId: sub.organizationId,
            delta: balance - (wallet?.balance ?? 0),
            reason: "annual_monthly_refill",
            balanceAfter: balance,
            refType: "subscription",
          },
        });
      }
    } catch (err) {
      console.error("✖ annual-wallet-refill tick:", (err as Error).message);
    }
  };
  void run();
  const interval = setInterval(run, SIX_HOURS);
  interval.unref?.();
  return () => clearInterval(interval);
}

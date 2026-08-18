/**
 * Implementación REAL del BillingPort con admin prisma + withTenant. Toda escritura de
 * datos de tenant va por withTenant (RLS activa) y queda auditada. La lectura cross-tenant
 * (catálogo de subs a cobrar) usa admin, como los demás ticks de plataforma.
 */
import { getAdminPrisma, withTenant } from "@conversia/database";
import { planIncludedQuota } from "../annual-wallet-refill";
import { getEnv } from "@conversia/config";
import type { BillingPort, EngineSub } from "./engine";
import type { SubState } from "./state-machine";

const HALTED = "SUSPENDED";

function billablesTotal(settings: unknown): number {
  const b = (settings as Record<string, unknown> | null)?.billables;
  if (!Array.isArray(b)) return 0;
  return b.reduce((a, x) => a + (Number((x as { amount?: unknown })?.amount) || 0), 0);
}

/** Mapea el estado interno a SubscriptionStatus de Prisma. */
function toDbStatus(state: SubState): "ACTIVE" | "PAST_DUE" | "SUSPENDED" | "CANCELLED" {
  return state === "CANCELED" ? "CANCELLED" : state;
}

export function createDbBillingPort(): BillingPort {
  const admin = getAdminPrisma();
  return {
    async listActionable(now) {
      const subs = await admin.subscription.findMany({
        where: { status: { in: ["ACTIVE", "PAST_DUE"] } },
        select: {
          id: true, organizationId: true, status: true, interval: true, periodEnd: true,
          nextChargeAt: true, pastDueSince: true, retriesDone: true, cancelAtPeriodEnd: true,
          providerCustomerRef: true, planId: true,
        },
      });
      const out: EngineSub[] = [];
      for (const s of subs) {
        const plan = await admin.plan.findUnique({ where: { id: s.planId }, select: { name: true, priceClp: true, priceUsd: true, priceClpYearly: true, priceUsdYearly: true } });
        const org = await admin.organization.findUnique({ where: { id: s.organizationId }, select: { currency: true, settings: true } });
        if (!plan || !org) continue;
        const currency = org.currency ?? "CLP";
        const yearly = s.interval === "yearly";
        const base = currency === "CLP"
          ? Number(yearly && plan.priceClpYearly != null ? plan.priceClpYearly : plan.priceClp)
          : Number(yearly && plan.priceUsdYearly != null ? plan.priceUsdYearly : plan.priceUsd);
        out.push({
          id: s.id,
          organizationId: s.organizationId,
          state: (s.status === "CANCELLED" ? "CANCELED" : s.status) as SubState,
          interval: yearly ? "yearly" : "monthly",
          amount: base + billablesTotal(org.settings),
          currency,
          subject: `Plan ${plan.name} (${yearly ? "anual" : "mensual"})`,
          providerCustomerRef: s.providerCustomerRef,
          dueAt: s.nextChargeAt ?? s.periodEnd,
          periodEnd: s.periodEnd,
          pastDueSince: s.pastDueSince,
          retriesDone: s.retriesDone,
          cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        });
      }
      return out;
    },

    async createAttempt(sub, kind, attemptNumber, commerceOrder) {
      await admin.paymentAttempt.upsert({
        where: { commerceOrder },
        update: {},
        create: { organizationId: sub.organizationId, subscriptionId: sub.id, commerceOrder, amount: sub.amount, currency: sub.currency, kind, attemptNumber, status: "pending", provider: "flow" },
      });
    },

    async markAttempt(commerceOrder, status, providerRef, reason) {
      await admin.paymentAttempt.updateMany({ where: { commerceOrder }, data: { status, providerRef: providerRef ?? undefined, reason: reason ?? undefined } });
    },

    async applySuccess(sub, periodEnd, dueAt) {
      const plan = await admin.plan.findUnique({ where: { id: (await admin.subscription.findUnique({ where: { id: sub.id }, select: { planId: true } }))?.planId ?? "" }, select: { features: true, name: true } });
      await withTenant(sub.organizationId, async (tx) => {
        await tx.subscription.update({ where: { id: sub.id }, data: { status: "ACTIVE", periodStart: new Date(), periodEnd, nextChargeAt: dueAt, pastDueSince: null, retriesDone: 0 } });
        await tx.organization.update({ where: { id: sub.organizationId }, data: { status: "ACTIVE" } });
        // Acreditar la bolsa del mes (mismo cálculo que el pago único / recarga anual).
        const included = planIncludedQuota(plan?.features ?? {}, getEnv().WALLET_DEFAULT_QUOTA);
        const wallet = await tx.messageWallet.findUnique({ where: { organizationId: sub.organizationId } });
        const keep = wallet ? Math.min(wallet.balance, included) : 0;
        await tx.messageWallet.upsert({
          where: { organizationId: sub.organizationId },
          create: { organizationId: sub.organizationId, balance: keep + included, includedPerPeriod: included, carryoverCap: included, periodStart: new Date() },
          update: { balance: keep + included, includedPerPeriod: included, carryoverCap: included, periodStart: new Date() },
        });
        // Comprobante interno (no es DTE — la boleta/factura del SII va fuera).
        const count = await tx.invoice.count();
        await tx.invoice.create({
          data: { organizationId: sub.organizationId, number: `CONV-${new Date().getFullYear()}-${String(count + 1).padStart(6, "0")}`, status: "PAID", currency: sub.currency, amountDue: sub.amount, lines: [{ concept: sub.subject, amount: sub.amount }], paidAt: new Date(), provider: "flow" },
        });
        await tx.auditLog.create({ data: { organizationId: sub.organizationId, actorType: "system", actorId: "billing", action: "billing.charge_succeeded", entityType: "subscription", entityId: sub.id, after: { periodEnd } } });
      });
    },

    async applyFailure(sub, pastDueSince, retriesDone) {
      await withTenant(sub.organizationId, async (tx) => {
        const org = await tx.organization.findUnique({ where: { id: sub.organizationId }, select: { settings: true } });
        const settings = { ...((org?.settings as Record<string, unknown>) ?? {}) };
        settings.billing = { state: "past_due", pastDueSince: pastDueSince.toISOString(), suspendAt: new Date(pastDueSince.getTime() + 48 * 3_600_000).toISOString() };
        await tx.subscription.update({ where: { id: sub.id }, data: { status: "PAST_DUE", pastDueSince, retriesDone } });
        await tx.organization.update({ where: { id: sub.organizationId }, data: { settings: settings as object } });
        await tx.auditLog.create({ data: { organizationId: sub.organizationId, actorType: "system", actorId: "billing", action: "billing.charge_failed", entityType: "subscription", entityId: sub.id, after: { retriesDone } } });
      });
    },

    async suspend(sub) {
      await withTenant(sub.organizationId, async (tx) => {
        const org = await tx.organization.findUnique({ where: { id: sub.organizationId }, select: { settings: true } });
        const settings = { ...((org?.settings as Record<string, unknown>) ?? {}) };
        settings.billing = { state: "suspended", suspendedAt: new Date().toISOString() };
        await tx.subscription.update({ where: { id: sub.id }, data: { status: HALTED } });
        await tx.organization.update({ where: { id: sub.organizationId }, data: { status: HALTED, settings: settings as object } });
        await tx.auditLog.create({ data: { organizationId: sub.organizationId, actorType: "system", actorId: "billing", action: "billing.suspend", entityType: "organization", entityId: sub.organizationId } });
      });
    },

    async notify(orgId, kind, data) {
      // Panel (integration_event) siempre; correo/WhatsApp se cablean en el bloque de avisos.
      const map: Record<string, { type: string; status: string; message: string }> = {
        payment_failed: { type: "billing.payment_failed", status: "warning", message: `No pudimos procesar tu pago. Tu servicio sigue activo por 48 h. Paga para no perderlo.` },
        payment_succeeded: { type: "billing.payment_succeeded", status: "ok", message: `Pago recibido. Tu plan quedó renovado.` },
        suspended: { type: "billing.suspended", status: "error", message: `Servicio suspendido por falta de pago. Paga para reactivar — tus datos siguen intactos.` },
        reactivated: { type: "billing.reactivated", status: "ok", message: `¡Listo! Recibimos tu pago y tu plan quedó activo de nuevo.` },
      };
      const e = map[kind];
      if (!e) return;
      await withTenant(orgId, (tx) => tx.integrationEvent.create({ data: { organizationId: orgId, provider: "billing", type: e.type, status: e.status, message: e.message } })).catch(() => undefined);
      void data;
    },
  };
}

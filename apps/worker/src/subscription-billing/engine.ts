/**
 * ENGINE del cobro recurrente — orquesta la máquina de estados contra los datos y la
 * pasarela. Separado en dos capas para poder probarlo con adaptadores FALSOS:
 *   - `runBillingCycle(port, providerFor, now)` : decide y ejecuta (charge/retry/suspend).
 *   - `applyOutcome(port, sub, commerceOrder, ok, reason, now)` : aplica el resultado de un
 *     cobro (lo llama el ciclo cuando el resultado es inmediato, y la reconciliación /
 *     webhook cuando llega asíncrono). Idempotente por estado del intento.
 *
 * Nada aquí sabe qué pasarela hay detrás (habla por SubscriptionProvider) ni escribe SQL
 * directo (habla por BillingPort). El tick real llena el puerto con admin prisma.
 */
import {
  onChargeFailed,
  onChargeSucceeded,
  planBillingAction,
  type BillingSnapshot,
  type SubState,
} from "./state-machine";
import type { SubscriptionProvider } from "./provider";

export interface EngineSub {
  id: string;
  organizationId: string;
  state: SubState;
  interval: "monthly" | "yearly";
  amount: number;
  currency: string;
  subject: string;
  providerCustomerRef: string | null;
  dueAt: Date | null;
  periodEnd: Date | null;
  pastDueSince: Date | null;
  retriesDone: number;
  cancelAtPeriodEnd: boolean;
}

/** Acceso a datos + efectos. El tick real lo implementa con admin prisma; los tests, en memoria. */
export interface BillingPort {
  /** Suscripciones candidatas: ACTIVE/PAST_DUE con medio de pago, o canceladas por vencer. */
  listActionable(now: Date): Promise<EngineSub[]>;
  /** Registra un intento de cobro (idempotente por commerceOrder). */
  createAttempt(sub: EngineSub, kind: "auto" | "retry" | "manual", attemptNumber: number, commerceOrder: string): Promise<void>;
  /** Marca el resultado del intento. */
  markAttempt(commerceOrder: string, status: "succeeded" | "failed" | "pending", providerRef: string | null, reason: string | null): Promise<void>;
  /** Cobro EXITOSO: renueva período, resetea impago, ACTIVE, acredita la bolsa, comprobante. */
  applySuccess(sub: EngineSub, periodEnd: Date, dueAt: Date): Promise<void>;
  /** Cobro RECHAZADO: PAST_DUE (o incrementa reintentos). */
  applyFailure(sub: EngineSub, pastDueSince: Date, retriesDone: number): Promise<void>;
  /** 48 h cumplidas (o cancelada vencida): SUSPENDED + apagado total de la org. */
  suspend(sub: EngineSub): Promise<void>;
  /** Avisa por los canales (correo/panel/WhatsApp) y al owner. */
  notify(orgId: string, kind: "payment_failed" | "payment_succeeded" | "suspended" | "reactivated", data: Record<string, unknown>): Promise<void>;
}

const URL_CONFIRM = "/billing/webhooks/flow"; // se completa con API_URL en el tick real
const RETRY_KIND: Record<string, "auto" | "retry"> = { charge: "auto", retry: "retry" };

function toSnapshot(sub: EngineSub, now: Date): BillingSnapshot {
  return {
    now,
    state: sub.state,
    dueAt: sub.dueAt,
    pastDueSince: sub.pastDueSince,
    retriesDone: sub.retriesDone,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    periodEnd: sub.periodEnd,
  };
}

/** Aplica el resultado de un cobro (inmediato o asíncrono). Reactiva/suspende según corresponda. */
export async function applyOutcome(port: BillingPort, sub: EngineSub, commerceOrder: string, ok: boolean, reason: string | null, now: Date): Promise<void> {
  const snap = toSnapshot(sub, now);
  if (ok) {
    const t = onChargeSucceeded(snap, sub.interval);
    await port.markAttempt(commerceOrder, "succeeded", null, null);
    await port.applySuccess(sub, t.periodEnd!, t.dueAt!);
    await port.notify(sub.organizationId, sub.state === "SUSPENDED" ? "reactivated" : "payment_succeeded", { periodEnd: t.periodEnd });
  } else {
    const t = onChargeFailed(snap);
    await port.markAttempt(commerceOrder, "failed", null, reason);
    await port.applyFailure(sub, t.pastDueSince!, t.retriesDone);
    await port.notify(sub.organizationId, "payment_failed", { reason, suspendAt: t.pastDueSince ? new Date(t.pastDueSince.getTime() + 48 * 3_600_000) : null });
  }
}

/** Un ciclo de cobro: decide la acción por suscripción y la ejecuta. */
export async function runBillingCycle(
  port: BillingPort,
  providerFor: (orgId: string) => Promise<SubscriptionProvider>,
  now: Date,
  urls: { confirmation: string; ret: string } = { confirmation: URL_CONFIRM, ret: URL_CONFIRM },
): Promise<{ charged: number; suspended: number }> {
  const subs = await port.listActionable(now);
  let charged = 0;
  let suspended = 0;
  for (const sub of subs) {
    const action = planBillingAction(toSnapshot(sub, now));
    if (action === "suspend") {
      await port.suspend(sub);
      await port.notify(sub.organizationId, "suspended", {});
      suspended++;
      continue;
    }
    if (action === "charge" || action === "retry") {
      if (!sub.providerCustomerRef) continue; // sin medio de pago no se puede cobrar
      const provider = await providerFor(sub.organizationId);
      const commerceOrder = `sub-${sub.id}-${now.getTime()}`;
      const attemptNumber = action === "retry" ? sub.retriesDone + 2 : 1;
      await port.createAttempt(sub, RETRY_KIND[action], attemptNumber, commerceOrder);
      const res = await provider.charge({
        customerRef: sub.providerCustomerRef,
        amount: sub.amount,
        currency: sub.currency,
        commerceOrder,
        subject: sub.subject,
        urlConfirmation: urls.confirmation,
        urlReturn: urls.ret,
      });
      if (res.settled) {
        await applyOutcome(port, sub, commerceOrder, res.ok, res.reason, now);
      } else {
        // Resultado asíncrono (Flow collect): queda pendiente; lo aplica el webhook o la
        // reconciliación del próximo tick al reconsultar el estado.
        await port.markAttempt(commerceOrder, "pending", res.providerRef, null);
      }
      charged++;
    }
  }
  return { charged, suspended };
}

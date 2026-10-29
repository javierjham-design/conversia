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
  /** Intentos de cobro aún PENDIENTES (para reconciliar contra la pasarela). */
  listPending(now: Date): Promise<Array<{ commerceOrder: string; providerRef: string; subscriptionId: string; createdAt?: Date }>>;
  /** IDs de suscripciones con un intento de cobro AÚN pendiente: NO se re-cobra mientras haya
   *  uno en vuelo (evita el loop que dispara N cobras por tick hasta que la pasarela confirme). */
  pendingSubscriptionIds(now: Date): Promise<Set<string>>;
  /** Carga la suscripción de un intento (para aplicar el resultado reconciliado). */
  getSub(subscriptionId: string): Promise<EngineSub | null>;
  /**
   * Cierra un intento HUÉRFANO (pendiente y sin referencia de la pasarela) sin tocar el
   * estado de la suscripción. OPCIONAL: los dobles de test viejos no la implementan.
   */
  abandonAttempt?(commerceOrder: string, reason: string): Promise<void>;
  /** Excepción para la consola de operación. OPCIONAL por el mismo motivo. */
  raiseOps?(
    organizationId: string,
    input: { type: string; title: string; detail: string; dedupeKey: string; severity: "warning" | "critical" },
  ): Promise<void>;
}

/**
 * Tras esto, un intento pendiente SIN referencia de la pasarela se da por perdido.
 *
 * Un `collect` cuya llamada HTTP murió antes de devolver el token deja un intento pendiente
 * que nadie puede reconsultar (la reconciliación necesita el token). Y como "esta suscripción
 * tiene un cobro en vuelo" no mira la fecha, ese intento **le apagaba el cobro a esa
 * suscripción para siempre**: el cliente se quedaba con el servicio gratis, en silencio y sin
 * un solo log. Es el mismo agujero que tenía la recarga automática, del otro lado del
 * producto. Seis horas es de sobra para que un cobro real haya resuelto.
 */
export const VENTANA_INTENTO_HUERFANO_MS = 6 * 60 * 60 * 1000;

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
    // ORDEN (auditoría §9.4): PRIMERO se aplica la renovación y SOLO AL FINAL se marca el
    // intento como `succeeded`. Al revés (como estaba), si `applySuccess` fallaba (timeout,
    // colisión del número de factura) el cobro quedaba "exitoso" sin renovar → el próximo
    // tick volvía a cobrarle la tarjeta. Mientras el intento siga `pending`, la suscripción
    // cuenta como "cobro en vuelo" (`pendingSubscriptionIds`) y NO se le re-cobra.
    await port.applySuccess(sub, t.periodEnd!, t.dueAt!);
    await port.markAttempt(commerceOrder, "succeeded", null, null);
    await port.notify(sub.organizationId, sub.state === "SUSPENDED" ? "reactivated" : "payment_succeeded", { periodEnd: t.periodEnd });
  } else {
    await port.markAttempt(commerceOrder, "failed", null, reason);
    // PERÍODO YA PAGADO: si otro pago (p.ej. "registrar pago" del Super Admin) ya
    // renovó el período (periodEnd a futuro), un intento VIEJO que se reconcilia
    // como fallido NO puede volver a poner la cuenta morosa (caso TuBot: quedó
    // PAST_DUE+suspendida con la renovación vigente al 07-10). El intento queda
    // marcado failed y nada más.
    if (sub.periodEnd && sub.periodEnd.getTime() > now.getTime()) return;
    const t = onChargeFailed(snap);
    await port.applyFailure(sub, t.pastDueSince!, t.retriesDone);
    await port.notify(sub.organizationId, "payment_failed", { reason, suspendAt: t.pastDueSince ? new Date(t.pastDueSince.getTime() + 48 * 3_600_000) : null });
  }
}

/**
 * Reconciliación: aplica el resultado de los cobros PENDIENTES reconsultándolos en la
 * pasarela. Cubre el flujo asíncrono de Flow (collect) Y los webhooks PERDIDOS — un
 * cliente que pagó y quedó pendiente por un webhook que no llegó es el peor escenario.
 */
export async function reconcilePending(
  port: BillingPort,
  providerFor: (orgId: string) => Promise<SubscriptionProvider>,
  now: Date,
): Promise<{ reconciled: number }> {
  const pending = await port.listPending(now);
  let reconciled = 0;
  for (const p of pending) {
    const sub = await port.getSub(p.subscriptionId);
    if (!p.providerRef) {
      // SIN TOKEN NO HAY NADA QUE RECONSULTAR. Si además ya es viejo, se cierra y se avisa:
      // dejarlo pendiente es dejar de cobrarle a ese cliente para siempre. NO se toca el
      // estado de la suscripción —no sabemos si el cobro entró— así que el ciclo normal
      // volverá a intentarlo; de eso justamente avisa la excepción, para que alguien mire
      // esa orden en la pasarela antes de que se cobre de nuevo.
      if (!sub || !p.createdAt || now.getTime() - p.createdAt.getTime() < VENTANA_INTENTO_HUERFANO_MS) continue;
      await port.abandonAttempt?.(p.commerceOrder, "sin_referencia");
      await port
        .raiseOps?.(sub.organizationId, {
          type: "cobro_sin_referencia",
          severity: "critical",
          title: "Un cobro de la mensualidad se emitió sin referencia de la pasarela",
          detail:
            `La orden ${p.commerceOrder} quedó pendiente sin token, así que no se puede reconsultar y no se sabe si la ` +
            `tarjeta quedó cobrada. Se cierra para que el cobro de esta cuenta no quede apagado, y el ciclo normal la ` +
            `volverá a intentar: hay que buscar esa orden en el panel de la pasarela ANTES de que eso pase.`,
          dedupeKey: `sin_referencia:${p.commerceOrder}`,
        })
        .catch(() => undefined);
      continue;
    }
    if (!sub) continue;
    const provider = await providerFor(sub.organizationId);
    const st = await provider.getChargeStatus(p.providerRef);
    if (!st.settled) continue;
    await applyOutcome(port, sub, p.commerceOrder, st.ok, st.reason, now);
    reconciled++;
  }
  return { reconciled };
}

/** Un ciclo de cobro: decide la acción por suscripción y la ejecuta. */
export async function runBillingCycle(
  port: BillingPort,
  providerFor: (orgId: string) => Promise<SubscriptionProvider>,
  now: Date,
  urls: { confirmation: string; ret: string } = { confirmation: URL_CONFIRM, ret: URL_CONFIRM },
): Promise<{ charged: number; suspended: number }> {
  const subs = await port.listActionable(now);
  // Cobros EN VUELO: si una suscripción ya tiene un intento pendiente (Flow collect asíncrono
  // sin confirmar), NO se le vuelve a cobrar hasta que se reconcilie. Sin esto, cada tick creaba
  // un cobro nuevo mientras el anterior no confirmaba → decenas de cobros al mismo cliente.
  const inFlight = await port.pendingSubscriptionIds(now);
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
      if (inFlight.has(sub.id)) continue; // ya hay un cobro pendiente: esperar la reconciliación
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

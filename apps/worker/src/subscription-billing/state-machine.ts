/**
 * MÁQUINA DE ESTADOS de la suscripción (el corazón del cobro recurrente).
 *
 * Lógica PURA y determinista — no sabe qué pasarela hay detrás ni toca BD. La
 * infraestructura (worker ticks, adaptador Flow/Stripe, notificaciones) la usa; los
 * tests la ejercitan con un adaptador FALSO. Así, el día que entre Stripe, estos
 * tests siguen valiendo.
 *
 * Estados (prompt del negocio):
 *   ACTIVE        — al día; se cobra el próximo período en la fecha de facturación.
 *   PAST_DUE      — un cobro falló; ventana de 48 h operativa con reintentos.
 *   SUSPENDED     — 48 h sin pago → apagado total (lo aplica el enforcement).
 *   CANCELED      — a solicitud; sigue ACTIVE hasta fin del período pagado y ahí SUSPENDED.
 *
 * Tiempos (duración exacta, sin desfases de zona horaria):
 *   - Ventana de gracia: 48 h EXACTAS desde el primer intento fallido (pastDueSince).
 *   - Reintentos automáticos: al fallo (0 h, ya contado), +12 h y +36 h.
 *   - Suspensión: al cumplirse 48 h sin pago.
 * Las FECHAS que se muestran al cliente se formatean en zona horaria de Chile
 * (America/Santiago) en la capa de presentación; el cálculo de la ventana es por
 * duración y por eso es exacto e inmune a cambios de huso/horario de verano.
 */

export type SubState = "ACTIVE" | "PAST_DUE" | "SUSPENDED" | "CANCELED";

export const HOUR_MS = 3_600_000;
/** Ventana de gracia operativa tras el primer fallo. */
export const GRACE_WINDOW_HOURS = 48;
/** Reintentos automáticos tras el fallo inicial (que ya cuenta como intento en 0 h). */
export const RETRY_OFFSETS_HOURS = [12, 36] as const;

export interface BillingSnapshot {
  now: Date;
  state: SubState;
  /** Fecha del próximo cobro programado (fin del período vigente). */
  dueAt: Date | null;
  /** Cuándo empezó el impago (primer intento fallido). null si no está en PAST_DUE. */
  pastDueSince: Date | null;
  /** Reintentos YA realizados después del fallo inicial (0, 1 o 2). */
  retriesDone: number;
  /** El cliente canceló: sigue ACTIVE hasta periodEnd y ahí se suspende. */
  cancelAtPeriodEnd: boolean;
  /** Fin del período pagado (para cancelación y para saber hasta cuándo hay servicio). */
  periodEnd: Date | null;
}

export type BillingAction = "none" | "charge" | "retry" | "suspend";

/** Momento del próximo reintento dado el inicio del impago y los reintentos hechos. */
export function nextRetryAt(pastDueSince: Date, retriesDone: number): Date | null {
  if (retriesDone >= RETRY_OFFSETS_HOURS.length) return null;
  return new Date(pastDueSince.getTime() + RETRY_OFFSETS_HOURS[retriesDone] * HOUR_MS);
}

/** Momento exacto en que vence la ventana de 48 h y corresponde suspender. */
export function suspendAt(pastDueSince: Date): Date {
  return new Date(pastDueSince.getTime() + GRACE_WINDOW_HOURS * HOUR_MS);
}

/**
 * Decide la PRÓXIMA acción de cobro. Pura y determinista.
 * - `charge`  : ACTIVE y llegó la fecha de facturación (o el fin de período de una cancelada aún no suspendida).
 * - `retry`   : PAST_DUE y toca un reintento programado dentro de la ventana.
 * - `suspend` : PAST_DUE y se cumplieron las 48 h; o CANCELED/ACTIVE con cancelAtPeriodEnd cuyo período ya terminó.
 * - `none`    : nada por hacer ahora.
 */
export function planBillingAction(s: BillingSnapshot): BillingAction {
  const t = s.now.getTime();

  // Cancelada (o marcada para cancelar): al terminar el período pagado → suspender.
  // Nunca se cobra un período nuevo después de cancelar.
  if (s.cancelAtPeriodEnd) {
    if (s.periodEnd && t >= s.periodEnd.getTime() && s.state !== "SUSPENDED") return "suspend";
    return "none";
  }

  if (s.state === "ACTIVE") {
    if (s.dueAt && t >= s.dueAt.getTime()) return "charge";
    return "none";
  }

  if (s.state === "PAST_DUE" && s.pastDueSince) {
    if (t >= suspendAt(s.pastDueSince).getTime()) return "suspend";
    const retryAt = nextRetryAt(s.pastDueSince, s.retriesDone);
    if (retryAt && t >= retryAt.getTime()) return "retry";
    return "none";
  }

  return "none";
}

// --------------------------- Transiciones por resultado ---------------------------
// Funciones puras que devuelven el nuevo snapshot parcial. La infraestructura las
// aplica a BD dentro de una transacción auditada.

export interface Transition {
  state: SubState;
  pastDueSince: Date | null;
  retriesDone: number;
  /** Nuevo fin de período tras un cobro exitoso (para avanzar la facturación). */
  periodEnd?: Date;
  dueAt?: Date;
  /** Indica si corresponde acreditar la bolsa de mensajes (solo con pago confirmado). */
  creditWallet: boolean;
}

/** Suma meses respetando fin de mes. */
export function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}

/**
 * Cobro EXITOSO (automático o manual). Renueva el período, resetea el impago y marca
 * que hay que acreditar la bolsa. Vale desde ACTIVE (renovación), PAST_DUE (regulariza)
 * o SUSPENDED (reactivación inmediata sin pérdida).
 */
export function onChargeSucceeded(s: BillingSnapshot, interval: "monthly" | "yearly"): Transition {
  // Renovación/regularización (ACTIVE o PAST_DUE dentro de las 48 h): se preserva el
  // ANCLA de facturación extendiendo desde periodEnd, así el cliente no pierde días.
  // Reactivación tras SUSPENDED (pudo pasar mucho tiempo): período fresco desde ahora.
  const from = s.state === "SUSPENDED" || !s.periodEnd ? s.now : s.periodEnd;
  const periodEnd = addMonths(from, interval === "yearly" ? 12 : 1);
  return { state: "ACTIVE", pastDueSince: null, retriesDone: 0, periodEnd, dueAt: periodEnd, creditWallet: true };
}

/**
 * Cobro RECHAZADO. Abre (o mantiene) la ventana de 48 h y cuenta el intento. El fallo
 * inicial fija pastDueSince; los siguientes solo incrementan retriesDone.
 */
export function onChargeFailed(s: BillingSnapshot): Transition {
  if (s.state === "PAST_DUE" && s.pastDueSince) {
    return { state: "PAST_DUE", pastDueSince: s.pastDueSince, retriesDone: s.retriesDone + 1, creditWallet: false };
  }
  return { state: "PAST_DUE", pastDueSince: s.now, retriesDone: 0, creditWallet: false };
}

/** Vencimiento de las 48 h: suspender (apagado total lo aplica el enforcement). */
export function onSuspend(s: BillingSnapshot): Transition {
  return { state: "SUSPENDED", pastDueSince: s.pastDueSince, retriesDone: s.retriesDone, creditWallet: false };
}

/** Cancelación a solicitud: sigue ACTIVE hasta periodEnd; marca cancelAtPeriodEnd afuera. */
export function onCancel(s: BillingSnapshot): { state: SubState; cancelAtPeriodEnd: boolean } {
  return { state: s.state === "SUSPENDED" ? "SUSPENDED" : "ACTIVE", cancelAtPeriodEnd: true };
}

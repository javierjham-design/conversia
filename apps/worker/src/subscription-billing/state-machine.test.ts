import { describe, expect, it } from "vitest";
import {
  addMonths,
  nextRetryAt,
  onCancel,
  onChargeFailed,
  onChargeSucceeded,
  onSuspend,
  planBillingAction,
  suspendAt,
  type BillingSnapshot,
  type SubState,
} from "./state-machine";
import { FakeSubscriptionProvider } from "./provider";

const T0 = new Date("2026-09-01T12:00:00Z");
const hoursAfter = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000);

function snap(over: Partial<BillingSnapshot> = {}): BillingSnapshot {
  return {
    now: T0,
    state: "ACTIVE",
    dueAt: T0,
    pastDueSince: null,
    retriesDone: 0,
    cancelAtPeriodEnd: false,
    periodEnd: T0,
    ...over,
  };
}

describe("planBillingAction — próxima acción de cobro", () => {
  it("ACTIVE con fecha de cobro llegada → charge", () => {
    expect(planBillingAction(snap({ state: "ACTIVE", dueAt: T0, now: T0 }))).toBe("charge");
  });
  it("ACTIVE antes de la fecha → none", () => {
    expect(planBillingAction(snap({ state: "ACTIVE", dueAt: hoursAfter(T0, 24), now: T0 }))).toBe("none");
  });
  it("PAST_DUE: primer reintento recién a las +12 h (no antes)", () => {
    const base = snap({ state: "PAST_DUE", pastDueSince: T0, retriesDone: 0 });
    expect(planBillingAction({ ...base, now: hoursAfter(T0, 11) })).toBe("none");
    expect(planBillingAction({ ...base, now: hoursAfter(T0, 12) })).toBe("retry");
  });
  it("PAST_DUE: segundo reintento a las +36 h", () => {
    const base = snap({ state: "PAST_DUE", pastDueSince: T0, retriesDone: 1 });
    expect(planBillingAction({ ...base, now: hoursAfter(T0, 35) })).toBe("none");
    expect(planBillingAction({ ...base, now: hoursAfter(T0, 36) })).toBe("retry");
  });
  it("PAST_DUE: agotados los 2 reintentos, antes de 48 h → none", () => {
    const base = snap({ state: "PAST_DUE", pastDueSince: T0, retriesDone: 2 });
    expect(planBillingAction({ ...base, now: hoursAfter(T0, 40) })).toBe("none");
  });
  it("PAST_DUE: a las 48 h EXACTAS → suspend", () => {
    const base = snap({ state: "PAST_DUE", pastDueSince: T0, retriesDone: 2 });
    expect(planBillingAction({ ...base, now: hoursAfter(T0, 47.99) })).toBe("none");
    expect(planBillingAction({ ...base, now: hoursAfter(T0, 48) })).toBe("suspend");
  });
  it("SUSPENDED → none (la reactivación es por pago, no por tick)", () => {
    expect(planBillingAction(snap({ state: "SUSPENDED", now: hoursAfter(T0, 100) }))).toBe("none");
  });
  it("cancelAtPeriodEnd: no cobra período nuevo; suspende al terminar el período", () => {
    const periodEnd = hoursAfter(T0, 240);
    const base = snap({ state: "ACTIVE", cancelAtPeriodEnd: true, periodEnd, dueAt: periodEnd });
    expect(planBillingAction({ ...base, now: hoursAfter(T0, 100) })).toBe("none"); // aún con servicio
    expect(planBillingAction({ ...base, now: periodEnd })).toBe("suspend"); // terminó el período pagado
  });
});

describe("transiciones por resultado", () => {
  it("cobro exitoso MENSUAL: renueva +1 mes, resetea impago, acredita bolsa", () => {
    const t = onChargeSucceeded(snap({ periodEnd: T0 }), "monthly");
    expect(t.state).toBe("ACTIVE");
    expect(t.creditWallet).toBe(true);
    expect(t.retriesDone).toBe(0);
    expect(t.pastDueSince).toBeNull();
    expect(t.periodEnd).toEqual(addMonths(T0, 1));
  });
  it("cobro exitoso ANUAL: renueva +12 meses", () => {
    const t = onChargeSucceeded(snap({ periodEnd: T0 }), "yearly");
    expect(t.periodEnd).toEqual(addMonths(T0, 12));
  });
  it("cobro exitoso extiende desde el fin de período vigente (no desde hoy) si aún no vence", () => {
    const future = hoursAfter(T0, 240);
    const t = onChargeSucceeded(snap({ periodEnd: future }), "monthly");
    expect(t.periodEnd).toEqual(addMonths(future, 1));
  });
  it("cobro rechazado inicial: abre ventana (PAST_DUE, pastDueSince=now, retries 0)", () => {
    const t = onChargeFailed(snap({ state: "ACTIVE" }));
    expect(t.state).toBe("PAST_DUE");
    expect(t.pastDueSince).toEqual(T0);
    expect(t.retriesDone).toBe(0);
    expect(t.creditWallet).toBe(false);
  });
  it("cobro rechazado siguiente: mantiene pastDueSince, incrementa reintentos", () => {
    const since = hoursAfter(T0, -12);
    const t = onChargeFailed(snap({ state: "PAST_DUE", pastDueSince: since, retriesDone: 0, now: T0 }));
    expect(t.pastDueSince).toEqual(since);
    expect(t.retriesDone).toBe(1);
  });
  it("suspender conserva el rastro del impago", () => {
    const t = onSuspend(snap({ state: "PAST_DUE", pastDueSince: T0, retriesDone: 2 }));
    expect(t.state).toBe("SUSPENDED");
  });
  it("cancelar deja ACTIVE + cancelAtPeriodEnd", () => {
    expect(onCancel(snap({ state: "ACTIVE" }))).toEqual({ state: "ACTIVE", cancelAtPeriodEnd: true });
  });
});

describe("nextRetryAt / suspendAt", () => {
  it("offsets 12 h y 36 h, y null tras el segundo", () => {
    expect(nextRetryAt(T0, 0)).toEqual(hoursAfter(T0, 12));
    expect(nextRetryAt(T0, 1)).toEqual(hoursAfter(T0, 36));
    expect(nextRetryAt(T0, 2)).toBeNull();
  });
  it("suspende a las 48 h", () => {
    expect(suspendAt(T0)).toEqual(hoursAfter(T0, 48));
  });
});

// -------- Recorridos completos con el adaptador FALSO (sin pasarela real) --------

/** Simula un ciclo conducido por la máquina: aplica charge y transiciones en memoria. */
async function driveCharge(s: BillingSnapshot, provider: FakeSubscriptionProvider, ok: boolean, interval: "monthly" | "yearly" = "monthly") {
  provider.scheduleCharge(ok);
  const res = await provider.charge({ customerRef: "c", amount: 69900, currency: "CLP", commerceOrder: `o-${Date.now()}`, subject: "Plan", urlConfirmation: "u", urlReturn: "r" });
  const t = res.ok ? onChargeSucceeded(s, interval) : onChargeFailed(s);
  return { ...s, state: t.state, pastDueSince: t.pastDueSince, retriesDone: t.retriesDone, periodEnd: t.periodEnd ?? s.periodEnd, dueAt: t.dueAt ?? s.dueAt } as BillingSnapshot;
}

describe("recorridos end-to-end con adaptador falso", () => {
  it("fallo → 2 reintentos que también fallan → suspensión a las 48 h", async () => {
    const p = new FakeSubscriptionProvider();
    let s = snap({ state: "ACTIVE", dueAt: T0 });
    // Cobro del día: falla → PAST_DUE.
    s = await driveCharge(s, p, false);
    expect(s.state).toBe("PAST_DUE");
    // +12 h: toca reintento, falla.
    s = { ...s, now: hoursAfter(T0, 12) };
    expect(planBillingAction(s)).toBe("retry");
    s = await driveCharge(s, p, false);
    expect(s.retriesDone).toBe(1);
    // +36 h: segundo reintento, falla.
    s = { ...s, now: hoursAfter(T0, 36) };
    expect(planBillingAction(s)).toBe("retry");
    s = await driveCharge(s, p, false);
    expect(s.retriesDone).toBe(2);
    // +48 h: suspende.
    s = { ...s, now: hoursAfter(T0, 48) };
    expect(planBillingAction(s)).toBe("suspend");
    expect(p.charges.length).toBe(3); // fallo inicial + 2 reintentos
  });

  it("fallo → pago MANUAL dentro de la ventana → vuelve a ACTIVE sin pérdida", async () => {
    const p = new FakeSubscriptionProvider();
    let s = snap({ state: "ACTIVE", dueAt: T0, periodEnd: T0 });
    s = await driveCharge(s, p, false);
    expect(s.state).toBe("PAST_DUE");
    // El cliente paga manualmente a las +20 h (antes de las 48 h).
    s = { ...s, now: hoursAfter(T0, 20) };
    s = await driveCharge(s, p, true);
    expect(s.state).toBe("ACTIVE");
    expect(s.pastDueSince).toBeNull();
    expect(s.periodEnd).toEqual(addMonths(T0, 1));
  });

  it("pago DESPUÉS de suspender reactiva a ACTIVE", async () => {
    const p = new FakeSubscriptionProvider();
    let s = snap({ state: "SUSPENDED", pastDueSince: T0, retriesDone: 2, periodEnd: T0 });
    s = await driveCharge(s, p, true);
    expect(s.state).toBe("ACTIVE");
    expect(s.periodEnd).toEqual(addMonths(T0, 1));
  });

  it("alta ANUAL: primer cobro exitoso deja período a +12 meses", async () => {
    const p = new FakeSubscriptionProvider();
    let s = snap({ state: "ACTIVE", dueAt: T0, periodEnd: T0 });
    s = await driveCharge(s, p, true, "yearly");
    expect(s.periodEnd).toEqual(addMonths(T0, 12));
  });
});

import { describe, expect, it } from "vitest";
import { addMonths, isMonthlyRefillDue, planIncludedQuota } from "./annual-wallet-refill";

const start = new Date("2026-08-01T00:00:00Z");
const periodEnd = addMonths(start, 12); // 2027-08-01

describe("isMonthlyRefillDue — acreditación mensual del cupo anual", () => {
  it("anual activo, pasó 1 mes desde la última recarga → recarga", () => {
    const now = addMonths(start, 1); // 2026-09-01
    expect(isMonthlyRefillDue({ now, interval: "yearly", subStatus: "ACTIVE", periodEnd, walletPeriodStart: start })).toBe(true);
  });

  it("anual activo, aún NO pasa el mes → no recarga (idempotente)", () => {
    const now = new Date("2026-08-20T00:00:00Z"); // < 1 mes
    expect(isMonthlyRefillDue({ now, interval: "yearly", subStatus: "ACTIVE", periodEnd, walletPeriodStart: start })).toBe(false);
  });

  it("plan MENSUAL → nunca (el pago mensual ya recarga)", () => {
    const now = addMonths(start, 1);
    expect(isMonthlyRefillDue({ now, interval: "monthly", subStatus: "ACTIVE", periodEnd, walletPeriodStart: start })).toBe(false);
  });

  it("año pagado TERMINADO (periodEnd vencido) → no recarga (lo maneja dunning)", () => {
    const now = addMonths(start, 13); // > periodEnd
    expect(isMonthlyRefillDue({ now, interval: "yearly", subStatus: "ACTIVE", periodEnd, walletPeriodStart: addMonths(start, 12) })).toBe(false);
  });

  it("suscripción no ACTIVE → no recarga", () => {
    const now = addMonths(start, 1);
    expect(isMonthlyRefillDue({ now, interval: "yearly", subStatus: "PAST_DUE", periodEnd, walletPeriodStart: start })).toBe(false);
  });

  it("anual sin recarga previa (borde) → recarga ahora", () => {
    const now = addMonths(start, 2);
    expect(isMonthlyRefillDue({ now, interval: "yearly", subStatus: "ACTIVE", periodEnd, walletPeriodStart: null })).toBe(true);
  });
});

describe("planIncludedQuota — cupo del plan", () => {
  it("−1 = ilimitado", () => expect(planIncludedQuota({ templateMessages: -1 }, 500)).toBe(1_000_000));
  it("valor concreto", () => expect(planIncludedQuota({ templateMessages: 1500 }, 500)).toBe(1500));
  it("0 = sin cupo", () => expect(planIncludedQuota({ templateMessages: 0 }, 500)).toBe(0));
  it("sin definir → default", () => expect(planIncludedQuota({}, 500)).toBe(500));
});

import { describe, expect, it } from "vitest";
import { BILLING_GRACE_DAYS, isOrgOperational, planDunningAction } from "./billing-dunning";

const DAY = 86_400_000;
const now = new Date("2026-08-04T12:00:00Z");

describe("dunning por impago (lógica pura)", () => {
  it("al día (periodEnd en el futuro) → sin acción", () => {
    const r = planDunningAction({ now, periodEnd: new Date(now.getTime() + 5 * DAY), subStatus: "ACTIVE", orgStatus: "ACTIVE" });
    expect(r.action).toBe("none");
  });

  it("el vencimiento dispara el período de gracia", () => {
    const periodEnd = new Date(now.getTime() - 1 * DAY); // venció ayer
    const r = planDunningAction({ now, periodEnd, subStatus: "ACTIVE", orgStatus: "ACTIVE" });
    expect(r.action).toBe("enter_grace");
    expect(r.graceEndsAt?.getTime()).toBe(periodEnd.getTime() + BILLING_GRACE_DAYS * DAY);
  });

  it("dentro de la gracia y ya marcado PAST_DUE → recordatorio (no re-entra)", () => {
    const periodEnd = new Date(now.getTime() - 2 * DAY);
    const r = planDunningAction({ now, periodEnd, subStatus: "PAST_DUE", orgStatus: "ACTIVE" });
    expect(r.action).toBe("warn_grace");
  });

  it("la gracia agotada suspende", () => {
    const periodEnd = new Date(now.getTime() - (BILLING_GRACE_DAYS + 1) * DAY);
    const r = planDunningAction({ now, periodEnd, subStatus: "PAST_DUE", orgStatus: "ACTIVE" });
    expect(r.action).toBe("suspend");
  });

  it("el pago reactiva: periodEnd renovado al futuro → sin acción (y no borra nada)", () => {
    // Tras activate(): sub ACTIVE, periodEnd +1 mes, org ACTIVE.
    const r = planDunningAction({ now, periodEnd: new Date(now.getTime() + 30 * DAY), subStatus: "ACTIVE", orgStatus: "ACTIVE" });
    expect(r.action).toBe("none");
  });

  it("ya suspendida o en trial o sin fecha → sin acción (idempotente)", () => {
    expect(planDunningAction({ now, periodEnd: new Date(now.getTime() - 30 * DAY), subStatus: "PAST_DUE", orgStatus: "SUSPENDED" }).action).toBe("none");
    expect(planDunningAction({ now, periodEnd: new Date(now.getTime() - 30 * DAY), subStatus: "TRIALING", orgStatus: "TRIAL" }).action).toBe("none");
    expect(planDunningAction({ now, periodEnd: null, subStatus: "ACTIVE", orgStatus: "ACTIVE" }).action).toBe("none");
  });

  it("un tenant suspendido no opera (IA no responde, flujos detenidos)", () => {
    expect(isOrgOperational("ACTIVE")).toBe(true);
    expect(isOrgOperational("TRIAL")).toBe(true);
    expect(isOrgOperational("SUSPENDED")).toBe(false);
    expect(isOrgOperational("CANCELLED")).toBe(false);
  });
});

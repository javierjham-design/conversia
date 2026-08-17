import { describe, expect, it } from "vitest";
import { planTrialAction, type TrialState } from "./trial-lifecycle";

const DAY = 86_400_000;
const created = new Date("2026-08-01T00:00:00Z");
const at = (days: number) => new Date(created.getTime() + days * DAY);

const activeTrial = (over: Partial<TrialState> = {}): TrialState => ({
  startedAt: created.toISOString(),
  endsAt: at(7).toISOString(),
  purgeAt: at(14).toISOString(),
  state: "active",
  warnedDays: [],
  ...over,
});

describe("planTrialAction — ciclo de vida de la prueba (7+7)", () => {
  it("prueba sin fechas → init", () => {
    const d = planTrialAction({ now: at(0), createdAt: created, orgStatus: "TRIAL", trial: null, hasPaid: false });
    expect(d.action).toBe("init");
    expect(d.endsAt.getTime()).toBe(at(7).getTime());
    expect(d.purgeAt.getTime()).toBe(at(14).getTime());
  });

  it("día 3 sin avisar → warn (día 3)", () => {
    const d = planTrialAction({ now: at(3), createdAt: created, orgStatus: "TRIAL", trial: activeTrial(), hasPaid: false });
    expect(d.action).toBe("warn");
    expect(d.warnDay).toBe(3);
  });

  it("día 3 YA avisado → none (idempotente)", () => {
    const d = planTrialAction({ now: at(3), createdAt: created, orgStatus: "TRIAL", trial: activeTrial({ warnedDays: [3] }), hasPaid: false });
    expect(d.action).toBe("none");
  });

  it("día 5 con día 3 ya avisado → warn (día 5)", () => {
    const d = planTrialAction({ now: at(5), createdAt: created, orgStatus: "TRIAL", trial: activeTrial({ warnedDays: [3] }), hasPaid: false });
    expect(d.action).toBe("warn");
    expect(d.warnDay).toBe(5);
  });

  it("día 7 en prueba → disable", () => {
    const d = planTrialAction({ now: at(7), createdAt: created, orgStatus: "TRIAL", trial: activeTrial({ warnedDays: [3, 5, 6] }), hasPaid: false });
    expect(d.action).toBe("disable");
  });

  it("deshabilitada pero aún NO llega el día 14 → none (no purga antes de tiempo)", () => {
    const d = planTrialAction({ now: at(10), createdAt: created, orgStatus: "SUSPENDED", trial: activeTrial({ state: "disabled" }), hasPaid: false });
    expect(d.action).toBe("none");
  });

  it("deshabilitada y día 14 cumplido → purge", () => {
    const d = planTrialAction({ now: at(14), createdAt: created, orgStatus: "SUSPENDED", trial: activeTrial({ state: "disabled" }), hasPaid: false });
    expect(d.action).toBe("purge");
  });

  it("PAGÓ → none SIEMPRE (nunca se deshabilita ni se purga a quien pagó)", () => {
    // aunque el reloj esté en el día 20 y la prueba figure disabled
    const d = planTrialAction({ now: at(20), createdAt: created, orgStatus: "SUSPENDED", trial: activeTrial({ state: "disabled" }), hasPaid: true });
    expect(d.action).toBe("none");
  });

  it("convertida → none", () => {
    const d = planTrialAction({ now: at(20), createdAt: created, orgStatus: "ACTIVE", trial: activeTrial({ state: "converted" }), hasPaid: false });
    expect(d.action).toBe("none");
  });

  it("cancelada → none", () => {
    const d = planTrialAction({ now: at(8), createdAt: created, orgStatus: "CANCELLED", trial: activeTrial(), hasPaid: false });
    expect(d.action).toBe("none");
  });
});

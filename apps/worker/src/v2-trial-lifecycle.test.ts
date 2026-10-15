import { describe, it, expect } from "vitest";
import { planV2TrialAction, V2_TRIAL_GRACE_DAYS } from "./v2-trial-lifecycle";

const DAY = 86_400_000;
const now = new Date("2026-10-15T12:00:00Z");

describe("planV2TrialAction", () => {
  it("con saldo > 0 no hace nada", () => {
    expect(planV2TrialAction({ now, remaining: 5, graceStartedAt: null, paused: false })).toBe("none");
  });

  it("al agotarse (saldo 0) y sin gracia iniciada → exhaust", () => {
    expect(planV2TrialAction({ now, remaining: 0, graceStartedAt: null, paused: false })).toBe("exhaust");
  });

  it("saldo negativo (gracia usada) sin arrancar la gracia → exhaust", () => {
    expect(planV2TrialAction({ now, remaining: -3, graceStartedAt: null, paused: false })).toBe("exhaust");
  });

  it("dentro de la ventana de gracia (copiloto) → none", () => {
    const graceStartedAt = new Date(now.getTime() - 3 * DAY).toISOString();
    expect(planV2TrialAction({ now, remaining: 0, graceStartedAt, paused: false })).toBe("none");
  });

  it("pasados los 7 días de gracia sin activar → pause", () => {
    const graceStartedAt = new Date(now.getTime() - (V2_TRIAL_GRACE_DAYS + 1) * DAY).toISOString();
    expect(planV2TrialAction({ now, remaining: 0, graceStartedAt, paused: false })).toBe("pause");
  });

  it("ya pausada → none (no re-pausa)", () => {
    const graceStartedAt = new Date(now.getTime() - 30 * DAY).toISOString();
    expect(planV2TrialAction({ now, remaining: 0, graceStartedAt, paused: true })).toBe("none");
  });

  it("justo en el borde de los 7 días → pause", () => {
    const graceStartedAt = new Date(now.getTime() - V2_TRIAL_GRACE_DAYS * DAY).toISOString();
    expect(planV2TrialAction({ now, remaining: 0, graceStartedAt, paused: false })).toBe("pause");
  });
});

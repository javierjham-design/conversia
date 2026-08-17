import { describe, expect, it, vi } from "vitest";
import { executeTrialPurge, planTrialAction, type PurgeDeps, type PurgeableOrg, type TrialState } from "./trial-lifecycle";

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

describe("executeTrialPurge — guardas de la purga (destructiva)", () => {
  const disabledOrg = (): PurgeableOrg => ({
    id: "org1",
    name: "Prueba Abandonada",
    createdAt: created,
    settings: { trial: activeTrial({ state: "disabled" }) },
  });
  const makeDeps = (over: Partial<PurgeDeps> = {}): { deps: PurgeDeps; calls: Record<string, number> } => {
    const calls = { recordPurge: 0, softDelete: 0, hardDelete: 0 };
    const deps: PurgeDeps = {
      hasEverPaid: vi.fn(async () => false),
      recordPurge: vi.fn(async () => { calls.recordPurge++; }),
      softDelete: vi.fn(async () => { calls.softDelete++; }),
      hardDelete: vi.fn(async () => { calls.hardDelete++; }),
      hardPurgeEnabled: false,
      now: () => at(14),
      ...over,
    };
    return { deps, calls };
  };

  it("PAGÓ → skipped, NUNCA borra (soft ni hard)", async () => {
    const { deps, calls } = makeDeps({ hasEverPaid: vi.fn(async () => true) });
    const r = await executeTrialPurge(disabledOrg(), deps);
    expect(r).toBe("skipped");
    expect(calls.softDelete + calls.hardDelete).toBe(0);
  });

  it("antes del día 14 → skipped", async () => {
    const { deps, calls } = makeDeps({ now: () => at(10) });
    const r = await executeTrialPurge(disabledOrg(), deps);
    expect(r).toBe("skipped");
    expect(calls.softDelete + calls.hardDelete).toBe(0);
  });

  it("día 14, no pagó, HARD desactivado → SOFT (marca, no borra de verdad)", async () => {
    const { deps, calls } = makeDeps();
    const r = await executeTrialPurge(disabledOrg(), deps);
    expect(r).toBe("soft");
    expect(calls.softDelete).toBe(1);
    expect(calls.hardDelete).toBe(0);
    expect(calls.recordPurge).toBe(1);
  });

  it("día 14, no pagó, HARD activado → HARD (borra en cascada) + registro", async () => {
    const { deps, calls } = makeDeps({ hardPurgeEnabled: true });
    const r = await executeTrialPurge(disabledOrg(), deps);
    expect(r).toBe("hard");
    expect(calls.hardDelete).toBe(1);
    expect(calls.softDelete).toBe(0);
    expect(calls.recordPurge).toBe(1);
  });
});

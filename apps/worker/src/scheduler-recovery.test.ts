import { describe, expect, it } from "vitest";
import { planJobRecovery } from "./scheduler";

/**
 * §8.6 — recuperación de jobs que quedaron en PROCESSING (el proceso murió en un redeploy).
 * Lo delicado: estos jobs mandan recordatorios REALES a clientes, así que recuperar de más
 * es peor que recuperar de menos.
 */

const AHORA = new Date("2026-10-27T12:00:00Z");
const hace = (ms: number) => new Date(AHORA.getTime() - ms).toISOString();
const MIN = 60_000;

describe("planJobRecovery", () => {
  it("recién tomado (2 min) → esperar, no tocarlo", () => {
    const job = { payload: { __processingAt: hace(2 * MIN) }, dueAt: new Date(hace(10 * MIN)) };
    expect(planJobRecovery(job, AHORA)).toEqual({ action: "wait" });
  });

  it("colgado hace 6 min sin intentos previos → reencolar (1.ª recuperación)", () => {
    const job = { payload: { __processingAt: hace(6 * MIN) }, dueAt: new Date(hace(10 * MIN)) };
    expect(planJobRecovery(job, AHORA)).toEqual({ action: "requeue", recoveries: 1 });
  });

  it("agotadas las 3 recuperaciones del MISMO ciclo → FAILED, no se reintenta para siempre", () => {
    const dueAt = new Date(hace(30 * MIN));
    const job = {
      payload: { __processingAt: hace(6 * MIN), __recoveries: 3, __recoveryFor: dueAt.toISOString() },
      dueAt,
    };
    expect(planJobRecovery(job, AHORA)).toEqual({ action: "fail", recoveries: 3, reason: "max_recoveries" });
  });

  it("el contador se reinicia si el job se re-armó con otro dueAt (no queda envenenado)", () => {
    const job = {
      payload: {
        __processingAt: hace(6 * MIN),
        __recoveries: 3,
        __recoveryFor: new Date(hace(5 * 60 * MIN)).toISOString(), // ciclo viejo
      },
      dueAt: new Date(hace(30 * MIN)),
    };
    expect(planJobRecovery(job, AHORA)).toEqual({ action: "requeue", recoveries: 1 });
  });

  it("CLAVE: un job de hace 2 días NO se resucita (no manda recordatorios de citas pasadas)", () => {
    const job = { payload: {}, dueAt: new Date(AHORA.getTime() - 2 * 24 * 60 * MIN) };
    expect(planJobRecovery(job, AHORA)).toEqual({ action: "fail", recoveries: 0, reason: "too_late" });
  });

  it("sin sello de claim (versión anterior) usa dueAt como referencia", () => {
    // dueAt hace 2 min → todavía no se considera colgado.
    expect(planJobRecovery({ payload: {}, dueAt: new Date(hace(2 * MIN)) }, AHORA)).toEqual({ action: "wait" });
    // dueAt hace 10 min → colgado, se recupera.
    expect(planJobRecovery({ payload: {}, dueAt: new Date(hace(10 * MIN)) }, AHORA)).toEqual({
      action: "requeue",
      recoveries: 1,
    });
  });

  it("payload que no es objeto plano no rompe nada", () => {
    expect(planJobRecovery({ payload: null, dueAt: new Date(hace(10 * MIN)) }, AHORA).action).toBe("requeue");
    expect(planJobRecovery({ payload: "texto", dueAt: new Date(hace(10 * MIN)) }, AHORA).action).toBe("requeue");
  });
});

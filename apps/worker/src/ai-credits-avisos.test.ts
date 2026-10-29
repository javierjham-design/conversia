import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CRE 3 — AVISOS de saldo para la unidad de Créditos IA.
 *
 * AGUJERO QUE CIERRA (y por qué importa): los avisos de 75%, 90% y gracia vivían SOLO en el
 * camino del cobro por conversación. CRE 1 desactivó ese camino para los planes de créditos
 * —correcto, para no cobrar dos veces—, y con eso un cliente de Créditos IA dejó de recibir
 * CUALQUIER advertencia: el bot se le paraba sin un solo aviso previo. Es el peor momento
 * posible para enterarse de que había que recargar.
 */

const estado = {
  included: 1000,
  lots: 1000,
  grace: 0,
  lastNotifiedPct: 0,
  features: { aiCreditsWallet: true, aiCreditsIncluded: 1000 } as Record<string, unknown>,
};
const updates: Record<string, unknown>[] = [];

vi.mock("@conversia/database", () => ({
  getAdminPrisma: () => ({
    organization: { findUnique: async () => ({ settings: { general: { industry: "barberia" } } }) },
    $queryRaw: async () => [],
  }),
  withTenant: async (_o: string, fn: (tx: unknown) => unknown) =>
    fn({
      $executeRaw: async () => 0,
      $queryRaw: async () => [],
      conversationWallet: {
        findUnique: async () => ({ lastNotifiedPct: estado.lastNotifiedPct }),
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          if (typeof data.lastNotifiedPct === "number") estado.lastNotifiedPct = data.lastNotifiedPct;
          return data;
        },
      },
    }),
  raiseException: async () => undefined,
  leerMuestraConsumoCreditos: async () => ({ conversaciones: 0, creditos: 0, dias: 0 }),
  leerPromedioDelRubro: async () => null,
}));

vi.mock("./conversation-credits", () => ({
  balanceInTx: async () => ({ lots: estado.lots, grace: estado.grace, net: estado.lots - estado.grace }),
  consumeCreditsInTx: async ({ amount }: any) => ({ ok: true, graceUsed: 0, consumido: amount, alTope: false }),
  ensurePeriodAccrued: async () => undefined,
  isConversiaOrg: async () => true,
  lockOrg: async () => undefined,
  planFeatures: async () => estado.features,
}));

import { aiCreditsNotifyDecision, getAiCreditsMeter } from "./ai-credits";

beforeEach(() => {
  estado.included = 1000;
  estado.lots = 1000;
  estado.grace = 0;
  estado.lastNotifiedPct = 0;
  updates.length = 0;
});

describe("umbrales", () => {
  it("con saldo entero no avisa nada", async () => {
    const r = await aiCreditsNotifyDecision("org-1");
    expect(r.fire).toBeNull();
    expect(updates).toEqual([]);
  });

  it("al 75% consumido avisa una vez", async () => {
    estado.lots = 250; // consumió 750 de 1000
    const r = await aiCreditsNotifyDecision("org-1");
    expect(r.fire).toBe("low75");
    expect(r.used).toBe(750);
    expect(updates.at(-1)).toEqual({ lastNotifiedPct: 75 });
  });

  it("NO repite el mismo umbral en el período", async () => {
    estado.lots = 250;
    expect((await aiCreditsNotifyDecision("org-1")).fire).toBe("low75");
    expect((await aiCreditsNotifyDecision("org-1")).fire).toBeNull();
  });

  it("al 90% avisa de nuevo, aunque ya hubiera avisado al 75%", async () => {
    estado.lots = 250;
    await aiCreditsNotifyDecision("org-1");
    estado.lots = 80; // 92%
    expect((await aiCreditsNotifyDecision("org-1")).fire).toBe("low90");
  });

  it("si cae de golpe del 100% al 95%, avisa el umbral MÁS ALTO y no los dos", async () => {
    estado.lots = 50; // 95%
    expect((await aiCreditsNotifyDecision("org-1")).fire).toBe("low90");
    expect((await aiCreditsNotifyDecision("org-1")).fire).toBeNull();
  });

  it("entrar en gracia avisa aunque ya se avisara el 90%", async () => {
    estado.lots = 50;
    await aiCreditsNotifyDecision("org-1");
    estado.lots = 0;
    estado.grace = 12;
    const r = await aiCreditsNotifyDecision("org-1");
    expect(r.fire).toBe("grace");
    expect(r.graceUsed).toBe(12);
  });

  it("la gracia es el último aviso: no vuelve a avisar nada después", async () => {
    estado.lots = 0;
    estado.grace = 12;
    expect((await aiCreditsNotifyDecision("org-1")).fire).toBe("grace");
    estado.grace = 40;
    expect((await aiCreditsNotifyDecision("org-1")).fire).toBeNull();
  });

  it("un plan sin cupo incluido no dispara avisos de porcentaje (no hay de qué calcular %)", async () => {
    estado.features = { aiCreditsWallet: true, aiCreditsIncluded: 0 };
    estado.lots = 0;
    const r = await aiCreditsNotifyDecision("org-1");
    expect(r.fire).toBeNull();
    estado.features = { aiCreditsWallet: true, aiCreditsIncluded: 1000 };
  });
});

describe("el medidor que acompaña al aviso", () => {
  it("traduce el saldo a algo que el dueño entienda", async () => {
    estado.lots = 450;
    const m = await getAiCreditsMeter("org-1");
    expect(m.summary.remaining).toBe(450);
    expect(m.frase).toContain("450 créditos");
    expect(m.frase).toContain("conversaciones");
    // Sin historial propio ni del rubro, lo dice en vez de fingir precisión.
    expect(m.explicacion).toMatch(/promedio general/);
  });

  it("sin saldo lo dice sin rodeos", async () => {
    estado.lots = 0;
    expect((await getAiCreditsMeter("org-1")).frase).toBe("Sin créditos disponibles");
  });
});

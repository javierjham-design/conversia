import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CRE 3 — EL MEDIDOR EN LA RESPUESTA DE `/billing/wallet/summary`.
 *
 * El estimador tiene sus propios tests (packages/agents/credit-estimate.test.ts) y las dos
 * consultas que lo alimentan se verifican contra un Postgres real
 * (`pnpm --filter @conversia/database verify:credit-meter`). Lo que faltaba era el punto de
 * unión: que la API ADJUNTE el medidor cuando el cliente paga en créditos, con los campos
 * que la pantalla lee, y que NO lo adjunte cuando paga por conversación (ahí "≈ 140
 * conversaciones" sobre un saldo que ya está en conversaciones es ruido, no información).
 *
 * Y que una lectura accesoria que falla NO tumbe el saldo: el medidor es un lujo, el saldo
 * no. Si la muestra no se puede leer, la pantalla tiene que seguir mostrando cuánto queda.
 */

const estado = {
  muestra: { conversaciones: 40, creditos: 360, dias: 20 },
  fallaMuestra: false,
  fallaRubro: false,
  rubro: "barberia" as string | null,
};

vi.mock("@conversia/database", () => ({
  leerMuestraConsumoCreditos: async () => {
    if (estado.fallaMuestra) throw new Error("BD caída");
    return estado.muestra;
  },
  leerPromedioDelRubro: async () => {
    if (estado.fallaRubro) throw new Error("BD caída");
    return 12;
  },
  messageWalletQuota: () => 0,
  refillMessageWallet: async () => ({ balanceAfter: 0 }),
}));

import { BillingController } from "../src/billing/billing.controller";

/** Prisma de mentira con lo justo que lee el resumen de la bolsa de lotes. */
function fakePrisma() {
  const admin = {
    conversationCreditLot: {
      aggregate: async () => ({ _sum: { remaining: 1240 } }),
      findFirst: async () => ({ id: "lote-del-periodo" }),
    },
    conversationWallet: { findUnique: async () => ({ graceUsed: 0, periodStart: new Date() }) },
    conversationCreditLedger: { count: async () => 12 },
    subscription: { findFirst: async () => ({ periodStart: new Date(), planId: "plan-1" }) },
    organization: {
      findUnique: async () => ({ settings: estado.rubro ? { general: { industry: estado.rubro } } : {} }),
    },
  };
  return { admin, withTenant: async (_org: string, fn: (tx: unknown) => unknown) => fn({}) };
}

function controller() {
  const c = new BillingController(fakePrisma() as never, {} as never, {} as never);
  return c as unknown as {
    conversationWalletSummary: (
      orgId: string,
      included: number,
      opts?: { unit?: "conversation" | "credit"; graceLimit?: number },
    ) => Promise<Record<string, any>>;
  };
}

describe("medidor de créditos en el resumen de la bolsa", () => {
  beforeEach(() => {
    estado.muestra = { conversaciones: 40, creditos: 360, dias: 20 };
    estado.fallaMuestra = false;
    estado.fallaRubro = false;
    estado.rubro = "barberia";
  });

  it("con unidad 'credit' adjunta el medidor con los campos que lee la pantalla", async () => {
    const r = await controller().conversationWalletSummary("org-1", 100, { unit: "credit", graceLimit: 100 });

    expect(r.unit).toBe("credit");
    expect(r.medidor).toBeTruthy();
    // Los tres campos que /inicio y /cobros renderizan. Si alguno cambia de nombre, la
    // pantalla deja de mostrar el medidor en silencio (está envuelto en un `? :`).
    for (const campo of ["conversaciones", "dias", "creditosPorConversacion", "base", "frase", "explicacion"]) {
      expect(Object.keys(r.medidor), `falta ${campo}`).toContain(campo);
    }
    expect(typeof r.medidor.conversaciones).toBe("number");
    expect(r.medidor.conversaciones).toBeGreaterThan(0);
    expect(typeof r.medidor.explicacion).toBe("string");
    expect(r.medidor.explicacion.length).toBeGreaterThan(0);
  });

  it("con 40 conversaciones propias el número sale de SU consumo, no del rubro", async () => {
    const r = await controller().conversationWalletSummary("org-1", 100, { unit: "credit" });
    // 360 créditos / 40 conversaciones = 9 por conversación → 1.240 / 9 = 137 (hacia abajo).
    expect(r.medidor.base).toBe("org");
    expect(r.medidor.creditosPorConversacion).toBe(9);
    expect(r.medidor.conversaciones).toBe(137);
    // Ritmo propio: 360 créditos en 20 días = 18/día → 1.240 / 18 = 68 días.
    expect(r.medidor.dias).toBe(68);
  });

  it("con muestra chica cae al promedio del rubro (3 conversaciones no son un promedio)", async () => {
    estado.muestra = { conversaciones: 3, creditos: 60, dias: 2 };
    const r = await controller().conversationWalletSummary("org-1", 100, { unit: "credit" });
    expect(r.medidor.base).toBe("rubro");
    expect(r.medidor.creditosPorConversacion).toBe(12); // el del rubro, no 20
  });

  it("con unidad 'conversation' NO adjunta medidor", async () => {
    const r = await controller().conversationWalletSummary("org-1", 30, { unit: "conversation" });
    expect(r.medidor).toBeUndefined();
    expect(r.balance).toBe(1240);
  });

  it("sin unidad (bolsa de plantillas) tampoco adjunta medidor", async () => {
    const r = await controller().conversationWalletSummary("org-1", 30);
    expect(r.medidor).toBeUndefined();
  });

  it("si la muestra no se puede leer, el SALDO sigue llegando y el medidor estima igual", async () => {
    estado.fallaMuestra = true;
    const r = await controller().conversationWalletSummary("org-1", 100, { unit: "credit" });
    expect(r.balance).toBe(1240); // el saldo es lo importante: nunca se cae por el medidor
    expect(r.medidor).toBeTruthy();
    expect(r.medidor.base).toBe("rubro"); // sin muestra propia, el promedio del rubro
    expect(r.medidor.dias).toBeNull(); // sin ritmo propio NO se inventan días
  });

  it("si además falla el rubro, estima con el valor general y no revienta", async () => {
    estado.fallaMuestra = true;
    estado.fallaRubro = true;
    const r = await controller().conversationWalletSummary("org-1", 100, { unit: "credit" });
    expect(r.medidor.base).toBe("defecto");
    expect(r.medidor.conversaciones).toBeGreaterThan(0);
  });

  it("una organización sin rubro configurado no rompe la lectura", async () => {
    estado.rubro = null;
    const r = await controller().conversationWalletSummary("org-1", 100, { unit: "credit" });
    expect(r.medidor).toBeTruthy();
  });
});

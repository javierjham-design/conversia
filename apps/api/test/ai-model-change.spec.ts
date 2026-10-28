import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CRE 1 (§4) — CAMBIO DE MODELO CON ACEPTACIÓN DEL CLIENTE.
 *
 * La regla que se prueba acá decide si al cliente le sube el consumo con aviso previo o
 * de un día para otro. Un error en cualquiera de las dos direcciones es malo: aplicar sin
 * avisar le gasta el saldo a sus espaldas, y pedir aceptación donde no corresponde le
 * manda un aviso falso ("tus créditos rinden menos") a alguien que no paga con créditos.
 */

const store = {
  settings: {} as Record<string, unknown>,
  planFeatures: { aiCreditsWallet: true } as Record<string, unknown>,
  lots: 1_000,
  grace: 0,
  versions: [] as Array<{ id: string; config: Record<string, unknown> }>,
  policyRow: null as null | { value: string },
};

vi.mock("@conversia/database", () => ({
  getAdminPrisma: () => ({
    organization: {
      findUnique: async () => ({ settings: store.settings, brand: "conversia" }),
      update: async ({ data }: any) => {
        store.settings = data.settings;
        return { settings: store.settings };
      },
    },
    subscription: { findFirst: async () => ({ planId: "p1" }) },
    plan: { findUnique: async () => ({ features: store.planFeatures }) },
    platformSetting: { findUnique: async () => store.policyRow },
    conversationCreditLot: { aggregate: async () => ({ _sum: { remaining: store.lots } }) },
    conversationWallet: { findUnique: async () => ({ graceUsed: store.grace }) },
    agentVersion: {
      findMany: async () => store.versions,
      update: async ({ where, data }: any) => {
        const v = store.versions.find((x) => x.id === where.id);
        if (v) v.config = data.config;
        return v;
      },
    },
  }),
}));

import {
  applyAgentModel,
  buildImpact,
  clearPendingModelChange,
  decideModelChange,
  modelOptions,
  planChargesAiCredits,
  readPendingModelChanges,
  savePendingModelChange,
} from "../src/agents/model-change";
import { resetAiModelPolicyCache } from "../src/agents/model-policy";

/** Pesos de la semilla: mini 1 · haiku 4 · gpt-4o 12 · sonnet 20 · opus 50. */
const creditos: Record<string, number> = {
  "gpt-4o-mini": 1,
  "claude-haiku-4-5": 4,
  "gpt-4o": 12,
  "claude-opus-4-8": 50,
};
const creditsOf = (m: string) => creditos[m] ?? 50;

beforeEach(() => {
  store.settings = {};
  store.planFeatures = { aiCreditsWallet: true };
  store.lots = 1_000;
  store.grace = 0;
  store.versions = [
    { id: "v1", config: { model: "gpt-4o-mini", maxTokens: 400 } },
    { id: "v2", config: { model: "gpt-4o-mini" } },
  ];
  store.policyRow = null;
  resetAiModelPolicyCache();
});

describe("§4 — la regla: ¿se aplica o se le pregunta al cliente?", () => {
  it("un modelo MÁS CARO con cobro por créditos: se le pregunta", () => {
    expect(decideModelChange({ current: "gpt-4o-mini", requested: "gpt-4o", chargesCredits: true, creditsOf })).toBe("pedir_aceptacion");
  });

  it("volver al estándar (más barato) se aplica solo: nadie tiene que aceptar nada", () => {
    expect(decideModelChange({ current: "gpt-4o", requested: "gpt-4o-mini", chargesCredits: true, creditsOf })).toBe("aplicar");
  });

  it("el mismo modelo se aplica (es un no-op, no un pedido)", () => {
    expect(decideModelChange({ current: "gpt-4o", requested: "gpt-4o", chargesCredits: true, creditsOf })).toBe("aplicar");
  });

  it("quitar el override se aplica", () => {
    expect(decideModelChange({ current: "gpt-4o", requested: null, chargesCredits: true, creditsOf })).toBe("aplicar");
  });

  it("un cliente que NO paga con créditos: se aplica sin aviso (el aviso sería falso)", () => {
    // Con cobro por conversación, el modelo no cambia lo que paga: mandarle "tus
    // créditos rinden menos" sería mentirle.
    expect(decideModelChange({ current: "gpt-4o-mini", requested: "claude-opus-4-8", chargesCredits: false, creditsOf })).toBe("aplicar");
  });

  it("el super admin puede forzar, y entonces la acción es otra (exige motivo)", () => {
    expect(decideModelChange({ current: "gpt-4o-mini", requested: "gpt-4o", chargesCredits: true, force: true, creditsOf })).toBe("forzar");
  });

  it("forzar algo que igual se aplicaría no cambia nada", () => {
    expect(decideModelChange({ current: "gpt-4o", requested: "gpt-4o-mini", chargesCredits: true, force: true, creditsOf })).toBe("aplicar");
  });

  it("un modelo desconocido se trata como el más caro (no se cuela sin aviso)", () => {
    expect(decideModelChange({ current: "gpt-4o-mini", requested: "modelo-raro", chargesCredits: true, creditsOf })).toBe("pedir_aceptacion");
  });
});

describe("§4 — el pedido queda guardado hasta que el cliente responda", () => {
  it("se guarda, se lee y se borra", async () => {
    const impact = await buildImpact("o", "gpt-4o-mini", "gpt-4o");
    await savePendingModelChange("o", {
      agentId: "a1",
      agentName: "Recepcionista",
      from: "gpt-4o-mini",
      to: "gpt-4o",
      requestedAt: new Date().toISOString(),
      requestedByAdminId: "admin1",
      impact,
    });
    const pend = await readPendingModelChanges("o");
    expect(pend).toHaveLength(1);
    expect(pend[0]).toMatchObject({ agentId: "a1", from: "gpt-4o-mini", to: "gpt-4o" });

    const borrado = await clearPendingModelChange("o", "a1");
    expect(borrado?.to).toBe("gpt-4o");
    expect(await readPendingModelChanges("o")).toEqual([]);
  });

  it("guardar el pedido NO toca el resto de los ajustes de la organización", async () => {
    // Se escribe sobre un settings compartido: si se pisara, borraríamos configuración
    // real del cliente (horarios, mensajería, lo que sea) por un cambio de modelo.
    store.settings = { messaging: { outOfCreditsMessage: "Ya te contactamos" }, ai: { model: "gpt-4o-mini", maxTokens: 400 } };
    await savePendingModelChange("o", {
      agentId: "a1",
      agentName: "Recepcionista",
      from: "gpt-4o-mini",
      to: "gpt-4o",
      requestedAt: new Date().toISOString(),
      requestedByAdminId: null,
      impact: await buildImpact("o", "gpt-4o-mini", "gpt-4o"),
    });
    expect((store.settings as any).messaging.outOfCreditsMessage).toBe("Ya te contactamos");
    expect((store.settings as any).ai.model).toBe("gpt-4o-mini");
    expect((store.settings as any).ai.maxTokens).toBe(400);
  });

  it("borrar un pedido que no existe no explota", async () => {
    expect(await clearPendingModelChange("o", "no-existe")).toBeNull();
  });

  it("dos agentes pueden tener pedidos distintos a la vez", async () => {
    const impact = await buildImpact("o", "gpt-4o-mini", "gpt-4o");
    for (const agentId of ["a1", "a2"]) {
      await savePendingModelChange("o", { agentId, agentName: agentId, from: "gpt-4o-mini", to: "gpt-4o", requestedAt: "x", requestedByAdminId: null, impact });
    }
    expect(await readPendingModelChanges("o")).toHaveLength(2);
    await clearPendingModelChange("o", "a1");
    expect((await readPendingModelChanges("o")).map((p) => p.agentId)).toEqual(["a2"]);
  });
});

describe("§4 — aplicar el modelo", () => {
  it("escribe el modelo en TODAS las versiones del agente", async () => {
    await applyAgentModel("o", "a1", "gpt-4o");
    expect(store.versions.map((v) => v.config.model)).toEqual(["gpt-4o", "gpt-4o"]);
  });

  it("quitar el override borra el modelo y NO se lleva el resto del config", async () => {
    await applyAgentModel("o", "a1", null);
    expect(store.versions[0].config.model).toBeUndefined();
    expect(store.versions[0].config.maxTokens).toBe(400);
  });
});

describe("§4 — el impacto se calcula con el saldo real del cliente", () => {
  it("usa los lotes vigentes menos la gracia usada", async () => {
    store.lots = 500;
    store.grace = 100;
    const i = await buildImpact("o", "gpt-4o-mini", "claude-haiku-4-5");
    // 400 créditos / (4,2 × 1) ≈ 95 conversaciones antes; / (4,2 × 4) ≈ 23 después.
    expect(i.from.conversations).toBe(95);
    expect(i.to.conversations).toBe(23);
  });
});

describe("§4 — opciones del selector", () => {
  it("vienen ordenadas de la más barata a la más cara, con su peso", async () => {
    const opts = await modelOptions();
    expect(opts[0]).toMatchObject({ model: "gpt-4o-mini", creditsPerReply: 1, selfServe: true });
    expect(opts.map((o) => o.creditsPerReply)).toEqual([...opts.map((o) => o.creditsPerReply)].sort((a, b) => a - b));
  });

  it("premium queda marcado como NO autoservicio (§4)", async () => {
    const opts = await modelOptions();
    const opus = opts.find((o) => o.model === "claude-opus-4-8");
    expect(opus).toMatchObject({ level: "premium", selfServe: false });
  });
});

describe("§4 — cuándo se exige la aceptación", () => {
  it("un plan con Créditos IA sí la exige", async () => {
    expect(await planChargesAiCredits("o")).toBe(true);
  });

  it("un plan por conversación no", async () => {
    store.planFeatures = { conversationDebitsWallet: true };
    expect(await planChargesAiCredits("o")).toBe(false);
  });
});

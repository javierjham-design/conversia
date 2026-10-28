import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CRE 1 — MOTOR DE CRÉDITOS IA.
 *
 * Esto cobra plata real por cada respuesta del bot, así que los tests van a los lugares
 * donde un error se traduce en cobrarle de más a un cliente, en regalarle el servicio o
 * en dejarlo sin bot: idempotencia del turno, gracia, lotes vencidos, modelo desconocido,
 * y que TuBot no entre por ninguna puerta.
 *
 * La serialización real entre dos turnos simultáneos la da el `SELECT … FOR UPDATE` de
 * Postgres, que un store en memoria no puede reproducir. Acá se verifica que el cerrojo
 * se tome ANTES de mirar los lotes (que es lo que el código tiene que garantizar); que
 * funcione bajo carga de verdad lo prueba el stack de simulación.
 */

const store = {
  lots: [] as any[],
  wallet: null as any,
  ledger: [] as any[],
  usage: [] as any[],
  excepciones: [] as any[],
  rawCalls: [] as string[],
  brand: "conversia" as string,
  planFeatures: { aiCreditsWallet: true, aiCreditsIncluded: 0 } as Record<string, unknown>,
  planId: "p-credits",
  policyRow: null as null | { value: string },
  seq: 0,
  fallarBase: false,
};

function matchLot(l: any, where: any) {
  if (where.remaining?.gt !== undefined && !(l.remaining > where.remaining.gt)) return false;
  if (where.OR) {
    const ok = where.OR.some(
      (c: any) => (c.expiresAt === null && l.expiresAt == null) || (c.expiresAt?.gt && l.expiresAt && l.expiresAt > c.expiresAt.gt),
    );
    if (!ok) return false;
  }
  return true;
}

const tx = {
  $executeRaw: async (q: any) => {
    store.rawCalls.push(String(Array.isArray(q) ? q.join("?") : q));
    return 0;
  },
  conversationCreditLot: {
    aggregate: async ({ where }: any) => ({
      _sum: { remaining: store.lots.filter((l) => matchLot(l, where)).reduce((a, l) => a + l.remaining, 0) },
    }),
    findMany: async ({ where }: any) =>
      store.lots
        .filter((l) => matchLot(l, where))
        .slice()
        .sort((a, b) => {
          const ax = a.expiresAt ? a.expiresAt.getTime() : Infinity;
          const bx = b.expiresAt ? b.expiresAt.getTime() : Infinity;
          return ax - bx || a.createdAt - b.createdAt;
        }),
    update: async ({ where, data }: any) => {
      const l = store.lots.find((x) => x.id === where.id);
      if (l) Object.assign(l, data);
      return l;
    },
    create: async ({ data }: any) => {
      const l = { id: `lot${++store.seq}`, createdAt: store.seq, ...data };
      store.lots.push(l);
      return l;
    },
  },
  conversationWallet: {
    upsert: async ({ create }: any) => {
      if (!store.wallet) store.wallet = { graceUsed: 0, lastNotifiedPct: 0, periodStart: new Date(0), ...create };
      return store.wallet;
    },
    findUnique: async () => store.wallet,
    update: async ({ data }: any) => {
      Object.assign(store.wallet, data);
      return store.wallet;
    },
  },
  conversationCreditLedger: {
    create: async ({ data }: any) => {
      store.ledger.push(data);
      return data;
    },
    findFirst: async ({ where }: any) =>
      store.ledger.find(
        (e) => e.reason === where.reason && (where.refId === undefined || e.refId === where.refId),
      ) ?? null,
  },
  usageEvent: {
    create: async ({ data }: any) => {
      store.usage.push(data);
      return data;
    },
  },
};

vi.mock("@conversia/database", () => ({
  withTenant: async (_org: string, fn: any) => {
    if (store.fallarBase) throw new Error("BD caída");
    return fn(tx);
  },
  getAdminPrisma: () => ({
    organization: { findUnique: async () => ({ brand: store.brand }) },
    subscription: { findFirst: async () => ({ planId: store.planId, periodStart: new Date() }) },
    plan: { findUnique: async () => ({ features: store.planFeatures }) },
    platformSetting: { findUnique: async () => store.policyRow },
  }),
  raiseException: async (_admin: unknown, input: any) => void store.excepciones.push(input),
}));

import {
  aiCreditsGate,
  debitAiCreditsForTurn,
  getAiCreditsSummary,
  planDebitsAiCredits,
  readCreditPolicy,
  resetCreditPolicyCache,
} from "./ai-credits";
import { planDebitsConversation } from "./conversation-credits";

const MANANA = () => new Date(Date.now() + 86_400_000);

function lote(remaining: number, expiresAt: Date | null = MANANA()) {
  store.lots.push({
    id: `L${++store.seq}`,
    organizationId: "o",
    source: "purchase",
    amount: remaining,
    remaining,
    expiresAt,
    createdAt: store.seq,
  });
}

/** Un turno normal: ~10.000 tokens con el modelo estándar = 1 crédito. */
function turno(turnId: string, over: Partial<Parameters<typeof debitAiCreditsForTurn>[1]> = {}) {
  return debitAiCreditsForTurn("o", {
    conversationId: "c1",
    turnId,
    model: "gpt-4o-mini",
    inputTokens: 9_600,
    outputTokens: 60,
    costUsd: 0.00204,
    ...over,
  });
}

beforeEach(() => {
  store.lots = [];
  store.wallet = null;
  store.ledger = [];
  store.usage = [];
  store.excepciones = [];
  store.rawCalls = [];
  store.brand = "conversia";
  store.planFeatures = { aiCreditsWallet: true, aiCreditsIncluded: 0 };
  store.planId = "p-credits";
  store.policyRow = null;
  store.seq = 0;
  store.fallarBase = false;
  resetCreditPolicyCache();
});

describe("Etapa 1 — débito por respuesta del bot", () => {
  it("una respuesta normal descuenta 1 crédito del lote", async () => {
    lote(10);
    const r = await turno("t1");
    expect(r.charged).toBe(true);
    if (r.charged) {
      expect(r.credits).toBe(1);
      expect(r.balanceAfter).toBe(9);
    }
    expect(store.lots[0].remaining).toBe(9);
  });

  it("una respuesta larga (3 bloques de tokens) descuenta 3", async () => {
    lote(10);
    const r = await turno("t1", { inputTokens: 44_000, outputTokens: 1_000 });
    if (r.charged) expect(r.credits).toBe(3);
    expect(store.lots[0].remaining).toBe(7);
  });

  it("el peso del modelo que RESPONDIÓ es el que se cobra", async () => {
    lote(100);
    const r = await turno("t1", { model: "gpt-4o" }); // nivel avanzado = 12
    if (r.charged) expect(r.credits).toBe(12);
    expect(store.lots[0].remaining).toBe(88);
  });

  it("el asiento del libro queda con créditos, costo y conversación", async () => {
    lote(10);
    await turno("t1");
    const asiento = store.ledger.find((e) => e.reason === "ai_credit_debit");
    expect(asiento).toMatchObject({ delta: -1, conversationId: "c1", refType: "turn", refId: "t1", balanceAfter: 9 });
    expect(Number(asiento.costUsd)).toBeCloseTo(0.00204, 6);
  });

  it("el consumo guarda el DETALLE que explica el cargo (tokens, modelo, nivel, bloques)", async () => {
    // Sin esto, un cliente que pregunta "¿por qué esta respuesta me costó 8?" no tiene
    // respuesta posible, y el reporte de margen de la Etapa 4 no tiene de dónde leer.
    lote(100);
    await turno("t1", { model: "claude-haiku-4-5", inputTokens: 25_000, outputTokens: 0 });
    const ev = store.usage.find((e) => e.type === "ai_credits");
    expect(ev.quantity).toBe(8);
    expect(ev.meta).toMatchObject({
      model: "claude-haiku-4-5",
      level: "plus",
      weight: 4,
      blocks: 2,
      inputTokens: 25_000,
      outputTokens: 0,
      turnId: "t1",
      tokensPerCredit: 20_000,
    });
  });

  it("toma el cerrojo de la org ANTES de mirar los lotes", async () => {
    lote(10);
    await turno("t1");
    expect(store.rawCalls[0]).toContain("FOR UPDATE");
  });
});

describe("Etapa 1 — idempotencia por turno", () => {
  it("el MISMO turno no se cobra dos veces (reintento del job)", async () => {
    lote(10);
    await turno("t1");
    const otra = await turno("t1");
    expect(otra.charged).toBe(false);
    if (!otra.charged) expect(otra.reason).toBe("ya_debitado");
    expect(store.lots[0].remaining).toBe(9);
    expect(store.ledger.filter((e) => e.reason === "ai_credit_debit")).toHaveLength(1);
  });

  it("dos turnos DISTINTOS sí se cobran los dos", async () => {
    lote(10);
    await turno("t1");
    await turno("t2");
    expect(store.lots[0].remaining).toBe(8);
    expect(store.ledger.filter((e) => e.reason === "ai_credit_debit")).toHaveLength(2);
  });
});

describe("Etapa 1 — un turno sin IA no se cobra", () => {
  it("cero tokens (proveedor caído) = sin débito y sin asiento", async () => {
    lote(10);
    const r = await turno("t1", { inputTokens: 0, outputTokens: 0 });
    expect(r.charged).toBe(false);
    if (!r.charged) expect(r.reason).toBe("sin_tokens");
    expect(store.lots[0].remaining).toBe(10);
    expect(store.ledger).toHaveLength(0);
  });
});

describe("Etapa 1 — gracia: el bot nunca queda mudo de golpe", () => {
  it("sin lotes, debita en gracia hasta 100 y después devuelve sin_saldo", async () => {
    for (let i = 0; i < 100; i++) {
      const r = await turno(`g${i}`);
      expect(r.charged).toBe(true);
    }
    expect(store.wallet.graceUsed).toBe(100);
    const corte = await turno("gX");
    expect(corte.charged).toBe(false);
    if (!corte.charged) expect(corte.reason).toBe("sin_saldo");
    expect(store.wallet.graceUsed).toBe(100); // no pasa del límite
  });

  it("un turno CARO que no cabe en la gracia no consume nada (ni lotes ni gracia)", async () => {
    // El caso que el cobro por conversación no veía: el turno pide 50 de una vez.
    // Antes el núcleo vaciaba los lotes y recién después miraba la gracia, así que esos
    // créditos desaparecían del libro sin asiento.
    lote(3);
    store.wallet = { graceUsed: 99, lastNotifiedPct: 0, periodStart: new Date(0) };
    const r = await turno("caro", { model: "claude-opus-4-8" }); // 50 créditos
    expect(r.charged).toBe(false);
    expect(store.lots[0].remaining).toBe(3); // intacto
    expect(store.wallet.graceUsed).toBe(99); // intacta
    expect(store.ledger).toHaveLength(0);
  });

  it("el saldo del lote se usa primero y solo el resto cae a gracia", async () => {
    lote(2);
    await turno("t1", { model: "gpt-4o" }); // pide 12: 2 del lote + 10 de gracia
    expect(store.lots[0].remaining).toBe(0);
    expect(store.wallet.graceUsed).toBe(10);
  });
});

describe("Etapa 1 — vencimiento y FIFO", () => {
  it("un lote VENCIDO no paga: el turno cae a gracia", async () => {
    lote(50, new Date(Date.now() - 86_400_000)); // venció ayer
    const r = await turno("t1");
    expect(r.charged).toBe(true);
    expect(store.lots[0].remaining).toBe(50); // el vencido no se toca
    expect(store.wallet.graceUsed).toBe(1);
  });

  it("consume primero el lote que vence ANTES", async () => {
    lote(5, new Date(Date.now() + 10 * 86_400_000));
    const tarde = store.lots[0].id;
    lote(5, new Date(Date.now() + 86_400_000));
    const pronto = store.lots[1].id;
    await turno("t1");
    expect(store.lots.find((l) => l.id === pronto)!.remaining).toBe(4);
    expect(store.lots.find((l) => l.id === tarde)!.remaining).toBe(5);
  });
});

describe("Etapa 1 — modelo sin peso definido", () => {
  it("se cobra como premium y levanta excepción al super admin", async () => {
    lote(100);
    const r = await turno("t1", { model: "modelo-nuevo-sin-alta" });
    if (r.charged) expect(r.credits).toBe(50);
    expect(store.excepciones).toHaveLength(1);
    expect(store.excepciones[0]).toMatchObject({ type: "modelo_sin_peso_de_credito", dedupeKey: "modelo-nuevo-sin-alta" });
  });

  it("un modelo conocido no molesta a nadie", async () => {
    lote(10);
    await turno("t1");
    expect(store.excepciones).toHaveLength(0);
  });
});

describe("Etapa 1 — la política vive en platform_settings, no en el código", () => {
  it("el dueño cambia el bloque de tokens y el cobro cambia sin desplegar", async () => {
    store.policyRow = { value: JSON.stringify({ tokensPerCredit: 5_000 }) };
    lote(100);
    const r = await turno("t1"); // 9.660 tokens → 2 bloques con el bloque en 5.000
    if (r.charged) expect(r.credits).toBe(2);
  });

  it("el dueño cambia la gracia y el corte se mueve", async () => {
    store.policyRow = { value: JSON.stringify({ graceCredits: 2 }) };
    expect((await readCreditPolicy()).graceCredits).toBe(2);
    await turno("g1");
    await turno("g2");
    const corte = await turno("g3");
    expect(corte.charged).toBe(false);
  });

  it("una fila corrupta no deja de cobrar (cae a la semilla calibrada)", async () => {
    store.policyRow = { value: "{ esto no es json" };
    lote(10);
    const r = await turno("t1");
    expect(r.charged).toBe(true);
    if (r.charged) expect(r.credits).toBe(1);
  });
});

describe("Etapa 1 — verificación antes de gastar tokens", () => {
  it("con saldo, deja pasar", async () => {
    lote(5);
    const g = await aiCreditsGate("o");
    expect(g).toMatchObject({ charges: true, blocked: false });
  });

  it("sin saldo pero con gracia disponible, deja pasar (el bot sigue respondiendo)", async () => {
    store.wallet = { graceUsed: 99, lastNotifiedPct: 0, periodStart: new Date(0) };
    const g = await aiCreditsGate("o");
    expect(g).toMatchObject({ charges: true, blocked: false });
  });

  it("sin saldo y con la gracia agotada, BLOQUEA (frase de respaldo + derivación)", async () => {
    store.wallet = { graceUsed: 100, lastNotifiedPct: 0, periodStart: new Date(0) };
    const g = await aiCreditsGate("o");
    expect(g).toMatchObject({ charges: true, blocked: true });
  });

  it("si la base se cae, FALLA ABIERTO: una caída nuestra no calla el bot del cliente", async () => {
    store.fallarBase = true;
    const g = await aiCreditsGate("o");
    expect(g).toMatchObject({ charges: true, blocked: false });
  });

  it("en un plan que no cobra créditos, el gate no opina", async () => {
    store.planFeatures = { conversationDebitsWallet: true };
    expect(await aiCreditsGate("o")).toEqual({ charges: false });
  });
});

describe("Etapa 1 — TuBot no se toca", () => {
  it("marca tubot con la feature encendida: NO cobra créditos IA", async () => {
    store.brand = "tubot";
    store.planFeatures = { aiCreditsWallet: true, aiCreditsIncluded: 500 };
    expect(await planDebitsAiCredits("o")).toBe(false);
    lote(10);
    const r = await turno("t1");
    expect(r.charged).toBe(false);
    if (!r.charged) expect(r.reason).toBe("no_aplica");
    expect(store.lots[0].remaining).toBe(10);
  });

  it("marca conversia sin la feature: tampoco cobra", async () => {
    store.planFeatures = { conversationDebitsWallet: true, conversationsIncluded: 100 };
    expect(await planDebitsAiCredits("o")).toBe(false);
  });

  it("un plan con las DOS unidades encendidas cobra solo Créditos IA (nunca dos veces)", async () => {
    // Un plan editado a mano en el super admin podría quedar con las dos features. El
    // cliente pagaría la conversación Y cada respuesta. Gana la unidad nueva.
    store.planFeatures = { aiCreditsWallet: true, conversationDebitsWallet: true, aiCreditsIncluded: 100 };
    expect(await planDebitsAiCredits("o")).toBe(true);
    expect(await planDebitsConversation("o")).toBe(false);
  });
});

describe("Etapa 1 — medidor", () => {
  it("informa incluidos, usados, saldo y gracia", async () => {
    store.planFeatures = { aiCreditsWallet: true, aiCreditsIncluded: 100 };
    await turno("t1"); // acredita el período (100) y descuenta 1
    const s = await getAiCreditsSummary("o");
    expect(s).toMatchObject({ unit: "credit", included: 100, used: 1, remaining: 99, graceUsed: 0, graceLimit: 100 });
  });

  it("acredita los créditos del plan en el PRIMER turno del período", async () => {
    store.planFeatures = { aiCreditsWallet: true, aiCreditsIncluded: 100 };
    await turno("t1");
    const delPlan = store.lots.filter((l) => l.source === "plan");
    expect(delPlan).toHaveLength(1);
    expect(delPlan[0].amount).toBe(100);
    // Y no re-acredita en el siguiente turno del mismo período.
    await turno("t2");
    expect(store.lots.filter((l) => l.source === "plan")).toHaveLength(1);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CRE 1 — MOTOR DE CRÉDITOS IA.
 *
 * Esto cobra plata real por cada respuesta del bot, así que los tests van a los lugares
 * donde un error se traduce en cobrarle de más a un cliente, en regalarle el servicio o
 * en dejarlo sin bot: idempotencia del turno, gracia, lotes vencidos, modelo desconocido,
 * y que TuBot no entre por ninguna puerta.
 *
 * La serialización real entre dos turnos simultáneos la da el cerrojo de aviso de Postgres
 * (`pg_advisory_xact_lock`), que un store en memoria no puede reproducir. Acá se verifica
 * que el cerrojo se tome ANTES de mirar los lotes (que es lo que el código tiene que
 * garantizar); que funcione bajo carga de verdad lo prueba el stack de simulación.
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
    // Lo usa el neteo del período (lo que el plan ya dio este mes): se filtra como la
    // consulta real, por refType, razones y el final del sello.
    findMany: async ({ where }: any) =>
      store.ledger.filter(
        (e: any) =>
          e.refType === where.refType &&
          (where.reason?.in ?? []).includes(e.reason) &&
          String(e.refId ?? "").endsWith(where.refId?.endsWith ?? ""),
      ),
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

  it("toma el cerrojo de la org ANTES de mirar los lotes, y uno que no dependa de que exista el monedero", async () => {
    lote(10);
    await turno("t1");
    // Era un `SELECT … FROM conversation_wallets … FOR UPDATE`, y ahí estaba el agujero:
    // si la fila del monedero no existe, ese FOR UPDATE no bloquea NADA y dos turnos
    // simultáneos de una cuenta nueva (o creada por un seed, o migrada) pasaban los dos.
    // El cerrojo de aviso se toma sobre el id de la organización y no necesita filas.
    expect(store.rawCalls[0]).toContain("pg_advisory_xact_lock");
    expect(store.rawCalls[0]).not.toContain("conversation_wallets");
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

  it("un turno CARO que no cabe en el colchón cobra TODO lo cobrable y deja la gracia en el tope", async () => {
    // EL AGUJERO QUE ESTO CIERRA: respuestas gratis para siempre.
    //
    // El gate de antes de responder solo pregunta "¿queda un crédito o colchón?", porque
    // todavía no sabe cuántos tokens va a gastar el turno. Con el consumo todo-o-nada, un
    // turno caro que no cabía NO se cobraba —y la respuesta ya estaba enviada—, dejando el
    // estado IDÉNTICO para el turno siguiente: gate pasa, consumo rechaza, otra respuesta
    // gratis. Indefinidamente, con saldo a la vista y sin un asiento que lo delate. Un
    // cliente con 3 créditos y un agente Sonnet tenía respuestas ilimitadas gratis.
    //
    // Ahora se cobra `min(pedido, lotes + colchón)`: la gracia aterriza EXACTAMENTE en el
    // tope y por eso el gate del turno siguiente sí corta.
    lote(3);
    store.wallet = { graceUsed: 99, lastNotifiedPct: 0, periodStart: new Date(0) };
    const r = await turno("caro", { model: "claude-opus-4-8" }); // pide 50
    expect(r.charged).toBe(true);
    // 3 del lote + 1 de colchón (99 → 100) = 4 de los 50 que pedía.
    if (r.charged) expect(r.credits).toBe(4);
    expect(store.lots[0].remaining).toBe(0);
    expect(store.wallet.graceUsed).toBe(100);
    // Un solo asiento, por lo CONSUMIDO: cobrar 50 habría dicho que salió plata que no salió.
    expect(store.ledger).toHaveLength(1);
    expect(store.ledger[0].delta).toBe(-4);
    // El consumo deja constancia de lo que pedía la fórmula y de que el colchón topeó, para
    // que la auditoría no lo confunda con un cobro mal hecho.
    expect(store.usage[0].meta.pedido).toBe(50);
    expect(store.usage[0].meta.alTope).toBe(true);
    expect(store.usage[0].quantity).toBe(4);
    // Y el super admin se entera AHORA, no cuando el cliente llame.
    expect(store.excepciones.some((e) => e.type === "saldo_gracia_sin_recarga")).toBe(true);
  });

  it("y con el colchón ya en el tope el gate corta: no hay turno siguiente gratis", async () => {
    // La otra mitad del agujero: que después de topear, el gate de verdad bloquee.
    store.wallet = { graceUsed: 100, lastNotifiedPct: 0, periodStart: new Date(0) };
    const g = await aiCreditsGate("o");
    expect(g.charges).toBe(true);
    if (g.charges) expect(g.blocked).toBe(true);
  });

  it("el turno que entra justo en el colchón se cobra COMPLETO (no se topea de más)", async () => {
    lote(0);
    store.wallet = { graceUsed: 60, lastNotifiedPct: 0, periodStart: new Date(0) };
    const r = await turno("justo", { model: "claude-haiku-4-5", inputTokens: 1_000, outputTokens: 0 }); // pide 4
    expect(r.charged).toBe(true);
    if (r.charged) expect(r.credits).toBe(4);
    expect(store.wallet.graceUsed).toBe(64);
    expect(store.usage[0].meta.alTope).toBe(false);
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

describe("§6 — el respaldo del modelo no lo paga el cliente", () => {
  it("configurado mini y respondió Haiku: se cobra 1, no 4", async () => {
    // El caso real del 24 al 29 de octubre: cinco días con la clave de OpenAI revocada y los
    // bots respondiendo con Haiku. Cobrando por el que respondió, a cada cliente con
    // gpt-4o-mini se le cobraba CUATRO veces más por una caída NUESTRA.
    lote(100);
    const r = await turno("t1", { model: "claude-haiku-4-5", configuredModel: "gpt-4o-mini" });
    if (r.charged) expect(r.credits).toBe(1);
    expect(store.lots[0].remaining).toBe(99);
  });

  it("deja en el consumo los DOS modelos y la marca de respaldo", async () => {
    // Sin esto, un turno cobrado con peso 1 mientras `ai_requests` dice que respondió Haiku
    // se lee como un cobro de menos: la auditoría necesita saber que fue a propósito.
    lote(100);
    await turno("t1", { model: "claude-haiku-4-5", configuredModel: "gpt-4o-mini" });
    expect(store.usage.find((e) => e.type === "ai_credits").meta).toMatchObject({
      configuredModel: "gpt-4o-mini",
      respondedModel: "claude-haiku-4-5",
      fallback: true,
      weight: 1,
    });
  });

  it("sin respaldo (configurado = respondió) se cobra lo de siempre y no se marca nada", async () => {
    lote(100);
    const r = await turno("t1", { model: "claude-haiku-4-5", configuredModel: "claude-haiku-4-5" });
    if (r.charged) expect(r.credits).toBe(4);
    expect(store.usage.find((e) => e.type === "ai_credits").meta).toMatchObject({ fallback: false, weight: 4 });
  });

  it("un turno viejo sin modelo configurado se cobra con el que respondió", async () => {
    lote(100);
    const r = await turno("t1", { model: "claude-haiku-4-5", configuredModel: null });
    if (r.charged) expect(r.credits).toBe(4);
  });

  it("si respondió un modelo DESCONOCIDO sigue siendo premium (y con alerta)", async () => {
    lote(100);
    const r = await turno("t1", { model: "modelo-raro-v9", configuredModel: "gpt-4o-mini" });
    if (r.charged) expect(r.credits).toBe(50);
    expect(store.excepciones.map((e) => e.type)).toContain("modelo_sin_peso_de_credito");
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

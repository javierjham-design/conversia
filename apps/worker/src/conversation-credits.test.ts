import { beforeEach, describe, expect, it, vi } from "vitest";

// Store en memoria que simula las 3 tablas de la bolsa de conversaciones + el plan.
const store = {
  lots: [] as any[],
  wallet: null as any,
  ledger: [] as any[],
  planFeatures: { conversationDebitsWallet: true, aiPlus: false, conversationsIncluded: 100 } as Record<string, unknown>,
  seq: 0,
};

function matchLot(l: any, where: any, now = new Date()) {
  if (where.remaining?.gt !== undefined && !(l.remaining > where.remaining.gt)) return false;
  if (where.OR) {
    const ok = where.OR.some((c: any) => (c.expiresAt === null && l.expiresAt == null) || (c.expiresAt?.gt && l.expiresAt && l.expiresAt > c.expiresAt.gt));
    if (!ok) return false;
  }
  if (where.expiresAt?.gt && !(l.expiresAt && l.expiresAt > where.expiresAt.gt)) return false;
  if (where.expiresAt?.lt && !(l.expiresAt && l.expiresAt < where.expiresAt.lt)) return false;
  return true;
}

const tx = {
  $executeRaw: async () => 0,
  conversationCreditLot: {
    aggregate: async ({ where }: any) => ({ _sum: { remaining: store.lots.filter((l) => matchLot(l, where)).reduce((a, l) => a + l.remaining, 0) } }),
    findMany: async ({ where, orderBy }: any) => {
      let rows = store.lots.filter((l) => matchLot(l, where));
      // FIFO por expiración asc (null al final), luego createdAt asc
      rows = rows.slice().sort((a, b) => {
        const ax = a.expiresAt ? a.expiresAt.getTime() : Infinity;
        const bx = b.expiresAt ? b.expiresAt.getTime() : Infinity;
        return ax - bx || a.createdAt - b.createdAt;
      });
      void orderBy;
      return rows;
    },
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
      if (!store.wallet) store.wallet = { graceUsed: 0, lastNotifiedPct: 0, periodStart: new Date(), ...create };
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
    findFirst: async ({ where }: any) => store.ledger.find((e) => e.refId === where.refId && e.reason === where.reason) ?? null,
  },
};

vi.mock("@conversia/database", () => ({
  withTenant: async (_org: string, fn: any) => fn(tx),
  getAdminPrisma: () => ({
    subscription: { findFirst: async () => ({ planId: "p1", periodStart: new Date() }) },
    plan: { findUnique: async () => ({ features: store.planFeatures }) },
    conversationCreditLot: { findMany: async () => [] },
  }),
}));

import { debitConversation, creditPurchasedConversations, GRACE_LIMIT } from "./conversation-credits";

beforeEach(() => {
  store.lots = [];
  store.wallet = null;
  store.ledger = [];
  store.planFeatures = { conversationDebitsWallet: true, aiPlus: false, conversationsIncluded: 100 };
  store.seq = 0;
});

describe("V2-1 — débito de crédito-conversación", () => {
  it("debita 1 crédito de un lote vigente", async () => {
    // included=0 para aislar el consumo del lote (la acreditación del plan se prueba aparte).
    store.planFeatures = { conversationDebitsWallet: true, aiPlus: false, conversationsIncluded: 0 };
    store.lots.push({ id: "A", organizationId: "o", source: "plan", amount: 10, remaining: 10, expiresAt: new Date(Date.now() + 86400000), createdAt: 1 });
    const r = await debitConversation("o", { conversationId: "c1" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.balanceAfter).toBe(9);
    expect(store.lots.find((l) => l.id === "A")!.remaining).toBe(9);
  });

  it("FIFO: consume primero el lote que expira ANTES", async () => {
    const soon = new Date(Date.now() + 86400000);
    const later = new Date(Date.now() + 10 * 86400000);
    store.lots.push({ id: "late", organizationId: "o", source: "purchase", amount: 5, remaining: 5, expiresAt: later, createdAt: 1 });
    store.lots.push({ id: "soon", organizationId: "o", source: "plan", amount: 5, remaining: 5, expiresAt: soon, createdAt: 2 });
    await debitConversation("o", { conversationId: "c1" });
    expect(store.lots.find((l) => l.id === "soon")!.remaining).toBe(4);
    expect(store.lots.find((l) => l.id === "late")!.remaining).toBe(5);
  });

  it("Asistente Plus (aiPlus) debita x2", async () => {
    store.planFeatures = { conversationDebitsWallet: true, aiPlus: true, conversationsIncluded: 100 };
    store.lots.push({ id: "A", organizationId: "o", source: "plan", amount: 10, remaining: 10, expiresAt: new Date(Date.now() + 86400000), createdAt: 1 });
    const r = await debitConversation("o", { conversationId: "c1", multiplier: 2 });
    expect(r.ok).toBe(true);
    expect(store.lots[0].remaining).toBe(8);
  });

  it("FIX sim-2026-10-16: el PRIMER débito acredita el período del plan (lote de 100) antes de debitar", async () => {
    // Bug cazado en la simulación: la wallet nacía con periodStart=now y el primer
    // período jamás acreditaba → todo caía a gracia. Ahora: sin lotes previos, el
    // primer débito debe crear el lote del plan (included=100) y debitar de AHÍ.
    const r = await debitConversation("o", { conversationId: "c-first" });
    expect(r.ok).toBe(true);
    const planLots = store.lots.filter((l) => l.source === "plan");
    expect(planLots).toHaveLength(1);
    expect(planLots[0].amount).toBe(100);
    expect(planLots[0].remaining).toBe(99);
    expect(store.wallet.graceUsed ?? 0).toBe(0); // nada de gracia en el camino feliz
    // Idempotencia del período: un segundo débito NO re-acredita otro lote.
    await debitConversation("o", { conversationId: "c-second" });
    expect(store.lots.filter((l) => l.source === "plan")).toHaveLength(1);
    expect(planLots[0].remaining).toBe(98);
  });

  it("gracia: sin lotes NI créditos de plan (trial included=0), debita en negativo hasta el límite y luego BLOQUEA", async () => {
    // El plan de prueba V2 incluye 0 → la acreditación del período no crea lote y el
    // flujo cae a gracia (sus 30 de regalo llegan por lote bonus aparte, no por plan).
    store.planFeatures = { conversationDebitsWallet: true, aiPlus: false, conversationsIncluded: 0 };
    for (let i = 0; i < GRACE_LIMIT; i++) {
      const r = await debitConversation("o", { conversationId: `c${i}` });
      expect(r.ok).toBe(true);
    }
    expect(store.wallet.graceUsed).toBe(GRACE_LIMIT);
    const blocked = await debitConversation("o", { conversationId: "cX" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.blocked).toBe(true);
    // No incrementó la gracia más allá del límite.
    expect(store.wallet.graceUsed).toBe(GRACE_LIMIT);
  });

  it("compra de pack: crea lote y es idempotente por pago", async () => {
    await creditPurchasedConversations("o", 400, { refType: "package", refId: "pay1" });
    await creditPurchasedConversations("o", 400, { refType: "package", refId: "pay1" }); // repetido
    const purchaseLots = store.lots.filter((l) => l.source === "purchase");
    expect(purchaseLots).toHaveLength(1);
    expect(purchaseLots[0].remaining).toBe(400);
    // Expira ~12 meses después (muy por encima de 300 días).
    expect(purchaseLots[0].expiresAt.getTime()).toBeGreaterThan(Date.now() + 300 * 86400000);
  });

  it("la compra paga primero la gracia pendiente", async () => {
    // Genera 3 de gracia (trial: included=0), luego compra 10 → paga 3 y deja lote de 7.
    store.planFeatures = { conversationDebitsWallet: true, aiPlus: false, conversationsIncluded: 0 };
    for (let i = 0; i < 3; i++) await debitConversation("o", { conversationId: `g${i}` });
    expect(store.wallet.graceUsed).toBe(3);
    await creditPurchasedConversations("o", 10, { refType: "package", refId: "pay2" });
    expect(store.wallet.graceUsed).toBe(0);
    expect(store.lots.find((l) => l.source === "purchase")!.remaining).toBe(7);
  });
});

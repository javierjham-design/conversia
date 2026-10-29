import { beforeEach, describe, expect, it, vi } from "vitest";

// Store en memoria que simula las 3 tablas de la bolsa de conversaciones + el plan.
const store = {
  lots: [] as any[],
  wallet: null as any,
  ledger: [] as any[],
  planFeatures: { conversationDebitsWallet: true, aiPlus: false, conversationsIncluded: 100 } as Record<string, unknown>,
  planId: "p1", // conmutable: simula upgrade de plan dentro del mismo período
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
    subscription: { findFirst: async () => ({ planId: store.planId, periodStart: new Date() }) },
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
  store.planId = "p1";
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

  it("FIX sim-2026-10-17: UPGRADE dentro del mismo período (trial→base el mismo día) acredita el plan nuevo", async () => {
    // Funnel normal: nace trial (included 0), conversa (gracia), paga base el MISMO día.
    // Antes: la wallet ya había "visto" el período con el trial y el lote de 100 jamás
    // se creaba (el cliente pagaba y quedaba bloqueado al agotar la gracia). Ahora la
    // acreditación es idempotente por (plan, período) vía ledger.
    store.planFeatures = { conversationDebitsWallet: true, aiPlus: false, conversationsIncluded: 0 };
    store.planId = "plan_trial";
    for (let i = 0; i < 3; i++) await debitConversation("o", { conversationId: `t${i}` });
    expect(store.wallet.graceUsed).toBe(3);
    expect(store.lots.filter((l) => l.source === "plan")).toHaveLength(0);
    // Upgrade: ahora el plan vigente es base (100 incluidas), mismo período.
    store.planFeatures = { conversationDebitsWallet: true, aiPlus: false, conversationsIncluded: 100 };
    store.planId = "plan_base";
    const r = await debitConversation("o", { conversationId: "post-upgrade" });
    expect(r.ok).toBe(true);
    const planLots = store.lots.filter((l) => l.source === "plan");
    expect(planLots).toHaveLength(1);
    // 100 acreditadas: 3 pagan la gracia pendiente → lote de 97; el débito deja 96.
    expect(store.wallet.graceUsed).toBe(0);
    expect(planLots[0].remaining).toBe(96);
    // Reintento (otro débito, mismo plan y período): NO re-acredita otro lote.
    await debitConversation("o", { conversationId: "post-upgrade-2" });
    expect(store.lots.filter((l) => l.source === "plan")).toHaveLength(1);
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

  it("y el LIBRO sigue explicando el saldo (la suma de asientos = saldo)", async () => {
    // LA INVARIANTE QUE ESTO PROTEGE: sumar todos los asientos tiene que dar el saldo. Si
    // no, hay un camino que mueve créditos sin anotarlos, y ese es por donde se va la plata
    // sin que nadie lo vea.
    //
    // Estaba roto justo acá: al pagar gracia se anotaba `grace_repay +pay` Y ADEMÁS el
    // monto BRUTO de la acreditación, así que el libro sumaba `amount + pay` para un
    // movimiento real de `amount`. Pasaba en cada renovación de un cliente que terminó el
    // mes en gracia —el fin de saldo normal— y ponía en rojo la auditoría por un descuadre
    // que no era una fuga. Ahora el asiento va por lo que entró al lote.
    store.planFeatures = { conversationDebitsWallet: true, aiPlus: false, conversationsIncluded: 0 };
    for (let i = 0; i < 3; i++) await debitConversation("o", { conversationId: `g${i}` });
    await creditPurchasedConversations("o", 10, { refType: "package", refId: "pay3" });

    const sumaLibro = store.ledger.reduce((a: number, l: any) => a + l.delta, 0);
    const lotes = store.lots.reduce((a: number, l: any) => a + l.remaining, 0);
    const saldo = lotes - store.wallet.graceUsed;
    expect(saldo).toBe(7);
    expect(sumaLibro).toBe(saldo);
    // Y las dos filas juntas siguen contando la historia completa de la compra de 10.
    const repago = store.ledger.find((l: any) => l.reason === "grace_repay");
    const compra = store.ledger.find((l: any) => l.reason === "package_purchase");
    expect(repago.delta).toBe(3);
    expect(compra.delta).toBe(7);
    expect(repago.delta + compra.delta).toBe(10);
  });

  it("si la acreditación se va ENTERA a pagar la deuda, el asiento sello se escribe igual", async () => {
    // El asiento de la acreditación no es solo contabilidad: es el sello de idempotencia
    // del período. Si se omitiera por tener delta 0, cada turno volvería a acreditar el
    // plan completo — un plan regalado por respuesta.
    store.planFeatures = { conversationDebitsWallet: true, aiPlus: false, conversationsIncluded: 0 };
    for (let i = 0; i < 5; i++) await debitConversation("o", { conversationId: `d${i}` });
    await creditPurchasedConversations("o", 5, { refType: "package", refId: "pay4" });
    const compra = store.ledger.filter((l: any) => l.reason === "package_purchase");
    expect(compra).toHaveLength(1);
    expect(compra[0].delta).toBe(0);
    expect(store.wallet.graceUsed).toBe(0);
    const sumaLibro = store.ledger.reduce((a: number, l: any) => a + l.delta, 0);
    expect(sumaLibro).toBe(0); // 5 débitos, 5 de repago, 0 de lote
  });
});

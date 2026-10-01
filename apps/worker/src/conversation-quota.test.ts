import { beforeEach, describe, expect, it, vi } from "vitest";

// Estado del mock de BD para countConversationOnce.
const state = {
  included: 100,
  subPeriodStart: null as Date | null,
  markExists: false,
  counterUsed: 0,
  insertThrows: false,
  created: [] as any[],
  usageEvents: [] as any[],
};

const prismaMock = {
  subscription: {
    findFirst: async () => ({ planId: "p1", periodStart: state.subPeriodStart }),
  },
  plan: {
    findUnique: async () => ({ features: { conversationsPerPeriod: state.included } }),
  },
  conversationQuotaMark: {
    findUnique: async () => (state.markExists ? { id: "m" } : null),
    create: async ({ data }: any) => {
      if (state.insertThrows) throw new Error("unique violation");
      state.markExists = true;
      state.created.push(data);
      return data;
    },
  },
  conversationQuotaCounter: {
    findUnique: async () => ({ used: state.counterUsed }),
  },
  $queryRaw: async () => [{ used: state.counterUsed + 1 }],
};

vi.mock("@conversia/database", () => ({
  getAdminPrisma: () => prismaMock,
  withTenant: async (_org: string, fn: (tx: any) => Promise<any>) =>
    fn({ usageEvent: { create: async ({ data }: any) => state.usageEvents.push(data) } }),
}));

import { resolvePeriodStart, countConversationOnce } from "./conversation-quota";

beforeEach(() => {
  state.included = 100;
  state.subPeriodStart = null;
  state.markExists = false;
  state.counterUsed = 0;
  state.insertThrows = false;
  state.created = [];
  state.usageEvents = [];
});

describe("resolvePeriodStart (puro, UTC)", () => {
  it("usa el día del periodStart de la suscripción", () => {
    const r = resolvePeriodStart(new Date("2026-09-15T10:30:00Z"), new Date("2026-10-20T00:00:00Z"));
    expect(r.toISOString().slice(0, 10)).toBe("2026-09-15");
  });

  it("sin suscripción → día 1 del mes calendario UTC de now", () => {
    const r = resolvePeriodStart(null, new Date("2026-10-20T23:00:00Z"));
    expect(r.toISOString().slice(0, 10)).toBe("2026-10-01");
  });

  it("ancla a medianoche UTC (sin hora)", () => {
    const r = resolvePeriodStart(new Date("2026-09-15T23:59:59Z"), new Date("2026-10-01T00:00:00Z"));
    expect(r.toISOString()).toBe("2026-09-15T00:00:00.000Z");
  });
});

describe("countConversationOnce (idempotente, atómico)", () => {
  const now = new Date("2026-10-10T12:00:00Z");

  it("cuenta la conversación la primera vez del período", async () => {
    const r = await countConversationOnce("org1", "conv1", now);
    expect(r.counted).toBe(true);
    expect(r.used).toBe(1);
    expect(r.included).toBe(100);
    expect(state.created).toHaveLength(1);
    expect(state.usageEvents).toHaveLength(1);
    expect(state.usageEvents[0].type).toBe("conversation");
  });

  it("no vuelve a contar si la marca ya existe (misma conversación, mismo período)", async () => {
    state.markExists = true;
    state.counterUsed = 1;
    const r = await countConversationOnce("org1", "conv1", now);
    expect(r.counted).toBe(false);
    expect(state.created).toHaveLength(0);
    expect(state.usageEvents).toHaveLength(0);
  });

  it("concurrencia: si el INSERT choca con el UNIQUE, no cuenta dos veces", async () => {
    state.insertThrows = true;
    const r = await countConversationOnce("org1", "conv1", now);
    expect(r.counted).toBe(false);
    expect(state.usageEvents).toHaveLength(0);
  });

  it("tope duro con cupo lleno → no cuenta una conversación nueva (blockedByHardCap)", async () => {
    state.counterUsed = 100; // ya alcanzó included
    const r = await countConversationOnce("org1", "conv-nueva", now, { hardCap: true });
    expect(r.blockedByHardCap).toBe(true);
    expect(r.counted).toBe(false);
    expect(state.created).toHaveLength(0); // no insertó la marca
  });

  it("cupo 0 (sin cupo) → cuenta igual (solo medición), sin bloqueo", async () => {
    state.included = 0;
    const r = await countConversationOnce("org1", "conv1", now, { hardCap: true });
    expect(r.counted).toBe(true);
    expect(r.included).toBe(0);
    expect(r.overagePct).toBe(0);
  });
});

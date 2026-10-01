import { beforeEach, describe, expect, it, vi } from "vitest";

// Estado del mock de prisma para probar la idempotencia del reembolso (W-2).
const state = {
  debit: null as unknown, // asiento send_debit previo (lo que se devolvería)
  refundExisting: null as unknown, // asiento refund ya hecho (anti-doble)
  refunds: [] as any[], // reembolsos creados
};

const prismaMock = {
  walletLedger: {
    findFirst: async ({ where }: any) => {
      if (where.reason === "send_debit") return state.debit;
      if (where.reason === "refund") return state.refundExisting;
      return null;
    },
    create: async ({ data }: any) => {
      state.refunds.push(data);
      return data;
    },
  },
  $queryRaw: async () => [{ balance: 501 }],
};

vi.mock("@conversia/database", () => ({ getAdminPrisma: () => prismaMock }));
vi.mock("ioredis", () => ({ default: class {} }));
vi.mock("./notifications/queue", () => ({ enqueueNotification: async () => undefined }));

import { refundForMessage } from "./wallet";

beforeEach(() => {
  state.debit = null;
  state.refundExisting = null;
  state.refunds = [];
});

describe("refundForMessage (W-2, idempotente)", () => {
  it("fallo terminal de una plantilla cobrada → devuelve una vez", async () => {
    state.debit = { delta: -1 };
    await refundForMessage("org1", "m1");
    expect(state.refunds).toHaveLength(1);
    expect(state.refunds[0].delta).toBe(1);
    expect(state.refunds[0].reason).toBe("refund");
    expect(state.refunds[0].refId).toBe("m1");
  });

  it("doble fallo del mismo mensaje → devuelve UNA sola vez (anti-doble-refund)", async () => {
    state.debit = { delta: -1 };
    state.refundExisting = { id: "ya" }; // ya se devolvió antes
    await refundForMessage("org1", "m1");
    expect(state.refunds).toHaveLength(0);
  });

  it("sin débito previo (nada que devolver) → no crea reembolso", async () => {
    state.debit = null;
    await refundForMessage("org1", "m1");
    expect(state.refunds).toHaveLength(0);
  });
});

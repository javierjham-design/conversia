import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Estado mutable del mock (referenciado dentro de los factories, patrón contact-import).
const state = {
  incr: 1, // valor que devuelve el contador Redis del free tier
  ledgerExisting: null as unknown, // para la idempotencia (findFirst previo)
  created: [] as any[], // asientos creados
  freeTierLimitRow: null as unknown, // platform_settings serviceFreeTierPerNumber
};

const prismaMock = {
  walletLedger: {
    findFirst: async () => state.ledgerExisting,
    create: async ({ data }: any) => {
      state.created.push(data);
      return data;
    },
  },
  messageWallet: { findUnique: async () => ({ balance: 500 }) },
  platformSetting: {
    findUnique: async ({ where }: any) => (where.key === "serviceFreeTierPerNumber" ? state.freeTierLimitRow : null),
  },
};

vi.mock("@conversia/database", () => ({
  getAdminPrisma: () => prismaMock,
}));

vi.mock("ioredis", () => ({
  default: class {
    async incr() {
      return state.incr;
    }
    async expire() {
      return 1;
    }
  },
}));

vi.mock("./phone-geo", () => ({ geoFromPhone: () => ({ country: "CL" }) }));

vi.mock("./cost-settings", () => ({
  getWhatsappRatesOverride: async () => ({}),
  getWhatsappRateSchedule: async () => ({
    CL: { service: [{ effectiveFrom: "2026-10-01T00:00:00Z", rateUsd: 0.02 }] },
  }),
}));

vi.mock("./notifications/queue", () => ({ enqueueNotification: async () => undefined }));

import { recordServiceSend } from "./service-metering";
import { normalizeCategory } from "./wallet";

beforeEach(() => {
  state.incr = 1;
  state.ledgerExisting = null;
  state.created = [];
  state.freeTierLimitRow = null; // → default 1000
});

afterEach(() => {
  vi.useRealTimers();
});

describe("normalizeCategory (contrato explícito, sin disfraz)", () => {
  it("mapea las 4 categorías conocidas", () => {
    expect(normalizeCategory("UTILITY")).toBe("utility");
    expect(normalizeCategory("utility")).toBe("utility");
    expect(normalizeCategory("MARKETING")).toBe("marketing");
    expect(normalizeCategory("marketing_lite")).toBe("marketing");
    expect(normalizeCategory("AUTHENTICATION")).toBe("authentication");
    expect(normalizeCategory("authentication_international")).toBe("authentication");
    expect(normalizeCategory("SERVICE")).toBe("service");
  });

  it("una categoría desconocida NO se disfraza de utility — devuelve { unknown }", () => {
    expect(normalizeCategory("referral")).toEqual({ unknown: "referral" });
    expect(normalizeCategory("")).toEqual({ unknown: "" });
    expect(normalizeCategory(null)).toEqual({ unknown: "" });
  });
});

describe("recordServiceSend (medición, delta 0, idempotente, free tier)", () => {
  it("bajo el free tier → asiento con costo 0, delta 0 y categoría service", async () => {
    state.incr = 1; // 1er mensaje del mes para el número
    await recordServiceSend("org1", "m1", "conv1", "56912345678", "pn1");
    expect(state.created).toHaveLength(1);
    const asiento = state.created[0];
    expect(asiento.delta).toBe(0);
    expect(asiento.reason).toBe("service_send");
    expect(asiento.category).toBe("service");
    expect(asiento.costUsd).toBe(0);
    expect(asiento.refType).toBe("message");
    expect(asiento.refId).toBe("m1");
  });

  it("sobre el free tier, antes del 1-oct (at=2026-09-30) → costo 0 (el schedule aún no rige)", async () => {
    state.incr = 1001; // supera el default 1000
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T23:59:59Z"));
    await recordServiceSend("org1", "m2", "conv1", "56912345678", "pn1");
    expect(state.created[0].costUsd).toBe(0);
  });

  it("sobre el free tier, desde el 1-oct (at=2026-10-01T00:00:00Z) → costo 0.02 del schedule", async () => {
    state.incr = 1001;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    await recordServiceSend("org1", "m3", "conv1", "56912345678", "pn1");
    expect(state.created[0].costUsd).toBe(0.02);
  });

  it("idempotente por messageId: un segundo llamado con el mismo mensaje no escribe otra vez", async () => {
    state.ledgerExisting = { id: "ya" }; // findFirst encuentra el asiento previo
    await recordServiceSend("org1", "m1", "conv1", "56912345678", "pn1");
    expect(state.created).toHaveLength(0);
  });
});

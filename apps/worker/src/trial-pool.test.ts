import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  enabled: false,
  poolNumbers: [] as any[],
  sessions: [] as any[],
  redis: {} as Record<string, string>,
};

vi.mock("ioredis", () => ({
  default: class {
    async get(k: string) { return state.redis[k] ?? null; }
    async set(k: string, v: string) { state.redis[k] = v; return "OK"; }
  },
}));
vi.mock("@conversia/config", () => ({ getEnv: () => ({ REDIS_URL: "redis://x" }) }));
vi.mock("@conversia/database", () => ({
  getAdminPrisma: () => ({
    platformSetting: { findUnique: async () => ({ value: JSON.stringify({ enabled: state.enabled }) }) },
    trialPoolNumber: { findUnique: async ({ where }: any) => state.poolNumbers.find((n) => n.phoneNumberId === where.phoneNumberId) ?? null },
    trialSession: {
      findUnique: async ({ where }: any) => state.sessions.find((s) => s.phoneNumberId === where.phoneNumberId_contactPhone.phoneNumberId && s.contactPhone === where.phoneNumberId_contactPhone.contactPhone) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const ex = state.sessions.find((s) => s.phoneNumberId === where.phoneNumberId_contactPhone.phoneNumberId && s.contactPhone === where.phoneNumberId_contactPhone.contactPhone);
        if (ex) { Object.assign(ex, update); return ex; }
        const row = { phoneNumberId: where.phoneNumberId_contactPhone.phoneNumberId, contactPhone: where.phoneNumberId_contactPhone.contactPhone, ...create };
        state.sessions.push(row);
        return row;
      },
    },
  }),
}));

import { extractTrialCode, resolveTrialRouting } from "./trial-pool";

beforeEach(() => {
  state.enabled = false;
  state.poolNumbers = [];
  state.sessions = [];
  state.redis = {};
});

describe("V2-4 — extractTrialCode", () => {
  it("extrae el código en cualquier caja", () => {
    expect(extractTrialCode("Hola CV-PRUEBA-AB12 quiero probar")).toBe("CV-PRUEBA-AB12");
    expect(extractTrialCode("cv-prueba-xyz9")).toBe("CV-PRUEBA-XYZ9");
    expect(extractTrialCode("sin codigo")).toBeNull();
    expect(extractTrialCode(null)).toBeNull();
  });
});

describe("V2-4 — resolveTrialRouting", () => {
  it("número que NO es del pool → pool:false (flujo normal)", async () => {
    const r = await resolveTrialRouting("pn-normal", "569111", "hola");
    expect(r).toEqual({ pool: false });
  });

  it("pool APAGADO → disabled (P1: no afecta prod)", async () => {
    state.poolNumbers = [{ phoneNumberId: "pn-pool", active: true }];
    state.enabled = false;
    const r = await resolveTrialRouting("pn-pool", "569111", "CV-PRUEBA-AB12");
    expect(r).toEqual({ pool: true, disabled: true });
  });

  it("con código válido → vincula y enruta", async () => {
    state.poolNumbers = [{ phoneNumberId: "pn-pool", active: true }];
    state.enabled = true;
    state.redis["trialcode:CV-PRUEBA-AB12"] = "org-1";
    const r = await resolveTrialRouting("pn-pool", "569111", "CV-PRUEBA-AB12");
    expect(r).toEqual({ pool: true, orgId: "org-1", linked: true });
    expect(state.sessions).toHaveLength(1);
  });

  it("ya vinculado y vigente → enruta sin código", async () => {
    state.poolNumbers = [{ phoneNumberId: "pn-pool", active: true }];
    state.enabled = true;
    state.sessions = [{ phoneNumberId: "pn-pool", contactPhone: "569111", orgIdRef: "org-2", expiresAt: new Date(Date.now() + 86400000) }];
    const r = await resolveTrialRouting("pn-pool", "569111", "hola de nuevo");
    expect(r).toEqual({ pool: true, orgId: "org-2", linked: false });
  });

  it("sin vínculo ni código → pide el código", async () => {
    state.poolNumbers = [{ phoneNumberId: "pn-pool", active: true }];
    state.enabled = true;
    const r = await resolveTrialRouting("pn-pool", "569999", "hola");
    expect(r).toEqual({ pool: true, needsCode: true });
  });
});

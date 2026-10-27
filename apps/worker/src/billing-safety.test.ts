import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * ETAPA 4 — Dinero. Los dos fallos que podían costar plata de verdad:
 *  §9.1 el proveedor FALSO dando cobros por exitosos sin cobrar (en producción).
 *  §9.5 el débito de bolsa fallando ABIERTO (plantillas gratis ante un error de BD).
 */

const platformSettings: Array<{ key: string; value: string }> = [];
const org = { settings: {} as Record<string, unknown>, currency: "CLP" };

vi.mock("@conversia/database", () => ({
  getAdminPrisma: () => ({
    platformSetting: { findMany: async () => platformSettings },
    organization: { findUnique: async () => org },
  }),
  withTenant: async (_o: string, fn: any) => fn({}),
  raiseException: async () => undefined,
}));
// Las rutas de vi.mock se resuelven desde ESTE archivo (apps/worker/src/), no desde el
// módulo que las importa: `../credentials` de subscription-billing/ es `./credentials` acá.
vi.mock("./credentials", () => ({ decryptCredential: (v: string) => v.replace("enc:", "") }));

// opsAlert es best-effort y hace fetch; lo silenciamos y registramos las llamadas.
const alertas: Array<{ summary: string }> = [];
vi.mock("./ops-alert.js", () => ({
  opsAlert: async (i: { summary: string }) => {
    alertas.push(i);
  },
}));

import { resolveSubscriptionProvider } from "./subscription-billing/resolve-provider";
import { FakeSubscriptionProvider } from "./subscription-billing/provider";
import { FlowSubscriptionProvider } from "./subscription-billing/flow-provider";

const conCredencialesFlow = () => {
  platformSettings.length = 0;
  platformSettings.push(
    { key: "flow.apiKey", value: "enc:api" },
    { key: "flow.secretKey", value: "enc:secret" },
    { key: "flow.baseUrl", value: "https://flow.test" },
  );
};
const sinCredenciales = () => {
  platformSettings.length = 0;
};

describe("§9.1 el proveedor FALSO nunca cobra en producción", () => {
  beforeEach(() => {
    alertas.length = 0;
    delete process.env.ALLOW_FAKE_BILLING_PROVIDER;
    process.env.FLOW_API_KEY = "";
    process.env.FLOW_SECRET_KEY = "";
  });

  it("con credenciales de Flow usa Flow (camino normal)", async () => {
    conCredencialesFlow();
    const p = await resolveSubscriptionProvider("org-1");
    expect(p).toBeInstanceOf(FlowSubscriptionProvider);
  });

  it("SIN credenciales NO cae al falso: lanza y alerta (el tick se omite)", async () => {
    sinCredenciales();
    await expect(resolveSubscriptionProvider("org-1")).rejects.toThrow(/Cobro recurrente DETENIDO/i);
    expect(alertas.some((a) => /sin credenciales de Flow/i.test(a.summary))).toBe(true);
  });

  it("el falso solo se permite con el interruptor explícito fuera de producción", async () => {
    sinCredenciales();
    process.env.ALLOW_FAKE_BILLING_PROVIDER = "true";
    // El entorno de test NO es production, así que acá sí puede devolver el falso.
    const p = await resolveSubscriptionProvider("org-1");
    expect(p).toBeInstanceOf(FakeSubscriptionProvider);
  });
});

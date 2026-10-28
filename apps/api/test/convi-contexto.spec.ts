import { describe, it, expect, vi } from "vitest";

/**
 * COP 2 — lo que el servidor tiene que darle a Convi para que sea un copiloto y no una
 * burbuja: cuánto falta en minutos, el saldo CON SU NÚMERO (para avisar de saldo bajo sin
 * parsear texto) y las citas por confirmar.
 *
 * El bloque del saldo es además una regresión: CRE 2 cambió la unidad de cobro y la
 * condición quedó mirando solo `conversationDebitsWallet`, así que un cliente con plan de
 * Créditos IA veía el saldo EN BLANCO en el copiloto — justo el cliente al que el saldo le
 * importa más, porque se le gasta por respuesta del bot.
 */

vi.mock("@conversia/agents", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createAIProvider: () => ({ chat: async () => ({ stopReason: "end", text: "ok", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } }) }),
}));

import { AssistantService } from "../src/assistant/assistant.service";
import { EMPTY_SETUP_FACTS, buildSetupSteps, summarizeSetupChecklist } from "../src/onboarding/setup-checklist";

/** Prisma falso con lo justo que `buildContext` consulta. */
function prismaCon(opts: { features?: Record<string, unknown>; lotes?: number; graceUsed?: number; citas?: number }) {
  const admin = {
    organization: { findUnique: async () => ({ name: "Barbería Central", settings: {}, currency: "CLP" }) },
    subscription: { findFirst: async () => (opts.features ? { planId: "plan-1" } : null) },
    plan: { findUnique: async () => ({ features: opts.features ?? {} }) },
    conversationCreditLot: { aggregate: async () => ({ _sum: { remaining: opts.lotes ?? 0 } }) },
    conversationWallet: { findUnique: async () => ({ graceUsed: opts.graceUsed ?? 0 }) },
    integrationEvent: { findFirst: async () => null },
    appointment: { count: async () => opts.citas ?? 0 },
    // Lo que consulta el checklist; todo en su valor neutro.
    service: { count: async () => 0 },
    professional: { findMany: async () => [] },
    agentVersion: { count: async () => 0 },
    channelConnection: { count: async () => 0 },
    whatsappPhoneNumber: { count: async () => 0 },
    message: { findFirst: async () => null },
    paymentMethod: { count: async () => 0 },
    invoice: { count: async () => 0 },
    organizationUser: { count: async () => 1 },
    auditLog: { findFirst: async () => null, create: async () => undefined },
    pushDevice: { count: async () => 0 },
    usageEvent: { create: async () => undefined },
  };
  return { admin, withTenant: async (_o: string, fn: (t: unknown) => unknown) => fn(admin) } as never;
}

describe("minutos estimados del montaje", () => {
  it("cada paso trae su estimación (si falta una, la barra de progreso miente)", () => {
    const sinMinutos = buildSetupSteps(EMPTY_SETUP_FACTS).filter((s) => !(s.minutes > 0));
    expect(sinMinutos.map((s) => s.key)).toEqual([]);
  });

  it("los minutos que faltan suman SOLO los pasos bloqueantes pendientes", () => {
    const steps = buildSetupSteps(EMPTY_SETUP_FACTS);
    const esperado = steps.filter((s) => s.blocking).reduce((t, s) => t + s.minutes, 0);
    expect(summarizeSetupChecklist(steps).remainingMinutes).toBe(esperado);
  });

  it("un paso ya hecho deja de contar", () => {
    const todo = summarizeSetupChecklist(buildSetupSteps(EMPTY_SETUP_FACTS));
    const conNegocio = summarizeSetupChecklist(
      buildSetupSteps({ ...EMPTY_SETUP_FACTS, hasBusinessName: true, hasIndustry: true, hasAddress: true, hasBusinessHours: true }),
    );
    expect(conNegocio.remainingMinutes).toBeLessThan(todo.remainingMinutes);
  });

  it("con todo hecho no falta ni un minuto", () => {
    const facts = { ...EMPTY_SETUP_FACTS, hasBusinessName: true, hasIndustry: true, hasAddress: true, hasBusinessHours: true, servicesPriced: 1, professionalsWithHours: 1, publishedAgents: 1, whatsappConnected: true, channelsWithAgent: 1, botReplied: true, planActive: true };
    const r = summarizeSetupChecklist(buildSetupSteps(facts));
    expect(r.remainingMinutes).toBe(0);
    expect(r.done).toBe(true);
  });

  it("la estimación del montaje completo es razonable (no 2 min ni una hora)", () => {
    const total = summarizeSetupChecklist(buildSetupSteps(EMPTY_SETUP_FACTS)).remainingMinutes;
    expect(total).toBeGreaterThanOrEqual(10);
    expect(total).toBeLessThanOrEqual(30);
  });
});

describe("saldo en el contexto del copiloto", () => {
  it("plan por CONVERSACIONES: lo nombra como conversaciones", async () => {
    const svc = new AssistantService(prismaCon({ features: { conversationDebitsWallet: true }, lotes: 120 }));
    const c = await svc.buildContext("org-1");
    expect(c.saldo).toBe("120 conversaciones disponibles");
    expect(c.saldoRestante).toBe(120);
    expect(c.saldoUnidad).toBe("conversation");
  });

  it("plan por CRÉDITOS IA: ya NO queda en blanco (regresión de CRE 2)", async () => {
    const svc = new AssistantService(prismaCon({ features: { aiCreditsWallet: true }, lotes: 450 }));
    const c = await svc.buildContext("org-1");
    expect(c.saldo).toBe("450 créditos disponibles");
    expect(c.saldoRestante).toBe(450);
    expect(c.saldoUnidad).toBe("credit");
  });

  it("la gracia ya usada se descuenta del saldo que se le muestra", async () => {
    const svc = new AssistantService(prismaCon({ features: { aiCreditsWallet: true }, lotes: 100, graceUsed: 30 }));
    expect((await svc.buildContext("org-1")).saldoRestante).toBe(70);
  });

  it("nunca muestra un saldo negativo", async () => {
    const svc = new AssistantService(prismaCon({ features: { aiCreditsWallet: true }, lotes: 10, graceUsed: 90 }));
    expect((await svc.buildContext("org-1")).saldoRestante).toBe(0);
  });

  it("un plan que no debita del monedero no muestra saldo", async () => {
    const svc = new AssistantService(prismaCon({ features: {}, lotes: 500 }));
    const c = await svc.buildContext("org-1");
    expect(c.saldo).toBeNull();
    expect(c.saldoRestante).toBeNull();
  });
});

describe("señales proactivas", () => {
  it("cuenta las citas por confirmar", async () => {
    const svc = new AssistantService(prismaCon({ citas: 3 }));
    expect((await svc.buildContext("org-1")).citasPorConfirmar).toBe(3);
  });

  it("el contexto trae los minutos que faltan", async () => {
    const svc = new AssistantService(prismaCon({}));
    expect((await svc.buildContext("org-1")).remainingMinutes).toBeGreaterThan(0);
  });
});

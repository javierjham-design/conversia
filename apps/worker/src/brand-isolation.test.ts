import { describe, expect, it, vi, beforeEach } from "vitest";
import { messagingFuseKeys, resolveBrandCap, DEFAULT_BRAND } from "@conversia/config";

/**
 * ETAPA 6 — coexistencia de marcas en los fusibles y el cobro.
 *
 * Dos cosas distintas se prueban acá:
 *  1. §6.1 — el fusible global cuenta y corta POR MARCA. Antes era un contador único: un
 *     pico de Conversia dejaba a TuBot sin poder enviar.
 *  2. §6.6 — DOBLE GUARDA del cobro: para que una org pague por conversación o por
 *     mensaje de servicio hace falta que sea de marca conversia Y que su plan traiga la
 *     feature. Con la feature sola, un plan de TuBot mal marcado —a mano, por un seed, o
 *     por un loop que recorra todos los planes, como el incidente de V2-7— empezaría a
 *     cobrarle a los clientes de TuBot.
 */

// ─────────────────────────────────────────────────────────────────────────────
// §6.1 — claves y topes por marca (funciones puras: sin Redis ni BD)
// ─────────────────────────────────────────────────────────────────────────────
describe("§6.1 — claves del fusible por marca", () => {
  const d = "2026-10-27";

  it("TuBot conserva las claves SIN sufijo (las que ya cuentan en producción)", () => {
    const k = messagingFuseKeys("tubot", d);
    expect(k.templateCounter).toBe(`msgcap:g:${d}`);
    expect(k.templateFuse).toBe(`msgcap:fuse:${d}`);
    expect(k.serviceCounter).toBe(`msgcap:svc:g:${d}`);
    expect(k.serviceFuse).toBe(`msgcap:svc-fuse:${d}`);
  });

  it("Conversia tiene su propio juego de claves", () => {
    const k = messagingFuseKeys("conversia", d);
    expect(k.templateCounter).toBe(`msgcap:g:conversia:${d}`);
    expect(k.templateFuse).toBe(`msgcap:fuse:conversia:${d}`);
    expect(k.serviceCounter).toBe(`msgcap:svc:g:conversia:${d}`);
    expect(k.serviceFuse).toBe(`msgcap:svc-fuse:conversia:${d}`);
  });

  it("NINGUNA clave se comparte entre marcas (es el punto del hallazgo)", () => {
    const a = messagingFuseKeys("tubot", d);
    const b = messagingFuseKeys("conversia", d);
    const compartidas = Object.keys(a).filter((k) => (a as any)[k] === (b as any)[k]);
    expect(compartidas, `claves compartidas: ${compartidas.join(", ")}`).toEqual([]);
  });

  it("sin marca, o con marca vacía, cuenta donde contaba antes (tubot)", () => {
    const esperado = messagingFuseKeys("tubot", d);
    expect(messagingFuseKeys(null, d)).toEqual(esperado);
    expect(messagingFuseKeys(undefined, d)).toEqual(esperado);
    expect(messagingFuseKeys("   ", d)).toEqual(esperado);
    expect(messagingFuseKeys("TUBOT", d)).toEqual(esperado); // no distingue mayúsculas
  });

  it("el día separa los contadores (el fusible es diario)", () => {
    expect(messagingFuseKeys("conversia", "2026-10-27").templateCounter).not.toBe(
      messagingFuseKeys("conversia", "2026-10-28").templateCounter,
    );
  });
});

describe("§6.1 — resolución del techo por marca", () => {
  it("el valor de la marca manda sobre todo", () => {
    expect(resolveBrandCap("conversia", { perBrand: 500, legacy: 1500, fallback: 10 })).toBe(500);
    expect(resolveBrandCap("tubot", { perBrand: 2000, legacy: 1500, fallback: 10 })).toBe(2000);
  });

  it("SOLO tubot hereda la clave sin marca (el techo que ya configuró el dueño)", () => {
    expect(resolveBrandCap("tubot", { legacy: 1500, fallback: 10 })).toBe(1500);
    // Conversia NO hereda: 1.500 es un techo pensado para el volumen de TuBot.
    expect(resolveBrandCap("conversia", { legacy: 1500, fallback: 10 })).toBe(10);
  });

  it("sin nada configurado, el default de entorno", () => {
    expect(resolveBrandCap("conversia", { fallback: 42 })).toBe(42);
    expect(resolveBrandCap("tubot", { fallback: 42 })).toBe(42);
  });

  it("ignora valores inservibles (0, negativos, NaN) en vez de apagar el fusible", () => {
    expect(resolveBrandCap("conversia", { perBrand: 0, fallback: 42 })).toBe(42);
    expect(resolveBrandCap("conversia", { perBrand: -5, fallback: 42 })).toBe(42);
    expect(resolveBrandCap("conversia", { perBrand: Number.NaN, fallback: 42 })).toBe(42);
    expect(resolveBrandCap("tubot", { legacy: 0, fallback: 42 })).toBe(42);
  });

  it("la marca por defecto es tubot (comportamiento histórico)", () => {
    expect(DEFAULT_BRAND).toBe("tubot");
    expect(resolveBrandCap(null, { legacy: 1500, fallback: 10 })).toBe(1500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.6 — doble guarda del cobro (marca + feature del plan)
// ─────────────────────────────────────────────────────────────────────────────

/** Marca y features que verá el módulo bajo prueba en cada caso. */
const escenario: { brand: string | null; features: Record<string, unknown> } = { brand: "conversia", features: {} };

vi.mock("@conversia/database", () => ({
  getAdminPrisma: () => ({
    organization: { findUnique: async () => ({ brand: escenario.brand }) },
    subscription: { findFirst: async () => ({ planId: "plan_1" }) },
    plan: { findUnique: async () => ({ features: escenario.features }) },
  }),
  withTenant: async (_org: string, fn: any) => fn({}),
  raiseException: async () => undefined,
}));
vi.mock("ioredis", () => ({
  default: class {
    async incr() {
      return 1;
    }
    async expire() {
      return 1;
    }
    async get() {
      return null;
    }
    async set() {
      return "OK";
    }
  },
}));

// Import estático DESPUÉS de los vi.mock (vitest los eleva): un `await import` en el
// nivel superior rompe estos tests del worker.
import { planDebitsConversation } from "./conversation-credits";

describe("§6.6 — cobrar por conversación exige marca conversia Y feature", () => {
  beforeEach(() => {
    escenario.brand = "conversia";
    escenario.features = {};
  });

  it("conversia + feature → debita", async () => {
    escenario.features = { conversationDebitsWallet: true };
    expect(await planDebitsConversation("org_1")).toBe(true);
  });

  it("TuBot con la feature ENCENDIDA → NO debita (ésta es la guarda)", async () => {
    escenario.brand = "tubot";
    escenario.features = { conversationDebitsWallet: true };
    expect(await planDebitsConversation("org_1")).toBe(false);
  });

  it("org sin marca (histórica) tampoco debita", async () => {
    escenario.brand = null;
    escenario.features = { conversationDebitsWallet: true };
    expect(await planDebitsConversation("org_1")).toBe(false);
  });

  it("conversia sin la feature → no debita", async () => {
    escenario.features = {};
    expect(await planDebitsConversation("org_1")).toBe(false);
  });
});

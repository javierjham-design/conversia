import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CRE 2 — CONVIVENCIA DE LAS DOS UNIDADES.
 *
 * Mientras no se encienda el modelo nuevo, Conversia cobra por conversación; después, por
 * Créditos IA. En el medio hay un rato —y clientes— con las dos cosas en la base.
 *
 * Lo que se prueba acá es que nadie quede del lado equivocado: que a cada cliente se le
 * ofrezcan los packs de SU unidad (comprar packs de la unidad que no usa sería pagar por
 * saldo que su bot no puede gastar), y que las cuentas nuevas entren al modelo que está
 * efectivamente a la venta.
 */

const state = {
  planFeatures: { conversationDebitsWallet: true } as Record<string, unknown> | null,
  tienePlan: true,
  creditBaseActive: false,
  planes: {} as Record<string, { id: string; active: boolean; features: Record<string, unknown> } | null>,
  fallarBase: false,
};

vi.mock("@conversia/database", () => ({
  getAdminPrisma: () => ({
    subscription: { findFirst: async () => (state.tienePlan ? { planId: "p1" } : null) },
    plan: {
      findUnique: async ({ where }: any) => {
        if (state.fallarBase) throw new Error("BD caída");
        if (where.code === "conversia_creditos_base") return { active: state.creditBaseActive };
        if (where.code && state.planes[where.code] !== undefined) return state.planes[where.code];
        if (where.id === "p1" || where.code === "free") return state.planFeatures ? { features: state.planFeatures } : null;
        return null;
      },
    },
  }),
}));

import { isLotPack, packUnitForBrand, packUnitForOrg, unitLabel } from "../src/billing/pack-unit";
import { resolveTrialPlan, TRIAL_PLAN_CODES } from "../src/auth/auth.service";

beforeEach(() => {
  state.planFeatures = { conversationDebitsWallet: true };
  state.tienePlan = true;
  state.creditBaseActive = false;
  state.planes = {};
  state.fallarBase = false;
});

describe("CRE 2 — qué packs ve cada cliente", () => {
  it("un cliente por conversación ve packs de conversaciones", async () => {
    expect(await packUnitForOrg("o")).toBe("conversation");
  });

  it("un cliente con Créditos IA ve packs de créditos", async () => {
    state.planFeatures = { aiCreditsWallet: true };
    expect(await packUnitForOrg("o")).toBe("credit");
  });

  it("sin suscripción vigente, la unidad vieja (lo que hay vendido hoy)", async () => {
    state.tienePlan = false;
    expect(await packUnitForOrg("o")).toBe("conversation");
  });

  it("si la base se cae, la unidad vieja: nunca se le ofrece algo que no pueda usar", async () => {
    state.fallarBase = true;
    expect(await packUnitForOrg("o")).toBe("conversation");
  });
});

describe("CRE 2 — qué muestra la web pública", () => {
  it("con el catálogo de créditos APAGADO, publica conversaciones", async () => {
    expect(await packUnitForBrand("conversia")).toBe("conversation");
  });

  it("con el catálogo de créditos ENCENDIDO, publica créditos", async () => {
    state.creditBaseActive = true;
    expect(await packUnitForBrand("conversia")).toBe("credit");
  });

  it("TuBot nunca entra en esto", async () => {
    state.creditBaseActive = true;
    expect(await packUnitForBrand("tubot")).toBe("conversation");
  });
});

describe("CRE 2 — qué packs acreditan la bolsa de lotes", () => {
  it("conversaciones y créditos sí; plantillas no", () => {
    expect(isLotPack("conversation")).toBe(true);
    expect(isLotPack("credit")).toBe(true);
    // Los de tipo "message" son la bolsa de plantillas de TuBot: otra bolsa, otro saldo.
    expect(isLotPack("message")).toBe(false);
    expect(isLotPack(null)).toBe(false);
    expect(isLotPack(undefined)).toBe(false);
  });

  it("la unidad se nombra en singular y plural como corresponde", () => {
    expect(unitLabel("credit", 1)).toBe("crédito");
    expect(unitLabel("credit", 5)).toBe("créditos");
    expect(unitLabel("conversation", 1)).toBe("conversación");
    expect(unitLabel("conversation", 5)).toBe("conversaciones");
  });
});

describe("CRE 2 — a qué modelo entra una cuenta nueva", () => {
  const db = {
    plan: {
      findUnique: async ({ where }: any) => state.planes[where.code] ?? null,
    },
  };

  it("con el catálogo de créditos activo, entra a créditos (200 de regalo)", async () => {
    state.planes = {
      conversia_creditos_trial: { id: "credit-trial", active: true, features: { signupGiftCredits: 200 } },
      conversia_v2_trial: { id: "conv-trial", active: true, features: { signupGiftCredits: 30 } },
    };
    const plan = await resolveTrialPlan(db);
    expect(plan?.id).toBe("credit-trial");
  });

  it("con el catálogo de créditos INACTIVO, entra al de conversaciones (lo de hoy)", async () => {
    state.planes = {
      conversia_creditos_trial: { id: "credit-trial", active: false, features: { signupGiftCredits: 200 } },
      conversia_v2_trial: { id: "conv-trial", active: true, features: { signupGiftCredits: 30 } },
    };
    const plan = await resolveTrialPlan(db);
    expect(plan?.id).toBe("conv-trial");
  });

  it("si NINGUNO está activo, devuelve uno igual: mejor plan inactivo que cuenta sin bolsa", async () => {
    state.planes = {
      conversia_creditos_trial: { id: "credit-trial", active: false, features: {} },
      conversia_v2_trial: { id: "conv-trial", active: false, features: {} },
    };
    const plan = await resolveTrialPlan(db);
    expect(plan?.id).toBe("credit-trial");
  });

  it("si no existe ninguno (base nueva sin sembrar), null y el registro sigue sin romperse", async () => {
    state.planes = {};
    expect(await resolveTrialPlan(db)).toBeNull();
  });

  it("el orden de preferencia es explícito: créditos antes que conversaciones", () => {
    expect(TRIAL_PLAN_CODES).toEqual(["conversia_creditos_trial", "conversia_v2_trial"]);
  });
});

/**
 * EL ARBITRAJE ENTRE LAS DOS UNIDADES.
 *
 * Los packs de conversación y los de Créditos IA acreditan el MISMO bucket de lotes
 * (`isLotPack`), y sus precios por unidad no se parecen: la recarga de créditos da 420
 * unidades por $24.990 ($59,5 cada una) y la de conversaciones 100 por $21.900 ($219 cada
 * una). `buy-package` validaba existencia, `active` y marca — nunca el TIPO contra el plan
 * del cliente. Un cliente que cobra por conversación comprando el pack de créditos se
 * llevaba 420 conversaciones por $24.990 en vez de ~$92.000, y tras el go-live, con sus
 * propios packs apagados, era el ÚNICO comprable por API. La pantalla ya filtraba por tipo,
 * pero eso es la UI: el endpoint aceptaba el código igual.
 *
 * La regla que cierra eso es una sola: `pkg.type` tiene que coincidir con la unidad de la
 * organización. Se prueba sobre `packUnitForOrg`, que es de donde sale esa unidad.
 */
describe("un pack de la unidad equivocada no se puede comprar", () => {
  /** La comprobación que hace el endpoint, con el pack y la unidad resuelta. */
  const permitido = (tipo: string | null, unidad: string) => !isLotPack(tipo) || tipo === unidad;

  it("el cliente por CONVERSACIÓN no puede comprar la recarga de créditos", async () => {
    state.planFeatures = { conversationDebitsWallet: true };
    const unidad = await packUnitForOrg("o1");
    expect(unidad).toBe("conversation");
    expect(permitido("credit", unidad)).toBe(false);
    expect(permitido("conversation", unidad)).toBe(true);
  });

  it("el cliente de CRÉDITOS no puede comprar packs de conversaciones", async () => {
    state.planFeatures = { aiCreditsWallet: true };
    const unidad = await packUnitForOrg("o1");
    expect(unidad).toBe("credit");
    expect(permitido("conversation", unidad)).toBe(false);
    expect(permitido("credit", unidad)).toBe(true);
  });

  it("los packs de PLANTILLAS no entran en la regla (no acreditan lotes)", async () => {
    // El sobre de 500 plantillas se sigue vendiendo a quien sea: va a otra bolsa.
    state.planFeatures = { aiCreditsWallet: true };
    const unidad = await packUnitForOrg("o1");
    expect(permitido("message", unidad)).toBe(true);
    expect(permitido(null, unidad)).toBe(true);
  });

  it("ante una base caída la unidad cae a 'conversation', así que el pack de créditos NO pasa", async () => {
    // El default seguro es el conservador: lo que está vendido y cobrando hoy. Si ante un
    // error cayera a "credit", un fallo de base abriría justo el arbitraje.
    state.fallarBase = true;
    const unidad = await packUnitForOrg("o1");
    expect(unidad).toBe("conversation");
    expect(permitido("credit", unidad)).toBe(false);
  });
});

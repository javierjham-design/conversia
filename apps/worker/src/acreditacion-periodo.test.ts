import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * EL MES QUE SE ACREDITA DOS VECES AL CAMBIAR DE PLAN.
 *
 * El sello de la acreditación del período es por (PLAN, período), y eso está bien: un upgrade
 * el mismo día tiene que acreditar el plan nuevo, porque si no el cliente paga y se queda con
 * 0 créditos hasta el mes siguiente (pasó, y por eso el sello es así). Pero por eso mismo,
 * cada plan distinto por el que pasara una cuenta en el mes abría SU PROPIO mes completo: dos
 * saltos de plan y el cliente se llevaba dos meses de créditos pagando uno, y quien quisiera
 * abusarlo solo tenía que ir saltando de plan.
 *
 * Lo que se prueba acá es que la acreditación netea contra lo que ese período ya dio, sin
 * perder ninguna de las dos cosas que tenía que seguir funcionando: el upgrade acredita de
 * inmediato, y el cambio de unidad (conversaciones → Créditos IA) NO se descuenta.
 */

const estado = {
  /** `aiCreditsIncluded` / `conversationsIncluded` del plan vigente. */
  included: 300,
  planId: "plan-base",
  periodStart: new Date("2026-10-01T00:00:00.000Z"),
  /** Asientos de acreditación que ya existen en el período. */
  asientos: [] as Array<{ delta: number; refId: string; reason: string; refType: string }>,
  /** Sellos ya escritos (lo que hace idempotente la acreditación). */
  sellos: [] as string[],
};
/** Lo que se acreditó en esta corrida. */
const lotes: Array<{ amount: number; refId?: string }> = [];

vi.mock("@conversia/database", () => ({
  getAdminPrisma: () => ({
    subscription: { findFirst: async () => ({ periodStart: estado.periodStart, planId: estado.planId }) },
    organization: { findUnique: async () => ({ brand: "conversia" }) },
    // Las features del plan salen de acá: `planFeatures` las lee del plan de la suscripción,
    // y es la función REAL la que corre (no se puede mockear un export del propio módulo que
    // se está probando: la llamada interna no pasa por el mock).
    plan: {
      findUnique: async () => ({ features: { aiCreditsIncluded: estado.included, conversationsIncluded: estado.included } }),
    },
  }),
  withTenant: async (_o: string, fn: (tx: unknown) => unknown) => fn({}),
  raiseException: async () => undefined,
}));

/** `tx` de juguete: solo lo que toca la acreditación del período. */
const tx = {
  conversationWallet: {
    upsert: async () => ({ graceUsed: 0, periodStart: new Date(0) }),
    findUnique: async () => ({ graceUsed: 0 }),
    update: async () => undefined,
  },
  conversationCreditLedger: {
    findFirst: async ({ where }: any) =>
      where.reason === "plan_renewal" && estado.sellos.includes(where.refId) ? { id: "x" } : null,
    findMany: async ({ where }: any) =>
      estado.asientos
        .filter((a) => a.refType === where.refType && where.reason.in.includes(a.reason))
        .filter((a) => a.refId.endsWith(where.refId.endsWith))
        .map((a) => ({ delta: a.delta, refId: a.refId })),
    create: async () => undefined,
  },
  conversationCreditLot: {
    aggregate: async () => ({ _sum: { remaining: 0 } }),
    create: async ({ data }: any) => void lotes.push({ amount: data.amount, refId: data.refId }),
  },
} as never;

import { ensurePeriodAccrued } from "./conversation-credits";

const FECHA = "2026-10-01";

beforeEach(() => {
  lotes.length = 0;
  estado.included = 300;
  estado.planId = "plan-base";
  estado.asientos = [];
  estado.sellos = [];
});

/** Lo que el plan ya dio en el período, tal como lo deja un mes normal. */
const yaAcreditado = (planId: string, delta: number, prefijo = "ai:") =>
  estado.asientos.push({ delta, refId: `${prefijo}${planId}:${FECHA}`, reason: "plan_renewal", refType: "subscription" });

describe("acreditación del período al cambiar de plan", () => {
  it("mes normal sin nada previo: acredita el mes completo", async () => {
    await ensurePeriodAccrued(tx, "org1", new Date("2026-10-05T00:00:00Z"), { includedKey: "aiCreditsIncluded" });
    expect(lotes).toEqual([{ amount: 300, refId: `ai:plan-base:${FECHA}` }]);
  });

  it("upgrade dentro del mes: acredita SOLO la diferencia", async () => {
    // El cliente ya recibió los 300 del plan Base este mes y sube a uno de 1.000.
    yaAcreditado("plan-base", 300);
    estado.sellos.push(`ai:plan-base:${FECHA}`);
    estado.planId = "plan-pro";
    estado.included = 1000;
    await ensurePeriodAccrued(tx, "org1", new Date("2026-10-15T00:00:00Z"), { includedKey: "aiCreditsIncluded" });
    expect(lotes).toEqual([{ amount: 700, refId: `ai:plan-pro:${FECHA}` }]);
  });

  it("DOWNGRADE dentro del mes: no acredita nada (ni se le quita lo que ya tenía)", async () => {
    yaAcreditado("plan-pro", 1000);
    estado.sellos.push(`ai:plan-pro:${FECHA}`);
    estado.planId = "plan-base";
    estado.included = 300;
    await ensurePeriodAccrued(tx, "org1", new Date("2026-10-15T00:00:00Z"), { includedKey: "aiCreditsIncluded" });
    expect(lotes).toEqual([]); // delta 0: el asiento igual se escribe, el LOTE no
  });

  it("saltar de plan tres veces no regala tres meses", async () => {
    // El abuso. Con el mes completo por plan, A→B→C daban 300+1000+300 = 1.600 créditos.
    yaAcreditado("plan-a", 300);
    yaAcreditado("plan-b", 700);
    estado.sellos.push(`ai:plan-a:${FECHA}`, `ai:plan-b:${FECHA}`);
    estado.planId = "plan-c";
    estado.included = 300;
    await ensurePeriodAccrued(tx, "org1", new Date("2026-10-20T00:00:00Z"), { includedKey: "aiCreditsIncluded" });
    expect(lotes).toEqual([]);
  });

  it("el crédito que se fue a pagar la GRACIA cuenta como recibido", async () => {
    // Un cliente que cerró el mes en gracia recibió sus 300: 100 taparon la deuda y 200
    // fueron a saldo. Si solo se contaran los 200, cada cambio de plan le regalaría 100.
    estado.asientos.push(
      { delta: 100, refId: `ai:plan-base:${FECHA}`, reason: "grace_repay", refType: "subscription" },
      { delta: 200, refId: `ai:plan-base:${FECHA}`, reason: "plan_renewal", refType: "subscription" },
    );
    estado.sellos.push(`ai:plan-base:${FECHA}`);
    estado.planId = "plan-pro";
    estado.included = 300;
    await ensurePeriodAccrued(tx, "org1", new Date("2026-10-15T00:00:00Z"), { includedKey: "aiCreditsIncluded" });
    expect(lotes).toEqual([]);
  });

  it("CAMBIO DE UNIDAD: el mes de conversaciones no se descuenta del de Créditos IA", async () => {
    // Son bolsas que se cobran distinto, y es justo el caso que el prefijo del sello vino a
    // resolver. Si se netearan entre sí, el cliente que pasa al modelo nuevo entraría con 0.
    yaAcreditado("plan-v2", 300, ""); // sello de conversaciones: sin prefijo "ai:"
    estado.sellos.push(`plan-v2:${FECHA}`);
    estado.planId = "plan-creditos";
    estado.included = 300;
    await ensurePeriodAccrued(tx, "org1", new Date("2026-10-15T00:00:00Z"), { includedKey: "aiCreditsIncluded" });
    expect(lotes).toEqual([{ amount: 300, refId: `ai:plan-creditos:${FECHA}` }]);
  });

  it("un asiento de OTRO período no entra en la cuenta", async () => {
    estado.asientos.push({ delta: 300, refId: `ai:plan-base:2026-09-01`, reason: "plan_renewal", refType: "subscription" });
    await ensurePeriodAccrued(tx, "org1", new Date("2026-10-05T00:00:00Z"), { includedKey: "aiCreditsIncluded" });
    expect(lotes).toEqual([{ amount: 300, refId: `ai:plan-base:${FECHA}` }]);
  });

  it("volver a correr con el mismo plan no acredita de nuevo", async () => {
    yaAcreditado("plan-base", 300);
    estado.sellos.push(`ai:plan-base:${FECHA}`);
    await ensurePeriodAccrued(tx, "org1", new Date("2026-10-15T00:00:00Z"), { includedKey: "aiCreditsIncluded" });
    expect(lotes).toEqual([]);
  });
});

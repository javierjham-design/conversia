import { describe, expect, it, vi } from "vitest";

/**
 * CRE 2 — LOS COBROS DE RECARGA Y LOS DE SUSCRIPCIÓN NO SE PUEDEN MEZCLAR.
 *
 * Los dos son cobros a la misma tarjeta guardada y viven en la misma tabla
 * (`payment_attempts`), que exige una suscripción. Si el motor de suscripciones viera los
 * intentos de recarga, pasarían dos cosas malas:
 *
 *  1. **La reconciliación renovaría el período gratis.** `reconcilePending` toma cada
 *     intento pendiente, le pregunta a la pasarela y, si salió bien, llama a `applyOutcome`
 *     → `applySuccess`, que extiende el período y acredita la bolsa del plan. Una recarga
 *     cobrada le regalaría un mes de plataforma.
 *  2. **Se frenaría la mensualidad.** `pendingSubscriptionIds` evita re-cobrar una
 *     suscripción mientras haya un intento en vuelo; una recarga en vuelo la bloquearía.
 *
 * Por eso los cobros de recarga llevan el prefijo `rec-` y las dos consultas lo excluyen.
 * Este test mira las consultas que se emiten de verdad: es la única forma de pinchar algo
 * que vive en un `where` de Prisma.
 */

const consultas: Array<{ metodo: string; where: unknown }> = [];

vi.mock("@conversia/database", () => ({
  getAdminPrisma: () => ({
    paymentAttempt: {
      findMany: async ({ where }: any) => {
        consultas.push({ metodo: "findMany", where });
        return [];
      },
    },
  }),
  refillMessageWallet: async () => undefined,
  withTenant: async (_o: string, fn: any) => fn({}),
}));
vi.mock("./subscription-billing/billing-emails", () => ({
  alertOwner: async () => undefined,
  sendBillingEmail: async () => undefined,
}));

import { createDbBillingPort } from "./subscription-billing/db-port";
import { RECHARGE_ORDER_PREFIX } from "./auto-recharge";

/** ¿La consulta excluye explícitamente los cobros con prefijo de recarga? */
function excluyeRecargas(where: any): boolean {
  return where?.NOT?.commerceOrder?.startsWith === RECHARGE_ORDER_PREFIX;
}

describe("CRE 2 — el motor de suscripciones ignora los cobros de recarga", () => {
  it("`listPending` (reconciliación) los excluye: si no, renovaría el período gratis", async () => {
    consultas.length = 0;
    const port = createDbBillingPort();
    await port.listPending(new Date());
    expect(consultas).toHaveLength(1);
    expect(excluyeRecargas(consultas[0].where)).toBe(true);
    // Y sigue filtrando lo que ya filtraba.
    expect((consultas[0].where as any).status).toBe("pending");
  });

  it("`pendingSubscriptionIds` los excluye: si no, frenaría la mensualidad", async () => {
    consultas.length = 0;
    const port = createDbBillingPort();
    await port.pendingSubscriptionIds(new Date());
    expect(consultas).toHaveLength(1);
    expect(excluyeRecargas(consultas[0].where)).toBe(true);
    expect((consultas[0].where as any).status).toBe("pending");
  });

  it("el prefijo es el mismo en los dos lados (una sola constante)", () => {
    expect(RECHARGE_ORDER_PREFIX).toBe("rec-");
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import {
  decidirRecarga,
  esRecarga,
  parseAutoRechargeConfig,
  RECHARGE_ORDER_PREFIX,
  runAutoRecharge,
  type AutoRechargeConfig,
  type AutoRechargePort,
  type RechargeCandidate,
} from "./auto-recharge";
import { FakeSubscriptionProvider } from "./subscription-billing/provider";

/**
 * CRE 2 — RECARGA AUTOMÁTICA (§6).
 *
 * Esto le cobra a la tarjeta del cliente sin que él apriete nada, así que los tests van
 * contra las formas en que eso puede salir mal: cobrar sin permiso, cobrar más veces de lo
 * autorizado, cobrar de nuevo porque el saldo sigue bajo mientras el pago se procesa, o
 * cobrar y que el pack no llegue.
 *
 * Se usa el proveedor FALSO que ya existe para el cobro recurrente: nada toca Flow.
 */

const CFG_OK: AutoRechargeConfig = {
  enabled: true,
  thresholdRemaining: 50,
  packCode: "conversia-cred-1000",
  monthlyCapClp: 56_970,
  consentAt: "2026-10-28T00:00:00.000Z",
};

describe("§6 — la decisión: ¿se cobra o no?", () => {
  const base = { cfg: CFG_OK, saldo: 10, precioClp: 18_990, gastadoEsteMesClp: 0, tieneTarjeta: true, enVuelo: false };

  it("saldo bajo el umbral, todo en orden → se cobra", () => {
    expect(decidirRecarga(base)).toBe("cobrar");
  });

  it("apagada → no se cobra", () => {
    expect(decidirRecarga({ ...base, cfg: { ...CFG_OK, enabled: false } })).toBe("apagada");
  });

  it("SIN CONSENTIMIENTO no se cobra, aunque esté encendida", () => {
    // El caso que más importa: un flag en true sin que el cliente haya aceptado nada
    // (migración de datos, edición a mano, un bug de la pantalla) no autoriza un cobro.
    expect(decidirRecarga({ ...base, cfg: { ...CFG_OK, consentAt: null } })).toBe("sin_consentimiento");
  });

  it("sin tarjeta guardada no se cobra", () => {
    expect(decidirRecarga({ ...base, tieneTarjeta: false })).toBe("sin_tarjeta");
  });

  it("sin pack configurado (o pack inexistente) no se cobra", () => {
    expect(decidirRecarga({ ...base, cfg: { ...CFG_OK, packCode: null } })).toBe("sin_pack");
    expect(decidirRecarga({ ...base, precioClp: 0 })).toBe("sin_pack");
  });

  it("con saldo por encima del umbral no se cobra", () => {
    expect(decidirRecarga({ ...base, saldo: 50 })).toBe("saldo_suficiente");
    expect(decidirRecarga({ ...base, saldo: 500 })).toBe("saldo_suficiente");
  });

  it("justo en el umbral NO se cobra; uno menos SÍ", () => {
    expect(decidirRecarga({ ...base, saldo: 50 })).toBe("saldo_suficiente");
    expect(decidirRecarga({ ...base, saldo: 49 })).toBe("cobrar");
  });

  it("con saldo NEGATIVO (ya en gracia) se cobra", () => {
    expect(decidirRecarga({ ...base, saldo: -30 })).toBe("cobrar");
  });

  it("un cobro EN VUELO frena el siguiente", () => {
    // Sin esto se cobrarían varios packs seguidos: el saldo sigue bajo hasta que el
    // webhook confirme, y el tick corre cada 15 minutos.
    expect(decidirRecarga({ ...base, enVuelo: true })).toBe("en_vuelo");
  });

  it("el tope mensual se mide CON el cobro incluido", () => {
    // Tope 56.970 = exactamente 3 recargas de 18.990. La tercera entra, la cuarta no.
    expect(decidirRecarga({ ...base, gastadoEsteMesClp: 18_990 * 2 })).toBe("cobrar");
    expect(decidirRecarga({ ...base, gastadoEsteMesClp: 18_990 * 3 })).toBe("tope_mensual");
  });

  it("el orden de las guardas: lo que es 'no y punto' manda sobre el estado", () => {
    // Sin consentimiento Y sin saldo → el motivo tiene que ser el consentimiento, que es
    // el que hay que arreglar.
    expect(decidirRecarga({ ...base, cfg: { ...CFG_OK, consentAt: null }, saldo: -100 })).toBe("sin_consentimiento");
  });
});

describe("§6 — config leída de los ajustes de la organización", () => {
  const def = { threshold: 50, monthlyCapClp: 56_970 };

  it("ajustes vacíos: apagada y con los defaults del §6", () => {
    const c = parseAutoRechargeConfig(undefined, def);
    expect(c).toEqual({ enabled: false, thresholdRemaining: 50, packCode: null, monthlyCapClp: 56_970, consentAt: null });
  });

  it("valores corruptos caen a los defaults (nunca a 0, que cobraría siempre)", () => {
    const c = parseAutoRechargeConfig({ enabled: true, thresholdRemaining: -5, monthlyCapClp: 0, packCode: "   " }, def);
    expect(c.thresholdRemaining).toBe(50);
    expect(c.monthlyCapClp).toBe(56_970);
    expect(c.packCode).toBeNull();
  });

  it("`enabled` solo cuenta si es exactamente true (un 1 o un 'si' no autorizan un cobro)", () => {
    for (const v of [1, "true", "si", {}]) {
      expect(parseAutoRechargeConfig({ enabled: v }, def).enabled).toBe(false);
    }
  });
});

describe("§6 — los cobros de recarga no se confunden con los de suscripción", () => {
  it("se reconocen por su prefijo", () => {
    expect(esRecarga(`${RECHARGE_ORDER_PREFIX}org1-123`)).toBe(true);
    expect(esRecarga("sub-abc-123")).toBe(false);
  });
});

/* ───────────────────────── Pasada completa, con puerto en memoria ───────────────────────── */

function makePort(over: Partial<AutoRechargePort> & { saldo?: number; gastado?: number; enVuelo?: boolean } = {}) {
  const attempts: Array<{ commerceOrder: string; amount: number; status: string; reason: string | null }> = [];
  const avisos: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const candidato: RechargeCandidate = {
    organizationId: "org1",
    cfg: CFG_OK,
    customerRef: "cus_1",
    subscriptionId: "sub1",
    currency: "CLP",
    brandSubject: "Conversia",
  };
  const port: AutoRechargePort = {
    listCandidates: async () => [candidato],
    balanceOf: async () => over.saldo ?? 10,
    packOf: async (code) => (code === "conversia-cred-1000" ? { code, credits: 1000, priceClp: 18_990 } : null),
    spentThisMonth: async () => over.gastado ?? 0,
    hasPendingRecharge: async () => over.enVuelo ?? false,
    createAttempt: async (i) => void attempts.push({ commerceOrder: i.commerceOrder, amount: i.amount, status: "pending", reason: null }),
    markAttempt: async (co, status, _ref, reason) => {
      const a = attempts.find((x) => x.commerceOrder === co);
      if (a) {
        a.status = status;
        a.reason = reason;
      }
    },
    notify: async (_org, kind, data) => void avisos.push({ kind, data }),
    firstTimeThisMonth: async () => true,
    ...over,
  };
  return { port, attempts, avisos, candidato };
}

const URLS = { confirmation: "https://api/billing/webhooks/flow", ret: "https://app/cobros" };

describe("§6 — pasada completa", () => {
  let provider: FakeSubscriptionProvider;
  beforeEach(() => {
    provider = new FakeSubscriptionProvider();
  });

  it("cobra, deja el intento pendiente y avisa al cliente", async () => {
    const { port, attempts, avisos } = makePort();
    provider.scheduleCharge(true, null, true); // asíncrono, como Flow
    const r = await runAutoRecharge(port, async () => provider, new Date(), URLS);

    expect(r.cobradas).toBe(1);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("pending");
    expect(attempts[0].amount).toBe(18_990);
    expect(avisos.map((a) => a.kind)).toEqual(["recharge_started"]);
    expect(avisos[0].data).toMatchObject({ credits: 1000, amountClp: 18_990 });
  });

  it("el cobro lleva la metadata que el webhook necesita para acreditar el pack", async () => {
    // Sin esto el cobro entra y el cliente NO recibe los créditos: el webhook no sabría
    // qué acreditar. Es el modo de falla más caro de todos.
    const { port } = makePort();
    provider.scheduleCharge(true, null, true);
    await runAutoRecharge(port, async () => provider, new Date(), URLS);
    expect(provider.charges[0].metadata).toEqual({
      organizationId: "org1",
      planCode: "pkg:conversia-cred-1000",
      expectedAmount: "18990",
      autoRecharge: "1",
    });
  });

  it("el cobro usa el prefijo de recarga (para que el motor de suscripciones lo ignore)", async () => {
    const { port } = makePort();
    provider.scheduleCharge(true, null, true);
    await runAutoRecharge(port, async () => provider, new Date(), URLS);
    expect(esRecarga(provider.charges[0].commerceOrder)).toBe(true);
  });

  it("tarjeta rechazada: intento FALLIDO y aviso inmediato", async () => {
    const { port, attempts, avisos } = makePort();
    provider.scheduleCharge(false, "card_declined");
    const r = await runAutoRecharge(port, async () => provider, new Date(), URLS);

    expect(r.cobradas).toBe(0);
    expect(attempts[0].status).toBe("failed");
    expect(attempts[0].reason).toBe("card_declined");
    expect(avisos[0]).toMatchObject({ kind: "recharge_failed" });
  });

  it("si la pasarela revienta, queda registrado y se avisa (no se pierde en silencio)", async () => {
    const { port, attempts, avisos } = makePort();
    const roto = {
      ...provider,
      charge: async () => {
        throw new Error("timeout de Flow");
      },
    } as unknown as FakeSubscriptionProvider;
    const r = await runAutoRecharge(port, async () => roto, new Date(), URLS);
    expect(r.cobradas).toBe(0);
    expect(attempts[0].status).toBe("failed");
    expect(attempts[0].reason).toContain("timeout");
    expect(avisos[0]).toMatchObject({ kind: "recharge_failed" });
  });

  it("con saldo suficiente no cobra NI crea intento", async () => {
    const { port, attempts, avisos } = makePort({ saldo: 800 });
    const r = await runAutoRecharge(port, async () => provider, new Date(), URLS);
    expect(r.cobradas).toBe(0);
    expect(attempts).toEqual([]);
    expect(avisos).toEqual([]);
    expect(provider.charges).toEqual([]);
    expect(r.motivos.saldo_suficiente).toBe(1);
  });

  it("en el tope mensual avisa UNA vez y no cobra", async () => {
    const { port, attempts, avisos } = makePort({ gastado: 18_990 * 3 });
    const r = await runAutoRecharge(port, async () => provider, new Date(), URLS);
    expect(r.cobradas).toBe(0);
    expect(attempts).toEqual([]);
    expect(avisos).toEqual([{ kind: "recharge_cap_reached", data: { monthlyCapClp: 56_970 } }]);
  });

  it("el aviso de tope no se repite en cada pasada", async () => {
    const { port, avisos } = makePort({ gastado: 18_990 * 3, firstTimeThisMonth: async () => false });
    await runAutoRecharge(port, async () => provider, new Date(), URLS);
    expect(avisos).toEqual([]);
  });

  it("un pack inactivo o de otra unidad no se cobra", async () => {
    const { port, attempts } = makePort({ packOf: async () => null });
    const r = await runAutoRecharge(port, async () => provider, new Date(), URLS);
    expect(r.cobradas).toBe(0);
    expect(attempts).toEqual([]);
    expect(r.motivos.sin_pack).toBe(1);
  });

  it("con un cobro en vuelo no se dispara otro", async () => {
    const { port, attempts } = makePort({ enVuelo: true });
    const r = await runAutoRecharge(port, async () => provider, new Date(), URLS);
    expect(r.cobradas).toBe(0);
    expect(attempts).toEqual([]);
    expect(provider.charges).toEqual([]);
  });

  it("sin candidatos no hace nada (el caso de todos los días)", async () => {
    const { port } = makePort({ listCandidates: async () => [] });
    const r = await runAutoRecharge(port, async () => provider, new Date(), URLS);
    expect(r).toEqual({ cobradas: 0, motivos: {} });
  });

  it("varias organizaciones: una cobra y la otra no, sin pisarse", async () => {
    const otra: RechargeCandidate = {
      organizationId: "org2",
      cfg: { ...CFG_OK, consentAt: null },
      customerRef: "cus_2",
      subscriptionId: "sub2",
      currency: "CLP",
      brandSubject: "Conversia",
    };
    const { port, candidato, attempts } = makePort();
    const multi: AutoRechargePort = { ...port, listCandidates: async () => [candidato, otra] };
    provider.scheduleCharge(true, null, true);
    const r = await runAutoRecharge(multi, async () => provider, new Date(), URLS);
    expect(r.cobradas).toBe(1);
    expect(r.motivos.sin_consentimiento).toBe(1);
    expect(attempts).toHaveLength(1);
  });
});

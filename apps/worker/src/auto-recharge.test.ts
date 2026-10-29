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
  packCode: "conversia-cred-420",
  monthlyCapClp: 249_900,
  consentAt: "2026-10-28T00:00:00.000Z",
};

describe("§6 — la decisión: ¿se cobra o no?", () => {
  const base = { cfg: CFG_OK, saldo: 10, precioClp: 24_990, gastadoEsteMesClp: 0, tieneTarjeta: true, enVuelo: false };

  it("saldo bajo el umbral, todo en orden → se cobra", () => {
    expect(decidirRecarga(base)).toBe("cobrar");
  });

  it("si el cliente acaba de recargar A MANO, no se le cobra otra vez por lo mismo", () => {
    // El aviso de saldo bajo lo manda a comprar al panel y el tick corre cada 15 minutos:
    // sin esta guarda, compraba su recarga y al rato le llegaba OTRO cobro por lo mismo.
    // Dos cobros a la tarjeta y el doble de créditos de los que quiso.
    expect(decidirRecarga({ ...base, compraReciente: true })).toBe("compra_reciente");
    expect(decidirRecarga({ ...base, compraReciente: false })).toBe("cobrar");
  });

  it("una org que NO cobra en CLP no se cobra automáticamente", () => {
    // El cobro va con `priceClp` y la moneda de la org, y el cobro recurrente es por Flow,
    // que es CLP. Una org en USD habría recibido un cargo de 24.990 DÓLARES (~23 millones
    // de pesos). Mejor no cobrar que cobrar en la moneda equivocada: esa cuenta recarga a
    // mano hasta que exista un cobro recurrente en USD.
    expect(decidirRecarga({ ...base, moneda: "USD" })).toBe("moneda_no_soportada");
    expect(decidirRecarga({ ...base, moneda: "CLP" })).toBe("cobrar");
    // Sin dato de moneda se asume CLP, que es lo que hay hoy: no se frena a nadie por un
    // campo vacío.
    expect(decidirRecarga({ ...base, moneda: undefined })).toBe("cobrar");
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
    // Tope 249.900 = exactamente 10 recargas de 24.990. La décima entra, la undécima no.
    expect(decidirRecarga({ ...base, gastadoEsteMesClp: 24_990 * 9 })).toBe("cobrar");
    expect(decidirRecarga({ ...base, gastadoEsteMesClp: 24_990 * 10 })).toBe("tope_mensual");
  });

  it("el orden de las guardas: lo que es 'no y punto' manda sobre el estado", () => {
    // Sin consentimiento Y sin saldo → el motivo tiene que ser el consentimiento, que es
    // el que hay que arreglar.
    expect(decidirRecarga({ ...base, cfg: { ...CFG_OK, consentAt: null }, saldo: -100 })).toBe("sin_consentimiento");
  });
});

/**
 * El tick corre cada 15 minutos y un intento FALLIDO no queda "en vuelo" ni cuenta contra
 * el tope (que mide cobros exitosos y pendientes), así que el saldo seguía bajo el umbral
 * y la decisión volvía a ser "cobrar": la misma tarjeta rechazada, 96 veces al día, con un
 * aviso cada vez. Estos son los dos frenos.
 */
describe("§6 — una tarjeta rechazada no se reintenta en ráfaga", () => {
  const base = { cfg: CFG_OK, saldo: 10, precioClp: 24_990, gastadoEsteMesClp: 0, tieneTarjeta: true, enVuelo: false };
  const now = new Date("2026-10-28T12:00:00.000Z");
  const haceHoras = (h: number) => new Date(now.getTime() - h * 3_600_000);

  it("recién rechazada: espera, no vuelve a cobrar", () => {
    expect(decidirRecarga({ ...base, now, fallos: { seguidos: 1, ultimoAt: haceHoras(0.25) } })).toBe("espera_tras_fallo");
  });

  it("a las 23 h sigue esperando; a las 24 h vuelve a intentar", () => {
    expect(decidirRecarga({ ...base, now, fallos: { seguidos: 1, ultimoAt: haceHoras(23) } })).toBe("espera_tras_fallo");
    expect(decidirRecarga({ ...base, now, fallos: { seguidos: 2, ultimoAt: haceHoras(24) } })).toBe("cobrar");
  });

  it("tras 3 rechazos seguidos se deja de intentar (hace falta otra tarjeta)", () => {
    expect(decidirRecarga({ ...base, now, fallos: { seguidos: 3, ultimoAt: haceHoras(48) } })).toBe("tarjeta_agotada");
  });

  it("si el cliente recargó a mano y tiene saldo, un rechazo viejo no lo reporta bloqueado", () => {
    expect(decidirRecarga({ ...base, saldo: 900, now, fallos: { seguidos: 5, ultimoAt: haceHoras(1) } })).toBe("saldo_suficiente");
  });

  it("sin fallos se comporta igual que siempre", () => {
    expect(decidirRecarga({ ...base, now, fallos: { seguidos: 0, ultimoAt: null } })).toBe("cobrar");
  });
});

describe("§6 — config leída de los ajustes de la organización", () => {
  const def = { threshold: 50, monthlyCapClp: 249_900 };

  it("ajustes vacíos: apagada y con los defaults del §6", () => {
    const c = parseAutoRechargeConfig(undefined, def);
    expect(c).toEqual({ enabled: false, thresholdRemaining: 50, packCode: null, monthlyCapClp: 249_900, consentAt: null });
  });

  it("valores corruptos caen a los defaults (nunca a 0, que cobraría siempre)", () => {
    const c = parseAutoRechargeConfig({ enabled: true, thresholdRemaining: -5, monthlyCapClp: 0, packCode: "   " }, def);
    expect(c.thresholdRemaining).toBe(50);
    expect(c.monthlyCapClp).toBe(249_900);
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

function makePort(over: Partial<AutoRechargePort> & { saldo?: number; gastado?: number; enVuelo?: boolean; compraReciente?: boolean } = {}) {
  const attempts: Array<{ commerceOrder: string; amount: number; status: string; reason: string | null }> = [];
  const avisos: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const excepciones: Array<{ type: string; title: string; detail: string; dedupeKey: string; severity: string }> = [];
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
    packOf: async (code) => (code === "conversia-cred-420" ? { code, credits: 420, priceClp: 24_990 } : null),
    spentThisMonth: async () => over.gastado ?? 0,
    hasPendingRecharge: async () => over.enVuelo ?? false,
    compraReciente: async () => over.compraReciente ?? false,
    failedRecharges: async () => ({ seguidos: 0, ultimoAt: null }),
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
    raiseOps: async (_org, input) => void excepciones.push(input),
    ...over,
  };
  return { port, attempts, avisos, excepciones, candidato };
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
    expect(attempts[0].amount).toBe(24_990);
    expect(avisos.map((a) => a.kind)).toEqual(["recharge_started"]);
    expect(avisos[0].data).toMatchObject({ credits: 420, amountClp: 24_990 });
  });

  it("el cobro lleva la metadata que el webhook necesita para acreditar el pack", async () => {
    // Sin esto el cobro entra y el cliente NO recibe los créditos: el webhook no sabría
    // qué acreditar. Es el modo de falla más caro de todos.
    const { port } = makePort();
    provider.scheduleCharge(true, null, true);
    await runAutoRecharge(port, async () => provider, new Date(), URLS);
    expect(provider.charges[0].metadata).toEqual({
      organizationId: "org1",
      planCode: "pkg:conversia-cred-420",
      expectedAmount: "24990",
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

  it("si la pasarela revienta, el cobro queda PENDIENTE (no fallido): no sabemos si entró", async () => {
    // El fallo más caro de este módulo, y el más fácil de escribir mal.
    //
    // Un `charge` que revienta por timeout puede haber entrado perfectamente en Flow: la
    // tarjeta quedó cobrada y lo que se perdió fue nuestra respuesta. Marcarlo `failed` era
    // AFIRMAR que no se cobró, y de esa afirmación falsa salían tres cosas: el intento
    // dejaba de contar contra el tope mensual (que mide exitosos y en vuelo), soltaba la
    // guarda de "un cobro a la vez", y el tick siguiente volvía a cobrar la misma tarjeta.
    // Cada 15 minutos. Y a los tres "rechazos" se apagaba la recarga automática de un
    // cliente al que ya le habíamos cobrado tres veces.
    const { port, attempts, avisos, excepciones } = makePort();
    const roto = {
      ...provider,
      charge: async () => {
        throw new Error("timeout de Flow");
      },
    } as unknown as FakeSubscriptionProvider;
    const r = await runAutoRecharge(port, async () => roto, new Date(), URLS);
    expect(r.cobradas).toBe(0);
    expect(r.sinRespuesta).toBe(1);
    expect(attempts[0].status).toBe("pending");
    expect(attempts[0].reason).toContain("sin_respuesta");
    expect(attempts[0].reason).toContain("timeout");
    // Al cliente NO se le dice "tu tarjeta falló": puede estar cobrada, y si lo está además
    // le van a llegar los créditos. El que tiene que mirar el panel de Flow es el dueño.
    expect(avisos).toEqual([]);
    expect(excepciones[0]).toMatchObject({ type: "recarga_sin_respuesta", severity: "critical" });
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
    const { port, attempts, avisos } = makePort({ gastado: 24_990 * 10 });
    const r = await runAutoRecharge(port, async () => provider, new Date(), URLS);
    expect(r.cobradas).toBe(0);
    expect(attempts).toEqual([]);
    expect(avisos).toEqual([{ kind: "recharge_cap_reached", data: { monthlyCapClp: 249_900 } }]);
  });

  it("el aviso de tope no se repite en cada pasada", async () => {
    const { port, avisos } = makePort({ gastado: 24_990 * 10, firstTimeThisMonth: async () => false });
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

  it("con la tarjeta rechazada hace un rato NO vuelve a cobrar ni avisa de nuevo", async () => {
    const { port, attempts, avisos } = makePort({
      failedRecharges: async () => ({ seguidos: 1, ultimoAt: new Date(Date.now() - 20 * 60_000) }),
    });
    const r = await runAutoRecharge(port, async () => provider, new Date(), URLS);

    expect(r.cobradas).toBe(0);
    expect(r.motivos.espera_tras_fallo).toBe(1);
    expect(attempts).toHaveLength(0); // ni un intento más a la pasarela
    expect(avisos).toEqual([]); // ni un aviso repetido al cliente
  });

  it("tras 3 rechazos avisa UNA vez y lo deja en la cola de operación", async () => {
    const { port, attempts, avisos, excepciones } = makePort({
      failedRecharges: async () => ({ seguidos: 3, ultimoAt: new Date(Date.now() - 2 * 86_400_000) }),
    });
    const r = await runAutoRecharge(port, async () => provider, new Date(), URLS);

    expect(r.motivos.tarjeta_agotada).toBe(1);
    expect(attempts).toHaveLength(0);
    expect(avisos.map((a) => a.kind)).toEqual(["recharge_failed"]);
    expect(excepciones).toHaveLength(1);
    expect(excepciones[0]).toMatchObject({ type: "recarga_fallida", severity: "critical" });
  });

  it("el primer rechazo ya aparece en la consola, con su propia clave (no tapa al grave)", async () => {
    const { port, excepciones } = makePort();
    provider.scheduleCharge(false, "tarjeta rechazada");
    await runAutoRecharge(port, async () => provider, new Date(), URLS);

    expect(excepciones).toHaveLength(1);
    expect(excepciones[0]).toMatchObject({ type: "recarga_fallida", severity: "warning" });
    // La clave del aviso leve y la del grave son distintas a propósito: con la misma, la
    // deduplicación de `raiseException` taparía el grave con el leve que llegó primero.
    expect(excepciones[0].dedupeKey).toMatch(/^fallo:/);
  });

  it("ese aviso no se repite en cada pasada", async () => {
    const { port, avisos, excepciones } = makePort({
      failedRecharges: async () => ({ seguidos: 4, ultimoAt: new Date(Date.now() - 2 * 86_400_000) }),
      firstTimeThisMonth: async () => false,
    });
    await runAutoRecharge(port, async () => provider, new Date(), URLS);
    expect(avisos).toEqual([]);
    expect(excepciones).toEqual([]);
  });

  it("sin `raiseOps` en el puerto el cobro sigue funcionando (la consola es un extra)", async () => {
    const { port } = makePort({
      failedRecharges: async () => ({ seguidos: 3, ultimoAt: new Date() }),
      raiseOps: undefined,
    });
    await expect(runAutoRecharge(port, async () => provider, new Date(), URLS)).resolves.toMatchObject({ cobradas: 0 });
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
    expect(r).toEqual({ cobradas: 0, motivos: {}, sinRespuesta: 0 });
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

import { describe, expect, it } from "vitest";
import { VENTANA_EN_VUELO_MS } from "./auto-recharge";
import {
  decidirCierre,
  GRACIA_WEBHOOK_MS,
  necesitaConsulta,
  reconciliarRecargas,
  VENTANA_TARJETA_NO_APTA_MS,
  type EstadoPasarela,
  type RecargaPendiente,
  type RechargeReconcilePort,
} from "./recharge-reconcile";
import { FakeSubscriptionProvider } from "./subscription-billing/provider";

/**
 * CRE — RECARGAS A MEDIAS.
 *
 * Todo lo que se prueba acá sale del mismo agujero: la tarjeta del cliente se cobra en un
 * momento y los créditos se entregan en otro, y entre los dos hay un webhook que puede no
 * llegar. Cada test es una forma concreta de que el cliente pague y no reciba nada.
 */

const AHORA = new Date("2026-10-29T12:00:00.000Z");
const haceMs = (ms: number) => new Date(AHORA.getTime() - ms);

const pendiente = (over: Partial<RecargaPendiente> = {}): RecargaPendiente => ({
  organizationId: "org1",
  commerceOrder: "rec-org1-123",
  providerRef: "tok_1",
  amountClp: 24_990,
  createdAt: haceMs(30 * 60 * 1000), // media hora: pasada la gracia del webhook
  ...over,
});

const PAGADO: EstadoPasarela = { settled: true, ok: true, reason: null };
const RECHAZADO: EstadoPasarela = { settled: true, ok: false, reason: "rechazado" };
const EN_CURSO: EstadoPasarela = { settled: false, ok: false, reason: null };

describe("la decisión: ¿qué se hace con un cobro de recarga sin cerrar?", () => {
  it("recién emitido: no se toca (el webhook es el camino normal)", () => {
    const p = pendiente({ createdAt: haceMs(GRACIA_WEBHOOK_MS - 1000) });
    expect(decidirCierre({ pendiente: p, estado: PAGADO, now: AHORA })).toBe("esperar");
    // Y tampoco se le pregunta a la pasarela: una consulta por cobro y por tick, al vicio.
    expect(necesitaConsulta(p, AHORA)).toBe(false);
  });

  it("la pasarela dice PAGADO y nadie acreditó → hay que acreditar", () => {
    // ESTE es el caso que costaba plata: webhook perdido, tarjeta cobrada, cero créditos.
    expect(decidirCierre({ pendiente: pendiente(), estado: PAGADO, now: AHORA })).toBe("acreditar");
  });

  it("la pasarela dice RECHAZADO → se cierra como fallido", () => {
    expect(decidirCierre({ pendiente: pendiente(), estado: RECHAZADO, now: AHORA })).toBe("marcar_fallido");
  });

  it("la pasarela sigue procesando → se espera, hasta el umbral de tarjeta no apta", () => {
    expect(decidirCierre({ pendiente: pendiente(), estado: EN_CURSO, now: AHORA })).toBe("esperar");
    const viejo = pendiente({ createdAt: haceMs(VENTANA_TARJETA_NO_APTA_MS) });
    expect(decidirCierre({ pendiente: viejo, estado: EN_CURSO, now: AHORA })).toBe("abandonar_alertar");
  });

  it("el umbral de la tarjeta no apta son DOS HORAS, no dos días", () => {
    // La evidencia no es un sandbox (no tenemos): el diagnóstico de cobro que ya corre en
    // producción dice, desde el E2E con tarjeta real del 29-ago, que un cobro "pendiente" en
    // Flow con tarjeta de débito es que Flow no admite cargo automático en débito. Un collect
    // legítimo resuelve en segundos. 48 h eran dos días de un cliente creyendo que su
    // recarga lo cubre — justo el daño que esto evita.
    expect(VENTANA_TARJETA_NO_APTA_MS).toBe(2 * 60 * 60 * 1000);
    const casi = pendiente({ createdAt: haceMs(VENTANA_TARJETA_NO_APTA_MS - 1000) });
    expect(decidirCierre({ pendiente: casi, estado: EN_CURSO, now: AHORA })).toBe("esperar");
  });

  it("no se pudo consultar el estado → se espera (no se inventa un resultado)", () => {
    // `getChargeStatus` que revienta no es "no se cobró": es "no sé". Declararlo fallido
    // soltaría la guarda de un cobro a la vez y el tick siguiente volvería a cobrar.
    expect(decidirCierre({ pendiente: pendiente(), estado: null, now: AHORA })).toBe("esperar");
  });

  it("cobro SIN TOKEN (la pasarela nunca respondió): se espera la ventana y después se alerta", () => {
    const reciente = pendiente({ providerRef: null, createdAt: haceMs(VENTANA_EN_VUELO_MS - 60_000) });
    expect(decidirCierre({ pendiente: reciente, estado: null, now: AHORA })).toBe("esperar");
    const vencido = pendiente({ providerRef: null, createdAt: haceMs(VENTANA_EN_VUELO_MS) });
    expect(decidirCierre({ pendiente: vencido, estado: null, now: AHORA })).toBe("sin_respuesta_alertar");
  });

  it("la alerta por falta de respuesta cae EXACTAMENTE cuando se suelta el cobro a la vez", () => {
    // Si la alerta fuera más tarde que la ventana, habría una franja en la que la cuenta ya
    // puede volver a cobrar y nadie miró el cobro anterior: dos cargos a la misma tarjeta
    // sin que nadie se enterara. Si fuera más temprano, se alertaría por cobros que el
    // webhook todavía puede cerrar solo.
    const justoAntes = pendiente({ providerRef: null, createdAt: haceMs(VENTANA_EN_VUELO_MS - 1) });
    const justoDespues = pendiente({ providerRef: null, createdAt: haceMs(VENTANA_EN_VUELO_MS) });
    expect(decidirCierre({ pendiente: justoAntes, estado: null, now: AHORA })).toBe("esperar");
    expect(decidirCierre({ pendiente: justoDespues, estado: null, now: AHORA })).toBe("sin_respuesta_alertar");
  });

  it("sin token no se consulta a la pasarela (no hay a qué preguntarle)", () => {
    expect(necesitaConsulta(pendiente({ providerRef: null }), AHORA)).toBe(false);
    expect(necesitaConsulta(pendiente(), AHORA)).toBe(true);
  });
});

/* ───────────────────────────── Pasada completa, puerto en memoria ───────────────────────────── */

function makePort(
  over: {
    pendientes?: RecargaPendiente[];
    /** ¿El libro tiene el asiento tras reaplicar el webhook? */
    acreditaAlReaplicar?: boolean;
    webhookRevienta?: boolean;
  } = {},
) {
  const cierres: Array<{ commerceOrder: string; status: string; reason: string | null }> = [];
  const replays: string[] = [];
  const excepciones: Array<{ type: string; severity: string; dedupeKey: string }> = [];
  const avisos: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const marcadas: string[] = [];
  const absueltas: string[] = [];
  const links: Array<{ org: string; monto: number }> = [];
  let acreditado = false;

  const port: RechargeReconcilePort = {
    listPendientes: async () => over.pendientes ?? [pendiente()],
    reaplicarWebhook: async ({ providerRef }) => {
      if (over.webhookRevienta) throw new Error("api caída");
      replays.push(providerRef);
      if (over.acreditaAlReaplicar !== false) acreditado = true;
    },
    creditoAcreditado: async () => acreditado,
    cerrarIntento: async (commerceOrder, status, reason) => void cierres.push({ commerceOrder, status, reason }),
    notificar: async (_org, kind, data) => void avisos.push({ kind, data }),
    raiseOps: async (_org, i) => void excepciones.push({ type: i.type, severity: i.severity, dedupeKey: i.dedupeKey }),
    marcarTarjetaNoApta: async (org) => void marcadas.push(org),
    marcarTarjetaApta: async (org) => void absueltas.push(org),
    linkDePago: async (org, monto) => {
      links.push({ org, monto });
      return "https://pago/link";
    },
  };
  return { port, cierres, replays, excepciones, avisos, marcadas, links, absueltas };
}

const providerCon = (estado: EstadoPasarela) => {
  const p = new FakeSubscriptionProvider();
  p.getChargeStatus = async () => estado;
  return async () => p;
};

describe("pasada completa", () => {
  it("el webhook perdido se recupera: acredita por el camino normal y cierra el intento", async () => {
    const { port, cierres, replays, absueltas } = makePort();
    const r = await reconciliarRecargas(port, providerCon(PAGADO), AHORA);

    expect(r.acreditadas).toBe(1);
    expect(r.pagadasSinAcreditar).toBe(0);
    // Acredita REAPLICANDO el webhook, no por su cuenta: una segunda forma de entregar
    // créditos es una segunda forma de equivocarse con el dinero.
    expect(replays).toEqual(["tok_1"]);
    expect(cierres).toEqual([{ commerceOrder: "rec-org1-123", status: "succeeded", reason: "reconciliado" }]);
    // Y LA TARJETA QUEDA ABSUELTA: un cobro automático confirmado es la prueba de que
    // admite cargos recurrentes. Es lo que hace seguro acusar a las 2 h — un veredicto
    // equivocado se borra con el primer cobro bueno, sin que nadie tenga que intervenir.
    expect(absueltas).toEqual(["org1"]);
  });

  it("si el webhook devuelve OK pero el libro queda vacío: NO se cierra y se alerta", async () => {
    // Un 200 no prueba que se acreditó (metadata perdida, pack fuera del catálogo). Si el
    // intento se cerrara igual, el cliente habría pagado, el historial diría "cobrado" y no
    // habría ni un crédito ni un aviso. Queda pendiente para que el próximo pase lo reintente.
    const { port, cierres, excepciones } = makePort({ acreditaAlReaplicar: false });
    const r = await reconciliarRecargas(port, providerCon(PAGADO), AHORA);

    expect(r.acreditadas).toBe(0);
    expect(r.pagadasSinAcreditar).toBe(1);
    expect(cierres).toEqual([]);
    expect(excepciones).toEqual([
      { type: "recarga_pagada_sin_acreditar", severity: "critical", dedupeKey: "pagada_sin_acreditar:rec-org1-123" },
    ]);
  });

  it("un pago confirmado que NO acreditó no absuelve la tarjeta (nada quedó resuelto)", async () => {
    const { port, absueltas } = makePort({ acreditaAlReaplicar: false });
    await reconciliarRecargas(port, providerCon(PAGADO), AHORA);
    expect(absueltas).toEqual([]);
  });

  it("si la reaplicación del webhook revienta, el intento queda pendiente (no se pierde)", async () => {
    const { port, cierres } = makePort({ webhookRevienta: true });
    const r = await reconciliarRecargas(port, providerCon(PAGADO), AHORA);
    expect(r.errores).toBe(1);
    expect(r.acreditadas).toBe(0);
    expect(cierres).toEqual([]); // sigue pendiente: lo toma el próximo pase
  });

  it("un intento que revienta no frena a los demás (es la plata de otro cliente)", async () => {
    const otro = pendiente({ organizationId: "org2", commerceOrder: "rec-org2-999", providerRef: "tok_2" });
    const { port, cierres } = makePort({ pendientes: [pendiente(), otro] });
    // Revienta solo el primero.
    const original = port.reaplicarWebhook;
    port.reaplicarWebhook = async (i) => {
      if (i.providerRef === "tok_1") throw new Error("boom");
      return original(i);
    };
    const r = await reconciliarRecargas(port, providerCon(PAGADO), AHORA);
    expect(r.errores).toBe(1);
    expect(r.acreditadas).toBe(1);
    expect(cierres).toEqual([{ commerceOrder: "rec-org2-999", status: "succeeded", reason: "reconciliado" }]);
  });

  it("rechazo descubierto por reconciliación: se cierra fallido Y se le avisa al cliente", async () => {
    // El cliente no se enteró: el cobro salió "en vuelo" y el rechazo llegó por acá. Sin el
    // aviso se queda sin saldo mirando una recarga activada que nunca entró.
    const { port, cierres, avisos } = makePort();
    const r = await reconciliarRecargas(port, providerCon(RECHAZADO), AHORA);

    expect(r.rechazadas).toBe(1);
    expect(cierres).toEqual([{ commerceOrder: "rec-org1-123", status: "failed", reason: "rechazado" }]);
    expect(avisos).toEqual([{ kind: "recharge_failed", data: { reason: "rechazado", amountClp: 24_990 } }]);
  });

  it("cobro sin respuesta y vencido: excepción crítica y se libera el tope del cliente", async () => {
    const sinToken = pendiente({ providerRef: null, createdAt: haceMs(VENTANA_EN_VUELO_MS + 1000) });
    const { port, cierres, excepciones, replays } = makePort({ pendientes: [sinToken] });
    const r = await reconciliarRecargas(port, providerCon(PAGADO), AHORA);

    expect(r.sinResolver).toBe(1);
    expect(replays).toEqual([]); // sin token no se reaplica nada
    expect(excepciones[0]).toMatchObject({ type: "recarga_sin_respuesta", severity: "critical" });
    // Se cierra como fallido a propósito: dejarlo pendiente para siempre le come el tope
    // mensual y le bloquea las recargas del resto del mes por un cobro que lo más probable
    // es que nunca haya entrado. La alerta es la red.
    expect(cierres).toEqual([{ commerceOrder: "rec-org1-123", status: "failed", reason: "sin_respuesta" }]);
  });

  it("pendiente pasado el umbral = TARJETA DE DÉBITO: se marca, se avisa con link y se cierra", async () => {
    // §4 — un cobro que la pasarela nunca cierra es el síntoma documentado de una tarjeta de
    // débito o prepago: no permiten cargos recurrentes. Al registrar no se puede distinguir
    // (la pasarela informa la marca, no el tipo), así que el primer cobro ES la prueba.
    // Lo que importa no es la etiqueta: antes el cobro se colgaba EN SILENCIO, la recarga
    // seguía "activada" y al cliente se le cortaba el bot al agotarse la gracia.
    const viejo = pendiente({ createdAt: haceMs(VENTANA_TARJETA_NO_APTA_MS + 1000) });
    const { port, cierres, excepciones, avisos, marcadas, links } = makePort({ pendientes: [viejo] });
    const r = await reconciliarRecargas(port, providerCon(EN_CURSO), AHORA);

    expect(r.sinResolver).toBe(1);
    expect(r.tarjetasNoAptas).toBe(1);
    expect(marcadas).toEqual(["org1"]); // la tarjeta queda marcada: no se reintenta a ciegas
    expect(links).toEqual([{ org: "org1", monto: 24_990 }]); // y el plan B: pagar a mano
    expect(excepciones[0]).toMatchObject({ type: "tarjeta_no_apta_cobro_automatico", severity: "warning" });
    // El aviso al cliente es el de "tu tarjeta no sirve", NO el de "tu tarjeta rechazó":
    // mandarle el segundo lo hace mirar su cupo, que no es donde está el problema.
    expect(avisos).toEqual([{ kind: "tarjeta_no_apta", data: { amountClp: 24_990, link: "https://pago/link" } }]);
    expect(cierres).toEqual([{ commerceOrder: "rec-org1-123", status: "failed", reason: "tarjeta_no_apta" }]);
  });

  it("si no se puede emitir el link, igual se marca y se avisa (no se pierde el caso)", async () => {
    const viejo = pendiente({ createdAt: haceMs(VENTANA_TARJETA_NO_APTA_MS + 1000) });
    const { port, excepciones, avisos, marcadas } = makePort({ pendientes: [viejo] });
    port.linkDePago = async () => null;
    await reconciliarRecargas(port, providerCon(EN_CURSO), AHORA);
    expect(marcadas).toEqual(["org1"]);
    expect(excepciones[0]).toMatchObject({ type: "tarjeta_no_apta_cobro_automatico" });
    expect(avisos[0].data.link).toBeNull();
  });

  it("un cobro recién emitido no se toca ni se consulta", async () => {
    const nuevo = pendiente({ createdAt: haceMs(60_000) });
    const { port, cierres, replays, excepciones } = makePort({ pendientes: [nuevo] });
    const r = await reconciliarRecargas(port, providerCon(PAGADO), AHORA);

    expect(r).toMatchObject({ revisadas: 1, acreditadas: 0, rechazadas: 0, sinResolver: 0, tarjetasNoAptas: 0, errores: 0 });
    expect(cierres).toEqual([]);
    expect(replays).toEqual([]);
    expect(excepciones).toEqual([]);
  });

  it("sin recargas a medias no hace nada", async () => {
    const { port, cierres, replays } = makePort({ pendientes: [] });
    const r = await reconciliarRecargas(port, providerCon(PAGADO), AHORA);
    expect(r.revisadas).toBe(0);
    expect(cierres).toEqual([]);
    expect(replays).toEqual([]);
  });
});

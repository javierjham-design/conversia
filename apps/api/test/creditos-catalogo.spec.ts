import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTO_RECARGA_DEFAULTS, CREDITOS_POR_CONVERSACION_POR_DEFECTO } from "@conversia/agents";

/**
 * CRE 2 — EL CATÁLOGO DE CRÉDITOS IA CUMPLE LO QUE DECIDIÓ EL DUEÑO.
 *
 * **El criterio cambió el 28-oct-2026.** Antes el precio salía del costo más una regla de
 * ganancia mínima. Ahora sale del VALOR PARA EL CLIENTE: está calibrado para que una cuenta
 * con el uso real de Digital-Dent en septiembre-2026 pague ~$200.000 al mes. La regla de
 * ganancia de 300% sigue viva, pero como PISO que hay que respetar, no como generadora del
 * precio.
 *
 * Este test encierra las dos cosas: la calibración (si alguien toca un precio, el cliente de
 * referencia deja de pagar ~$200.000 y se entera acá) y el piso de ganancia. Los precios se
 * editan en `packages/database/seeds/creditos-catalogo.json`.
 *
 * El costo de un pack son tres cosas, no una: los créditos que el cliente va a consumir, la
 * comisión de Flow sobre lo cobrado, y (solo en el plan) el costo fijo por cliente.
 */

const catalogo = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "packages", "database", "seeds", "creditos-catalogo.json"), "utf-8"),
) as {
  supuestos: {
    costoPorCreditoClp: number;
    comisionFlowPct: number;
    costoFijoPorClienteClp: number;
    ivaPct: number;
    creditosPorConversacion: number;
    gananciaMinimaPct: number;
  };
  planes: Array<{ code: string; priceClp: number; creditos: number; esPlanBase?: boolean; trial?: boolean; regaloBienvenida?: number }>;
  packs: Array<{ code: string; credits: number; priceClp: number; esRecargaBasica?: boolean }>;
  packsEliminados: { creditos: number[] };
  recargaAutomatica: { topeMensualClp: number; recargasEquivalentes: number };
};

const S = catalogo.supuestos;

/**
 * El cliente de referencia de la calibración: Digital-Dent, septiembre-2026. El consumo es
 * un hecho medido, no un supuesto — por eso los tramos se escriben acá y se comprueba que
 * sumen las 3.042 respuestas y los 3.172 créditos reales.
 */
const SEPTIEMBRE_DIGITAL_DENT = {
  tramos: [
    { respuestas: 2926, creditosCadaUna: 1 },
    { respuestas: 102, creditosCadaUna: 2 },
    { respuestas: 14, creditosCadaUna: 3 },
  ],
  respuestas: 3042,
  creditos: 3172,
  objetivoMensualClp: 200_000,
};

/** Neto (sin IVA) de un precio con IVA incluido. */
function neto(precioConIva: number): number {
  return precioConIva / (1 + S.ivaPct / 100);
}

/** Ganancia sobre el costo, en %: cuántas veces recuperamos lo que gastamos. */
function gananciaSobreCosto(precioConIva: number, creditos: number, costoFijo = 0): number {
  const ingresoNeto = neto(precioConIva);
  const costo = creditos * S.costoPorCreditoClp + precioConIva * (S.comisionFlowPct / 100) + costoFijo;
  return ((ingresoNeto - costo) / costo) * 100;
}

const base = () => catalogo.planes.find((p) => p.esPlanBase)!;
const recarga = () => catalogo.packs.find((p) => p.esRecargaBasica)!;

/** Lo que paga en un mes quien consume `creditos`: el plan más las recargas que necesite. */
function cuentaDelMes(creditos: number): { recargas: number; totalClp: number } {
  const faltan = Math.max(0, creditos - base().creditos);
  const recargas = Math.ceil(faltan / recarga().credits);
  return { recargas, totalClp: base().priceClp + recargas * recarga().priceClp };
}

describe("§8.3 — los precios aprobados el 28-oct están sembrados tal cual", () => {
  it("el plan Base es $24.990 con 300 créditos", () => {
    expect(base()).toMatchObject({ code: "conversia_creditos_base", priceClp: 24990, creditos: 300 });
  });

  it("la prueba regala 200 créditos y no incluye saldo mensual", () => {
    const trial = catalogo.planes.find((p) => p.trial);
    expect(trial).toMatchObject({ code: "conversia_creditos_trial", priceClp: 0, creditos: 0, regaloBienvenida: 200 });
  });

  it("hay UNA sola recarga —420 créditos a $24.990— y ningún pack por volumen", () => {
    // Decisión del dueño: sin descuentos por volumen por ahora. Un pack grande con
    // descuento premia justo al cliente que más cuesta.
    expect(catalogo.packs).toHaveLength(1);
    expect(recarga()).toMatchObject({ code: "conversia-cred-420", credits: 420, priceClp: 24990 });
  });

  it("los packs eliminados NO están sembrados", () => {
    for (const c of catalogo.packsEliminados.creditos) {
      expect(catalogo.packs.some((p) => p.credits === c), `el pack de ${c} créditos volvió`).toBe(false);
    }
  });

  it("los packs del catálogo anterior quedaron en la lista de eliminados", () => {
    // Si alguien los borra de la lista, el guardián de arriba deja de protegerlos.
    for (const c of [1000, 3000, 6000, 8500, 16000]) {
      expect(catalogo.packsEliminados.creditos).toContain(c);
    }
  });
});

describe("§8.3 — la calibración: el cliente de referencia paga ~$200.000 al mes", () => {
  it("los tramos de septiembre suman las respuestas y los créditos medidos", () => {
    const r = SEPTIEMBRE_DIGITAL_DENT.tramos.reduce((a, t) => a + t.respuestas, 0);
    const c = SEPTIEMBRE_DIGITAL_DENT.tramos.reduce((a, t) => a + t.respuestas * t.creditosCadaUna, 0);
    expect(r).toBe(SEPTIEMBRE_DIGITAL_DENT.respuestas);
    expect(c).toBe(SEPTIEMBRE_DIGITAL_DENT.creditos);
  });

  it("con ese consumo la cuenta del mes da ~$200.000", () => {
    const { recargas, totalClp } = cuentaDelMes(SEPTIEMBRE_DIGITAL_DENT.creditos);
    expect(recargas).toBe(7);
    expect(totalClp).toBe(199_920);
    // Dentro del 5% del objetivo: es una calibración, no una coincidencia exacta.
    expect(Math.abs(totalClp - SEPTIEMBRE_DIGITAL_DENT.objetivoMensualClp)).toBeLessThan(SEPTIEMBRE_DIGITAL_DENT.objetivoMensualClp * 0.05);
  });

  it("el tope por defecto de la recarga automática alcanza para ese mes", () => {
    // El tope viejo (3 recargas) habría cortado el servicio a mitad de mes justo al cliente
    // que más paga. Por eso sube a 10.
    const { recargas } = cuentaDelMes(SEPTIEMBRE_DIGITAL_DENT.creditos);
    expect(catalogo.recargaAutomatica.recargasEquivalentes).toBe(10);
    expect(catalogo.recargaAutomatica.topeMensualClp).toBe(recarga().priceClp * 10);
    expect(recargas).toBeLessThanOrEqual(catalogo.recargaAutomatica.recargasEquivalentes);
  });

  it("el tope que usan el api y el worker es el MISMO que dice el catálogo", () => {
    // El tope vive en `@conversia/agents` y el precio de la recarga en el JSON del
    // catálogo. Si alguien cambia el precio y no el tope, el default deja de ser "10
    // recargas" sin que nadie lo note — y el cliente se queda sin bot antes de tiempo o
    // gasta más de lo que cree. Este test los ata.
    expect(AUTO_RECARGA_DEFAULTS.topeMensualClp).toBe(catalogo.recargaAutomatica.topeMensualClp);
    expect(AUTO_RECARGA_DEFAULTS.topeMensualClp).toBe(recarga().priceClp * catalogo.recargaAutomatica.recargasEquivalentes);
  });
});

describe("§5 — el piso de ganancia de 300% sigue vigente", () => {
  it("la recarga lo cumple", () => {
    expect(gananciaSobreCosto(recarga().priceClp, recarga().credits)).toBeGreaterThanOrEqual(S.gananciaMinimaPct);
  });

  it("el plan Base también, y ya NO necesita la excepción del 260%", () => {
    // Con los precios del 27-oct el Base quedaba en 260% y estaba documentado como la única
    // excepción al piso. Con los del 28-oct lo cumple por derecho propio.
    const g = gananciaSobreCosto(base().priceClp, base().creditos, S.costoFijoPorClienteClp);
    expect(g).toBeGreaterThanOrEqual(S.gananciaMinimaPct);
  });

  it("el Base es el que queda más al límite: es el primero a revisar si sube el costo", () => {
    const gBase = gananciaSobreCosto(base().priceClp, base().creditos, S.costoFijoPorClienteClp);
    const gRecarga = gananciaSobreCosto(recarga().priceClp, recarga().credits);
    expect(gBase).toBeLessThan(gRecarga);
  });

  it("si el crédito costara 20% más, el Base queda al BORDE del piso (colchón real)", () => {
    // No es un requisito: es saber cuánto aguanta el catálogo antes de recalibrar, con un
    // número en vez de a ojo. El Base pasa de 313% a 303% — diez puntos de margen. La
    // recarga ni se despeina. Si el costo por crédito sube de verdad, lo que hay que
    // revisar es el PLAN, no las recargas.
    const costoOriginal = S.costoPorCreditoClp;
    try {
      (S as { costoPorCreditoClp: number }).costoPorCreditoClp = costoOriginal * 1.2;
      expect(gananciaSobreCosto(recarga().priceClp, recarga().credits)).toBeGreaterThan(500);
      const gBase = gananciaSobreCosto(base().priceClp, base().creditos, S.costoFijoPorClienteClp);
      expect(gBase).toBeGreaterThan(S.gananciaMinimaPct);
      expect(gBase).toBeLessThan(S.gananciaMinimaPct + 20); // al borde, y queremos saberlo
    } finally {
      (S as { costoPorCreditoClp: number }).costoPorCreditoClp = costoOriginal;
    }
  });
});

describe("§5 — lo que el cliente recibe por su plata", () => {
  it("el catálogo y el estimador del panel usan EL MISMO costo por conversación", () => {
    // Si se separan, la página de precios promete una cantidad de conversaciones y el
    // medidor de adentro otra, para el mismo saldo. Ya pasó una vez (#576).
    expect(S.creditosPorConversacion).toBe(CREDITOS_POR_CONVERSACION_POR_DEFECTO);
  });

  it("es el valor MEDIDO en septiembre, redondeado hacia arriba", () => {
    // 3.172 créditos en 727 conversaciones = 4,36. Hacia arriba, porque el costo
    // conservador es el alto: el saldo dura algo más de lo prometido, nunca menos.
    const medido = 3172 / 727;
    expect(S.creditosPorConversacion).toBeGreaterThanOrEqual(medido);
    expect(S.creditosPorConversacion).toBeLessThan(medido + 0.5);
  });

  it("la recarga rinde ~93 conversaciones", () => {
    expect(Math.round(recarga().credits / S.creditosPorConversacion)).toBe(93);
  });

  it("el plan Base rinde ~67 conversaciones al mes", () => {
    expect(Math.round(base().creditos / S.creditosPorConversacion)).toBe(67);
  });

  it("la prueba gratis rinde ~44 conversaciones", () => {
    const trial = catalogo.planes.find((p) => p.trial)!;
    expect(Math.round((trial.regaloBienvenida ?? 0) / S.creditosPorConversacion)).toBe(44);
  });

  it("la recarga cuesta lo mismo que el plan y trae 40% más créditos", () => {
    // Misma plata, más créditos: el plan carga además el costo fijo del cliente.
    expect(recarga().priceClp).toBe(base().priceClp);
    expect(recarga().credits / base().creditos).toBeCloseTo(1.4, 2);
  });
});

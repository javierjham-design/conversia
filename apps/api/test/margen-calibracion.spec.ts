import { describe, it, expect } from "vitest";
import {
  INFRA_USD_POR_CUENTA_MES,
  MARGEN_MINIMO_PCT,
  MIN_TURNOS_PARA_CALIBRAR,
  calcularMargen,
  recomendarCalibracion,
} from "../src/platform/margen";

/**
 * CRE 4 — margen por cuenta y calibración.
 *
 * Los precios de la Etapa 2 se fijaron con una meta de ≥300% de margen sobre el COSTO,
 * calculada con el consumo histórico. Si el consumo real cambia, el margen se cae sin que
 * nadie se entere hasta que llega la factura del proveedor. Esto lo hace visible — y lo que
 * se prueba acá es que no mienta en las dos direcciones: que no alerte por cuentas en
 * prueba (ruido que taparía las de verdad) y que no recomiende mover precios con una
 * muestra que no alcanza.
 */
const base = {
  organizationId: "org-1",
  nombre: "Barbería Central",
  ingresosClp: 18_990,
  costoIaUsd: 1.0,
  costoWhatsappUsd: 0,
  clpPorUsd: 950,
};

describe("margen por cuenta", () => {
  it("suma IA, WhatsApp e infraestructura", () => {
    const m = calcularMargen({ ...base, costoIaUsd: 2, costoWhatsappUsd: 1 });
    expect(m.detalle.iaClp).toBe(1_900);
    expect(m.detalle.whatsappClp).toBe(950);
    expect(m.detalle.infraClp).toBe(Math.round(INFRA_USD_POR_CUENTA_MES * 950));
    expect(m.costoClp).toBe(m.detalle.iaClp + m.detalle.whatsappClp + m.detalle.infraClp);
  });

  it("el porcentaje es sobre los INGRESOS, no sobre el costo", () => {
    // $18.990 de ingreso, $950 de IA + $1.140 de infra = $2.090 → margen 89%.
    const m = calcularMargen(base);
    expect(m.margenClp).toBe(18_990 - m.costoClp);
    expect(m.margenPct).toBe(Math.round((m.margenClp / 18_990) * 100));
    expect(m.margenPct).toBeGreaterThan(80);
  });

  it("alerta cuando el margen cae bajo el mínimo", () => {
    // Un cliente que consume mucho más de lo previsto.
    const m = calcularMargen({ ...base, costoIaUsd: 13 });
    expect(m.margenPct).toBeLessThan(MARGEN_MINIMO_PCT);
    expect(m.alerta).toBe(true);
  });

  it("una cuenta EN PRUEBA (sin ingresos) no es una alerta de margen", () => {
    // Sin esto la consola se llenaría de cuentas de prueba y taparía las que sí pierden plata.
    const m = calcularMargen({ ...base, ingresosClp: 0, costoIaUsd: 5 });
    expect(m.margenPct).toBeNull();
    expect(m.alerta).toBe(false);
  });

  it("el margen puede ser negativo y se dice como tal", () => {
    const m = calcularMargen({ ...base, ingresosClp: 1_000, costoIaUsd: 10 });
    expect(m.margenClp).toBeLessThan(0);
    expect(m.margenPct).toBeLessThan(0);
    expect(m.alerta).toBe(true);
  });

  it("justo en el umbral NO alerta (el mínimo es aceptable)", () => {
    // Se construye un caso con margen exactamente igual al mínimo.
    const costoUsd = 1;
    const infra = INFRA_USD_POR_CUENTA_MES;
    const costoClp = Math.round(costoUsd * 950) + Math.round(infra * 950);
    const ingresos = Math.round(costoClp / (1 - MARGEN_MINIMO_PCT / 100));
    const m = calcularMargen({ ...base, ingresosClp: ingresos, costoIaUsd: costoUsd });
    expect(m.margenPct).toBe(MARGEN_MINIMO_PCT);
    expect(m.alerta).toBe(false);
  });
});

describe("calibración — no recomienda con muestra insuficiente", () => {
  const chico = {
    creditos: 300,
    conversaciones: 30,
    turnos: 50,
    tokens: 500_000,
    tokensPorCredito: 20_000,
    costoIaUsd: 0.5,
    clpPorUsd: 950,
    precioCreditoClp: 19,
  };

  it("lo dice en vez de sugerir mover un precio por ruido", () => {
    const c = recomendarCalibracion(chico);
    expect(c.recomendacion).toMatch(/Muestra insuficiente/);
    expect(c.tokensPorCreditoSugerido).toBeNull();
  });

  it("pero igual informa los promedios observados", () => {
    const c = recomendarCalibracion(chico);
    expect(c.creditosPorConversacion).toBe(10);
    expect(c.tokensPorTurno).toBe(10_000);
  });
});

describe("calibración — el margen manda", () => {
  const conMargenBajo = {
    creditos: 10_000,
    conversaciones: 1_000,
    turnos: 3_000,
    tokens: 60_000_000, // 20.000 por turno = exactamente el bloque
    tokensPorCredito: 20_000,
    costoIaUsd: 100, // $95.000 CLP / 10.000 créditos = $9,5 por crédito
    clpPorUsd: 950,
    precioCreditoClp: 19, // solo 100% sobre el costo
  };

  it("si el crédito se vende por debajo de la meta, eso va PRIMERO", () => {
    const c = recomendarCalibracion(conMargenBajo);
    expect(c.margenSobreCostoPct).toBe(100);
    expect(c.recomendacion).toMatch(/margen por crédito/);
    // Y NO propone tocar el bloque de tokens: el problema es el precio o los pesos.
    expect(c.tokensPorCreditoSugerido).toBeNull();
  });

  it("calcula el costo real de producir un crédito", () => {
    expect(recomendarCalibracion(conMargenBajo).costoPorCreditoClp).toBe(9.5);
  });
});

describe("calibración — el bloque de tokens", () => {
  const sano = {
    creditos: 10_000,
    conversaciones: 1_000,
    turnos: 3_000,
    tokens: 3_000 * 20_000,
    tokensPorCredito: 20_000,
    costoIaUsd: 20, // $19.000 / 10.000 = $1,9 por crédito → 900% sobre el costo
    clpPorUsd: 950,
    precioCreditoClp: 19,
  };

  it("con el bloque bien calibrado no recomienda nada", () => {
    const c = recomendarCalibracion(sano);
    expect(c.margenSobreCostoPct).toBeGreaterThanOrEqual(300);
    expect(c.recomendacion).toBeNull();
  });

  it("si la respuesta promedio usa muy pocos tokens, avisa que el cobro se volvió PLANO", () => {
    // 2.000 tokens por turno contra un bloque de 20.000: todos cobran 1 bloque.
    const c = recomendarCalibracion({ ...sano, tokens: 3_000 * 2_000 });
    expect(c.recomendacion).toMatch(/cobro plano por respuesta/);
    expect(c.tokensPorCreditoSugerido).toBe(4_000);
  });

  it("si usa muchos más, avisa que el cliente ve caer el saldo sin entender", () => {
    // 60.000 tokens por turno: 3 bloques por respuesta.
    const c = recomendarCalibracion({ ...sano, tokens: 3_000 * 60_000, costoIaUsd: 20 });
    expect(c.recomendacion).toMatch(/más rápido de lo que espera/);
    expect(c.tokensPorCreditoSugerido).toBe(60_000);
  });

  it("el bloque sugerido es un número contable (múltiplo de 1.000)", () => {
    const c = recomendarCalibracion({ ...sano, tokens: 3_000 * 1_847 });
    expect(c.tokensPorCreditoSugerido! % 1_000).toBe(0);
  });

  it("nunca sugiere un bloque absurdamente chico", () => {
    const c = recomendarCalibracion({ ...sano, tokens: 3_000 * 10 });
    expect(c.tokensPorCreditoSugerido).toBeGreaterThanOrEqual(1_000);
  });
});

describe("calibración — bordes", () => {
  it("sin créditos ni turnos no divide por cero ni inventa números", () => {
    const c = recomendarCalibracion({
      creditos: 0,
      conversaciones: 0,
      turnos: 0,
      tokens: 0,
      tokensPorCredito: 20_000,
      costoIaUsd: 0,
      clpPorUsd: 950,
      precioCreditoClp: 19,
    });
    expect(c.creditosPorConversacion).toBe(0);
    expect(c.tokensPorTurno).toBe(0);
    expect(c.costoPorCreditoClp).toBe(0);
    expect(c.margenSobreCostoPct).toBeNull();
  });

  it("un bloque de tokens en 0 no revienta", () => {
    const c = recomendarCalibracion({
      creditos: 10_000,
      conversaciones: 1_000,
      turnos: 3_000,
      tokens: 3_000 * 20_000,
      tokensPorCredito: 0,
      costoIaUsd: 20,
      clpPorUsd: 950,
      precioCreditoClp: 19,
    });
    expect(c.recomendacion).toBeNull();
  });
});

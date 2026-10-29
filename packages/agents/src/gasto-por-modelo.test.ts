import { describe, expect, it } from "vitest";
import { explicarGastoMensual, gastoMensualConOtroModelo } from "./gasto-por-modelo";

/**
 * SUBIRLE EL MODELO A UN CLIENTE PUEDE CORTARLE EL SERVICIO.
 *
 * De `gpt-4o-mini` (peso 1) a `claude-sonnet-4-6` (peso 20) son veinte veces más créditos por
 * la misma conversación. Si eso pasa del tope mensual que el cliente fijó, su recarga
 * automática deja de cobrar y el bot se le pausa a mitad de mes — un cambio bien intencionado
 * del super admin le corta el servicio a alguien que paga, y hasta ahora no había forma de
 * verlo venir antes de apretar el botón.
 */

/** Un cliente tipo: 300 créditos al mes de plan, recarga de 420 a $24.990, tope 10 recargas. */
const CLIENTE = {
  incluidosDelPlan: 300,
  packPrecioClp: 24_990,
  packCreditos: 420,
  topeMensualClp: 249_900,
};

/** Digital-Dent en septiembre: 3.172 créditos en 30 días con el modelo estándar. */
const DIGITAL_DENT = { creditosDeLaMuestra: 3172, diasDeLaMuestra: 30, pesoActual: 1 };

describe("el gasto mensual con otro modelo", () => {
  it("sin cambiar de modelo, el estimado es su gasto de hoy", () => {
    const g = gastoMensualConOtroModelo({ ...CLIENTE, ...DIGITAL_DENT, pesoNuevo: 1 });
    expect(g.factor).toBe(1);
    expect(g.creditosAlMes).toBe(3172);
    // 3.172 − 300 incluidos = 2.872 → 7 recargas de 420 = $174.930
    expect(g.recargas).toBe(7);
    expect(g.recargasClp).toBe(174_930);
    expect(g.superaElTope).toBe(false);
  });

  it("a Haiku (peso 4) el gasto se cuadruplica y el TOPE ya no alcanza", () => {
    const g = gastoMensualConOtroModelo({ ...CLIENTE, ...DIGITAL_DENT, pesoNuevo: 4 });
    expect(g.creditosAlMes).toBe(12_688);
    expect(g.factor).toBe(4);
    expect(g.superaElTope).toBe(true);
    // Lo que importa no es el precio: pasado el tope, la recarga automática DEJA de cobrar.
    expect(g.recargasClp).toBeGreaterThan(g.topeMensualClp);
  });

  it("a Sonnet (peso 20) es veinte veces: el bot se le pausa a mitad de mes", () => {
    const g = gastoMensualConOtroModelo({ ...CLIENTE, ...DIGITAL_DENT, pesoNuevo: 20 });
    expect(g.creditosAlMes).toBe(63_440);
    expect(g.superaElTope).toBe(true);
  });

  it("BAJAR el modelo abarata, y se dice", () => {
    const g = gastoMensualConOtroModelo({ ...CLIENTE, ...DIGITAL_DENT, pesoActual: 4, pesoNuevo: 1 });
    expect(g.factor).toBe(0.25);
    expect(g.superaElTope).toBe(false);
  });

  it("la muestra se NORMALIZA al peso de hoy: no se cuenta el modelo dos veces", () => {
    // Un cliente que ya está en Haiku tiene su muestra cobrada a peso 4. Pasarlo a Sonnet
    // (20) es 5× — no 20×. Sin dividir primero, la pantalla le diría al super admin un
    // número cuatro veces más grande y le haría abortar un cambio razonable.
    const g = gastoMensualConOtroModelo({ ...CLIENTE, creditosDeLaMuestra: 12_688, diasDeLaMuestra: 30, pesoActual: 4, pesoNuevo: 20 });
    expect(g.factor).toBe(5);
    expect(g.creditosAlMes).toBe(63_440);
  });

  it("una muestra de pocos días se proyecta a 30", () => {
    const g = gastoMensualConOtroModelo({ ...CLIENTE, creditosDeLaMuestra: 100, diasDeLaMuestra: 5, pesoActual: 1, pesoNuevo: 1 });
    expect(g.creditosAlMes).toBe(600);
  });

  it("SIN consumo medido no se inventa un número", () => {
    // Alguien va a decidir sobre esto. Una proyección inventada es peor que un "no sé".
    for (const sin of [{ creditosDeLaMuestra: 0, diasDeLaMuestra: 30 }, { creditosDeLaMuestra: 500, diasDeLaMuestra: 0 }]) {
      const g = gastoMensualConOtroModelo({ ...CLIENTE, ...sin, pesoActual: 1, pesoNuevo: 20 });
      expect(g.conDatosReales).toBe(false);
      expect(g.creditosAlMes).toBe(0);
      expect(g.superaElTope).toBe(false);
    }
  });

  it("si el consumo CABE en el plan, no necesita recargas", () => {
    const g = gastoMensualConOtroModelo({ ...CLIENTE, creditosDeLaMuestra: 200, diasDeLaMuestra: 30, pesoActual: 1, pesoNuevo: 1 });
    expect(g.recargas).toBe(0);
    expect(g.recargasClp).toBe(0);
  });

  it("sin tope fijado no se afirma que lo supera", () => {
    const g = gastoMensualConOtroModelo({ ...CLIENTE, ...DIGITAL_DENT, pesoNuevo: 20, topeMensualClp: 0 });
    expect(g.superaElTope).toBe(false);
  });

  it("pesos corruptos (0, negativos) no rompen la cuenta", () => {
    const g = gastoMensualConOtroModelo({ ...CLIENTE, ...DIGITAL_DENT, pesoActual: 0, pesoNuevo: -5 });
    expect(Number.isFinite(g.creditosAlMes)).toBe(true);
    expect(Number.isFinite(g.factor)).toBe(true);
  });
});

describe("la frase para el super admin", () => {
  it("cuando el tope no alcanza, lo dice en mayúsculas y pide hablarlo con el cliente", () => {
    const g = gastoMensualConOtroModelo({ ...CLIENTE, ...DIGITAL_DENT, pesoNuevo: 20 });
    const f = explicarGastoMensual(g, "claude-sonnet-4-6");
    expect(f).toContain("SU TOPE MENSUAL");
    expect(f).toContain("se le va a pausar");
    expect(f).toContain("hablalo con el cliente");
  });

  it("cuando alcanza, dice el gasto y nada más (no asusta de gratis)", () => {
    const g = gastoMensualConOtroModelo({ ...CLIENTE, ...DIGITAL_DENT, pesoNuevo: 1 });
    const f = explicarGastoMensual(g, "gpt-4o-mini");
    expect(f).toContain("7 recarga(s)");
    expect(f).not.toContain("TOPE");
  });

  it("sin datos, lo dice en vez de mostrar ceros", () => {
    const g = gastoMensualConOtroModelo({ ...CLIENTE, creditosDeLaMuestra: 0, diasDeLaMuestra: 0, pesoActual: 1, pesoNuevo: 20 });
    expect(explicarGastoMensual(g, "claude-sonnet-4-6")).toContain("no tiene consumo medido");
  });
});

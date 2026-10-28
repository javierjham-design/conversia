import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * CRE 2 — EL CATÁLOGO DE CRÉDITOS IA CUMPLE LA REGLA DEL DUEÑO.
 *
 * El dueño fijó el 27-oct: **ganancia mínima de 300% sobre el costo** (= 75% de margen
 * sobre el neto) en todo pack, con el plan Base como única excepción (260%), porque además
 * carga el costo fijo por cliente.
 *
 * Este test encierra esa regla. Los precios se editan en
 * `packages/database/seeds/creditos-catalogo.json`, y el día que alguien cambie uno —o que
 * suba el costo del dólar y haya que recalibrar— este test dice si el catálogo sigue en
 * pie, en vez de que nos enteremos por el reporte de margen tres meses después.
 *
 * El costo de un pack son tres cosas, no una: los créditos que el cliente va a consumir,
 * la comisión de Flow sobre lo cobrado, y (solo en el plan) el costo fijo por cliente.
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
    gananciaMinimaPlanBasePct: number;
  };
  planes: Array<{ code: string; priceClp: number; creditos: number; esPlanBase?: boolean; trial?: boolean; regaloBienvenida?: number }>;
  packs: Array<{ code: string; credits: number; priceClp: number; esRecargaBasica?: boolean }>;
  packsEliminados: { creditos: number[] };
};

const S = catalogo.supuestos;

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

describe("§5/§8.2 — los precios aprobados están sembrados tal cual", () => {
  it("el plan Base es $18.990 con 100 créditos", () => {
    const base = catalogo.planes.find((p) => p.esPlanBase);
    expect(base).toMatchObject({ code: "conversia_creditos_base", priceClp: 18990, creditos: 100 });
  });

  it("la prueba regala 200 créditos y no incluye saldo mensual", () => {
    const trial = catalogo.planes.find((p) => p.trial);
    expect(trial).toMatchObject({ code: "conversia_creditos_trial", priceClp: 0, creditos: 0, regaloBienvenida: 200 });
  });

  it("los cinco packs son los aprobados, con sus precios exactos", () => {
    expect(catalogo.packs.map((p) => [p.credits, p.priceClp])).toEqual([
      [1000, 18990],
      [3000, 49990],
      [6000, 89990],
      [8500, 109990],
      [16000, 199990],
    ]);
  });

  it("la recarga básica (la de la recarga automática) es la de 1.000 a $18.990", () => {
    const basica = catalogo.packs.filter((p) => p.esRecargaBasica);
    expect(basica).toHaveLength(1);
    expect(basica[0]).toMatchObject({ credits: 1000, priceClp: 18990 });
  });

  it("los packs eliminados NO están sembrados", () => {
    // 1.150 / 2.500 / 5.000 / 11.000 / 20.000 no cumplían la regla de 300%.
    for (const c of catalogo.packsEliminados.creditos) {
      expect(catalogo.packs.some((p) => p.credits === c)).toBe(false);
    }
  });
});

describe("§5 — la regla de ganancia mínima de 300%", () => {
  it("TODOS los packs la cumplen", () => {
    const fallan: string[] = [];
    for (const p of catalogo.packs) {
      const g = gananciaSobreCosto(p.priceClp, p.credits);
      if (g < S.gananciaMinimaPct) fallan.push(`${p.code}: ${g.toFixed(0)}% (mínimo ${S.gananciaMinimaPct}%)`);
    }
    expect(fallan).toEqual([]);
  });

  it("el pack más grande es el que queda más al límite (el primero a revisar si sube el costo)", () => {
    const ganancias = catalogo.packs.map((p) => ({ code: p.code, g: gananciaSobreCosto(p.priceClp, p.credits) }));
    const peor = ganancias.reduce((a, b) => (a.g <= b.g ? a : b));
    expect(peor.code).toBe("conversia-cred-16000");
    expect(peor.g).toBeGreaterThanOrEqual(S.gananciaMinimaPct);
  });

  it("el plan Base cumple SU mínimo (260%: la excepción documentada por el costo fijo)", () => {
    const base = catalogo.planes.find((p) => p.esPlanBase)!;
    const g = gananciaSobreCosto(base.priceClp, base.creditos, S.costoFijoPorClienteClp);
    // El §5 da 260%, que es el redondeo de 259,94% (sale de sus propios números: $4.434 de
    // costo contra $15.958 netos). Se compara redondeado para no perseguir centésimas.
    expect(Math.round(g)).toBe(S.gananciaMinimaPlanBasePct);
    // Y es, efectivamente, peor que cualquier pack: la ganancia viene de las recargas.
    const mejorPack = Math.min(...catalogo.packs.map((p) => gananciaSobreCosto(p.priceClp, p.credits)));
    expect(g).toBeLessThan(mejorPack);
  });

  it("si el costo por crédito subiera 20%, los packs seguirían sobre 200% (colchón real)", () => {
    // La "sensibilidad" del §5. No es un requisito del dueño: es saber cuánto aguanta el
    // catálogo antes de que haya que recalibrar, con un número en vez de a ojo.
    const costoOriginal = S.costoPorCreditoClp;
    try {
      (S as { costoPorCreditoClp: number }).costoPorCreditoClp = costoOriginal * 1.2;
      for (const p of catalogo.packs) {
        expect(gananciaSobreCosto(p.priceClp, p.credits)).toBeGreaterThan(200);
      }
    } finally {
      (S as { costoPorCreditoClp: number }).costoPorCreditoClp = costoOriginal;
    }
  });
});

describe("§5 — lo que el cliente recibe por su plata", () => {
  it("la recarga básica rinde ~240 conversaciones, como dice el documento", () => {
    const basica = catalogo.packs.find((p) => p.esRecargaBasica)!;
    const conversaciones = Math.round(basica.credits / S.creditosPorConversacion);
    expect(conversaciones).toBeGreaterThanOrEqual(230);
    expect(conversaciones).toBeLessThanOrEqual(250);
  });

  it("el plan Base rinde ~24 conversaciones al mes (por eso la ganancia viene de las recargas)", () => {
    const base = catalogo.planes.find((p) => p.esPlanBase)!;
    expect(Math.round(base.creditos / S.creditosPorConversacion)).toBe(24);
  });

  it("la prueba gratis rinde ~48 conversaciones", () => {
    const trial = catalogo.planes.find((p) => p.trial)!;
    expect(Math.round((trial.regaloBienvenida ?? 0) / S.creditosPorConversacion)).toBe(48);
  });

  it("la recarga básica cuesta lo mismo que el plan pero trae 10 veces más créditos", () => {
    const base = catalogo.planes.find((p) => p.esPlanBase)!;
    const basica = catalogo.packs.find((p) => p.esRecargaBasica)!;
    expect(basica.priceClp).toBe(base.priceClp);
    expect(basica.credits).toBe(base.creditos * 10);
  });
});

describe("CRE 2 — el precio por crédito baja a medida que el pack crece", () => {
  it("ningún pack grande sale más caro por crédito que uno más chico", () => {
    // Si se rompiera, al cliente le convendría comprar dos packs chicos que uno grande:
    // el catálogo estaría castigando justo al que más nos deja.
    const porCredito = catalogo.packs.map((p) => ({ code: p.code, credits: p.credits, clp: p.priceClp / p.credits }));
    const ordenados = [...porCredito].sort((a, b) => a.credits - b.credits);
    for (let i = 1; i < ordenados.length; i++) {
      expect(ordenados[i].clp).toBeLessThanOrEqual(ordenados[i - 1].clp);
    }
  });
});

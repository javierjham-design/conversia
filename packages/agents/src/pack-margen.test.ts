import { describe, expect, it } from "vitest";
import {
  explicarProblemaDelPack,
  gananciaSobreCostoPct,
  netoSinIva,
  precioMinimo,
  problemaDelPack,
  type SupuestosDeCosto,
} from "./pack-margen";

/**
 * LA VALIDACIÓN QUE LE FALTABA A LA PANTALLA DEL SUPER ADMIN.
 *
 * El piso de 300% de ganancia vivía solo en el test del catálogo: protegía los precios del
 * repo y no los que se escriben a mano en la pantalla de paquetes. Un cero de más en los
 * créditos y se empieza a vender saldo bajo costo sin que nada lo frene — los packs que el
 * dueño sacó el 28-oct salieron justamente por no cumplir esta regla.
 */

const S: SupuestosDeCosto = {
  costoPorCreditoClp: 2.1,
  comisionFlowPct: 3.81,
  costoFijoPorClienteClp: 3500,
  ivaPct: 19,
  gananciaMinimaPct: 300,
};

/** Los cuatro packs vigentes. */
const CATALOGO = [
  { code: "conversia-cred-420", credits: 420, priceClp: 24_990 },
  { code: "conversia-cred-880", credits: 880, priceClp: 49_900 },
  { code: "conversia-cred-1850", credits: 1850, priceClp: 99_900 },
  { code: "conversia-cred-2900", credits: 2900, priceClp: 149_900 },
];

describe("la cuenta del margen", () => {
  it("el neto saca el IVA del precio", () => {
    expect(netoSinIva(23_800, 19)).toBeCloseTo(20_000, 0);
  });

  it("los cuatro packs vigentes cumplen el piso", () => {
    for (const p of CATALOGO) {
      expect(gananciaSobreCostoPct({ precioClp: p.priceClp, creditos: p.credits, s: S }), p.code).toBeGreaterThanOrEqual(300);
    }
  });

  it("un costo que sale cero NO es ganancia infinita: no se puede evaluar", () => {
    // Dejarlo pasar como válido sería abrir la puerta justo por donde nadie mira.
    expect(gananciaSobreCostoPct({ precioClp: 0, creditos: 0, s: S })).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("qué packs rechaza la pantalla", () => {
  const otros = CATALOGO;

  it("los cuatro vigentes se pueden guardar", () => {
    for (const p of CATALOGO) {
      expect(problemaDelPack({ pack: p, otros, s: S }), p.code).toBeNull();
    }
  });

  it("un cero de más en los créditos se rechaza (vendería bajo costo)", () => {
    // 4.200 créditos a $24.990: el costo en IA solo ya es $8.820 y el neto es $21.000.
    const pack = { code: "conversia-cred-420", credits: 4200, priceClp: 24_990 };
    expect(problemaDelPack({ pack, otros, s: S })).toBe("bajo_el_piso");
  });

  it("un precio de regalo se rechaza", () => {
    const pack = { code: "nuevo", credits: 2900, priceClp: 9_990 };
    expect(problemaDelPack({ pack, otros, s: S })).toBe("bajo_el_piso");
  });

  it("un pack MÁS CARO que da menos por peso se rechaza (el pack grande trampa)", () => {
    // $199.900 por 2.000 créditos: cumple el piso de ganancia de sobra, pero rinde menos por
    // peso que el de $149.900/2.900. El cliente que compra el grande sale perdiendo.
    const pack = { code: "nuevo", credits: 2000, priceClp: 199_900 };
    expect(gananciaSobreCostoPct({ precioClp: pack.priceClp, creditos: pack.credits, s: S })).toBeGreaterThan(300);
    expect(problemaDelPack({ pack, otros, s: S })).toBe("orden_roto");
  });

  it("EDITAR un precio puede romper el orden igual que crear un pack", () => {
    // Se sube el de 880 por encima del de 1.850 sin tocar sus créditos.
    const pack = { code: "conversia-cred-880", credits: 880, priceClp: 120_000 };
    expect(problemaDelPack({ pack, otros, s: S })).toBe("orden_roto");
  });

  it("precio o créditos en cero: no se puede evaluar", () => {
    expect(problemaDelPack({ pack: { code: "x", credits: 0, priceClp: 1000 }, otros, s: S })).toBe("sin_datos");
    expect(problemaDelPack({ pack: { code: "x", credits: 100, priceClp: 0 }, otros, s: S })).toBe("sin_datos");
  });

  it("el primer pack de un catálogo vacío solo se mide contra el piso", () => {
    expect(problemaDelPack({ pack: CATALOGO[0], otros: [], s: S })).toBeNull();
  });

  it("dos packs al MISMO precio por crédito son válidos (no se rechaza por un redondeo)", () => {
    const pack = { code: "gemelo", credits: 840, priceClp: 49_980 };
    expect(problemaDelPack({ pack, otros: [CATALOGO[0]], s: S })).toBeNull();
  });

  it("el pack que se edita no se compara CONTRA SÍ MISMO en su versión vieja", () => {
    // Si el viejo siguiera en la lista, bajarle el precio se vería como orden roto contra su
    // propia fila anterior y no se podría corregir nunca.
    const pack = { code: "conversia-cred-2900", credits: 2900, priceClp: 140_000 };
    expect(problemaDelPack({ pack, otros, s: S })).toBeNull();
  });
});

describe("el mensaje que ve el super admin", () => {
  it("dice cuánto deja y cuál es el precio mínimo para esos créditos", () => {
    const pack = { code: "x", credits: 2900, priceClp: 9_990 };
    const msg = explicarProblemaDelPack("bajo_el_piso", pack, S);
    expect(msg).toContain("el piso es 300%");
    expect(msg).toContain("precio mínimo");
    // Y el precio mínimo que dice tiene que CUMPLIR de verdad el piso.
    const minimo = Math.ceil(precioMinimo(pack.credits, S));
    expect(gananciaSobreCostoPct({ precioClp: minimo, creditos: pack.credits, s: S })).toBeGreaterThanOrEqual(300);
  });

  it("el precio mínimo es el más bajo que pasa: un peso menos NO pasa", () => {
    const minimo = Math.ceil(precioMinimo(2900, S));
    expect(gananciaSobreCostoPct({ precioClp: minimo - 2, creditos: 2900, s: S })).toBeLessThan(300);
  });

  it("explica el orden roto sin hablar de márgenes (no es el problema)", () => {
    const msg = explicarProblemaDelPack("orden_roto", { code: "x", credits: 1, priceClp: 1 }, S);
    expect(msg).toContain("créditos por peso");
    expect(msg).not.toContain("300%");
  });

  it("si la comisión se comiera el margen, no hay precio que sirva (y se dice así)", () => {
    expect(precioMinimo(100, { ...S, comisionFlowPct: 90 })).toBe(Number.POSITIVE_INFINITY);
  });
});

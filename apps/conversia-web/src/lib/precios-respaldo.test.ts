import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BASE_RESPALDO,
  CREDITOS_POR_CONVERSACION_RESPALDO,
  PACKS_RESPALDO,
  PACK_MAS_ELEGIDO,
  PACK_MEJOR_PRECIO,
  PRUEBA_RESPALDO_CREDITOS,
} from "./precios-respaldo";

/**
 * UNA SOLA FUENTE DE VERDAD PARA LOS PRECIOS (§1 del encargo del 29-oct).
 *
 * La landing muestra precios de respaldo cuando la llamada al servidor no llega. Ese respaldo
 * es el mismo hecho escrito dos veces, y lo peor de un número duplicado es CUÁNDO se ve:
 * solo cuando algo falla, o sea cuando nadie está mirando. El día que el dueño cambie un
 * precio en el catálogo, la landing seguiría anunciando el viejo a quien tenga mala red.
 *
 * Este test ata los dos lados. Si se cae, no hay que "arreglar el test": hay que copiar el
 * precio nuevo al respaldo.
 */

const catalogo = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "..", "packages", "database", "seeds", "creditos-catalogo.json"), "utf-8"),
) as {
  supuestos: { creditosPorConversacion: number };
  planes: Array<{ code: string; priceClp: number; creditos: number; esPlanBase?: boolean; trial?: boolean; regaloBienvenida?: number }>;
  packs: Array<{ code: string; name: string; credits: number; priceClp: number; bonoPct: number; masElegido?: boolean; mejorPrecio?: boolean }>;
};

describe("el respaldo de la landing dice lo mismo que el catálogo", () => {
  it("el plan Base: precio y créditos incluidos", () => {
    const base = catalogo.planes.find((p) => p.esPlanBase)!;
    expect(BASE_RESPALDO.priceClp).toBe(base.priceClp);
    expect(BASE_RESPALDO.creditos).toBe(base.creditos);
  });

  it("los créditos de regalo de la prueba", () => {
    const trial = catalogo.planes.find((p) => p.trial)!;
    expect(PRUEBA_RESPALDO_CREDITOS).toBe(trial.regaloBienvenida);
  });

  it("los packs: mismos códigos, créditos, precios y bono, en el mismo orden", () => {
    expect(PACKS_RESPALDO.map((p) => [p.code, p.credits, p.priceClp, p.bonoPct])).toEqual(
      catalogo.packs.map((p) => [p.code, p.credits, p.priceClp, p.bonoPct]),
    );
  });

  it("los nombres también (son los que lee el visitante)", () => {
    expect(PACKS_RESPALDO.map((p) => p.name)).toEqual(catalogo.packs.map((p) => p.name));
  });

  it("los créditos por conversación del estimador", () => {
    // Si no fueran el mismo número, la landing prometería un alcance distinto del que el
    // cliente va a ver en el medidor del panel.
    expect(CREDITOS_POR_CONVERSACION_RESPALDO).toBe(catalogo.supuestos.creditosPorConversacion);
  });

  it("los packs destacados son los que marca el catálogo", () => {
    expect(PACK_MAS_ELEGIDO).toBe(catalogo.packs.find((p) => p.masElegido)?.code);
    expect(PACK_MEJOR_PRECIO).toBe(catalogo.packs.find((p) => p.mejorPrecio)?.code);
  });

  it("hay exactamente UN pack destacado de cada clase", () => {
    // Dos "más elegido" es una página que no decide; ninguno es un destacado que se perdió
    // en una edición del catálogo.
    expect(catalogo.packs.filter((p) => p.masElegido)).toHaveLength(1);
    expect(catalogo.packs.filter((p) => p.mejorPrecio)).toHaveLength(1);
  });

  it("el 'mejor precio por crédito' es de verdad el mejor", () => {
    // Si no lo fuera, el cartel mandaría al cliente al pack equivocado.
    const porPeso = catalogo.packs.map((p) => ({ code: p.code, v: p.credits / p.priceClp }));
    const mejor = porPeso.reduce((a, b) => (b.v > a.v ? b : a));
    expect(PACK_MEJOR_PRECIO).toBe(mejor.code);
  });
});

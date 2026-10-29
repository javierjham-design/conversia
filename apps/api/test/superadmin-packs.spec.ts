import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { explicarProblemaDelPack, problemaDelPack, type SupuestosDeCosto } from "@conversia/agents";
import { leerSupuestosDeCosto } from "../src/platform/supuestos-de-costo";

/**
 * LA PANTALLA DE PAQUETES DEL SUPER ADMIN NO PUEDE VENDER BAJO COSTO.
 *
 * El piso de 300% de ganancia vivía solo en el test del catálogo: protegía los precios que
 * están en el repo y NO los que el dueño escribe a mano en la pantalla. Un cero de más en los
 * créditos, o uno de menos en el precio, y se empieza a vender saldo bajo costo sin que nada
 * lo frene — y los packs que él mismo sacó del catálogo el 28-oct salieron justamente por no
 * cumplir esta regla.
 *
 * Lo que se prueba acá es lo que hace que "la misma cuenta que el test" sea literal: que el
 * endpoint lea los MISMOS supuestos del MISMO archivo, y que con ellos rechace lo que tiene
 * que rechazar.
 */

const catalogo = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "packages", "database", "seeds", "creditos-catalogo.json"), "utf-8"),
) as { supuestos: Record<string, number>; packs: Array<{ code: string; credits: number; priceClp: number }> };

describe("los supuestos que usa el endpoint son los del catálogo", () => {
  it("se leen del mismo archivo, campo por campo", () => {
    // Si el endpoint leyera otros supuestos, podría aprobar un precio que el test rechaza (o
    // al revés) y nadie entendería por qué.
    const s = leerSupuestosDeCosto();
    expect(s).not.toBeNull();
    expect(s).toEqual({
      costoPorCreditoClp: catalogo.supuestos.costoPorCreditoClp,
      comisionFlowPct: catalogo.supuestos.comisionFlowPct,
      costoFijoPorClienteClp: catalogo.supuestos.costoFijoPorClienteClp,
      ivaPct: catalogo.supuestos.ivaPct,
      gananciaMinimaPct: catalogo.supuestos.gananciaMinimaPct,
    });
  });

  it("se cachean: es un archivo del repo, no cambia en caliente", () => {
    expect(leerSupuestosDeCosto()).toBe(leerSupuestosDeCosto());
  });
});

describe("qué deja guardar y qué no", () => {
  const s = leerSupuestosDeCosto() as SupuestosDeCosto;
  const otros = catalogo.packs.map((p) => ({ code: p.code, credits: p.credits, priceClp: p.priceClp }));

  it("los cuatro packs sembrados pasan la validación del endpoint", () => {
    // Si no pasaran, el dueño no podría ni volver a guardar lo que ya está vendido.
    for (const p of otros) {
      expect(problemaDelPack({ pack: p, otros, s }), p.code).toBeNull();
    }
  });

  it("un cero de más en los créditos se rechaza, con el precio mínimo en el mensaje", () => {
    const pack = { code: "conversia-cred-880", credits: 8800, priceClp: 49_900 };
    const problema = problemaDelPack({ pack, otros, s });
    expect(problema).toBe("bajo_el_piso");
    const msg = explicarProblemaDelPack(problema!, pack, s);
    expect(msg).toContain("precio mínimo");
    expect(msg).toContain(`${s.gananciaMinimaPct}%`);
  });

  it("un pack grande que rinde menos por peso se rechaza (es una trampa para el cliente)", () => {
    const pack = { code: "nuevo", credits: 1900, priceClp: 199_900 };
    expect(problemaDelPack({ pack, otros, s })).toBe("orden_roto");
  });
});

describe("el código del pack admite los códigos que están vendidos de verdad", () => {
  // El regex del endpoint pedía `^[a-z0-9_]+$` y TODOS los códigos reales llevan guión: la
  // pantalla no podía crear ni renombrar un pack al formato que usa el catálogo, y el 400
  // hablaba de guiones bajos, así que ni se entendía el motivo.
  const regex = /^[a-z0-9_-]+$/;

  it("acepta los códigos del catálogo", () => {
    for (const p of catalogo.packs) expect(regex.test(p.code), p.code).toBe(true);
  });

  it("acepta también el formato viejo con guión bajo", () => {
    expect(regex.test("conversia_sobre_500")).toBe(true);
  });

  it("sigue rechazando mayúsculas, espacios y puntos", () => {
    for (const malo of ["Conversia-Cred", "cred 420", "cred.420", "créd-420", ""]) {
      expect(regex.test(malo), malo).toBe(false);
    }
  });
});

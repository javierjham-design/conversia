import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cortesiaDelPlan, incluidoDelPlan, planDePrepagoEnVenta, type PlanPrepago } from "../src/billing/plan-prepago";

/**
 * CRE 2 — EL ESTIMADO Y EL BOTÓN TIENEN QUE HABLAR DEL MISMO PLAN.
 *
 * El go-live de Créditos IA apaga `conversia_v2_base` y enciende `conversia_creditos_base`.
 * `v2-migrate` ya elegía el plan activo, pero `v2-simulator` leía `conversia_v2_base`
 * escrito a mano: el día del encendido, el único cliente que paga veía el banner "paga solo
 * por conversación" con un estimado de "$18.900 + $219 por conversación extra" al lado de un
 * botón que lo dejaba en "$24.990 con 300 créditos", y el mensaje de éxito le prometía "100
 * conversaciones de cortesía" cuando el plan le acredita 1.000 créditos.
 *
 * Estos tests fijan las tres cosas: una sola fuente para el plan, la cortesía leída del plan
 * y nada escrito a mano en las dos rutas ni en la pantalla.
 */

const CREDITOS: PlanPrepago = {
  code: "conversia_creditos_base",
  active: true,
  priceClp: 24990,
  priceUsd: 25,
  features: { aiCreditsWallet: true, aiCreditsIncluded: 300, migrationCourtesyCredits: 1000 },
};
const CONVERSACIONES: PlanPrepago = {
  code: "conversia_v2_base",
  active: true,
  priceClp: 18900,
  priceUsd: 19,
  features: { conversationDebitsWallet: true, conversationsIncluded: 100, migrationCourtesyCredits: 100 },
};

/** Doble del lector de planes: devuelve lo que se le pase, por código. */
const lector = (planes: PlanPrepago[]) => ({
  plan: {
    findUnique: async ({ where }: { where: { code: string } }) => planes.find((p) => p.code === where.code) ?? null,
  },
});

const apagado = (p: PlanPrepago): PlanPrepago => ({ ...p, active: false });

describe("plan de prepago en venta (una sola fuente)", () => {
  it("con el catálogo de créditos ENCENDIDO manda créditos", async () => {
    const r = await planDePrepagoEnVenta(lector([CREDITOS, apagado(CONVERSACIONES)]));
    expect(r?.unit).toBe("credit");
    expect(r?.plan.code).toBe("conversia_creditos_base");
  });

  it("con el catálogo de créditos APAGADO sigue rigiendo el de conversaciones", async () => {
    const r = await planDePrepagoEnVenta(lector([apagado(CREDITOS), CONVERSACIONES]));
    expect(r?.unit).toBe("conversation");
    expect(r?.plan.code).toBe("conversia_v2_base");
  });

  it("sin ningún plan activo devuelve null: no se cotiza un precio inventado", async () => {
    expect(await planDePrepagoEnVenta(lector([apagado(CREDITOS), apagado(CONVERSACIONES)]))).toBeNull();
    expect(await planDePrepagoEnVenta(lector([]))).toBeNull();
  });

  it("prefiere créditos aunque los DOS estén activos (mismo orden que TRIAL_PLAN_CODES)", async () => {
    // Estado transitorio posible a mitad de un go-live: la preferencia tiene que ser la
    // misma que la del registro de cuentas nuevas, o una cuenta nueva y una que migra
    // terminarían en modelos distintos.
    const r = await planDePrepagoEnVenta(lector([CREDITOS, CONVERSACIONES]));
    expect(r?.unit).toBe("credit");
  });

  it("un error de base no explota: se comporta como si no hubiera plan", async () => {
    const roto = { plan: { findUnique: async () => { throw new Error("db caída"); } } };
    expect(await planDePrepagoEnVenta(roto)).toBeNull();
  });
});

describe("lo incluido y la cortesía salen del PLAN", () => {
  it("lee el incluido de la unidad correcta", () => {
    expect(incluidoDelPlan(CREDITOS, "credit")).toBe(300);
    expect(incluidoDelPlan(CONVERSACIONES, "conversation")).toBe(100);
  });

  it("si el plan no declara el incluido devuelve 0, no un número inventado", () => {
    expect(incluidoDelPlan({ ...CREDITOS, features: {} }, "credit")).toBe(0);
    expect(incluidoDelPlan({ ...CREDITOS, features: null }, "credit")).toBe(0);
  });

  it("la cortesía de créditos son 1.000 y la de conversaciones 100", () => {
    expect(cortesiaDelPlan(CREDITOS)).toBe(1000);
    expect(cortesiaDelPlan(CONVERSACIONES)).toBe(100);
  });
});

describe("nada de precios ni unidades escritos a mano en el camino del grandfathering", () => {
  const src = readFileSync(join(__dirname, "..", "src", "billing", "billing.controller.ts"), "utf8");
  /**
   * Los TRES bloques del grandfathering, cada uno por separado: el que arma el banner, el
   * que estima y el que contrata.
   *
   * Por qué uno por uno y no un tramo grande: probé con un tramo desde `@Get("v2-simulator")`
   * y la mutación de prueba cayó en el bloque del banner, FUERA del tramo, dejando el
   * guardián verde con el literal puesto. Y un tramo que arranque en `@Get("v2")` se come el
   * bloque `activation`, que nombra los dos códigos con razón: ahí la pregunta es "qué
   * incluye MI plan", no "qué plan está en venta". Tres rebanadas exactas es lo único que
   * cubre los tres sitios sin dar falsos positivos.
   */
  const trozo = (desdeTxt: string, hastaTxt: string, nombre: string): string => {
    const desde = src.indexOf(desdeTxt);
    const hasta = src.indexOf(hastaTxt, desde + 1);
    expect(desde, `no se encontró el inicio de ${nombre}`).toBeGreaterThan(-1);
    expect(hasta, `no se encontró el final de ${nombre}`).toBeGreaterThan(desde);
    const t = src.slice(desde, hasta);
    expect(t.length, `la rebanada de ${nombre} salió vacía`).toBeGreaterThan(200);
    return t;
  };
  const BLOQUES: Array<[string, string]> = [
    ["banner", trozo("// Grandfathering: org conversia V1", "return { isV2,", "banner")],
    ["simulador", trozo('@Get("v2-simulator")', '@Post("v2-migrate")', "simulador")],
    ["migración", trozo('@Post("v2-migrate")', "private async activate(", "migración")],
  ];
  const tramo = BLOQUES.map(([, t]) => t).join("\n");

  it.each(BLOQUES)("el bloque del %s no nombra un plan escrito a mano", (nombre, bloque) => {
    // Antes: `findUnique({ where: { code: "conversia_v2_base" } })` dentro del simulador.
    // El nombre de cada plan solo puede vivir en `plan-prepago.ts`, que es quien decide.
    expect(bloque, `el ${nombre} volvió a nombrar el plan por conversación`).not.toContain('"conversia_v2_base"');
    expect(bloque, `el ${nombre} volvió a nombrar el plan de créditos`).not.toContain('"conversia_creditos_base"');
  });

  it.each(BLOQUES)("el bloque del %s resuelve el plan por el helper compartido", (nombre, bloque) => {
    const veces = bloque.match(/planDePrepagoEnVenta\(/g)?.length ?? 0;
    expect(veces, `el ${nombre} tiene que leer el mismo helper, exactamente una vez`).toBe(1);
  });

  it("no queda ningún 18900 ni 100 de cortesía de respaldo", () => {
    expect(tramo).not.toContain("18900");
    expect(tramo).not.toContain("courtesyCredits: 100");
    expect(tramo).toContain("cortesiaDelPlan");
  });

  it("la respuesta del simulador declara la unidad", () => {
    expect(tramo).toMatch(/\n\s+unit,/);
    expect(tramo).toContain("courtesy:");
  });
});

describe("la pantalla no titula con una unidad fija", () => {
  const ui = readFileSync(join(__dirname, "..", "..", "conversia-web", "src", "app", "inicio", "page.tsx"), "utf8");
  /** El bloque del banner de grandfathering (Caso A). */
  const caso = (() => {
    const desde = ui.indexOf("Caso A");
    const hasta = ui.indexOf("Caso B");
    expect(desde, "no se encontró el Caso A").toBeGreaterThan(-1);
    expect(hasta).toBeGreaterThan(desde);
    return ui.slice(desde, hasta);
  })();

  it("el título depende de la unidad destino, no es una frase fija", () => {
    expect(caso).toContain("targetUnit");
    expect(caso).toContain("esCred");
    // La frase vieja solo puede aparecer como la RAMA de conversaciones, nunca sola.
    const titulosFijos = caso.match(/>Nuevo: paga solo por conversación</g);
    expect(titulosFijos, "el título quedó escrito fijo otra vez").toBeNull();
  });

  it("la cortesía del mensaje de éxito viene de la respuesta, no escrita a mano", () => {
    const migrar = ui.slice(ui.indexOf("v2-migrate") - 400, ui.indexOf("v2-migrate") + 900);
    expect(migrar).toContain("courtesyCredits");
    expect(migrar).not.toContain("100 conversaciones del primer mes");
  });
});

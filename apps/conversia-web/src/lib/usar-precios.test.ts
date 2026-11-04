import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("./api-base", () => ({ apiBase: () => "http://api.test" }));

import { derivarPrecios, elegirPlanBase } from "./usar-precios";

/**
 * EL PRECIO QUE NO ESTÁ CONFIRMADO NO SE MUESTRA.
 *
 * Hallazgo en producción (3-nov, con M0 recién desplegado): `conversia.cl` servía
 * **"Desde $24.990 al mes"** y **"300 conversaciones incluidos al mes"** mientras el plan
 * activo cobraba **$18.900 por 30 conversaciones**. La causa: los precios se piden al
 * servidor desde el navegador, y mientras la respuesta no llega el hook devolvía
 * `BASE_RESPALDO` — que son los números del catálogo de CRÉDITOS, el que todavía está
 * APAGADO. O sea el respaldo de un catálogo contestaba por el otro.
 *
 * No era un parpadeo: la portada es prerenderizada, así que ese precio equivocado estaba en
 * el HTML que ven Google, el revisor de anuncios de Meta y cualquiera cuya llamada a la API
 * no llegue. Y es justo lo que las reglas del encargo prohíben: afirmar lo que no se puede
 * comprobar.
 *
 * El arreglo tiene dos mitades y las dos se prueban acá:
 *  - `basePrice`/`baseIncluded` son `null` mientras el catálogo no esté CONFIRMADO. Es el
 *    tipo el que obliga a cada página a resolver ese caso, no un comentario.
 *  - el precio llega en el HTML: lo lee el servidor (`leerCatalogo`) y entra como estado
 *    inicial, así que el prerenderizado ya trae el del catálogo activo.
 */

const V2 = { code: "conversia_v2_base", priceClp: 18_900, features: { conversationsIncluded: 30 } };
const CREDITOS = {
  code: "conversia_creditos_base",
  priceClp: 24_990,
  features: { aiCreditsIncluded: 300, signupGiftCredits: 200, billingUnit: "credits" },
};

describe("sin catálogo confirmado no hay precio", () => {
  it("NO inventa un precio ni una cantidad", () => {
    const p = derivarPrecios(null, []);
    expect(p.basePrice).toBeNull();
    expect(p.baseIncluded).toBeNull();
    expect(p.desdeElServidor).toBe(false);
  });

  it("y no se cuela el precio del catálogo apagado", () => {
    // El bug exacto: con el catálogo de conversaciones activo se mostraba $24.990, que es el
    // precio del de créditos. Un respaldo no puede contestar por un catálogo que no es el suyo.
    const p = derivarPrecios(null, []);
    expect(JSON.stringify({ basePrice: p.basePrice, baseIncluded: p.baseIncluded })).not.toMatch(/24[.,]?990|300/);
  });

  it("la unidad y la prueba caen al modelo VIEJO, que es el que rige mientras no se confirme otro", () => {
    const p = derivarPrecios(null, []);
    expect(p.esCreditos).toBe(false);
    expect(p.unidad).toBe("conversaciones");
    expect(p.pruebaGratis).toBe(30);
  });

  it("tampoco muestra la lista de packs del catálogo apagado", () => {
    // La portada servía "420 conversaciones · $24.990": packs de CRÉDITOS rotulados como
    // conversaciones. El respaldo de packs solo vale si se confirmó que ese catálogo es el
    // activo; sin confirmar, la tarjeta se queda sin lista.
    expect(derivarPrecios(null, []).packs).toEqual([]);
  });

  it("con el catálogo de conversaciones tampoco se cuelan los packs de créditos", () => {
    expect(derivarPrecios(V2, []).packs).toEqual([]);
  });

  it("pero con el de créditos confirmado, el respaldo de packs SÍ sirve", () => {
    // Acá el respaldo habla de su propio catálogo, que es para lo que existe.
    expect(derivarPrecios(CREDITOS, []).packs.length).toBeGreaterThan(0);
  });
});

describe("con el catálogo que está activo HOY (conversaciones)", () => {
  const p = derivarPrecios(V2, []);
  it("muestra su precio y su cantidad, no las del otro", () => {
    expect(p.basePrice).toBe("$18.900");
    expect(p.baseIncluded).toBe(30);
    expect(p.desdeElServidor).toBe(true);
  });
  it("habla de conversaciones", () => {
    expect(p.esCreditos).toBe(false);
    expect(p.unidad).toBe("conversaciones");
    expect(p.aprox(420)).toBe("");
  });
});

describe("con el catálogo de créditos encendido", () => {
  const p = derivarPrecios(CREDITOS, []);
  it("cambia precio, cantidad y unidad sin desplegar nada", () => {
    expect(p.basePrice).toBe("$24.990");
    expect(p.baseIncluded).toBe(300);
    expect(p.esCreditos).toBe(true);
    expect(p.unidad).toBe("créditos");
  });
  it("el regalo de la prueba sale del PLAN (el mismo campo que acredita la cuenta)", () => {
    expect(p.pruebaGratis).toBe(200);
  });
  it("si el plan no trae el regalo, cae al respaldo del catálogo de créditos", () => {
    const sinRegalo = derivarPrecios({ ...CREDITOS, features: { aiCreditsIncluded: 300, billingUnit: "credits" } }, []);
    expect(sinRegalo.pruebaGratis).toBe(200);
  });
});

describe("elegirPlanBase", () => {
  it("prefiere el de créditos cuando los dos vienen activos", () => {
    expect(elegirPlanBase([V2, CREDITOS])?.code).toBe("conversia_creditos_base");
  });
  it("usa el viejo cuando es el único", () => {
    expect(elegirPlanBase([V2])?.code).toBe("conversia_v2_base");
  });
  it("devuelve null ante una lista vacía o basura (nunca un precio inventado)", () => {
    expect(elegirPlanBase([])).toBeNull();
    expect(elegirPlanBase(null as never)).toBeNull();
    expect(elegirPlanBase([{ code: "otro", priceClp: 1 }])).toBeNull();
  });
});

describe("el respaldo de precio no puede volver por la ventana", () => {
  it("`usar-precios.ts` ya no usa BASE_RESPALDO para el precio", () => {
    // Si alguien lo reintroduce "para que no quede vacío", vuelve el bug de producción.
    const src = readFileSync(resolve(__dirname, "usar-precios.ts"), "utf8");
    expect(src).not.toContain("BASE_RESPALDO");
  });
});

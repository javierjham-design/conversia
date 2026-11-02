import { describe, it, expect } from "vitest";
import { miniSitioPublicado } from "../src/public/public.controller";

/**
 * PUERTA DEL MINI-SITIO PÚBLICO. Es lo único que separa los datos de un negocio de internet,
 * y desde que el logo se sirve por su propia ruta hay DOS rutas públicas que dependen de ella.
 * Por eso la condición es una función y no está copiada en cada una: una copia mal hecha
 * publica el logo de un cliente que todavía no salió al aire.
 */
describe("miniSitioPublicado", () => {
  const publicado = { brand: "conversia", settings: { miniSite: { enabled: true } } };

  it("publicado y de la marca correcta: sí", () => {
    expect(miniSitioPublicado(publicado)).toBe(true);
  });

  it("el dueño NO lo publicó: no", () => {
    expect(miniSitioPublicado({ brand: "conversia", settings: { miniSite: { enabled: false } } })).toBe(false);
    // Nunca lo tocó: sin la sección, y sin la bandera dentro de ella.
    expect(miniSitioPublicado({ brand: "conversia", settings: {} })).toBe(false);
    expect(miniSitioPublicado({ brand: "conversia", settings: { miniSite: {} } })).toBe(false);
  });

  it("el mini-sitio es de Conversia: una org de TuBot no publica por esta vía", () => {
    expect(miniSitioPublicado({ brand: "tubot", settings: { miniSite: { enabled: true } } })).toBe(false);
    expect(miniSitioPublicado({ brand: null, settings: { miniSite: { enabled: true } } })).toBe(false);
  });

  it("el slug no existe: no (y sin reventar)", () => {
    expect(miniSitioPublicado(null)).toBe(false);
  });

  it("solo el booleano `true` publica, no lo que se le parezca", () => {
    // `enabled: "true"` o `1` vienen de un PUT mal tipado o de un seed a mano. Si contaran como
    // publicado, un dato sucio sacaría el negocio al aire sin que nadie lo decidiera.
    expect(miniSitioPublicado({ brand: "conversia", settings: { miniSite: { enabled: "true" } } })).toBe(false);
    expect(miniSitioPublicado({ brand: "conversia", settings: { miniSite: { enabled: 1 } } })).toBe(false);
  });

  it("settings nulo o basura no explota", () => {
    expect(miniSitioPublicado({ brand: "conversia", settings: null })).toBe(false);
    expect(miniSitioPublicado({ brand: "conversia" })).toBe(false);
  });
});

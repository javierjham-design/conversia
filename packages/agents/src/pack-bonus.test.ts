import { describe, expect, it } from "vitest";
import { bonoDePacks, textoDelBono } from "./pack-bonus";

/**
 * EL BONO QUE SE LE PROMETE AL CLIENTE.
 *
 * Es un número que va en la página de precios al lado de un precio, así que no puede estar
 * guardado aparte: el día que alguien cambie el precio de un pack y no el bono, la página
 * promete un extra que el pack no da. Acá se prueba que el cálculo aguante lo que le va a
 * llegar desde la base (packs sin recarga básica marcada, precios en 0, un pack solo).
 */

const CATALOGO = [
  { credits: 420, priceClp: 24_990, esRecargaBasica: true },
  { credits: 880, priceClp: 49_900 },
  { credits: 1850, priceClp: 99_900 },
  { credits: 2900, priceClp: 149_900 },
];

describe("el bono se calcula contra la recarga básica", () => {
  it("los cuatro packs del catálogo dan 0 / 5 / 10 / 15", () => {
    expect(bonoDePacks(CATALOGO)).toEqual([0, 5, 10, 15]);
  });

  it("la recarga básica nunca tiene bono (es la referencia de sí misma)", () => {
    expect(bonoDePacks([CATALOGO[0]])).toEqual([0]);
  });

  it("sin recarga básica marcada se usa el pack MÁS BARATO como referencia", () => {
    // Es el que el cliente compraría por defecto, así que es contra ese que un pack grande
    // tiene que ofrecer algo. Con el orden al revés el resultado tiene que ser el mismo.
    const sinMarca = CATALOGO.map(({ credits, priceClp }) => ({ credits, priceClp }));
    expect(bonoDePacks(sinMarca)).toEqual([0, 5, 10, 15]);
    expect(bonoDePacks([...sinMarca].reverse())).toEqual([15, 10, 5, 0]);
  });

  it("un pack MÁS CARO por crédito no anuncia un bono negativo", () => {
    // Si pasara, lo correcto es no prometer nada —y lo caza el test de orden del catálogo—,
    // no anunciarle al cliente un "-3% de créditos extra".
    const r = bonoDePacks([
      { credits: 420, priceClp: 24_990, esRecargaBasica: true },
      { credits: 400, priceClp: 30_000 },
    ]);
    expect(r).toEqual([0, 0]);
  });

  it("precios o créditos en 0 (fila a medio editar) dan 0 y no NaN", () => {
    const r = bonoDePacks([
      { credits: 420, priceClp: 24_990, esRecargaBasica: true },
      { credits: 0, priceClp: 49_900 },
      { credits: 880, priceClp: 0 },
    ]);
    expect(r).toEqual([0, 0, 0]);
    expect(r.every((x) => Number.isFinite(x))).toBe(true);
  });

  it("una lista vacía no rompe nada", () => {
    expect(bonoDePacks([])).toEqual([]);
  });

  it("si TODOS los packs están corruptos devuelve ceros, no NaN", () => {
    expect(bonoDePacks([{ credits: 0, priceClp: 0 }])).toEqual([0]);
  });

  it("el bono se redondea al entero (la página no muestra '4,93%')", () => {
    expect(bonoDePacks(CATALOGO)[1]).toBe(5);
  });
});

describe("el texto del bono", () => {
  it("con bono lo anuncia; sin bono no dice nada", () => {
    expect(textoDelBono(10)).toBe("+10% de créditos extra");
    expect(textoDelBono(0)).toBe("");
    expect(textoDelBono(-5)).toBe("");
  });
});

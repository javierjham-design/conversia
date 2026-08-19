import { describe, expect, it } from "vitest";
import { normalizeBsaleProduct } from "./bsale";

// Producto de Bsale con variantes embebidas (expand=[variants,product_type]).
const product = {
  id: 321,
  name: "Café en grano 1kg",
  description: "Tostado medio, origen Colombia.",
  state: 0, // 0 = activo
  product_type: { id: 7, name: "Cafés" },
  variants: {
    items: [
      { id: 900, code: "CAF-1K", barCode: "7809999000011", unlimitedStock: 0, state: 0 },
      { id: 901, code: "CAF-1K-DESC", barCode: "7809999000028", unlimitedStock: 0, state: 0 },
    ],
  },
};
// Mapas resueltos por el adaptador (lista de precios por defecto + stock sumado).
const prices = { "900": 9990, "901": 8990 };
const stocks = { "900": { qty: 12, unlimited: false }, "901": { qty: 3, unlimited: false } };

describe("normalizeBsaleProduct — mapeo Bsale → NormalizedItem", () => {
  const n = normalizeBsaleProduct(product, prices, stocks, "CLP")!;

  it("identidad, categoría (product_type) y sku/barcode de la 1ª variante", () => {
    expect(n.externalId).toBe("321");
    expect(n.kind).toBe("product");
    expect(n.name).toBe("Café en grano 1kg");
    expect(n.category).toBe("Cafés");
    expect(n.sku).toBe("CAF-1K");
    expect(n.barcode).toBe("7809999000011");
  });

  it("precio = menor de las variantes; stock = suma de variantes", () => {
    expect(n.price).toBe(8990);
    expect(n.trackStock).toBe(true);
    expect(n.stock).toBe(15);
    expect(n.available).toBe(true);
  });

  it("stock ilimitado en una variante → sin seguimiento y disponible", () => {
    const out = normalizeBsaleProduct(
      { ...product, variants: { items: [{ id: 900, code: "X", unlimitedStock: 1 }] } },
      { "900": 9990 },
      {},
      "CLP",
    )!;
    expect(out.trackStock).toBe(false);
    expect(out.stock).toBeNull();
    expect(out.available).toBe(true);
  });

  it("producto inactivo (state=1) → no disponible", () => {
    const out = normalizeBsaleProduct({ ...product, state: 1 }, prices, stocks, "CLP")!;
    expect(out.available).toBe(false);
  });

  it("sin stock (todas las variantes en 0) → no disponible", () => {
    const out = normalizeBsaleProduct(product, prices, { "900": { qty: 0, unlimited: false }, "901": { qty: 0, unlimited: false } }, "CLP")!;
    expect(out.stock).toBe(0);
    expect(out.available).toBe(false);
  });

  it("sin precio en los mapas → price null", () => {
    const out = normalizeBsaleProduct(product, {}, stocks, "CLP")!;
    expect(out.price).toBeNull();
  });

  it("producto sin id → null", () => {
    expect(normalizeBsaleProduct({ name: "x" }, {}, {}, "CLP")).toBeNull();
  });
});

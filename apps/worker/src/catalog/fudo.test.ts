import { describe, expect, it } from "vitest";
import { normalizeFudoProduct } from "./fudo";

// Recurso JSON:API de un producto (plato) de Fudo, con relación a su categoría.
const dish = {
  type: "Product",
  id: "55",
  attributes: {
    name: "Pizza Margarita",
    price: 8900,
    description: "Salsa de tomate, mozzarella y albahaca.",
    active: true,
    code: "PIZ-MAR",
    stockControl: false,
  },
  relationships: { productCategory: { data: { type: "ProductCategory", id: "3" } } },
};
const categories = { "3": "Pizzas", "4": "Bebidas" };

describe("normalizeFudoProduct — mapeo Fudo (JSON:API) → NormalizedItem", () => {
  const n = normalizeFudoProduct(dish, categories, "CLP")!;

  it("mapea identidad, precio y kind=dish", () => {
    expect(n.externalId).toBe("55");
    expect(n.kind).toBe("dish");
    expect(n.name).toBe("Pizza Margarita");
    expect(n.sku).toBe("PIZ-MAR");
    expect(n.price).toBe(8900);
    expect(n.currency).toBe("CLP");
  });

  it("categoría → menuSection", () => {
    expect(n.category).toBe("Pizzas");
    expect(n.menuSection).toBe("Pizzas");
  });

  it("sin control de stock → trackStock false, disponible", () => {
    expect(n.trackStock).toBe(false);
    expect(n.stock).toBeNull();
    expect(n.available).toBe(true);
  });

  it("con control de stock en 0 → no disponible", () => {
    const out = normalizeFudoProduct({ ...dish, attributes: { ...dish.attributes, stockControl: true, stock: 0 } }, categories, "CLP")!;
    expect(out.trackStock).toBe(true);
    expect(out.stock).toBe(0);
    expect(out.available).toBe(false);
  });

  it("inactivo → no disponible", () => {
    const out = normalizeFudoProduct({ ...dish, attributes: { ...dish.attributes, active: false } }, categories, "CLP")!;
    expect(out.available).toBe(false);
  });

  it("categoría desconocida → menuSection null", () => {
    const out = normalizeFudoProduct(dish, {}, "CLP")!;
    expect(out.menuSection).toBeNull();
  });

  it("recurso sin id → null", () => {
    expect(normalizeFudoProduct({ type: "Product", attributes: { name: "x" } }, categories, "CLP")).toBeNull();
  });
});

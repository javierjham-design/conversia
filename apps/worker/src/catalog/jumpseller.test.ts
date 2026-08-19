import { describe, expect, it } from "vitest";
import { normalizeJumpsellerProduct } from "./jumpseller";

// Fixture representativo de un producto de Jumpseller (envuelto en { product }).
const jsProduct = {
  product: {
    id: 987,
    name: "Polera algodón orgánico",
    sku: "POL-ORG-M",
    price: 12990,
    stock: 8,
    stock_unlimited: false,
    status: "available",
    description: "<p>Polera <b>suave</b> de algodón orgánico.</p>",
    permalink: "https://mitienda.jumpseller.com/polera-organica",
    categories: [{ name: "Ropa" }, { name: "Poleras" }],
    images: [{ url: "https://cdn.jumpseller.com/pol1.jpg" }, { url: "https://cdn.jumpseller.com/pol2.jpg" }],
    brand: { name: "EcoWear" },
    barcode: "7801111222333",
    variants: [{ id: 1, sku: "POL-ORG-S" }],
  },
};

describe("normalizeJumpsellerProduct — mapeo Jumpseller → NormalizedItem", () => {
  const n = normalizeJumpsellerProduct(jsProduct, "CLP")!;

  it("mapea identidad y precio", () => {
    expect(n.externalId).toBe("987");
    expect(n.sku).toBe("POL-ORG-M");
    expect(n.kind).toBe("product");
    expect(n.price).toBe(12990);
    expect(n.currency).toBe("CLP");
  });

  it("limpia HTML de la descripción", () => {
    expect(n.description).toBe("Polera suave de algodón orgánico.");
  });

  it("stock, disponibilidad y categorías", () => {
    expect(n.trackStock).toBe(true);
    expect(n.stock).toBe(8);
    expect(n.available).toBe(true);
    expect(n.category).toBe("Ropa");
    expect(n.subcategory).toBe("Poleras");
  });

  it("imagen, galería, enlace, marca y código de barras", () => {
    expect(n.imageUrl).toBe("https://cdn.jumpseller.com/pol1.jpg");
    expect(n.images).toEqual(["https://cdn.jumpseller.com/pol1.jpg", "https://cdn.jumpseller.com/pol2.jpg"]);
    expect(n.productUrl).toBe("https://mitienda.jumpseller.com/polera-organica");
    expect(n.buyUrl).toBe("https://mitienda.jumpseller.com/polera-organica");
    expect(n.brand).toBe("EcoWear");
    expect(n.barcode).toBe("7801111222333");
  });

  it("stock ilimitado → sin seguimiento de stock", () => {
    const out = normalizeJumpsellerProduct({ product: { ...jsProduct.product, stock_unlimited: true } }, "CLP")!;
    expect(out.trackStock).toBe(false);
    expect(out.stock).toBeNull();
  });

  it("status distinto de available → no disponible", () => {
    const out = normalizeJumpsellerProduct({ product: { ...jsProduct.product, status: "not-available" } }, "CLP")!;
    expect(out.available).toBe(false);
  });

  it("acepta el producto sin envoltorio (webhook)", () => {
    const out = normalizeJumpsellerProduct(jsProduct.product, "CLP")!;
    expect(out.externalId).toBe("987");
  });

  it("producto sin id → null", () => {
    expect(normalizeJumpsellerProduct({ product: { name: "x" } }, "CLP")).toBeNull();
  });
});

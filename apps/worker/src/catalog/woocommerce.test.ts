import { describe, expect, it } from "vitest";
import { normalizeWooProduct } from "./woocommerce";

// Fixture representativo de un producto de WooCommerce (en oferta, con stock y categorías).
const wooProduct = {
  id: 42,
  name: "Aceite esencial de lavanda",
  sku: "LAV-30",
  price: "6990",
  regular_price: "8990",
  on_sale: true,
  manage_stock: true,
  stock_quantity: 12,
  stock_status: "instock",
  short_description: "<p>Relaja y ayuda a <b>dormir</b>.</p>",
  permalink: "https://tienda.cl/producto/lavanda",
  images: [{ src: "https://tienda.cl/img/lav.jpg" }, { src: "https://tienda.cl/img/lav2.jpg" }],
  categories: [{ name: "Aromaterapia" }, { name: "Aceites" }],
  tags: [{ name: "relajación" }, { name: "sueño" }],
  attributes: [{ name: "Volumen", options: ["30ml"] }, { name: "Material", options: ["vidrio"] }],
  brands: [{ name: "Naturalis" }],
  global_unique_id: "7801234567890",
  variations: [101, 102],
  purchasable: true,
};

describe("normalizeWooProduct — mapeo WooCommerce → NormalizedItem", () => {
  const n = normalizeWooProduct(wooProduct, "CLP")!;

  it("mapea identidad, precios y descuento", () => {
    expect(n.externalId).toBe("42");
    expect(n.sku).toBe("LAV-30");
    expect(n.kind).toBe("product");
    expect(n.price).toBe(6990);
    expect(n.compareAtPrice).toBe(8990); // en oferta → precio antes de descuento
    expect(n.currency).toBe("CLP");
  });

  it("limpia HTML de la descripción", () => {
    expect(n.description).toBe("Relaja y ayuda a dormir.");
  });

  it("stock, disponibilidad y categorías", () => {
    expect(n.trackStock).toBe(true);
    expect(n.stock).toBe(12);
    expect(n.available).toBe(true);
    expect(n.category).toBe("Aromaterapia");
    expect(n.subcategory).toBe("Aceites");
  });

  it("imagen, enlace y enlace de compra (carrito armado)", () => {
    expect(n.imageUrl).toBe("https://tienda.cl/img/lav.jpg");
    expect(n.productUrl).toBe("https://tienda.cl/producto/lavanda");
    expect(n.buyUrl).toBe("https://tienda.cl/producto/lavanda?add-to-cart=42");
  });

  it("etiquetas y variantes", () => {
    expect(n.tags).toEqual(["relajación", "sueño"]);
    expect(n.variants).toEqual([101, 102]);
  });

  it("galería, atributos, marca y código de barras (info completa)", () => {
    expect(n.images).toEqual(["https://tienda.cl/img/lav.jpg", "https://tienda.cl/img/lav2.jpg"]);
    expect(n.attributes).toEqual({ Volumen: ["30ml"], Material: ["vidrio"] });
    expect(n.brand).toBe("Naturalis");
    expect(n.barcode).toBe("7801234567890");
  });

  it("producto agotado → no disponible; sin oferta → sin compareAtPrice", () => {
    const out = normalizeWooProduct({ ...wooProduct, stock_status: "outofstock", on_sale: false }, "CLP")!;
    expect(out.available).toBe(false);
    expect(out.compareAtPrice).toBeNull();
  });

  it("producto sin id → null", () => {
    expect(normalizeWooProduct({ name: "x" }, "CLP")).toBeNull();
  });
});

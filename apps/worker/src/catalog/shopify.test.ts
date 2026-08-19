import { describe, expect, it } from "vitest";
import { normalizeShopifyProduct } from "./shopify";

// Nodo de producto de Shopify (GraphQL Admin API), en oferta y con 2 variantes.
const node = {
  id: "gid://shopify/Product/1234567890",
  title: "Zapatilla running",
  handle: "zapatilla-running",
  description: "Liviana y con buen amortiguación.",
  productType: "Calzado",
  vendor: "RunFast",
  tags: ["deporte", "running"],
  status: "ACTIVE",
  onlineStoreUrl: "https://tienda.myshopify.com/products/zapatilla-running",
  featuredImage: { url: "https://cdn.shopify.com/zap1.jpg" },
  images: { edges: [{ node: { url: "https://cdn.shopify.com/zap1.jpg" } }, { node: { url: "https://cdn.shopify.com/zap2.jpg" } }] },
  variants: {
    edges: [
      { node: { id: "gid://shopify/ProductVariant/1", sku: "ZAP-42", price: "39990", compareAtPrice: "49990", inventoryQuantity: 5, availableForSale: true, barcode: "7801234000001" } },
      { node: { id: "gid://shopify/ProductVariant/2", sku: "ZAP-43", price: "39990", compareAtPrice: "49990", inventoryQuantity: 3, availableForSale: true, barcode: "7801234000002" } },
    ],
  },
};

describe("normalizeShopifyProduct — mapeo Shopify (GraphQL) → NormalizedItem", () => {
  const n = normalizeShopifyProduct(node, "CLP")!;

  it("mapea identidad (gid → id corto), sku de la 1ª variante y precio con descuento", () => {
    expect(n.externalId).toBe("1234567890");
    expect(n.sku).toBe("ZAP-42");
    expect(n.kind).toBe("product");
    expect(n.price).toBe(39990);
    expect(n.compareAtPrice).toBe(49990);
    expect(n.currency).toBe("CLP");
  });

  it("categoría (productType), marca (vendor), etiquetas y código de barras", () => {
    expect(n.category).toBe("Calzado");
    expect(n.brand).toBe("RunFast");
    expect(n.tags).toEqual(["deporte", "running"]);
    expect(n.barcode).toBe("7801234000001");
  });

  it("stock suma variantes; disponible si ACTIVE + alguna variante vendible", () => {
    expect(n.trackStock).toBe(true);
    expect(n.stock).toBe(8);
    expect(n.available).toBe(true);
  });

  it("imagen destacada, galería y enlace de compra", () => {
    expect(n.imageUrl).toBe("https://cdn.shopify.com/zap1.jpg");
    expect(n.images).toEqual(["https://cdn.shopify.com/zap1.jpg", "https://cdn.shopify.com/zap2.jpg"]);
    expect(n.productUrl).toBe("https://tienda.myshopify.com/products/zapatilla-running");
    expect(n.buyUrl).toBe("https://tienda.myshopify.com/products/zapatilla-running");
  });

  it("producto DRAFT → no disponible aunque tenga stock", () => {
    const out = normalizeShopifyProduct({ ...node, status: "DRAFT" }, "CLP")!;
    expect(out.available).toBe(false);
  });

  it("sin oferta (compareAt <= price) → sin compareAtPrice", () => {
    const out = normalizeShopifyProduct({ ...node, variants: { edges: [{ node: { sku: "X", price: "1000", compareAtPrice: "1000", inventoryQuantity: 1, availableForSale: true } }] } }, "CLP")!;
    expect(out.compareAtPrice).toBeNull();
  });

  it("nodo sin id → null", () => {
    expect(normalizeShopifyProduct({ title: "x" }, "CLP")).toBeNull();
  });
});

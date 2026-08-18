/**
 * Contrato de un ADAPTADOR de catálogo. Agregar un proveedor nuevo (Shopify, Fudo,
 * Jumpseller, Bsale, VTEX…) = escribir un adaptador que implemente esto. El agente y el
 * motor de sync NO saben de qué fuente vienen los datos: todo se normaliza a NormalizedItem.
 */

/** Ítem de catálogo NORMALIZADO — sirve igual para un producto de tienda o un plato. */
export interface NormalizedItem {
  externalId: string;
  sku: string | null;
  kind: "product" | "dish" | "service";
  name: string;
  description: string | null;
  category: string | null;
  subcategory: string | null;
  price: number | null;
  compareAtPrice: number | null; // precio antes de descuento
  currency: string;
  stock: number | null;
  trackStock: boolean;
  available: boolean;
  variants: unknown[]; // variantes / modificadores
  imageUrl: string | null;
  images: string[]; // galería completa
  productUrl: string | null;
  buyUrl: string | null; // enlace de compra / carrito armado donde el proveedor lo permita
  tags: string[];
  attributes: Record<string, unknown>; // marca, peso, material, alérgenos, atributos del proveedor…
  brand: string | null;
  barcode: string | null;
  unit: string | null;
  menuSection: string | null; // restaurante
  availability: Record<string, unknown>; // ventanas por horario / precios por canal
  raw: unknown; // objeto crudo original
}

export interface CatalogAdapterConfig {
  baseUrl: string;
  auth: Record<string, string>; // credenciales ya descifradas (consumerKey/secret, token…)
  currency?: string;
}

/** Callback por página: el motor de sync lo usa para upsertear en lotes (catálogos grandes). */
export type OnPage = (items: NormalizedItem[]) => Promise<void>;

export interface CatalogAdapter {
  readonly source: string;
  /** Prueba la conexión y, si puede, devuelve cuántos productos ve. */
  testConnection(): Promise<{ ok: boolean; count: number | null; error: string | null }>;
  /** Sincronización COMPLETA, paginada (no carga todo en memoria). */
  fetchAll(onPage: OnPage): Promise<void>;
  /** Sincronización INCREMENTAL desde una fecha (modificados). */
  fetchSince(since: Date, onPage: OnPage): Promise<void>;
  /** Normaliza un objeto crudo del proveedor (para webhooks). null si no aplica. */
  normalize(raw: unknown): NormalizedItem | null;
}

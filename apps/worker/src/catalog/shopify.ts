/**
 * Adaptador de Shopify. En 2026 el REST Admin API está en desmantelamiento → usamos el
 * GraphQL Admin API. Conexión por tienda con una APP PERSONALIZADA: el cliente crea la app
 * en su admin (Configuración → Apps → Desarrollar apps), le da permiso read_products y copia
 * el "Admin API access token" (shpat_…). Con eso + el dominio {tienda}.myshopify.com basta
 * (sin baile OAuth).
 *
 * Endpoint: POST https://{shop}/admin/api/{version}/graphql.json con header
 *   X-Shopify-Access-Token. Paginación por cursor (pageInfo.endCursor). Incremental con el
 *   argumento query "updated_at:>ISO".
 */
import type { CatalogAdapter, CatalogAdapterConfig, NormalizedItem, OnPage } from "./types";

const API_VERSION = "2025-04";

const PRODUCTS_QUERY = `
query Products($cursor: String, $query: String) {
  products(first: 100, after: $cursor, query: $query) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      id title handle description productType vendor tags status onlineStoreUrl
      featuredImage { url }
      images(first: 10) { edges { node { url } } }
      variants(first: 50) { edges { node { id sku price compareAtPrice inventoryQuantity availableForSale barcode } } }
    } }
  }
}`;

function num(v: unknown): number | null {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** "gid://shopify/Product/12345" → "12345" (id estable, corto). */
function shortId(gid: string): string {
  const m = /\/(\d+)(?:\?.*)?$/.exec(gid);
  return m ? m[1] : gid;
}

/** Normaliza un producto de Shopify (GraphQL) a NormalizedItem. Pura (testeable con fixtures). */
export function normalizeShopifyProduct(node: any, currency: string): NormalizedItem | null {
  if (!node || node.id == null) return null;
  const variants = (node.variants?.edges ?? []).map((e: any) => e.node).filter(Boolean);
  const v0 = variants[0] ?? {};
  const prices = variants.map((v: any) => num(v.price)).filter((x: number | null): x is number => x != null);
  const price = num(v0.price) ?? (prices.length ? Math.min(...prices) : null);
  const compareAt = num(v0.compareAtPrice);
  const anyAvailable = variants.length === 0 || variants.some((v: any) => v.availableForSale);
  const tracksStock = variants.some((v: any) => v.inventoryQuantity != null);
  const stock = tracksStock ? variants.reduce((s: number, v: any) => s + (num(v.inventoryQuantity) ?? 0), 0) : null;
  const images = (node.images?.edges ?? []).map((e: any) => e.node?.url).filter(Boolean);
  return {
    externalId: shortId(String(node.id)),
    sku: v0.sku || null,
    kind: "product",
    name: String(node.title ?? "").trim(),
    description: (node.description || "").toString().trim() || null,
    category: node.productType || null,
    subcategory: null,
    price,
    compareAtPrice: compareAt != null && price != null && compareAt > price ? compareAt : null,
    currency,
    stock,
    trackStock: tracksStock,
    available: node.status ? node.status === "ACTIVE" && anyAvailable : anyAvailable,
    variants,
    imageUrl: node.featuredImage?.url ?? images[0] ?? null,
    images,
    productUrl: node.onlineStoreUrl ?? null,
    buyUrl: node.onlineStoreUrl ?? null,
    tags: Array.isArray(node.tags) ? node.tags : [],
    attributes: {},
    brand: node.vendor || null,
    barcode: v0.barcode || null,
    unit: null,
    menuSection: null,
    availability: {},
    raw: node,
  };
}

export class ShopifyAdapter implements CatalogAdapter {
  readonly source = "shopify";
  private currency: string;
  private endpoint: string;
  constructor(private cfg: CatalogAdapterConfig) {
    this.currency = cfg.currency ?? "CLP";
    this.endpoint = `${cfg.baseUrl.replace(/\/$/, "")}/admin/api/${API_VERSION}/graphql.json`;
  }

  /** POST GraphQL con reintentos (backoff) ante 429/5xx. */
  private async gql(query: string, variables: Record<string, unknown>): Promise<any> {
    let lastErr = "sin respuesta";
    for (let i = 0; i < 4; i++) {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "X-Shopify-Access-Token": this.cfg.auth.token ?? "", "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      if (res.ok) {
        const json = (await res.json()) as { data?: any; errors?: unknown };
        if (json.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(json.errors).slice(0, 200)}`);
        return json.data;
      }
      lastErr = `HTTP ${res.status}`;
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
        continue;
      }
      break;
    }
    throw new Error(`Shopify: ${lastErr}`);
  }

  async testConnection() {
    try {
      const d = await this.gql(`{ shop { name } }`, {});
      return { ok: !!d?.shop, count: null, error: null };
    } catch (e) {
      return { ok: false, count: null, error: (e as Error).message };
    }
  }

  private async paginate(filter: string | null, onPage: OnPage) {
    let cursor: string | null = null;
    for (let i = 0; i < 1000; i++) {
      const d = await this.gql(PRODUCTS_QUERY, { cursor, query: filter });
      const conn = d?.products;
      if (!conn) break;
      const nodes = (conn.edges ?? []).map((e: any) => e.node);
      const items = nodes.map((n: any) => normalizeShopifyProduct(n, this.currency)).filter((x: NormalizedItem | null): x is NormalizedItem => !!x);
      await onPage(items);
      if (!conn.pageInfo?.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
  }

  fetchAll(onPage: OnPage) {
    return this.paginate(null, onPage);
  }
  fetchSince(since: Date, onPage: OnPage) {
    return this.paginate(`updated_at:>'${since.toISOString()}'`, onPage);
  }
  normalize(raw: unknown) {
    return normalizeShopifyProduct(raw, this.currency);
  }
}

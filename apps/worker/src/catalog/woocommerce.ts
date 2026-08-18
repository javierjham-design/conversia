/**
 * Adaptador de WooCommerce (WordPress). El caso más simple y probablemente el más común.
 *
 * Auth: Basic con consumerKey/consumerSecret que el cliente genera en su WordPress
 *   (WooCommerce → Ajustes → Avanzado → REST API → Crear clave, permisos "Lectura").
 * Endpoint: GET {baseUrl}/wp-json/wc/v3/products?per_page=100&page=N (paginado; total en el
 *   header X-WP-Total). Incremental con &modified_after=ISO. Rate limit: paginamos de a 100 y
 *   reintentamos con backoff ante 429/5xx.
 */
import type { CatalogAdapter, CatalogAdapterConfig, NormalizedItem, OnPage } from "./types";

function num(v: unknown): number | null {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Normaliza un producto de WooCommerce a NormalizedItem. Pura (testeable con fixtures). */
export function normalizeWooProduct(p: any, currency: string): NormalizedItem | null {
  if (!p || p.id == null) return null;
  const price = num(p.price);
  const regular = num(p.regular_price);
  const onSale = p.on_sale === true && regular != null && price != null && regular > price;
  return {
    externalId: String(p.id),
    sku: p.sku || null,
    kind: "product",
    name: String(p.name ?? "").trim(),
    description: (p.short_description || p.description || "").replace(/<[^>]+>/g, "").trim() || null,
    category: p.categories?.[0]?.name ?? null,
    subcategory: p.categories?.[1]?.name ?? null,
    price,
    compareAtPrice: onSale ? regular : null,
    currency,
    stock: p.manage_stock ? num(p.stock_quantity) : null,
    trackStock: p.manage_stock === true,
    available: p.stock_status ? p.stock_status === "instock" : p.purchasable !== false,
    variants: Array.isArray(p.variations) ? p.variations : [],
    imageUrl: p.images?.[0]?.src ?? null,
    productUrl: p.permalink ?? null,
    buyUrl: p.permalink ? `${p.permalink}${p.permalink.includes("?") ? "&" : "?"}add-to-cart=${p.id}` : null,
    tags: Array.isArray(p.tags) ? p.tags.map((t: any) => t.name).filter(Boolean) : [],
    menuSection: null,
    availability: {},
    raw: p,
  };
}

export class WooCommerceAdapter implements CatalogAdapter {
  readonly source = "woocommerce";
  private currency: string;
  constructor(private cfg: CatalogAdapterConfig) {
    this.currency = cfg.currency ?? "CLP";
  }

  private url(page: number, params: Record<string, string> = {}): string {
    const u = new URL(`${this.cfg.baseUrl.replace(/\/$/, "")}/wp-json/wc/v3/products`);
    u.searchParams.set("per_page", "100");
    u.searchParams.set("page", String(page));
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }
  private headers(): Record<string, string> {
    const basic = Buffer.from(`${this.cfg.auth.consumerKey}:${this.cfg.auth.consumerSecret}`).toString("base64");
    return { authorization: `Basic ${basic}`, accept: "application/json" };
  }

  /** GET con reintentos (backoff) ante 429/5xx. */
  private async getWithRetry(url: string, tries = 4): Promise<Response> {
    let last: Response | null = null;
    for (let i = 0; i < tries; i++) {
      const res = await fetch(url, { headers: this.headers() });
      if (res.ok) return res;
      last = res;
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
        continue;
      }
      break;
    }
    return last as Response;
  }

  async testConnection() {
    try {
      const res = await this.getWithRetry(this.url(1));
      if (!res.ok) return { ok: false, count: null, error: `HTTP ${res.status}` };
      const total = Number(res.headers.get("x-wp-total"));
      return { ok: true, count: Number.isFinite(total) ? total : null, error: null };
    } catch (e) {
      return { ok: false, count: null, error: (e as Error).message };
    }
  }

  private async paginate(params: Record<string, string>, onPage: OnPage) {
    for (let page = 1; page < 500; page++) {
      const res = await this.getWithRetry(this.url(page, params));
      if (!res.ok) throw new Error(`WooCommerce products: HTTP ${res.status}`);
      const arr = (await res.json()) as any[];
      if (!Array.isArray(arr) || arr.length === 0) break;
      const items = arr.map((p) => normalizeWooProduct(p, this.currency)).filter((x): x is NormalizedItem => !!x);
      await onPage(items);
      if (arr.length < 100) break; // última página
    }
  }

  fetchAll(onPage: OnPage) {
    return this.paginate({}, onPage);
  }
  fetchSince(since: Date, onPage: OnPage) {
    return this.paginate({ modified_after: since.toISOString() }, onPage);
  }
  normalize(raw: unknown) {
    return normalizeWooProduct(raw, this.currency);
  }
}

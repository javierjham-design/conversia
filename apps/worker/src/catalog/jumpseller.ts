/**
 * Adaptador de Jumpseller (muy usado en Chile).
 *
 * Auth: login + authtoken que el cliente obtiene en su panel (Cuenta → API). Van como
 *   query params en cada request (no hay baseUrl del cliente: la API es central).
 * Endpoint: GET https://api.jumpseller.com/v1/products.json?login=L&authtoken=T&limit=100&page=N
 *   La respuesta es un array de objetos { product: {...} }. Conteo en products/count.json.
 *   No hay filtro fiable de "modificados desde", así que el incremental hace un fetch completo
 *   (el motor en modo incremental no desactiva lo ausente, así que es seguro y mantiene fresco).
 */
import type { CatalogAdapter, CatalogAdapterConfig, NormalizedItem, OnPage } from "./types";

const BASE = "https://api.jumpseller.com/v1";

function num(v: unknown): number | null {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Normaliza un producto de Jumpseller a NormalizedItem. Pura (testeable con fixtures).
 * Acepta tanto el envoltorio { product: {...} } como el producto directo. */
export function normalizeJumpsellerProduct(raw: any, currency: string): NormalizedItem | null {
  const p = raw?.product ?? raw;
  if (!p || p.id == null) return null;
  const unlimited = p.stock_unlimited === true;
  const brand = typeof p.brand === "string" ? p.brand : p.brand?.name ?? null;
  return {
    externalId: String(p.id),
    sku: p.sku || null,
    kind: "product",
    name: String(p.name ?? "").trim(),
    description: (p.description || "").replace(/<[^>]+>/g, "").trim() || null,
    category: p.categories?.[0]?.name ?? null,
    subcategory: p.categories?.[1]?.name ?? null,
    price: num(p.price),
    compareAtPrice: null,
    currency,
    stock: unlimited ? null : num(p.stock),
    trackStock: !unlimited,
    available: p.status ? p.status === "available" : true,
    variants: Array.isArray(p.variants) ? p.variants : [],
    imageUrl: p.images?.[0]?.url ?? null,
    images: Array.isArray(p.images) ? p.images.map((im: any) => im.url).filter(Boolean) : [],
    productUrl: p.permalink ?? null,
    buyUrl: p.permalink ?? null,
    tags: [],
    attributes: {},
    brand,
    barcode: p.barcode || null,
    unit: null,
    menuSection: null,
    availability: {},
    raw: p,
  };
}

export class JumpsellerAdapter implements CatalogAdapter {
  readonly source = "jumpseller";
  private currency: string;
  constructor(private cfg: CatalogAdapterConfig) {
    this.currency = cfg.currency ?? "CLP";
  }

  private url(path: string, params: Record<string, string> = {}): string {
    const u = new URL(`${BASE}${path}`);
    u.searchParams.set("login", this.cfg.auth.login ?? "");
    u.searchParams.set("authtoken", this.cfg.auth.authtoken ?? "");
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  /** GET con reintentos (backoff) ante 429/5xx. */
  private async getWithRetry(url: string, tries = 4): Promise<Response> {
    let last: Response | null = null;
    for (let i = 0; i < tries; i++) {
      const res = await fetch(url, { headers: { accept: "application/json" } });
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
      const res = await this.getWithRetry(this.url("/products/count.json"));
      if (!res.ok) return { ok: false, count: null, error: `HTTP ${res.status}` };
      const json = (await res.json()) as { count?: number };
      return { ok: true, count: num(json?.count), error: null };
    } catch (e) {
      return { ok: false, count: null, error: (e as Error).message };
    }
  }

  private async paginate(onPage: OnPage) {
    for (let page = 1; page < 1000; page++) {
      const res = await this.getWithRetry(this.url("/products.json", { limit: "100", page: String(page) }));
      if (!res.ok) throw new Error(`Jumpseller products: HTTP ${res.status}`);
      const arr = (await res.json()) as any[];
      if (!Array.isArray(arr) || arr.length === 0) break;
      const items = arr.map((p) => normalizeJumpsellerProduct(p, this.currency)).filter((x): x is NormalizedItem => !!x);
      await onPage(items);
      if (arr.length < 100) break; // última página
    }
  }

  fetchAll(onPage: OnPage) {
    return this.paginate(onPage);
  }
  fetchSince(_since: Date, onPage: OnPage) {
    // Jumpseller no expone filtro fiable de modificados: refrescamos todo (incremental no desactiva).
    return this.paginate(onPage);
  }
  normalize(raw: unknown) {
    return normalizeJumpsellerProduct(raw, this.currency);
  }
}

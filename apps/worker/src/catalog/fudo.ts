/**
 * Adaptador de Fudo (POS de restaurantes, común en LatAm/Chile). El "catálogo" es el MENÚ:
 * productos (kind="dish") agrupados por categoría (menuSection).
 *
 * Auth (2 pasos): el restaurante pide a soporte Fudo habilitar la API y obtiene apiKey + apiSecret.
 *   Se intercambian por un bearer token (JWT, dura ~10 días) en POST https://auth.fu.do/api.
 *   Intercambiamos un token FRESCO en cada sincronización → esquivamos la renovación a los 10 días.
 * Datos: API JSON:API en https://api.fu.do/v1alpha1. GET /products?include=productCategory
 *   (paginado con page[number]/page[size]); la categoría llega en `included`.
 */
import type { CatalogAdapter, CatalogAdapterConfig, NormalizedItem, OnPage } from "./types";

const AUTH_URL = "https://auth.fu.do/api";
const BASE = "https://api.fu.do/v1alpha1";

function num(v: unknown): number | null {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Normaliza un producto (recurso JSON:API) de Fudo a NormalizedItem (kind="dish"). Pura.
 * `categories` mapea id de categoría → nombre (para menuSection). */
export function normalizeFudoProduct(res: any, categories: Record<string, string>, currency: string): NormalizedItem | null {
  if (!res || res.id == null) return null;
  const a = res.attributes ?? {};
  const catId = res.relationships?.productCategory?.data?.id ?? res.relationships?.["product-category"]?.data?.id ?? null;
  const section = catId != null ? categories[String(catId)] ?? null : null;
  const tracks = a.stockControl === true || a.stock_control === true;
  const stock = tracks ? num(a.stock) : null;
  return {
    externalId: String(res.id),
    sku: a.code || a.sku || null,
    kind: "dish",
    name: String(a.name ?? "").trim(),
    description: (a.description || "").toString().replace(/<[^>]+>/g, "").trim() || null,
    category: section,
    subcategory: null,
    price: num(a.price),
    compareAtPrice: null,
    currency,
    stock,
    trackStock: tracks,
    available: a.active !== false && (stock == null || stock > 0),
    variants: [],
    imageUrl: a.imageUrl || a.image || null,
    images: [],
    productUrl: null,
    buyUrl: null,
    tags: [],
    attributes: {},
    brand: null,
    barcode: null,
    unit: null,
    menuSection: section,
    availability: {},
    raw: res,
  };
}

export class FudoAdapter implements CatalogAdapter {
  readonly source = "fudo";
  private currency: string;
  private token: string | null = null;
  constructor(private cfg: CatalogAdapterConfig) {
    this.currency = cfg.currency ?? "CLP";
  }

  /** Intercambia apiKey/apiSecret por un bearer token (una vez por corrida). */
  private async auth(): Promise<string> {
    if (this.token) return this.token;
    const res = await fetch(AUTH_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ apiKey: this.cfg.auth.apiKey, apiSecret: this.cfg.auth.apiSecret }),
    });
    if (!res.ok) throw new Error(`Fudo auth: HTTP ${res.status}`);
    const json = (await res.json()) as { token?: string };
    if (!json?.token) throw new Error("Fudo auth: respuesta sin token");
    this.token = json.token;
    return this.token;
  }

  private async getWithRetry(url: string, tries = 4): Promise<Response> {
    const token = await this.auth();
    let last: Response | null = null;
    for (let i = 0; i < tries; i++) {
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
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

  private url(page: number): string {
    const u = new URL(`${BASE}/products`);
    u.searchParams.set("include", "productCategory");
    u.searchParams.set("page[size]", "100");
    u.searchParams.set("page[number]", String(page));
    return u.toString();
  }

  async testConnection() {
    try {
      const res = await this.getWithRetry(this.url(1));
      if (!res.ok) return { ok: false, count: null, error: `HTTP ${res.status}` };
      const json = (await res.json()) as { data?: unknown[]; meta?: { totalCount?: number; count?: number } };
      const count = num(json?.meta?.totalCount ?? json?.meta?.count) ?? (Array.isArray(json?.data) ? json!.data!.length : null);
      return { ok: true, count, error: null };
    } catch (e) {
      return { ok: false, count: null, error: (e as Error).message };
    }
  }

  /** Mapa id→nombre de categoría a partir del bloque `included` de JSON:API. */
  private categoriesFrom(included: any[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const inc of included ?? []) {
      const type = String(inc?.type ?? "").toLowerCase();
      if (type.includes("category")) out[String(inc.id)] = inc.attributes?.name ?? "";
    }
    return out;
  }

  private async paginate(onPage: OnPage) {
    for (let page = 1; page < 1000; page++) {
      const res = await this.getWithRetry(this.url(page));
      if (!res.ok) throw new Error(`Fudo products: HTTP ${res.status}`);
      const json = (await res.json()) as { data?: any[]; included?: any[] };
      const data = json?.data ?? [];
      if (!Array.isArray(data) || data.length === 0) break;
      const cats = this.categoriesFrom(json?.included ?? []);
      const items = data.map((p) => normalizeFudoProduct(p, cats, this.currency)).filter((x): x is NormalizedItem => !!x);
      await onPage(items);
      if (data.length < 100) break; // última página
    }
  }

  fetchAll(onPage: OnPage) {
    return this.paginate(onPage);
  }
  fetchSince(_since: Date, onPage: OnPage) {
    // Fudo no expone filtro fiable de modificados: refrescamos todo (incremental no desactiva).
    return this.paginate(onPage);
  }
  normalize(raw: unknown) {
    return normalizeFudoProduct(raw, {}, this.currency);
  }
}

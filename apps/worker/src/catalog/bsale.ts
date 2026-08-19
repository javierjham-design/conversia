/**
 * Adaptador de Bsale (POS/inventario/facturación, muy usado en Chile). A diferencia de
 * WooCommerce/Shopify, Bsale separa el catálogo en recursos distintos:
 *   - producto (products) con sus variantes (variants, embebidas con expand=[variants]),
 *   - PRECIO en una lista de precios (price_lists/{id}/details) — no en el producto,
 *   - STOCK por sucursal (stocks) — no en el producto.
 * Estrategia: cargamos una vez el mapa variante→precio (de la lista por defecto = la primera)
 * y variante→stock (sumado entre sucursales), y luego paginamos productos resolviendo con esos
 * mapas. Así evitamos una llamada por variante. Defaults ajustables después (lista/impuesto/sucursal).
 *
 * Auth: header `access_token` con el token que el cliente genera en Bsale (Configuración → Token).
 * Base: https://api.bsale.io/v1. Paginación por limit/offset (el total viene en `count`).
 */
import type { CatalogAdapter, CatalogAdapterConfig, NormalizedItem, OnPage } from "./types";

const BASE = "https://api.bsale.io/v1";

function num(v: unknown): number | null {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface StockInfo {
  qty: number;
  unlimited: boolean;
}

/** Normaliza un producto de Bsale a NormalizedItem. Pura: recibe los mapas de precio/stock
 * (variante id → valor) ya resueltos. Un producto Bsale → un ítem (agrega sus variantes). */
export function normalizeBsaleProduct(
  p: any,
  prices: Record<string, number>,
  stocks: Record<string, StockInfo>,
  currency: string,
): NormalizedItem | null {
  if (!p || p.id == null) return null;
  const variants: any[] = p.variants?.items ?? (Array.isArray(p.variants) ? p.variants : []);
  const v0 = variants[0] ?? {};
  const vids = variants.map((v) => String(v.id));
  const priceVals = vids.map((id) => prices[id]).filter((x): x is number => x != null);
  const price = priceVals.length ? Math.min(...priceVals) : null;
  const anyUnlimited = variants.some((v) => v.unlimitedStock === 1 || v.unlimitedStock === true) || vids.some((id) => stocks[id]?.unlimited);
  const tracked = vids.some((id) => stocks[id] != null);
  const stockSum = vids.reduce((s, id) => s + (stocks[id]?.qty ?? 0), 0);
  const stock = anyUnlimited || !tracked ? null : stockSum;
  const active = p.state === 0 || p.state === "0" || p.state == null; // 0 = activo en Bsale
  return {
    externalId: String(p.id),
    sku: v0.code || v0.barCode || null,
    kind: "product",
    name: String(p.name ?? "").trim(),
    description: (p.description || "").toString().replace(/<[^>]+>/g, "").trim() || null,
    category: p.product_type?.name ?? null,
    subcategory: null,
    price,
    compareAtPrice: null,
    currency,
    stock,
    trackStock: tracked && !anyUnlimited,
    available: active && (anyUnlimited || stock == null || stock > 0),
    variants,
    imageUrl: null,
    images: [],
    productUrl: null,
    buyUrl: null,
    tags: [],
    attributes: {},
    brand: null,
    barcode: v0.barCode || null,
    unit: null,
    menuSection: null,
    availability: {},
    raw: p,
  };
}

export class BsaleAdapter implements CatalogAdapter {
  readonly source = "bsale";
  private currency: string;
  constructor(private cfg: CatalogAdapterConfig) {
    this.currency = cfg.currency ?? "CLP";
  }

  private headers(): Record<string, string> {
    return { access_token: this.cfg.auth.token ?? "", accept: "application/json" };
  }

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

  /** Pagina un recurso Bsale (limit/offset) llamando a `onItems` por página. */
  private async paginate(path: string, onItems: (items: any[]) => Promise<void> | void) {
    const limit = 50;
    for (let offset = 0; offset < 100000; offset += limit) {
      const sep = path.includes("?") ? "&" : "?";
      const res = await this.getWithRetry(`${BASE}${path}${sep}limit=${limit}&offset=${offset}`);
      if (!res.ok) throw new Error(`Bsale ${path}: HTTP ${res.status}`);
      const json = (await res.json()) as { items?: any[]; count?: number };
      const items = json?.items ?? [];
      if (!Array.isArray(items) || items.length === 0) break;
      await onItems(items);
      if (items.length < limit) break;
    }
  }

  /** Id de la lista de precios por defecto (la primera). null si no hay ninguna. */
  private async defaultPriceListId(): Promise<string | null> {
    const res = await this.getWithRetry(`${BASE}/price_lists.json?limit=1`);
    if (!res.ok) return null;
    const json = (await res.json()) as { items?: Array<{ id: number }> };
    return json?.items?.[0]?.id != null ? String(json.items[0].id) : null;
  }

  /** Mapa variante→precio de una lista (prefiere el valor CON impuestos si viene). */
  private async loadPrices(listId: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    await this.paginate(`/price_lists/${listId}/details.json`, (items) => {
      for (const d of items) {
        const vid = d?.variant?.id;
        const val = num(d?.variantValueWithTaxes) ?? num(d?.variantValue);
        if (vid != null && val != null) out[String(vid)] = val;
      }
    });
    return out;
  }

  /** Mapa variante→stock disponible (sumado entre sucursales). */
  private async loadStocks(): Promise<Record<string, StockInfo>> {
    const out: Record<string, StockInfo> = {};
    await this.paginate(`/stocks.json`, (items) => {
      for (const s of items) {
        const vid = s?.variant?.id;
        if (vid == null) continue;
        const key = String(vid);
        const qty = num(s?.quantityAvailable) ?? num(s?.quantity) ?? 0;
        const prev = out[key] ?? { qty: 0, unlimited: false };
        out[key] = { qty: prev.qty + qty, unlimited: prev.unlimited };
      }
    });
    return out;
  }

  async testConnection() {
    try {
      const res = await this.getWithRetry(`${BASE}/products.json?limit=1`);
      if (!res.ok) return { ok: false, count: null, error: `HTTP ${res.status}` };
      const json = (await res.json()) as { count?: number };
      return { ok: true, count: num(json?.count), error: null };
    } catch (e) {
      return { ok: false, count: null, error: (e as Error).message };
    }
  }

  private async run(onPage: OnPage) {
    const listId = await this.defaultPriceListId();
    const [prices, stocks] = await Promise.all([listId ? this.loadPrices(listId) : Promise.resolve({}), this.loadStocks()]);
    await this.paginate(`/products.json?expand=[variants,product_type]`, async (items) => {
      const normalized = items.map((p) => normalizeBsaleProduct(p, prices, stocks, this.currency)).filter((x): x is NormalizedItem => !!x);
      await onPage(normalized);
    });
  }

  fetchAll(onPage: OnPage) {
    return this.run(onPage);
  }
  fetchSince(_since: Date, onPage: OnPage) {
    // Bsale no expone filtro fiable de modificados: refrescamos todo (incremental no desactiva).
    return this.run(onPage);
  }
  normalize(raw: unknown) {
    return normalizeBsaleProduct(raw, {}, {}, this.currency);
  }
}

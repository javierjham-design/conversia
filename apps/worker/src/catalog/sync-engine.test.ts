import { describe, expect, it } from "vitest";
import { runCatalogSync, type CatalogSyncPort } from "./sync-engine";
import { FakeCatalogAdapter } from "./fake";
import type { NormalizedItem } from "./types";

function item(id: string, over: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    externalId: id, sku: null, kind: "product", name: `Producto ${id}`, description: null,
    category: null, subcategory: null, price: 1000, compareAtPrice: null, currency: "CLP",
    stock: 5, trackStock: true, available: true, variants: [], imageUrl: null, images: [],
    productUrl: null, buyUrl: null, tags: [], attributes: {}, brand: null, barcode: null,
    unit: null, menuSection: null, availability: {}, raw: {}, ...over,
  };
}

/** Puerto en memoria: guarda ítems por externalId y registra las llamadas. */
function memPort() {
  const store = new Map<string, NormalizedItem>();
  const runs: Array<{ mode: string; status?: string; counts?: any }> = [];
  const port: CatalogSyncPort = {
    async startRun(_o, _s, mode) { runs.push({ mode }); return `run-${runs.length}`; },
    async upsertItems(_o, _s, items) {
      let created = 0, updated = 0;
      for (const i of items) { if (store.has(i.externalId)) updated++; else created++; store.set(i.externalId, i); }
      return { created, updated };
    },
    async deactivateMissing(_o, _s, seen) {
      const set = new Set(seen);
      let n = 0;
      for (const [id, it] of store) if (!set.has(id) && it.available) { store.set(id, { ...it, available: false }); n++; }
      return n;
    },
    async finishRun(runId, status, counts) { const r = runs[Number(runId.split("-")[1]) - 1]; r.status = status; r.counts = counts; },
  };
  return { port, store, runs };
}

describe("runCatalogSync — motor de sincronización", () => {
  it("sync completo crea todos los ítems", async () => {
    const m = memPort();
    const adapter = new FakeCatalogAdapter([item("1"), item("2"), item("3")]);
    const r = await runCatalogSync(m.port, adapter, "org1", { mode: "full" });
    expect(r.created).toBe(3);
    expect(r.updated).toBe(0);
    expect(m.store.size).toBe(3);
    expect(m.runs[0].status).toBe("success");
  });

  it("re-sync es idempotente: actualiza, no duplica", async () => {
    const m = memPort();
    await runCatalogSync(m.port, new FakeCatalogAdapter([item("1"), item("2")]), "org1", { mode: "full" });
    const r = await runCatalogSync(m.port, new FakeCatalogAdapter([item("1"), item("2")]), "org1", { mode: "full" });
    expect(r.created).toBe(0);
    expect(r.updated).toBe(2);
    expect(m.store.size).toBe(2);
  });

  it("producto que desaparece del origen → se marca NO disponible, no se borra", async () => {
    const m = memPort();
    await runCatalogSync(m.port, new FakeCatalogAdapter([item("1"), item("2"), item("3")]), "org1", { mode: "full" });
    // Segunda sync sin el "3".
    const r = await runCatalogSync(m.port, new FakeCatalogAdapter([item("1"), item("2")]), "org1", { mode: "full" });
    expect(r.deactivated).toBe(1);
    expect(m.store.size).toBe(3); // sigue existiendo
    expect(m.store.get("3")!.available).toBe(false);
  });

  it("sync incremental NO desactiva lo ausente (no ve todo el catálogo)", async () => {
    const m = memPort();
    await runCatalogSync(m.port, new FakeCatalogAdapter([item("1"), item("2")]), "org1", { mode: "full" });
    const r = await runCatalogSync(m.port, new FakeCatalogAdapter([item("1")]), "org1", { mode: "incremental" });
    expect(r.deactivated).toBe(0);
    expect(m.store.get("2")!.available).toBe(true);
  });

  it("ítems inválidos (sin id o sin nombre) cuentan como fallidos, no rompen la sync", async () => {
    const m = memPort();
    const bad = { ...item("x"), externalId: "" };
    const r = await runCatalogSync(m.port, new FakeCatalogAdapter([item("1"), bad]), "org1", { mode: "full" });
    expect(r.created).toBe(1);
    expect(r.failed).toBe(1);
  });
});

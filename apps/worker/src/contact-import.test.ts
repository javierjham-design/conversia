import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock de withTenant: ejecuta fn contra un tx en memoria y registra las
// opciones de transacción pedidas (el fix exige timeout ampliado por lote).
const txOptions: Array<Record<string, unknown> | undefined> = [];
const counters = { leadStatusFindMany: 0, fieldDefFindMany: 0 };
let failBatchContaining: string | null = null;

function makeTx() {
  const contacts = new Map<string, any>();
  (globalThis as any).__contacts = contacts;
  return {
    contact: {
      findFirst: async ({ where }: any) => contacts.get(where.phone) ?? null,
      create: async ({ data }: any) => {
        if (failBatchContaining && data.phone?.includes(failBatchContaining)) throw new Error("boom simulado");
        const c = { id: `c_${contacts.size + 1}`, ...data };
        contacts.set(data.phone, c);
        return c;
      },
      update: async () => ({}),
    },
    leadStatus: {
      findMany: async () => {
        counters.leadStatusFindMany++;
        return [{ id: "s1", code: "nuevo", name: "Nuevo interesado" }];
      },
    },
    customFieldDefinition: {
      findMany: async () => {
        counters.fieldDefFindMany++;
        return [{ id: "d1", key: "rubro" }];
      },
    },
    tag: { upsert: async () => ({ id: "t1" }) },
    tagAssignment: { createMany: async () => ({}) },
    lead: { findFirst: async () => null, create: async () => ({}), update: async () => ({}) },
    customFieldValue: { upsert: async () => ({}) },
    auditLog: { create: async () => ({}) },
  };
}

let sharedTx = makeTx();
vi.mock("@conversia/database", () => ({
  withTenant: async (_org: string, fn: (tx: any) => Promise<any>, _client?: unknown, options?: Record<string, unknown>) => {
    txOptions.push(options);
    return fn(sharedTx);
  },
}));

import { processContactImport } from "./contact-import";

function makeJob(rows: any[]) {
  return { data: { organizationId: "org1", userId: "u1", rows, updateExisting: false }, updateProgress: async () => undefined } as any;
}

beforeEach(() => {
  sharedTx = makeTx();
  txOptions.length = 0;
  counters.leadStatusFindMany = 0;
  counters.fieldDefFindMany = 0;
  failBatchContaining = null;
});

describe("processContactImport (regresión timeout de transacción)", () => {
  it("importa 320 filas completas: lotes de 50 con timeout ampliado y lecturas invariantes UNA vez", async () => {
    const rows = Array.from({ length: 320 }, (_, i) => ({
      firstName: `P${i}`,
      phone: `+5691${String(i).padStart(7, "0")}`,
      stage: "nuevo",
      custom: { rubro: "dental" },
      tags: "migrado",
    }));
    const r = await processContactImport(makeJob(rows));
    expect(r.created).toBe(320);
    expect(r.updated + r.skipped).toBe(0);
    expect(r.errors).toEqual([]);
    // Las lecturas que no dependen de la fila salieron del bucle: 1 vez por job
    expect(counters.leadStatusFindMany).toBe(1);
    expect(counters.fieldDefFindMany).toBe(1);
    // 1 refs + 7 lotes (320/50) + 1 audit; los 7 lotes con timeout ampliado
    const batchOpts = txOptions.filter((o) => o?.timeout === 30_000 && o?.maxWait === 10_000);
    expect(batchOpts.length).toBe(Math.ceil(320 / 50));
  });

  it("un lote que falla queda en errors con su rango y el import sigue (números reales)", async () => {
    // Filas 51-100 (2.º lote) llevan prefijo marcador que hace fallar contact.create
    const rows = Array.from({ length: 150 }, (_, i) => ({
      firstName: `P${i}`,
      phone: i >= 50 && i < 100 ? `+56999${String(i).padStart(6, "0")}` : `+56921${String(i).padStart(6, "0")}`,
    }));
    failBatchContaining = "56999";
    const r = await processContactImport(makeJob(rows));
    expect(r.created).toBe(100); // lotes 1 y 3 completos
    expect(r.errors.some((e) => e.reason.includes("lote filas 51-100"))).toBe(true);
  });
});

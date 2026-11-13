import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockStorage } from "@conversia/storage";

const ENV = { MEDIA_RETENTION_DAYS: 365 };
vi.mock("@conversia/config", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEnv: () => ENV,
}));

const filas: Array<{ id: string; key: string; scope: string; deletedAt: Date | null; createdAt: Date }> = [];
const updates: Array<{ id: string; data: Record<string, unknown> }> = [];

vi.mock("@conversia/database", () => ({
  getAdminPrisma: () => ({
    file: {
      findMany: async ({ where, take }: { where: any; take: number }) =>
        filas
          .filter(
            (f) =>
              f.scope === where.scope &&
              f.deletedAt === null &&
              f.createdAt.getTime() < (where.createdAt.lt as Date).getTime(),
          )
          .slice(0, take)
          .map((f) => ({ id: f.id, key: f.key })),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push({ id: where.id, data });
        const f = filas.find((x) => x.id === where.id);
        if (f) f.deletedAt = data.deletedAt as Date;
        return f;
      },
    },
  }),
}));

import { barrerMediosVencidos, fechaDeCorte, TOPE_POR_PASADA } from "./media-retention";
import { _ponerStorageDelWorker } from "./media-store";

const AHORA = new Date("2026-11-12T00:00:00Z");
const hace = (dias: number) => new Date(AHORA.getTime() - dias * 24 * 3600 * 1000);

function sembrar(items: Array<{ id: string; dias: number; scope?: string; borrado?: boolean }>) {
  filas.length = 0;
  updates.length = 0;
  for (const i of items) {
    filas.push({ id: i.id, key: `org1/${i.id}/image.jpg`, scope: i.scope ?? "message", deletedAt: i.borrado ? AHORA : null, createdAt: hace(i.dias) });
  }
}

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  ENV.MEDIA_RETENTION_DAYS = 365;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  logSpy.mockRestore();
  _ponerStorageDelWorker(undefined);
});

describe("la fecha de corte", () => {
  it("sale de los días configurados", () => {
    expect(fechaDeCorte(AHORA, 365).toISOString()).toBe("2025-11-12T00:00:00.000Z");
    expect(fechaDeCorte(AHORA, 30).toISOString()).toBe("2026-10-13T00:00:00.000Z");
  });
});

describe("borra SOLO lo vencido", () => {
  it("un archivo de hace 400 días sí, uno de hace 10 no", async () => {
    const s = new MockStorage();
    await s.put("org1/viejo/image.jpg", Buffer.from("x"), "image/jpeg");
    await s.put("org1/nuevo/image.jpg", Buffer.from("x"), "image/jpeg");
    _ponerStorageDelWorker(s);
    sembrar([{ id: "viejo", dias: 400 }, { id: "nuevo", dias: 10 }]);

    const r = await barrerMediosVencidos(AHORA);
    expect(r.borrados).toBe(1);
    expect(await s.get("org1/viejo/image.jpg")).toBeNull();
    expect(await s.get("org1/nuevo/image.jpg")).not.toBeNull();
  });

  it("la FILA no se borra: se marca, para que el chat pueda decir «ya no está disponible»", async () => {
    _ponerStorageDelWorker(new MockStorage());
    sembrar([{ id: "viejo", dias: 400 }]);
    await barrerMediosVencidos(AHORA);
    expect(updates).toHaveLength(1);
    expect(updates[0].data.deletedAt).toEqual(AHORA);
    expect(filas.find((f) => f.id === "viejo")?.deletedAt).toEqual(AHORA);
  });

  it("lo que NO es de un mensaje (conocimiento, marca, exportes) no se toca", async () => {
    _ponerStorageDelWorker(new MockStorage());
    sembrar([{ id: "a", dias: 400, scope: "knowledge" }, { id: "b", dias: 400, scope: "branding" }]);
    expect((await barrerMediosVencidos(AHORA)).borrados).toBe(0);
  });

  it("lo ya marcado no se vuelve a procesar (idempotente)", async () => {
    _ponerStorageDelWorker(new MockStorage());
    sembrar([{ id: "viejo", dias: 400, borrado: true }]);
    expect((await barrerMediosVencidos(AHORA)).borrados).toBe(0);
  });

  it("con el plazo en 30 días, uno de 100 ya vence", async () => {
    ENV.MEDIA_RETENTION_DAYS = 30;
    _ponerStorageDelWorker(new MockStorage());
    sembrar([{ id: "x", dias: 100 }]);
    expect((await barrerMediosVencidos(AHORA)).borrados).toBe(1);
  });
});

describe("sin bucket configurado no hay nada que barrer", () => {
  it("no toca la base siquiera", async () => {
    _ponerStorageDelWorker(null);
    sembrar([{ id: "viejo", dias: 400 }]);
    expect((await barrerMediosVencidos(AHORA)).borrados).toBe(0);
    expect(updates).toHaveLength(0);
  });
});

describe("si el bucket falla, la fila queda SIN marcar para reintentar", () => {
  let err: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { err = vi.spyOn(console, "error").mockImplementation(() => undefined); });
  afterEach(() => err.mockRestore());

  it("al revés quedaría un objeto pagándose para siempre sin fila que lo recuerde", async () => {
    const roto = { ...new MockStorage(), bucket: "roto", del: async () => { throw new Error("502"); } } as never;
    _ponerStorageDelWorker(roto);
    sembrar([{ id: "viejo", dias: 400 }]);
    const r = await barrerMediosVencidos(AHORA);
    expect(r.borrados).toBe(0);
    expect(updates).toHaveLength(0);
    expect(filas[0].deletedAt).toBeNull();
    expect(err).toHaveBeenCalled();
  });
});

describe("el barrido no se come el worker", () => {
  it("tiene tope por pasada", async () => {
    expect(TOPE_POR_PASADA).toBeLessThanOrEqual(1000);
    _ponerStorageDelWorker(new MockStorage());
    sembrar(Array.from({ length: TOPE_POR_PASADA + 50 }, (_, i) => ({ id: `f${i}`, dias: 400 })));
    expect((await barrerMediosVencidos(AHORA)).borrados).toBe(TOPE_POR_PASADA);
  });
});

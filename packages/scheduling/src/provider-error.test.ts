import { afterEach, describe, expect, it, vi } from "vitest";
import { ClarivaSchedulingProvider } from "./index";

// F1: cuando el proveedor se cae, getAvailableSlots agregado tragaba el error por profesional
// (.catch(()=>[])) → [] → el bot decía "no hay horas". Ahora: éxito parcial OK, pero si TODOS
// fallan, PROPAGA el error (para que el bot avise "no puedo ver la agenda", no "no hay").

const prov = () => new ClarivaSchedulingProvider({ baseUrl: "http://clariva.test", apiKey: "k" } as any);
const q = { from: "2026-11-09", to: "2026-11-09", clinicId: "c" } as any;

function mockFetch(handler: (url: string) => { ok: boolean; status?: number; body?: unknown }) {
  return vi.fn(async (url: string) => {
    const r = handler(String(url));
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), async text() { return ""; }, async json() { return r.body ?? {}; } };
  });
}

describe("ClarivaSchedulingProvider.getAvailableSlots — un error NO es 'no hay horas'", () => {
  afterEach(() => vi.restoreAllMocks());

  it("si TODOS los profesionales fallan, LANZA (no devuelve [] en silencio)", async () => {
    global.fetch = mockFetch((url) =>
      url.includes("/professionals")
        ? { ok: true, body: [{ id: "p1", name: "A" }, { id: "p2", name: "B" }] }
        : { ok: false, status: 503 },
    ) as unknown as typeof fetch;
    await expect(prov().getAvailableSlots(q)).rejects.toThrow();
  });

  it("éxito PARCIAL: si un profesional responde, devuelve sus cupos (no falla por el otro)", async () => {
    global.fetch = mockFetch((url) => {
      if (url.includes("/professionals")) return { ok: true, body: [{ id: "p1", name: "A" }, { id: "p2", name: "B" }] };
      if (url.includes("professionalId=p1")) return { ok: true, body: [{ start: "2026-11-09T12:15:00.000Z", end: "2026-11-09T12:30:00.000Z", professionalId: "p1", clinicId: "c" }] };
      return { ok: false, status: 503 }; // p2 cae
    }) as unknown as typeof fetch;
    const slots = await prov().getAvailableSlots(q);
    expect(slots).toHaveLength(1);
    expect(slots[0].professionalId).toBe("p1");
  });

  it("todos responden vacío (sin error) → [] legítimo (no lanza)", async () => {
    global.fetch = mockFetch((url) =>
      url.includes("/professionals")
        ? { ok: true, body: [{ id: "p1", name: "A" }] }
        : { ok: true, body: [] },
    ) as unknown as typeof fetch;
    await expect(prov().getAvailableSlots(q)).resolves.toEqual([]);
  });
});

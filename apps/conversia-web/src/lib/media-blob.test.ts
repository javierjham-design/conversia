import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./api", () => ({ getToken: () => "tok-de-prueba" }));
vi.mock("./api-base", () => ({ apiBase: () => "https://api.test" }));

import { obtenerBlob, MedioExpirado, _limpiarCacheDeMedios, MS_ANTES_DE_LIBERAR } from "./media-blob";

/**
 * D3.a — la bandeja recarga el hilo COMPLETO en cada evento SSE. Si cada burbuja pidiera su
 * archivo al montar, una conversación con 20 fotos las bajaría enteras otra vez con cada
 * mensaje nuevo, y cada descarga pasa por nuestra API, que a su vez la pide a Meta.
 */

let creadas = 0;
let revocadas = 0;

beforeEach(() => {
  creadas = 0;
  revocadas = 0;
  _limpiarCacheDeMedios();
  // jsdom no está: se definen los mínimos que usa el módulo.
  globalThis.URL.createObjectURL = vi.fn(() => `blob:fake-${++creadas}`) as never;
  globalThis.URL.revokeObjectURL = vi.fn(() => { revocadas++; }) as never;
});

afterEach(() => {
  _limpiarCacheDeMedios();
  vi.restoreAllMocks();
});

function responde(veces: { ok: boolean; status?: number; body?: unknown }[]) {
  let i = 0;
  const llamadas: string[] = [];
  globalThis.fetch = vi.fn(async (url: unknown, init?: unknown) => {
    llamadas.push(String(url));
    const r = veces[Math.min(i++, veces.length - 1)];
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 404),
      blob: async () => new Blob(["x"]),
      json: async () => r.body ?? {},
      _init: init,
    } as never;
  }) as never;
  return llamadas;
}

describe("una sola descarga por archivo", () => {
  it("la segunda vez devuelve el MISMO blob sin volver a pedirlo", async () => {
    const llamadas = responde([{ ok: true }]);
    const a = await obtenerBlob("/conversations/c1/messages/m1/image");
    const b = await obtenerBlob("/conversations/c1/messages/m1/image");
    expect(a).toBe(b);
    expect(llamadas).toHaveLength(1);
  });

  it("dos burbujas que piden A LA VEZ generan UNA sola descarga", async () => {
    const llamadas = responde([{ ok: true }]);
    const [a, b] = await Promise.all([
      obtenerBlob("/conversations/c1/messages/m1/image"),
      obtenerBlob("/conversations/c1/messages/m1/image"),
    ]);
    expect(a).toBe(b);
    expect(llamadas, "la descarga en vuelo debe deduplicarse").toHaveLength(1);
  });

  it("archivos distintos sí se bajan por separado", async () => {
    const llamadas = responde([{ ok: true }]);
    await obtenerBlob("/conversations/c1/messages/m1/image");
    await obtenerBlob("/conversations/c1/messages/m2/image");
    expect(llamadas).toHaveLength(2);
  });
});

describe("el token va en la CABECERA, nunca en la URL", () => {
  it("la URL no lleva el token", async () => {
    const llamadas = responde([{ ok: true }]);
    await obtenerBlob("/conversations/c1/messages/m1/image");
    expect(llamadas[0]).toBe("https://api.test/conversations/c1/messages/m1/image");
    expect(llamadas[0]).not.toContain("tok-de-prueba");
  });

  it("y sí va como Bearer", async () => {
    responde([{ ok: true }]);
    await obtenerBlob("/conversations/c1/messages/m1/image");
    const init = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers.authorization).toBe("Bearer tok-de-prueba");
  });
});

describe("expirado: Meta borra los medios y eso NO es un error", () => {
  it("un 404 con MEDIA_EXPIRED se distingue de una falla cualquiera", async () => {
    responde([{ ok: false, status: 404, body: { code: "MEDIA_EXPIRED" } }]);
    await expect(obtenerBlob("/conversations/c1/messages/m1/image")).rejects.toBeInstanceOf(MedioExpirado);
  });

  it("y NO se reintenta: si Meta lo borró, volver a pedirlo es regalarle tráfico", async () => {
    const llamadas = responde([{ ok: false, status: 404, body: { code: "MEDIA_EXPIRED" } }]);
    await expect(obtenerBlob("/x")).rejects.toBeInstanceOf(MedioExpirado);
    await expect(obtenerBlob("/x")).rejects.toBeInstanceOf(MedioExpirado);
    expect(llamadas).toHaveLength(1);
  });

  it("un 500 NO es expiración: es un error y se puede reintentar", async () => {
    const llamadas = responde([{ ok: false, status: 500 }, { ok: true }]);
    await expect(obtenerBlob("/y")).rejects.toThrow();
    await expect(obtenerBlob("/y")).resolves.toMatch(/^blob:/);
    expect(llamadas).toHaveLength(2);
  });

  it("un 404 SIN el código tampoco se trata como expirado", async () => {
    responde([{ ok: false, status: 404, body: { message: "no existe" } }]);
    await expect(obtenerBlob("/z")).rejects.not.toBeInstanceOf(MedioExpirado);
  });
});

describe("liberar la memoria sin romper el refetch", () => {
  it("el blob NO se suelta en el instante en que se desmonta la burbuja", () => {
    // Ese es justo el refetch del SSE: si se revocara al desmontar, volvería a bajar todo.
    expect(MS_ANTES_DE_LIBERAR).toBeGreaterThanOrEqual(60_000);
  });

  it("limpiar la caché revoca lo creado (no deja memoria colgando)", async () => {
    responde([{ ok: true }]);
    await obtenerBlob("/a");
    await obtenerBlob("/b");
    expect(creadas).toBe(2);
    _limpiarCacheDeMedios();
    expect(revocadas).toBe(2);
  });
});

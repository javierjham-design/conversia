import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MEDIA_EXPIRED } from "@conversia/types";

vi.mock("@conversia/config", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEnv: () => ({ META_GRAPH_VERSION: "v26.0", META_APP_SECRET: "s", META_ACCESS_TOKEN: "tok-global" }),
  withAppSecretProof: (url: string) => url,
}));

import { descargarMediaDeMeta, MediaExpiradoError, CACHE_DE_MEDIA, LIMITES_BYTES } from "../src/conversations/media-proxy";

/**
 * D2 — la descarga de medios de Meta, que antes estaba COPIADA en tres endpoints con tres
 * textos de error distintos y tres `cache-control` distintos.
 */

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  vi.restoreAllMocks();
});

/** Doble de Meta: primera llamada = metadatos, segunda = el archivo. */
function metaDevuelve(meta: Record<string, unknown> | null, bytes?: Buffer, okArchivo = true) {
  const llamadas: string[] = [];
  globalThis.fetch = vi.fn(async (url: unknown) => {
    llamadas.push(String(url));
    if (llamadas.length === 1) {
      return { ok: true, json: async () => meta ?? {} } as never;
    }
    // OJO: `Buffer.from(x).buffer` devuelve el POOL de Node (8 KB), no el trozo. Un doble
    // que devuelve eso hace pasar un test que mide tamaños y miente sobre el real.
    const b = bytes ?? Buffer.alloc(0);
    return { ok: okArchivo, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) } as never;
  }) as never;
  return llamadas;
}

describe("descarga desde Meta", () => {
  it("devuelve el archivo con su mime y su tamaño", async () => {
    const bytes = Buffer.from("contenido de prueba");
    metaDevuelve({ url: "https://lookaside/x", mime_type: "image/jpeg" }, bytes);
    const r = await descargarMediaDeMeta("MEDIA1", "tok");
    expect(r.mime).toBe("image/jpeg");
    expect(r.sizeBytes).toBe(bytes.byteLength);
    expect(r.buffer.toString()).toBe("contenido de prueba");
  });

  it("son DOS llamadas: el media id devuelve una URL firmada, y esa URL el archivo", async () => {
    const llamadas = metaDevuelve({ url: "https://lookaside/x", mime_type: "image/jpeg" }, Buffer.from("a"));
    await descargarMediaDeMeta("MEDIA1", "tok");
    expect(llamadas).toHaveLength(2);
    expect(llamadas[0]).toContain("MEDIA1");
    expect(llamadas[1]).toBe("https://lookaside/x");
  });

  it("sin mime declarado cae a un tipo genérico, no a undefined", async () => {
    metaDevuelve({ url: "https://lookaside/x" }, Buffer.from("a"));
    expect((await descargarMediaDeMeta("M", "tok")).mime).toBe("application/octet-stream");
  });
});

describe("EXPIRADO: Meta borra los medios y eso NO es un error nuestro", () => {
  it("sin URL firmada → MEDIA_EXPIRED, no un 404 cualquiera", async () => {
    metaDevuelve({ error: { message: "does not exist" } });
    await expect(descargarMediaDeMeta("M", "tok")).rejects.toBeInstanceOf(MediaExpiradoError);
    try {
      metaDevuelve({ error: {} });
      await descargarMediaDeMeta("M", "tok");
    } catch (e) {
      const body = (e as { getResponse(): { code: string; message: string } }).getResponse();
      expect(body.code).toBe(MEDIA_EXPIRED);
      // El texto es para el dueño: tiene que explicar, no culpar.
      expect(body.message).toMatch(/ya no está disponible/i);
    }
  });

  it("si la URL firmada falla al bajar, también es expirado", async () => {
    metaDevuelve({ url: "https://lookaside/x", mime_type: "image/jpeg" }, Buffer.from("a"), false);
    await expect(descargarMediaDeMeta("M", "tok")).rejects.toBeInstanceOf(MediaExpiradoError);
  });

  it("una respuesta de Meta ilegible no explota con un error raro", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => { throw new Error("no es json"); } })) as never;
    await expect(descargarMediaDeMeta("M", "tok")).rejects.toBeInstanceOf(MediaExpiradoError);
  });
});

describe("límites de tamaño", () => {
  it("corta ANTES de bajar el cuerpo si Meta ya declara que pesa de más", async () => {
    const llamadas = metaDevuelve({ url: "https://lookaside/x", mime_type: "video/mp4", file_size: 20 * 1024 * 1024 });
    await expect(descargarMediaDeMeta("M", "tok", { limiteBytes: LIMITES_BYTES.video })).rejects.toThrow(/pesa más/i);
    expect(llamadas, "no debe llegar a pedir el archivo").toHaveLength(1);
  });

  it("y también después, si Meta mintió sobre el tamaño", async () => {
    metaDevuelve({ url: "https://lookaside/x", mime_type: "video/mp4" }, Buffer.alloc(20 * 1024 * 1024));
    await expect(descargarMediaDeMeta("M", "tok", { limiteBytes: LIMITES_BYTES.video })).rejects.toThrow(/pesa más/i);
  });

  it("el video admite 16 MB, que es el techo de WhatsApp", () => {
    expect(LIMITES_BYTES.video).toBe(16 * 1024 * 1024);
  });
});

describe("caché", () => {
  it("un día e immutable: el media id de Meta NO cambia nunca", () => {
    expect(CACHE_DE_MEDIA).toContain("max-age=86400");
    expect(CACHE_DE_MEDIA).toContain("immutable");
    expect(CACHE_DE_MEDIA).toContain("private"); // jamás en una caché compartida
  });
});

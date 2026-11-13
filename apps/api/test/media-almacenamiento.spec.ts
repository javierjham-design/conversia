import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MockStorage, guardarMedioDeMensaje, claveDeMedio } from "@conversia/storage";

/**
 * D4 — los medios dejan de depender de que Meta los conserve.
 *
 * Lo que se prueba acá es lo que de verdad importa del cambio: que la SEGUNDA apertura de una
 * foto no vuelva a llamar a Meta, y que sin bucket configurado todo siga funcionando
 * exactamente como antes.
 */

/** Doble del `tx` por tenant: solo los dos modelos que toca el guardado. */
function txFalso() {
  const files: Array<Record<string, unknown>> = [];
  const adjuntos: Array<Record<string, unknown>> = [];
  return {
    files,
    adjuntos,
    messageAttachment: {
      findFirst: async ({ where }: { where: { messageId: string; kind: string } }) =>
        (adjuntos.find((a) => a.messageId === where.messageId && a.kind === where.kind) as { fileId: string | null } | undefined) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        adjuntos.push(data);
        return data;
      },
    },
    file: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: `f${files.length + 1}` };
        files.push(row);
        return row as { id: string };
      },
    },
  };
}

describe("guardar un medio deja las tres piezas", () => {
  it("objeto en el bucket, fila en files y el adjunto que las une", async () => {
    const s = new MockStorage();
    const tx = txFalso();
    await guardarMedioDeMensaje(s, tx, {
      organizationId: "org1",
      messageId: "m1",
      kind: "image",
      body: Buffer.from("foto"),
      mime: "image/jpeg",
    });
    expect(s.puts).toEqual(["org1/m1/image.jpg"]);
    expect(tx.files).toHaveLength(1);
    expect(tx.files[0]).toMatchObject({ organizationId: "org1", scope: "message", mime: "image/jpeg", size: 4 });
    expect(tx.adjuntos[0]).toMatchObject({ messageId: "m1", kind: "image", fileId: "f1" });
  });

  it("el documento conserva su nombre real", async () => {
    const s = new MockStorage();
    const tx = txFalso();
    await guardarMedioDeMensaje(s, tx, {
      organizationId: "org1", messageId: "m2", kind: "document",
      body: Buffer.from("pdf"), mime: "application/pdf", nombre: "presupuesto.pdf",
    });
    expect(tx.files[0].name).toBe("presupuesto.pdf");
  });

  it("guardar DOS VECES el mismo medio no duplica nada (el primer uso ya fue)", async () => {
    const s = new MockStorage();
    const tx = txFalso();
    const datos = { organizationId: "org1", messageId: "m1", kind: "image" as const, body: Buffer.from("x"), mime: "image/png" };
    await guardarMedioDeMensaje(s, tx, datos);
    await guardarMedioDeMensaje(s, tx, datos);
    expect(tx.files).toHaveLength(1);
    expect(tx.adjuntos).toHaveLength(1);
    expect(s.puts).toHaveLength(1);
  });

  it("un sticker se guarda COMO sticker, no como foto", async () => {
    const s = new MockStorage();
    const tx = txFalso();
    await guardarMedioDeMensaje(s, tx, { organizationId: "org1", messageId: "m3", kind: "sticker", body: Buffer.from("s"), mime: "image/webp" });
    expect(s.puts).toEqual(["org1/m3/sticker.webp"]);
    expect(tx.adjuntos[0].kind).toBe("sticker");
  });
});

describe("sin bucket configurado NO cambia nada", () => {
  it("no escribe filas ni intenta subir", async () => {
    const tx = txFalso();
    await guardarMedioDeMensaje(null, tx, {
      organizationId: "org1", messageId: "m1", kind: "image", body: Buffer.from("x"), mime: "image/png",
    });
    expect(tx.files).toHaveLength(0);
    expect(tx.adjuntos).toHaveLength(0);
  });
});

describe("el bucket NUNCA puede tumbar la vista ni el turno", () => {
  let err: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { err = vi.spyOn(console, "error").mockImplementation(() => undefined); });
  afterEach(() => err.mockRestore());

  it("si subir falla, no lanza: el dueño ya tiene su archivo en pantalla", async () => {
    const roto = { ...new MockStorage(), bucket: "roto", put: async () => { throw new Error("502 del bucket"); } } as never;
    const tx = txFalso();
    await expect(
      guardarMedioDeMensaje(roto, tx, { organizationId: "org1", messageId: "m1", kind: "image", body: Buffer.from("x"), mime: "image/png" }),
    ).resolves.toBeUndefined();
    expect(tx.files).toHaveLength(0);
    expect(err).toHaveBeenCalled();
  });

  it("si escribir la fila falla, tampoco", async () => {
    const s = new MockStorage();
    const tx = { ...txFalso(), file: { create: async () => { throw new Error("BD caída"); } } } as never;
    await expect(
      guardarMedioDeMensaje(s, tx, { organizationId: "org1", messageId: "m1", kind: "image", body: Buffer.from("x"), mime: "image/png" }),
    ).resolves.toBeUndefined();
  });
});

describe("la clave agrupa por organización", () => {
  it("permite borrar o listar un tenant entero sin mirar la base", () => {
    expect(claveDeMedio("orgA", "m1", "audio", "audio/ogg")).toBe("orgA/m1/audio.ogg");
    expect(claveDeMedio("orgB", "m1", "audio", "audio/ogg").startsWith("orgB/")).toBe(true);
  });
});

describe("la SEGUNDA apertura se sirve del bucket", () => {
  it("el objeto queda disponible para leerlo sin tocar Meta", async () => {
    const s = new MockStorage();
    const tx = txFalso();
    await guardarMedioDeMensaje(s, tx, {
      organizationId: "org1", messageId: "m1", kind: "image", body: Buffer.from("la foto"), mime: "image/jpeg",
    });
    // Esto es lo que hace `leerGuardado` del controlador: busca el adjunto, su file, y pide
    // la clave al bucket. Si esto devuelve los bytes, la llamada a Graph no ocurre.
    const adj = await tx.messageAttachment.findFirst({ where: { messageId: "m1", kind: "image" } });
    expect(adj?.fileId).toBe("f1");
    const key = tx.files[0].key as string;
    const obj = await s.get(key);
    expect(obj?.body.toString()).toBe("la foto");
  });
});

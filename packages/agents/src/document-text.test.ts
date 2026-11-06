import { describe, expect, it } from "vitest";
import { extractDocumentText } from "./document-text.js";

/**
 * EL EXTRACTOR DE TEXTO SE MUDÓ, NO CAMBIÓ.
 *
 * Vivía en `apps/worker/src/document-text.ts` y lo usa el worker de TuBot desde hace
 * tiempo para que el agente pueda LEER los PDF que mandan los clientes por WhatsApp. Se
 * movió a este paquete para que Convi (en el api) lea los mismos archivos con el mismo
 * código, en vez de tener dos copias que se separan con el tiempo.
 *
 * Como el archivo que cambió de sitio corre en producción para TuBot, estos tests fijan su
 * comportamiento: si alguien lo "mejora", acá se nota. Antes de la mudanza no tenía
 * ninguno — la mudanza es un buen momento para dejarlos puestos.
 */

const buf = (s: string) => Buffer.from(s, "utf8");

describe("extractDocumentText", () => {
  it("lee texto plano", async () => {
    expect(await extractDocumentText(buf("Corte $12.000"), "text/plain", "precios.txt")).toBe("Corte $12.000");
  });

  it("lee un CSV por su extensión aunque el mime venga vacío", async () => {
    expect(await extractDocumentText(buf("servicio,precio\ncorte,12000"), "", "lista.csv")).toContain("corte,12000");
  });

  it("normaliza los saltos de línea de más", async () => {
    expect(await extractDocumentText(buf("uno\n\n\n\ndos   \n"), "text/plain", "a.txt")).toBe("uno\n\ndos");
  });

  it("un archivo vacío devuelve null (no una cadena vacía)", async () => {
    expect(await extractDocumentText(buf("   \n  "), "text/plain", "a.txt")).toBeNull();
  });

  it("recorta los documentos largos y lo DICE", async () => {
    const largo = "a".repeat(7000);
    const r = await extractDocumentText(buf(largo), "text/plain", "a.txt");
    expect(r).toMatch(/documento recortado/);
    expect(r!.length).toBeLessThan(6200);
  });

  it("un formato que no sabe leer devuelve null en vez de lanzar", async () => {
    expect(await extractDocumentText(buf("%!PS"), "application/postscript", "a.ps")).toBeNull();
    expect(await extractDocumentText(buf("x"), "application/msword", "a.doc")).toBeNull();
  });

  it("un PDF corrupto no tumba a quien lo llama", async () => {
    // El worker lo llama dentro del camino de un mensaje entrante: si lanzara, el mensaje
    // del cliente se perdería por un adjunto roto.
    expect(await extractDocumentText(buf("%PDF-1.4 roto"), "application/pdf", "roto.pdf")).toBeNull();
  });
});

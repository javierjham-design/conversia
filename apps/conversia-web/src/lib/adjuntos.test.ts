import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MAX_ADJUNTOS,
  MAX_BYTES_ADJUNTO,
  medidaReducida,
  nombreCorto,
  pesoLegible,
  porQueNoPuedo,
  soloBase64,
  tipoDeArchivo,
} from "./adjuntos";

/**
 * MOSTRARLE LAS COSAS A CONVI, DESDE EL NAVEGADOR.
 *
 * Lo que el dueño pidió: poder mandarle audios, fotos, pantallazos, enlaces y PDF. Lo que
 * hay que cuidar para que eso no sea un dolor:
 *  - Una foto de teléfono pesa 4-8 MB y el modelo la achica igual antes de mirarla.
 *  - Un archivo que el servidor va a rechazar se ataja acá, con una frase que se entienda.
 *  - Lo que decide el tipo es el MIME, no la extensión.
 */

describe("qué sabemos leer", () => {
  it("reconoce fotos, audios y documentos", () => {
    expect(tipoDeArchivo("image/jpeg")).toBe("imagen");
    expect(tipoDeArchivo("image/png")).toBe("imagen");
    expect(tipoDeArchivo("audio/webm")).toBe("audio");
    expect(tipoDeArchivo("audio/ogg; codecs=opus")).toBe("audio");
    expect(tipoDeArchivo("application/pdf")).toBe("documento");
    expect(tipoDeArchivo("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("documento");
  });

  it("no se deja engañar por la extensión", () => {
    // Un ejecutable renombrado a .jpg no es una imagen: manda el MIME.
    expect(tipoDeArchivo("application/x-msdownload", "foto.jpg")).toBeNull();
  });

  it("acepta un .csv aunque el navegador no mande MIME", () => {
    expect(tipoDeArchivo("", "lista.csv")).toBe("documento");
    expect(tipoDeArchivo("", "cualquiera.bin")).toBeNull();
  });
});

describe("por qué no puedo con este archivo", () => {
  const archivo = (p: Partial<{ type: string; name: string; size: number }>) => ({ type: "application/pdf", name: "precios.pdf", size: 1000, ...p });

  it("deja pasar lo que sirve", () => {
    expect(porQueNoPuedo(archivo({}), 0)).toBeNull();
  });

  it("corta en el cuarto archivo", () => {
    expect(porQueNoPuedo(archivo({}), MAX_ADJUNTOS)).toMatch(/3 archivos/);
  });

  it("explica un formato que no sabe leer, con el nombre del archivo", () => {
    const motivo = porQueNoPuedo(archivo({ type: "application/zip", name: "respaldo.zip" }), 0);
    expect(motivo).toContain("respaldo.zip");
    expect(motivo).toMatch(/fotos, PDF/);
  });

  it("corta los documentos pesados…", () => {
    expect(porQueNoPuedo(archivo({ size: MAX_BYTES_ADJUNTO + 1 }), 0)).toMatch(/3 MB/);
  });

  it("…pero NO las fotos, que se achican antes de subir", () => {
    // Si el tope se aplicara a las imágenes, una foto de un teléfono moderno (4-8 MB) se
    // rechazaría siempre — justo el caso más común de "mírame esto".
    expect(porQueNoPuedo(archivo({ type: "image/jpeg", name: "cartel.jpg", size: 7_000_000 }), 0)).toBeNull();
  });
});

describe("achicar", () => {
  it("reduce manteniendo la proporción", () => {
    expect(medidaReducida(4000, 3000, 1400)).toEqual({ ancho: 1400, alto: 1050 });
    expect(medidaReducida(1200, 4000, 1400)).toEqual({ ancho: 420, alto: 1400 });
  });

  it("nunca agranda una imagen chica", () => {
    expect(medidaReducida(300, 200, 1400)).toEqual({ ancho: 300, alto: 200 });
  });

  it("no devuelve cero píxeles con proporciones extremas", () => {
    const m = medidaReducida(10_000, 3, 1400);
    expect(m.alto).toBeGreaterThanOrEqual(1);
  });
});

describe("cómo se muestra", () => {
  it("acorta el nombre conservando la extensión", () => {
    expect(nombreCorto("lista-de-precios-actualizada-noviembre.pdf", 20)).toMatch(/…\.pdf$/);
    expect(nombreCorto("corto.pdf", 20)).toBe("corto.pdf");
  });

  it("dice el peso en algo que se entiende", () => {
    expect(pesoLegible(340 * 1024)).toBe("340 KB");
    expect(pesoLegible(1.5 * 1024 * 1024)).toBe("1,5 MB");
    expect(pesoLegible(10)).toBe("1 KB");
  });

  it("le quita el prefijo al data URL", () => {
    expect(soloBase64("data:image/jpeg;base64,AAAA")).toBe("AAAA");
    expect(soloBase64("AAAA")).toBe("AAAA");
  });
});

/**
 * Que la lógica esté bien no sirve si el compositor no la usa. Las tres vías tienen que
 * estar: el clip, el micrófono y PEGAR (que es como se manda de verdad un pantallazo).
 */
describe("el compositor de Convi", () => {
  const widget = readFileSync(join(__dirname, "..", "components", "SupportWidget.tsx"), "utf8");

  it("tiene clip, micrófono y pegado", () => {
    expect(widget).toContain('type="file"');
    expect(widget, "falta el botón de grabar").toMatch(/alternarGrabacion/);
    expect(widget, "no se puede pegar un pantallazo").toMatch(/onPaste=\{alPegar\}/);
  });

  it("acepta fotos, PDF y planillas en el selector", () => {
    const accept = /accept="([^"]+)"/.exec(widget)?.[1] ?? "";
    for (const t of ["image/jpeg", "image/png", "application/pdf"]) expect(accept, `falta ${t}`).toContain(t);
  });

  it("manda los adjuntos al servidor con el mensaje", () => {
    expect(widget).toMatch(/adjuntos: archivos\.map/);
  });

  it("deja mandar un mensaje que es SOLO una foto o una nota de voz", () => {
    // Exigir texto obligaba a escribir "mira esto" para poder mandar lo que importa.
    expect(widget).toMatch(/if \(\(!body && !archivos\.length\) \|\| busy\) return;/);
  });

  it("el mensaje del dueño muestra lo que adjuntó (si no, se ve vacío)", () => {
    expect(widget).toMatch(/m\.adjuntos\?\.length \?/);
  });

  it("no ofrece grabar donde el navegador no puede", () => {
    expect(widget).toMatch(/puedeGrabar\(\) \?/);
  });
});

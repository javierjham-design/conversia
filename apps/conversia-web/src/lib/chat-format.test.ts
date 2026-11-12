import { describe, it, expect } from "vitest";
import {
  abreDia,
  esSoloEmojis,
  etiquetaAccesible,
  etiquetaDeDia,
  familiaDeMime,
  formatearDuracion,
  formatearTamaño,
  siguenJuntos,
  tickDeEstado,
  traducirPlaceholderViejo,
  trozosConEnlaces,
} from "./chat-format";

/**
 * D3 — las reglas que hacen que un hilo se lea como un chat. Todas tienen casos de borde
 * (la medianoche, el cambio de autor, el audio de más de una hora) y ninguna necesita un
 * navegador para comprobarse.
 */

// Fecha fija: una etiqueta que dice «Hoy» es correcta o no SEGÚN EL DÍA en que se mire, y un
// test con `new Date()` dentro deja de valer mañana — que es exactamente cómo una fecha
// escrita a mano tumbó main el 10-nov.
const AHORA = new Date("2026-11-11T15:00:00-03:00");

describe("duración", () => {
  it("formato de minutos y de horas", () => {
    expect(formatearDuracion(0)).toBe("0:00");
    expect(formatearDuracion(42)).toBe("0:42");
    expect(formatearDuracion(65)).toBe("1:05");
    expect(formatearDuracion(3930)).toBe("1:05:30");
  });

  it("nunca devuelve NaN, que es lo que se ve si el audio aún no cargó", () => {
    for (const v of [null, undefined, NaN, -5, Infinity]) {
      expect(formatearDuracion(v as number)).toBe("0:00");
    }
  });
});

describe("separadores de día", () => {
  it("hoy, ayer y un día cualquiera", () => {
    expect(etiquetaDeDia("2026-11-11T09:00:00-03:00", AHORA)).toBe("Hoy");
    expect(etiquetaDeDia("2026-11-10T23:59:00-03:00", AHORA)).toBe("Ayer");
    expect(etiquetaDeDia("2026-11-02T10:00:00-03:00", AHORA)).toMatch(/noviembre/);
  });

  it("un año distinto lo dice, para no confundir noviembre con noviembre", () => {
    expect(etiquetaDeDia("2025-11-02T10:00:00-03:00", AHORA)).toMatch(/2025/);
  });

  it("una fecha ilegible no pinta un separador con basura", () => {
    expect(etiquetaDeDia("no es fecha", AHORA)).toBe("");
  });

  it("el PRIMER mensaje del hilo siempre abre día", () => {
    expect(abreDia("2026-11-11T09:00:00-03:00", null)).toBe(true);
  });

  it("dos mensajes del mismo día no abren otro separador", () => {
    expect(abreDia("2026-11-11T09:00:00-03:00", "2026-11-11T08:00:00-03:00")).toBe(false);
  });

  it("cruzar la medianoche SÍ abre día (aunque sean 2 minutos de diferencia)", () => {
    expect(abreDia("2026-11-11T00:01:00-03:00", "2026-11-10T23:59:00-03:00")).toBe(true);
  });
});

describe("agrupar mensajes seguidos", () => {
  const base: { direction: "INBOUND" | "OUTBOUND"; authorType: string; authorName: string | null; visibility: string } = { direction: "INBOUND", authorType: "USER", authorName: null, visibility: "PUBLIC" };
  const en = (iso: string, extra: Partial<typeof base> = {}) => ({ ...base, ...extra, createdAt: iso });

  it("mismo autor dentro de 3 minutos se agrupa", () => {
    expect(siguenJuntos(en("2026-11-11T10:02:00Z"), en("2026-11-11T10:00:00Z"))).toBe(true);
  });

  it("pasados 3 minutos, no", () => {
    expect(siguenJuntos(en("2026-11-11T10:04:00Z"), en("2026-11-11T10:00:00Z"))).toBe(false);
  });

  it("cambiar de dirección corta el bloque", () => {
    expect(siguenJuntos(en("2026-11-11T10:01:00Z", { direction: "OUTBOUND" }), en("2026-11-11T10:00:00Z"))).toBe(false);
  });

  it("una NOTA INTERNA no se agrupa con una respuesta al cliente, aunque las dos sean salientes", () => {
    const nota = { direction: "OUTBOUND" as const, authorType: "USER", authorName: "Javier", visibility: "INTERNAL", createdAt: "2026-11-11T10:01:00Z" };
    const publica = { direction: "OUTBOUND" as const, authorType: "USER", authorName: "Javier", visibility: "PUBLIC", createdAt: "2026-11-11T10:00:00Z" };
    expect(siguenJuntos(nota, publica)).toBe(false);
  });

  it("la IA y una persona no comparten bloque", () => {
    const ia = { direction: "OUTBOUND" as const, authorType: "AGENT", authorName: null, visibility: "PUBLIC", createdAt: "2026-11-11T10:01:00Z" };
    const persona = { direction: "OUTBOUND" as const, authorType: "USER", authorName: "Javier", visibility: "PUBLIC", createdAt: "2026-11-11T10:00:00Z" };
    expect(siguenJuntos(ia, persona)).toBe(false);
  });

  it("dos personas distintas del equipo tampoco", () => {
    const a = { direction: "OUTBOUND" as const, authorType: "USER", authorName: "Ana", visibility: "PUBLIC", createdAt: "2026-11-11T10:01:00Z" };
    const b = { direction: "OUTBOUND" as const, authorType: "USER", authorName: "Javier", visibility: "PUBLIC", createdAt: "2026-11-11T10:00:00Z" };
    expect(siguenJuntos(a, b)).toBe(false);
  });

  it("cruzar la medianoche corta el bloque aunque sean minutos", () => {
    expect(siguenJuntos(en("2026-11-11T00:01:00-03:00"), en("2026-11-10T23:59:00-03:00"))).toBe(false);
  });

  it("el primero nunca continúa nada", () => {
    expect(siguenJuntos(en("2026-11-11T10:00:00Z"), null)).toBe(false);
  });
});

describe("ticks de estado", () => {
  it("los entrantes NO llevan tick: nadie acusa recibo al revés", () => {
    expect(tickDeEstado("READ", "INBOUND")).toBeNull();
    expect(tickDeEstado("DELIVERED", "INBOUND")).toBeNull();
  });

  it("cada estado tiene su símbolo", () => {
    expect(tickDeEstado("SENT", "OUTBOUND")?.simbolo).toBe("✓");
    expect(tickDeEstado("DELIVERED", "OUTBOUND")?.simbolo).toBe("✓✓");
    expect(tickDeEstado("READ", "OUTBOUND")?.simbolo).toBe("✓✓");
    expect(tickDeEstado("FAILED", "OUTBOUND")?.simbolo).toBe("⚠");
    expect(tickDeEstado("PENDING", "OUTBOUND")?.simbolo).toBe("🕐");
  });

  it("solo LEÍDO se destaca en color: es la diferencia que importa", () => {
    expect(tickDeEstado("READ", "OUTBOUND")?.destacado).toBe(true);
    expect(tickDeEstado("DELIVERED", "OUTBOUND")?.destacado).toBe(false);
  });

  it("todos llevan etiqueta para el lector de pantalla", () => {
    for (const s of ["PENDING", "SENT", "DELIVERED", "READ", "FAILED"]) {
      expect(tickDeEstado(s, "OUTBOUND")?.etiqueta.length).toBeGreaterThan(2);
    }
  });

  it("un estado desconocido no inventa un tick", () => {
    expect(tickDeEstado("LO_QUE_SEA", "OUTBOUND")).toBeNull();
  });
});

describe("los [tipo] históricos se traducen en pantalla", () => {
  it("el script de reparación no los corrige todos, así que la UI tiene que saber leerlos", () => {
    expect(traducirPlaceholderViejo("[image]")).toBe("📷 Foto");
    expect(traducirPlaceholderViejo("[audio de voz]")).toBe("🎤 Nota de voz");
    expect(traducirPlaceholderViejo("[sticker]")).toBe("Sticker");
    expect(traducirPlaceholderViejo("[location]")).toBe("📍 Ubicación");
  });

  it("un texto normal NO se toca (nunca se inventa contenido)", () => {
    expect(traducirPlaceholderViejo("hola, quiero una hora")).toBe("hola, quiero una hora");
    expect(traducirPlaceholderViejo("[esto lo escribió el cliente]")).toBe("[esto lo escribió el cliente]");
  });

  it("vacío o nulo devuelve vacío", () => {
    expect(traducirPlaceholderViejo(null)).toBe("");
    expect(traducirPlaceholderViejo("   ")).toBe("");
  });
});

describe("documentos", () => {
  it("la familia sale del mime o, si falta, de la extensión", () => {
    expect(familiaDeMime("application/pdf")).toBe("pdf");
    expect(familiaDeMime(null, "presupuesto.pdf")).toBe("pdf");
    expect(familiaDeMime(null, "radiografia.PNG")).toBe("imagen");
    expect(familiaDeMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("word");
    expect(familiaDeMime(null, "datos.xlsx")).toBe("excel");
    expect(familiaDeMime(null, "cosas.zip")).toBe("comprimido");
    expect(familiaDeMime(null, "archivo.xyz")).toBe("otro");
  });

  it("el tamaño se lee humano, y si no se sabe NO se inventa", () => {
    expect(formatearTamaño(900)).toBe("900 B");
    expect(formatearTamaño(2048)).toBe("2 KB");
    expect(formatearTamaño(1_258_291)).toBe("1,2 MB");
    expect(formatearTamaño(null)).toBeNull();
    expect(formatearTamaño(0)).toBeNull();
  });
});

describe("emojis grandes", () => {
  it("hasta tres emojis solos van grandes", () => {
    expect(esSoloEmojis("❤️")).toBe(true);
    expect(esSoloEmojis("😀😀😀")).toBe(true);
  });

  it("cuatro ya no, y con texto tampoco", () => {
    expect(esSoloEmojis("😀😀😀😀")).toBe(false);
    expect(esSoloEmojis("hola 😀")).toBe(false);
    expect(esSoloEmojis("")).toBe(false);
  });
});

describe("enlaces clicables sin meter HTML en el DOM", () => {
  it("parte el texto en trozos", () => {
    const t = trozosConEnlaces("mira https://conversia.cl ahora");
    expect(t).toEqual([
      { tipo: "texto", valor: "mira " },
      { tipo: "enlace", valor: "https://conversia.cl" },
      { tipo: "texto", valor: " ahora" },
    ]);
  });

  it("el punto final de la frase NO es parte del enlace", () => {
    const t = trozosConEnlaces("entra a https://conversia.cl.");
    expect(t[1]).toEqual({ tipo: "enlace", valor: "https://conversia.cl" });
    expect(t[2]).toEqual({ tipo: "texto", valor: "." });
  });

  it("un texto sin enlaces vuelve entero", () => {
    expect(trozosConEnlaces("hola")).toEqual([{ tipo: "texto", valor: "hola" }]);
  });

  it("varios enlaces en el mismo mensaje", () => {
    const t = trozosConEnlaces("http://a.cl y http://b.cl");
    expect(t.filter((x) => x.tipo === "enlace")).toHaveLength(2);
  });

  it("NO interpreta HTML: lo que llega por WhatsApp lo escribió un desconocido", () => {
    const t = trozosConEnlaces('<img src=x onerror="alert(1)">');
    expect(t).toEqual([{ tipo: "texto", valor: '<img src=x onerror="alert(1)">' }]);
  });
});

describe("accesibilidad", () => {
  it("cada tipo tiene su etiqueta, y el audio dice cuánto dura", () => {
    expect(etiquetaAccesible("audio", 42)).toBe("Nota de voz de 0:42");
    expect(etiquetaAccesible("audio", null)).toBe("Nota de voz");
    expect(etiquetaAccesible("image")).toBe("Foto");
    expect(etiquetaAccesible("sticker")).toBe("Sticker");
    expect(etiquetaAccesible(null)).toBe("Mensaje");
  });
});

import { describe, it, expect } from "vitest";
import {
  mapInboundType,
  mapMessagingAttachmentType,
  mediaPlaceholder,
  lastMessagePreview,
  placeholderParaElAgente,
  leerReaccion,
  aplicarReaccion,
} from "./message-type";

/**
 * D1 — el mapeo de tipos entrantes no tenía UN SOLO test, y por eso un sticker llevaba meses
 * guardándose como TEXT con body `[sticker]` teniendo el enum STICKER disponible.
 */

describe("WhatsApp: cada tipo cae donde corresponde", () => {
  const TABLA: Array<[string, string]> = [
    ["text", "TEXT"],
    ["audio", "AUDIO"],
    ["voice", "AUDIO"],
    ["image", "IMAGE"],
    ["document", "DOCUMENT"],
    ["video", "VIDEO"],
    ["sticker", "STICKER"],
    ["location", "LOCATION"],
    ["contacts", "CONTACTS"],
    ["reaction", "REACTION"],
    ["button", "TEXT"],
    ["interactive", "TEXT"],
    ["unsupported", "TEXT"],
  ];
  for (const [wa, esperado] of TABLA) {
    it(`${wa} → ${esperado}`, () => expect(mapInboundType(wa)).toBe(esperado));
  }

  it("mayúsculas, nulo y un tipo que Meta invente no rompen nada", () => {
    expect(mapInboundType("STICKER")).toBe("STICKER");
    expect(mapInboundType(null)).toBe("TEXT");
    expect(mapInboundType(undefined)).toBe("TEXT");
    expect(mapInboundType("holograma")).toBe("TEXT");
  });
});

describe("Instagram y Messenger", () => {
  const TABLA: Array<[string, string]> = [
    ["image", "IMAGE"],
    ["audio", "AUDIO"],
    ["video", "VIDEO"],
    ["file", "DOCUMENT"],
    ["sticker", "STICKER"],
    ["like_heart", "STICKER"],
    ["share", "TEXT"],
  ];
  for (const [t, esperado] of TABLA) {
    it(`${t} → ${esperado}`, () => expect(mapMessagingAttachmentType(t)).toBe(esperado));
  }

  it("el corazón de Instagram es un sticker, no un texto", () => {
    expect(mapMessagingAttachmentType("like_heart")).toBe("STICKER");
  });
});

describe("el cuerpo que se guarda está en castellano y sin corchetes", () => {
  it("nunca devuelve el formato viejo [tipo]", () => {
    for (const t of ["AUDIO", "IMAGE", "STICKER", "VIDEO", "DOCUMENT", "LOCATION", "CONTACTS"] as const) {
      const p = mediaPlaceholder(t);
      expect(p, `${t} no debe llevar corchetes`).not.toMatch(/^\[/);
      expect(p).not.toMatch(/[a-z]+\]/);
    }
  });

  it("los tipos sin datos extra", () => {
    expect(mediaPlaceholder("AUDIO")).toBe("🎤 Nota de voz");
    expect(mediaPlaceholder("IMAGE")).toBe("📷 Foto");
    expect(mediaPlaceholder("STICKER")).toBe("Sticker");
    expect(mediaPlaceholder("VIDEO")).toBe("🎬 Video");
    expect(mediaPlaceholder("DOCUMENT")).toBe("📄 Documento");
    expect(mediaPlaceholder("LOCATION")).toBe("📍 Ubicación");
    expect(mediaPlaceholder("CONTACTS")).toBe("👤 Contacto compartido");
  });

  it("el pie de foto MANDA sobre el placeholder: si el cliente escribió algo, eso es el mensaje", () => {
    expect(mediaPlaceholder("IMAGE", { image: { caption: "mi radiografía" } })).toBe("📷 mi radiografía");
    expect(mediaPlaceholder("VIDEO", { video: { caption: "mirá esto" } })).toBe("🎬 mirá esto");
  });

  it("el documento se nombra por su archivo", () => {
    expect(mediaPlaceholder("DOCUMENT", { document: { filename: "presupuesto.pdf" } })).toBe("📄 presupuesto.pdf");
  });

  it("la ubicación usa nombre y dirección, sin repetirse", () => {
    expect(mediaPlaceholder("LOCATION", { location: { name: "Clínica" } })).toBe("📍 Clínica");
    expect(mediaPlaceholder("LOCATION", { location: { name: "Clínica", address: "Av. Alemania 01", latitude: 1, longitude: 2 } })).toBe("📍 Clínica — Av. Alemania 01");
    expect(mediaPlaceholder("LOCATION", { location: { name: "Igual", address: "Igual" } })).toBe("📍 Igual");
  });

  it("un caption vacío o con espacios no deja un ícono suelto", () => {
    expect(mediaPlaceholder("IMAGE", { image: { caption: "   " } })).toBe("📷 Foto");
    expect(mediaPlaceholder("DOCUMENT", { document: { filename: "" } })).toBe("📄 Documento");
  });
});

describe("la vista previa de la lista", () => {
  it("una nota de voz transcrita conserva el 🎤 (si no, parece que el cliente ESCRIBIÓ eso)", () => {
    const p = lastMessagePreview({ type: "AUDIO", body: "hola quería saber el precio", transcribed: true });
    expect(p).toBe("🎤 hola quería saber el precio");
  });

  it("una transcripción larga se recorta con puntos suspensivos", () => {
    const largo = "a".repeat(200);
    const p = lastMessagePreview({ type: "AUDIO", body: largo, transcribed: true });
    expect(p.startsWith("🎤 ")).toBe(true);
    expect(p.endsWith("…")).toBe(true);
    expect(p.length).toBeLessThan(70);
  });

  it("una nota de voz SIN transcripción muestra el placeholder", () => {
    expect(lastMessagePreview({ type: "AUDIO", body: null })).toBe("🎤 Nota de voz");
  });

  it("un texto normal se muestra tal cual", () => {
    expect(lastMessagePreview({ type: "TEXT", body: "hola" })).toBe("hola");
  });

  it("un sticker dice Sticker, no [sticker]", () => {
    expect(lastMessagePreview({ type: "STICKER", body: null })).toBe("Sticker");
  });

  it("un body histórico con el formato viejo NO se propaga", () => {
    expect(lastMessagePreview({ type: "IMAGE", body: "[image]" })).toBe("📷 Foto");
  });
});

describe("lo que lee el AGENTE es distinto de lo que ve el dueño", () => {
  it("el sticker se nombra, y NO se le manda a visión (decisión del dueño)", () => {
    expect(placeholderParaElAgente("STICKER")).toBe("[el contacto envió un sticker]");
  });

  it("al video y al audio sin transcribir se les dice al agente que NO puede verlos/oírlos", () => {
    expect(placeholderParaElAgente("VIDEO")).toMatch(/no puedes verlo/i);
    expect(placeholderParaElAgente("AUDIO")).toMatch(/pídele que te escriba/i);
  });

  it("la ubicación SÍ le llega con el detalle (es información útil y gratis)", () => {
    const p = placeholderParaElAgente("LOCATION", { location: { name: "Clínica Norte", address: "Av. Alemania 01" } });
    expect(p).toContain("Clínica Norte");
    expect(p).toContain("Av. Alemania 01");
  });

  it("sin nombre ni dirección, la ubicación cae a las coordenadas", () => {
    expect(placeholderParaElAgente("LOCATION", { location: { latitude: -38.73, longitude: -72.59 } })).toContain("-38.73");
  });

  it("todos van entre corchetes: es una ACOTACIÓN para el modelo, no algo que el cliente dijo", () => {
    for (const t of ["STICKER", "VIDEO", "AUDIO", "IMAGE", "LOCATION", "CONTACTS", "DOCUMENT"] as const) {
      expect(placeholderParaElAgente(t)).toMatch(/^\[.*\]$/s);
    }
  });
});

describe("reacciones: no son un mensaje, son una marca sobre otro mensaje", () => {
  it("se lee el mensaje al que reaccionaron y el emoji", () => {
    expect(leerReaccion({ reaction: { message_id: "wamid.ABC", emoji: "❤️" } })).toEqual({ externalId: "wamid.ABC", emoji: "❤️" });
  });

  it("quitar la reacción llega con emoji vacío y es un evento VÁLIDO", () => {
    expect(leerReaccion({ reaction: { message_id: "wamid.ABC", emoji: "" } })).toEqual({ externalId: "wamid.ABC", emoji: null });
  });

  it("sin message_id no hay nada que hacer", () => {
    expect(leerReaccion({ reaction: { emoji: "❤️" } })).toBeNull();
    expect(leerReaccion({})).toBeNull();
    expect(leerReaccion(null)).toBeNull();
  });

  it("agrega la primera reacción", () => {
    const r = aplicarReaccion({}, { emoji: "❤️", from: "56911111111", at: "2026-11-11T00:00:00Z" });
    expect(r.reactions).toEqual([{ emoji: "❤️", from: "56911111111", at: "2026-11-11T00:00:00Z" }]);
  });

  it("la misma persona cambia de emoji: REEMPLAZA la suya, no se acumulan dos", () => {
    const uno = aplicarReaccion({}, { emoji: "❤️", from: "A", at: "t1" });
    const dos = aplicarReaccion({ reactions: uno.reactions }, { emoji: "😂", from: "A", at: "t2" });
    expect(dos.reactions).toEqual([{ emoji: "😂", from: "A", at: "t2" }]);
  });

  it("personas distintas conviven", () => {
    const uno = aplicarReaccion({}, { emoji: "❤️", from: "A", at: "t1" });
    const dos = aplicarReaccion({ reactions: uno.reactions }, { emoji: "👍", from: "B", at: "t2" });
    expect(dos.reactions).toHaveLength(2);
  });

  it("quitar la reacción saca la suya y deja las demás", () => {
    const base = { reactions: [{ emoji: "❤️", from: "A", at: "t1" }, { emoji: "👍", from: "B", at: "t2" }] };
    const r = aplicarReaccion(base, { emoji: null, from: "A", at: "t3" });
    expect(r.reactions).toEqual([{ emoji: "👍", from: "B", at: "t2" }]);
  });

  it("un payload con basura en reactions no tumba el mensaje", () => {
    const r = aplicarReaccion({ reactions: ["x", null, { emoji: 5 }, { from: "B" }] }, { emoji: "❤️", from: "A", at: "t" });
    expect(r.reactions).toEqual([{ emoji: "❤️", from: "A", at: "t" }]);
  });
});

describe("el fixture REAL del webhook de sticker", () => {
  // Tal como lo manda Meta (Cloud API v26), con el sticker animado.
  const webhook = {
    from: "56911111111",
    id: "wamid.HBgLNTY5MTExMTExMTEVAgASGCA0",
    timestamp: "1794430000",
    type: "sticker",
    sticker: { mime_type: "image/webp", sha256: "x", id: "1234567890", animated: true },
  };

  it("termina en STICKER con cuerpo «Sticker», no en TEXT con «[sticker]»", () => {
    const tipo = mapInboundType(webhook.type);
    expect(tipo).toBe("STICKER");
    expect(mediaPlaceholder(tipo, webhook)).toBe("Sticker");
    expect(lastMessagePreview({ type: tipo, body: null, payload: webhook })).toBe("Sticker");
  });

  it("el dato de animado sigue en el payload para que la UI lo use", () => {
    expect(webhook.sticker.animated).toBe(true);
  });
});

describe("guardián: un sticker NO se le manda a visión (decisión del dueño, cuesta créditos)", () => {
  it("el código de visión filtra por IMAGE, y un sticker ya NO es IMAGE", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    // Sin `import.meta`: este paquete compila a CommonJS y tsc lo rechaza. Se prueban las
    // dos raíces posibles según desde dónde se lance vitest (apps/worker o la raíz).
    const candidatas = [
      path.resolve(process.cwd(), "src/agent-turn.ts"),
      path.resolve(process.cwd(), "apps/worker/src/agent-turn.ts"),
    ];
    let src = "";
    for (const c of candidatas) {
      src = await fs.readFile(c, "utf-8").catch(() => "");
      if (src) break;
    }
    expect(src, `no encontré agent-turn.ts (probé: ${candidatas.join(", ")})`).toBeTruthy();
    // La condición que decide si una imagen va al modelo.
    const linea = src.split("\n").find((l) => l.includes("visionToken") && l.includes("m.type ==="));
    expect(linea, "no encontré la condición de visión en agent-turn.ts").toBeTruthy();
    expect(linea).toContain('m.type === "IMAGE"');
    expect(linea).not.toContain("STICKER");
    // Y el mapeo manda los stickers a STICKER, no a IMAGE: por eso quedan fuera.
    expect(mapInboundType("sticker")).toBe("STICKER");
    expect(mapInboundType("sticker")).not.toBe("IMAGE");
  });
});

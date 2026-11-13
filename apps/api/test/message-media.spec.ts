import { describe, it, expect } from "vitest";
import { MessageMediaSchema, MEDIA_EXPIRED } from "@conversia/types";
import { derivarMedia, kindDeTipo, mediaIdDePayload } from "../src/conversations/message-media";

/**
 * D2.c — el objeto `media` que la API deriva de `type` + `payload`.
 *
 * Antes cada panel tenía que saber por su cuenta que una imagen ENTRANTE vive en
 * `payload.image.id` y una SALIENTE en `payload.mediaId`, que un sticker está en
 * `payload.sticker.id` y que una nota de voz puede estar en `audio.id` o en `voice.id`. Esa
 * lógica estaba copiada dentro de los endpoints y faltaba entera en la bandeja de Conversia.
 */

const CONV = "conv_1";
const msg = (type: string, payload: unknown, body?: string | null) => ({ id: "m1", type, payload, body: body ?? null });

describe("el contrato se cumple para TODOS los tipos", () => {
  const TIPOS = ["TEXT", "AUDIO", "IMAGE", "STICKER", "VIDEO", "DOCUMENT", "LOCATION", "CONTACTS", "NOTE", "SYSTEM"];
  for (const t of TIPOS) {
    it(`${t} produce un objeto válido contra el esquema zod`, () => {
      const r = MessageMediaSchema.safeParse(derivarMedia(CONV, msg(t, {})));
      expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
    });
  }

  it("un mensaje de texto no tiene medio ni url", () => {
    const m = derivarMedia(CONV, msg("TEXT", { text: { body: "hola" } }));
    expect(m.kind).toBeNull();
    expect(m.url).toBeNull();
  });
});

describe("la URL apunta al endpoint correcto", () => {
  it("audio entrante (payload.audio.id)", () => {
    const m = derivarMedia(CONV, msg("AUDIO", { audio: { id: "A1", mime_type: "audio/ogg", duration: 42 } }));
    expect(m.kind).toBe("audio");
    expect(m.url).toBe("/conversations/conv_1/messages/m1/audio");
    expect(m.durationSec).toBe(42);
    expect(m.mime).toBe("audio/ogg");
  });

  it("nota de voz (payload.voice.id) — el otro nombre que usa Meta", () => {
    expect(derivarMedia(CONV, msg("AUDIO", { voice: { id: "V1" } })).url).toBe("/conversations/conv_1/messages/m1/audio");
  });

  it("imagen ENTRANTE y SALIENTE llegan al mismo endpoint", () => {
    expect(derivarMedia(CONV, msg("IMAGE", { image: { id: "I1" } })).url).toBe("/conversations/conv_1/messages/m1/image");
    expect(derivarMedia(CONV, msg("IMAGE", { mediaId: "I2" })).url).toBe("/conversations/conv_1/messages/m1/image");
  });

  it("el sticker se sirve por /image (para Meta es un media id más)", () => {
    const m = derivarMedia(CONV, msg("STICKER", { sticker: { id: "S1", mime_type: "image/webp", animated: true } }));
    expect(m.kind).toBe("sticker");
    expect(m.url).toBe("/conversations/conv_1/messages/m1/image");
    expect(m.animated).toBe(true);
  });

  it("el video tiene su endpoint propio (D2.a: antes no existía)", () => {
    expect(derivarMedia(CONV, msg("VIDEO", { video: { id: "V9" } })).url).toBe("/conversations/conv_1/messages/m1/video");
  });

  it("el documento conserva su nombre real", () => {
    const m = derivarMedia(CONV, msg("DOCUMENT", { document: { id: "D1", filename: "presupuesto.pdf", mime_type: "application/pdf" } }));
    expect(m.url).toBe("/conversations/conv_1/messages/m1/document");
    expect(m.filename).toBe("presupuesto.pdf");
    expect(m.mime).toBe("application/pdf");
  });

  it("SIN media id NO se inventa una url (sería un 404 seguro)", () => {
    expect(derivarMedia(CONV, msg("IMAGE", {})).url).toBeNull();
    expect(derivarMedia(CONV, msg("AUDIO", {})).url).toBeNull();
    expect(derivarMedia(CONV, msg("VIDEO", { video: {} })).url).toBeNull();
  });

  it("ubicación y contacto no tienen archivo que bajar", () => {
    expect(derivarMedia(CONV, msg("LOCATION", { location: { latitude: 1, longitude: 2 } })).url).toBeNull();
    expect(derivarMedia(CONV, msg("CONTACTS", { contacts: [] })).url).toBeNull();
  });
});

describe("caption, transcripción y datos propios de cada tipo", () => {
  it("el caption sale de la imagen o del video", () => {
    expect(derivarMedia(CONV, msg("IMAGE", { image: { id: "x", caption: "mi radiografía" } })).caption).toBe("mi radiografía");
    expect(derivarMedia(CONV, msg("VIDEO", { video: { id: "x", caption: "mirá" } })).caption).toBe("mirá");
  });

  it("transcript SOLO cuando la transcripción corrió de verdad", () => {
    const con = derivarMedia(CONV, msg("AUDIO", { audio: { id: "x" }, transcribed: true }, "hola quiero una hora"));
    expect(con.transcript).toBe("hola quiero una hora");
    const sin = derivarMedia(CONV, msg("AUDIO", { audio: { id: "x" } }, "🎤 Nota de voz"));
    expect(sin.transcript).toBeNull();
  });

  it("una imagen con body NO se confunde con un transcript", () => {
    expect(derivarMedia(CONV, msg("IMAGE", { image: { id: "x" }, transcribed: true }, "texto")).transcript).toBeNull();
  });

  it("la ubicación trae coordenadas, nombre y dirección", () => {
    const m = derivarMedia(CONV, msg("LOCATION", { location: { latitude: -38.73, longitude: -72.59, name: "Clínica", address: "Av. Alemania 01" } }));
    expect(m.location).toEqual({ lat: -38.73, lng: -72.59, name: "Clínica", address: "Av. Alemania 01" });
  });

  it("una ubicación sin coordenadas NO se inventa un punto en el mapa", () => {
    expect(derivarMedia(CONV, msg("LOCATION", { location: { name: "Clínica" } })).location).toBeNull();
  });

  it("coordenadas que llegan como texto se entienden igual", () => {
    const m = derivarMedia(CONV, msg("LOCATION", { location: { latitude: "-38.73", longitude: "-72.59" } }));
    expect(m.location?.lat).toBe(-38.73);
  });

  it("los contactos traen nombre y teléfonos", () => {
    const m = derivarMedia(CONV, msg("CONTACTS", {
      contacts: [{ name: { formatted_name: "Ana Pérez" }, phones: [{ phone: "+56 9 1111 1111" }, { wa_id: "56922222222" }] }],
    }));
    expect(m.contacts).toEqual([{ name: "Ana Pérez", phones: ["+56 9 1111 1111", "56922222222"] }]);
  });

  it("un contacto sin nombre no rompe: queda como «Contacto»", () => {
    const m = derivarMedia(CONV, msg("CONTACTS", { contacts: [{ phones: [{ phone: "+569" }] }] }));
    expect(m.contacts?.[0].name).toBe("Contacto");
  });
});

describe("reacciones (las escribe D1 en payload.reactions)", () => {
  it("llegan a la UI para pintarlas sobre la burbuja", () => {
    const m = derivarMedia(CONV, msg("TEXT", { reactions: [{ emoji: "❤️", from: "A", at: "2026-11-11T00:00:00Z" }] }));
    expect(m.reactions).toEqual([{ emoji: "❤️", at: "2026-11-11T00:00:00Z" }]);
  });

  it("un mensaje sin reacciones devuelve null, no un arreglo vacío", () => {
    expect(derivarMedia(CONV, msg("TEXT", {})).reactions).toBeNull();
  });

  it("basura en reactions no tumba el mensaje entero", () => {
    expect(derivarMedia(CONV, msg("TEXT", { reactions: ["x", null, { from: "A" }] })).reactions).toBeNull();
  });

  it("una reacción puede ir sobre CUALQUIER tipo, no solo texto", () => {
    const m = derivarMedia(CONV, msg("IMAGE", { image: { id: "x" }, reactions: [{ emoji: "👍", from: "A", at: "t" }] }));
    expect(m.kind).toBe("image");
    expect(m.reactions).toHaveLength(1);
  });
});

describe("un payload roto nunca puede tumbar el hilo completo", () => {
  it("payload nulo, vacío o con tipos equivocados", () => {
    for (const p of [null, undefined, {}, { image: "no es objeto" }, { audio: 5 }, []]) {
      expect(() => derivarMedia(CONV, msg("IMAGE", p))).not.toThrow();
      expect(MessageMediaSchema.safeParse(derivarMedia(CONV, msg("IMAGE", p))).success).toBe(true);
    }
  });
});

describe("piezas sueltas", () => {
  it("kindDeTipo mapea los tipos con medio y deja el resto en null", () => {
    expect(kindDeTipo("AUDIO")).toBe("audio");
    expect(kindDeTipo("STICKER")).toBe("sticker");
    expect(kindDeTipo("TEXT")).toBeNull();
    expect(kindDeTipo("NOTE")).toBeNull();
  });

  it("mediaIdDePayload prefiere el id propio del tipo sobre mediaId", () => {
    expect(mediaIdDePayload("image", { image: { id: "propio" }, mediaId: "generico" })).toBe("propio");
    expect(mediaIdDePayload("image", { mediaId: "generico" })).toBe("generico");
  });

  it("el código de expiración es el que la UI espera", () => {
    expect(MEDIA_EXPIRED).toBe("MEDIA_EXPIRED");
  });
});

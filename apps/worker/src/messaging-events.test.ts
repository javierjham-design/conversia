import { describe, expect, it } from "vitest";
import { parseMessagingEvents } from "./messaging-events";

describe("parseMessagingEvents", () => {
  it("parsea un mensaje de Messenger (object=page)", () => {
    const raw = {
      object: "page",
      entry: [
        {
          id: "PAGE_1",
          messaging: [
            { sender: { id: "PSID_9" }, recipient: { id: "PAGE_1" }, timestamp: 1755600000000, message: { mid: "m_abc", text: "hola" } },
          ],
        },
      ],
    };
    expect(parseMessagingEvents(raw)).toEqual([
      { platform: "messenger", channelExternalId: "PAGE_1", senderId: "PSID_9", externalId: "m_abc", text: "hola", attachmentType: null, timestamp: 1755600000000, isEcho: false },
    ]);
  });

  it("parsea Instagram Direct (object=instagram) y adjuntos sin texto", () => {
    const raw = {
      object: "instagram",
      entry: [
        {
          id: "IG_7",
          messaging: [
            { sender: { id: "IGSID_1" }, recipient: { id: "IG_7" }, timestamp: 1, message: { mid: "m_ig", attachments: [{ type: "image", payload: {} }] } },
          ],
        },
      ],
    };
    const [e] = parseMessagingEvents(raw);
    expect(e.platform).toBe("instagram");
    expect(e.text).toBeNull();
    expect(e.attachmentType).toBe("image");
  });

  it("ignora ecos de la propia página, entradas sin mid y objetos ajenos", () => {
    expect(
      parseMessagingEvents({
        object: "page",
        entry: [
          { id: "P", messaging: [{ sender: { id: "P" }, message: { mid: "m1", text: "eco", is_echo: true } }] },
          { id: "P", messaging: [{ sender: { id: "X" }, read: { watermark: 1 } }] },
        ],
      }),
    ).toEqual([]);
    expect(parseMessagingEvents({ object: "whatsapp_business_account", entry: [] })).toEqual([]);
  });

  it("leadgen (object=page con changes) no produce eventos de mensajería", () => {
    const raw = { object: "page", entry: [{ id: "P", changes: [{ field: "leadgen", value: { leadgen_id: "1" } }] }] };
    expect(parseMessagingEvents(raw)).toEqual([]);
  });

  it("acepta la forma changes[field=messages] (topic instagram / tests del dashboard)", () => {
    const raw = {
      object: "instagram",
      entry: [
        {
          id: "IG_9",
          changes: [
            { field: "messages", value: { sender: { id: "U1" }, recipient: { id: "IG_9" }, timestamp: 5, message: { mid: "m_chg", text: "hola por changes" } } },
          ],
        },
      ],
    };
    const [e] = parseMessagingEvents(raw);
    expect(e).toMatchObject({ platform: "instagram", channelExternalId: "IG_9", senderId: "U1", externalId: "m_chg", text: "hola por changes" });
  });
});

/**
 * C3(e) — casos nuevos que aparecen en producción con Instagram y que el v1 no cubría.
 */
describe("C3 — casos reales de Instagram", () => {
  const sobre = (items: unknown[], object = "instagram") => ({ object, entry: [{ id: "ig-cuenta", messaging: items }] });

  it("respuesta a una HISTORIA: llega como mensaje normal con su adjunto", () => {
    const [e] = parseMessagingEvents(
      sobre([
        {
          sender: { id: "igsid-1" },
          recipient: { id: "ig-cuenta" },
          timestamp: 1_762_000_000_000,
          message: { mid: "mid.story", text: "me encantó este corte", reply_to: { story: { id: "story-1", url: "https://..." } } },
        },
      ]),
    );
    expect(e.text).toBe("me encantó este corte");
    expect(e.senderId).toBe("igsid-1");
    expect(e.externalId).toBe("mid.story");
  });

  it("adjunto CON texto: se quedan los dos (el texto manda, el adjunto se sabe)", () => {
    const [e] = parseMessagingEvents(
      sobre([
        {
          sender: { id: "igsid-2" },
          recipient: { id: "ig-cuenta" },
          message: { mid: "mid.ambos", text: "¿me haces este?", attachments: [{ type: "image", payload: { url: "https://..." } }] },
        },
      ]),
    );
    expect(e.text).toBe("¿me haces este?");
    expect(e.attachmentType).toBe("image");
  });

  it("el ECO de lo que mandamos nosotros se descarta (si no, el bot se respondería solo)", () => {
    expect(
      parseMessagingEvents(
        sobre([
          { sender: { id: "ig-cuenta" }, recipient: { id: "igsid-3" }, message: { mid: "mid.eco", text: "hola, soy el asistente", is_echo: true } },
        ]),
      ),
    ).toEqual([]);
  });

  it("un postback (botón) se ignora: no es un mensaje del cliente", () => {
    expect(
      parseMessagingEvents(sobre([{ sender: { id: "igsid-4" }, recipient: { id: "ig-cuenta" }, postback: { title: "Empezar", payload: "START" } }])),
    ).toEqual([]);
  });

  it("los acuses de lectura y entrega tampoco son mensajes", () => {
    expect(
      parseMessagingEvents(
        sobre([
          { sender: { id: "igsid-5" }, recipient: { id: "ig-cuenta" }, read: { watermark: 1 } },
          { sender: { id: "igsid-5" }, recipient: { id: "ig-cuenta" }, delivery: { mids: ["mid.x"] } },
        ]),
      ),
    ).toEqual([]);
  });

  it("una mención en historia llega como adjunto, no como texto vacío", () => {
    const [e] = parseMessagingEvents(
      sobre([{ sender: { id: "igsid-6" }, recipient: { id: "ig-cuenta" }, message: { mid: "mid.mention", attachments: [{ type: "story_mention", payload: {} }] } }]),
    );
    expect(e.text).toBeNull();
    expect(e.attachmentType).toBe("story_mention");
  });
});

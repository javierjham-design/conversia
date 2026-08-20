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

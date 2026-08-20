import { describe, expect, it } from "vitest";
import { mapRespondRow, santiagoToUtc } from "./respond-import";

const base = { dateTime: "2026-08-18 21:05:56", senderType: "contact", contactId: "514484557", messageId: "m1", contentType: "text", messageType: "incoming", content: '{"type":"text","text":"hola"}', channelId: "483605" };

describe("respond-import mapper", () => {
  it("convierte hora de Santiago (invierno, -04) a UTC", () => {
    expect(santiagoToUtc("2026-08-18 21:05:56").toISOString()).toBe("2026-08-19T01:05:56.000Z");
  });
  it("convierte hora de Santiago (verano, -03) a UTC", () => {
    expect(santiagoToUtc("2026-01-15 10:00:00").toISOString()).toBe("2026-01-15T13:00:00.000Z");
  });
  it("mapea texto entrante del contacto", () => {
    const m = mapRespondRow(base as any)!;
    expect(m).toMatchObject({ externalId: "m1", direction: "INBOUND", authorType: "CONTACT", type: "TEXT", body: "hola" });
    expect((m.payload as any).respondSenderType).toBe("contact");
  });
  it("mapea saliente de IA/workflow/echo como AGENT con status coherente y adjuntos por subtipo", () => {
    const m = mapRespondRow({ ...base, messageType: "outgoing", senderType: "ai_agent", contentType: "attachment", content: '{"attachment":{"type":"audio","url":"https://cdn.chatapi.net/a.ogg"}}' } as any)!;
    expect(m).toMatchObject({ direction: "OUTBOUND", authorType: "AGENT", type: "AUDIO" });
    expect(m.body).toBe("[attachment]");
  });
  it("sticker y tipos raros no revientan; sin messageId se descarta", () => {
    expect(mapRespondRow({ ...base, contentType: "sticker" } as any)!.type).toBe("STICKER");
    expect(mapRespondRow({ ...base, contentType: "story_reply", content: "no-json" } as any)!.type).toBe("SYSTEM");
    expect(mapRespondRow({ ...base, messageId: "" } as any)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { detectCtwa, mapAdRow, isRateLimited, type RawAd } from "./meta-ads-sync";

describe("detectCtwa", () => {
  it("detecta CTA de WhatsApp en el creative", () => {
    const ad: RawAd = { id: "1", creative: { object_story_spec: { link_data: { call_to_action: { type: "WHATSAPP_MESSAGE" } } } } };
    expect(detectCtwa(ad)).toBe(true);
  });
  it("detecta enlace wa.me / api.whatsapp", () => {
    expect(detectCtwa({ id: "1", creative: { object_story_spec: { link_data: { link: "https://wa.me/56999" } } } })).toBe(true);
    expect(detectCtwa({ id: "2", creative: { object_story_spec: { video_data: { call_to_action: { value: { link: "https://api.whatsapp.com/x" } } } } } })).toBe(true);
  });
  it("es false para anuncios que no llevan a WhatsApp", () => {
    expect(detectCtwa({ id: "1", creative: { object_story_spec: { link_data: { call_to_action: { type: "LEARN_MORE" }, link: "https://sitio.cl" } } } })).toBe(false);
    expect(detectCtwa({ id: "2" })).toBe(false);
    expect(detectCtwa({ id: "3", creative: null })).toBe(false);
  });
});

describe("mapAdRow", () => {
  it("aplana el anuncio con campaña/conjunto y normaliza estado", () => {
    const ad: RawAd = {
      id: "ad_1", name: "Anuncio A", status: "active",
      adset: { id: "as_1", name: "Conjunto 1" },
      campaign: { id: "cmp_1", name: "Campaña Verano", objective: "OUTCOME_ENGAGEMENT" },
      creative: { object_story_spec: { link_data: { call_to_action: { type: "WHATSAPP_MESSAGE" } } } },
    };
    expect(mapAdRow(ad, "act_9")).toEqual({
      adAccountId: "act_9", campaignId: "cmp_1", campaignName: "Campaña Verano",
      adsetId: "as_1", adsetName: "Conjunto 1", adExternalId: "ad_1", adName: "Anuncio A",
      status: "ACTIVE", objective: "OUTCOME_ENGAGEMENT", isCtwa: true,
    });
  });
  it("tolera campos ausentes con placeholders", () => {
    const m = mapAdRow({ id: "x" }, "act_1");
    expect(m.campaignName).toBe("(campaña sin nombre)");
    expect(m.adName).toBe("(anuncio sin nombre)");
    expect(m.status).toBe("UNKNOWN");
    expect(m.isCtwa).toBe(false);
  });
});

describe("isRateLimited", () => {
  it("reconoce 429 y códigos de límite de Graph", () => {
    expect(isRateLimited(429)).toBe(true);
    for (const c of [4, 17, 32, 613, 80000, 80004]) expect(isRateLimited(400, c)).toBe(true);
  });
  it("no marca errores normales como rate limit", () => {
    expect(isRateLimited(400, 100)).toBe(false);
    expect(isRateLimited(200)).toBe(false);
  });
});

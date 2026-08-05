import { describe, expect, it } from "vitest";
import { toMultimodalContent } from "./providers.js";
import type { AIChatMessage } from "@conversia/types";

describe("visión — mapeo de contenido multimodal", () => {
  const withImage: AIChatMessage = {
    role: "user",
    content: "¿qué es esto?",
    images: [{ mimeType: "image/jpeg", dataBase64: "AAAA" }],
  };

  it("sin imágenes devuelve el texto tal cual", () => {
    expect(toMultimodalContent({ role: "user", content: "hola" }, "anthropic")).toBe("hola");
    expect(toMultimodalContent({ role: "user", content: "hola" }, "openai")).toBe("hola");
  });

  it("Anthropic: bloque text + image (base64/media_type)", () => {
    const c = toMultimodalContent(withImage, "anthropic") as any[];
    expect(c[0]).toEqual({ type: "text", text: "¿qué es esto?" });
    expect(c[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } });
  });

  it("OpenAI: bloque text + image_url (data URL)", () => {
    const c = toMultimodalContent(withImage, "openai") as any[];
    expect(c[0]).toEqual({ type: "text", text: "¿qué es esto?" });
    expect(c[1]).toEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } });
  });

  it("imagen sin texto: solo el bloque de imagen", () => {
    const c = toMultimodalContent({ role: "user", content: "", images: [{ mimeType: "image/png", dataBase64: "BBBB" }] }, "anthropic") as any[];
    expect(c).toHaveLength(1);
    expect(c[0].type).toBe("image");
  });
});

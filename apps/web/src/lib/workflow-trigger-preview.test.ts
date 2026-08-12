import { describe, expect, it } from "vitest";
import { triggerPreview, messageWouldTrigger } from "./workflow-trigger-preview";

describe("triggerPreview — lenguaje natural del disparador", () => {
  it("conversación iniciada", () => {
    expect(triggerPreview("conversation_started")).toMatch(/inicia una conversación/);
  });
  it("mensaje sin palabras = cualquier mensaje", () => {
    expect(triggerPreview("message_received", {})).toMatch(/cualquier mensaje/);
  });
  it("mensaje con palabras 'contiene'", () => {
    const s = triggerPreview("message_received", { keywords: ["hora", "agendar"] });
    expect(s).toMatch(/contiene/);
    expect(s).toMatch(/«hora».*«agendar»/);
  });
  it("mensaje 'exacto' con canal legible", () => {
    const s = triggerPreview("message_received", { keywords: ["hola"], matchType: "exact", channel: "whatsapp" }, { channelName: () => "WhatsApp" });
    expect(s).toMatch(/es exactamente/);
    expect(s).toMatch(/por WhatsApp/);
  });
  it("etapa con nombres legibles", () => {
    const s = triggerPreview("lead_status_changed", { fromStatus: "new", toStatus: "won" }, { leadStatusName: (c) => ({ new: "Nuevo", won: "Ganado" }[c]) });
    expect(s).toBe("un contacto pasa de «Nuevo» a «Ganado».");
  });
  it("etiqueta específica vs cualquiera", () => {
    expect(triggerPreview("tag_added", { tag: "vip" })).toMatch(/«vip»/);
    expect(triggerPreview("tag_added", {})).toMatch(/cualquier etiqueta/);
  });
  it("recordatorio con horas", () => {
    expect(triggerPreview("appointment_upcoming", { hoursBefore: 2 })).toMatch(/faltan 2 horas/);
  });
  it("enlace/QR con y sin código", () => {
    expect(triggerPreview("link_scan", { code: "promo-x" })).toMatch(/«promo-x»/);
    expect(triggerPreview("link_scan", {})).toMatch(/falta generar el código/);
  });
  it("tipo desconocido no rompe", () => {
    expect(triggerPreview("algo_raro")).toBe("ocurre el evento configurado.");
  });
});

describe("messageWouldTrigger — prueba local (refleja el motor)", () => {
  it("sin palabras dispara con cualquier texto", () => {
    expect(messageWouldTrigger({}, "lo que sea")).toBe(true);
  });
  it("'contiene' cualquiera", () => {
    expect(messageWouldTrigger({ keywords: ["hora", "precio"] }, "¿cuál es el precio?")).toBe(true);
    expect(messageWouldTrigger({ keywords: ["hora", "precio"] }, "hola")).toBe(false);
  });
  it("'todas' exige todas", () => {
    expect(messageWouldTrigger({ keywords: ["hora", "lunes"], matchAll: true }, "quiero hora el lunes")).toBe(true);
    expect(messageWouldTrigger({ keywords: ["hora", "lunes"], matchAll: true }, "quiero hora")).toBe(false);
  });
  it("'exacto' compara el mensaje completo", () => {
    expect(messageWouldTrigger({ keywords: ["hola"], matchType: "exact" }, "hola")).toBe(true);
    expect(messageWouldTrigger({ keywords: ["hola"], matchType: "exact" }, "hola buenas")).toBe(false);
  });
});

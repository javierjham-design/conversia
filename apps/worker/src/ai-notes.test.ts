import { describe, expect, it } from "vitest";
import { buildConversationInstructions, extractBotIndication } from "./ai-notes";

/**
 * Punto 5 de la Bandeja Pro: una indicación activa cambia el prompt del agente
 * en ESA conversación y no aparece en prompts sin indicaciones. El aislamiento
 * por conversación lo da el filtro `conversationId` del loader y el aislamiento
 * por tenant lo da RLS (withTenant) — verificado por el CI de tenant-isolation.
 */
describe("indicaciones al bot por conversación", () => {
  it("inyecta las indicaciones activas como bloque de prioridad alta", () => {
    const block = buildConversationInstructions([
      { body: "Ofrécele el plan con 20% de descuento" },
      { body: "Trátalo de usted" },
    ]);
    expect(block).toContain("Indicaciones del equipo para ESTA conversación");
    expect(block).toContain("- Ofrécele el plan con 20% de descuento");
    expect(block).toContain("- Trátalo de usted");
    // Las indicaciones jamás anulan las reglas de seguridad del sistema.
    expect(block).toContain("NUNCA anulan tus reglas de seguridad");
  });

  it("sin indicaciones el prompt queda intacto (bloque vacío)", () => {
    expect(buildConversationInstructions([])).toBe("");
    expect(buildConversationInstructions([{ body: "   " }])).toBe("");
  });

  it("dos conversaciones con notas distintas producen bloques distintos (aislamiento)", () => {
    const convA = buildConversationInstructions([{ body: "Solo limpieza, no insistas con implantes" }]);
    const convB = buildConversationInstructions([{ body: "Cliente VIP: agenda directo con la doctora" }]);
    expect(convA).toContain("no insistas con implantes");
    expect(convA).not.toContain("VIP");
    expect(convB).toContain("VIP");
    expect(convB).not.toContain("implantes");
  });
});

describe("comentario interno dirigido al bot (@bot / @ia)", () => {
  it("detecta el marcador y devuelve la indicación sin el prefijo", () => {
    expect(extractBotIndication("@bot ofrece siempre la promo del flyer")).toBe("ofrece siempre la promo del flyer");
    expect(extractBotIndication("@IA: trata de usted")).toBe("trata de usted");
    expect(extractBotIndication("ia - retoma el montaje")).toBe("retoma el montaje");
    expect(extractBotIndication("bot: pregunta la comuna")).toBe("pregunta la comuna");
    expect(extractBotIndication("#bot corrige el precio")).toBe("corrige el precio");
  });
  it("los comentarios SIN marcador quedan privados del equipo (null)", () => {
    expect(extractBotIndication("cliente moroso, ojo con el cobro")).toBeNull();
    expect(extractBotIndication("robot de cocina")).toBeNull(); // 'robot' no es el marcador 'bot'
    expect(extractBotIndication("")).toBeNull();
    expect(extractBotIndication("@bot   ")).toBeNull(); // marcador sin contenido
  });
});

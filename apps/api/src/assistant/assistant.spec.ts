import { describe, it, expect } from "vitest";
import { assistantMode, isWebOwner, resolveAssistantModel } from "./assistant.service";

describe("Asistente Conversia — guardas puras", () => {
  it("modo implementación mientras el checklist no está al 100%", () => {
    expect(assistantMode(0)).toBe("implementacion");
    expect(assistantMode(66)).toBe("implementacion");
    expect(assistantMode(99)).toBe("implementacion");
  });
  it("modo asistencia al completar el checklist", () => {
    expect(assistantMode(100)).toBe("asistencia");
  });
  it("webOwnerContext: solo owner/admin pueden configurar", () => {
    expect(isWebOwner("owner")).toBe(true);
    expect(isWebOwner("admin")).toBe(true);
    expect(isWebOwner("viewer")).toBe(false);
    expect(isWebOwner("support")).toBe(false);
    expect(isWebOwner("operador")).toBe(false);
  });

  it("resolveAssistantModel: nunca manda un modelo de otra familia al proveedor (hallazgo prod 26-oct)", () => {
    // El caso del bug: provider anthropic + default de config gpt-4o-mini → NO se lo manda a Anthropic.
    expect(resolveAssistantModel("anthropic", "gpt-4o-mini")).toBe("claude-sonnet-4-6");
    // Respeta un modelo de la misma familia.
    expect(resolveAssistantModel("anthropic", "claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(resolveAssistantModel("openai", "gpt-4o")).toBe("gpt-4o");
    // Provider openai con un claude configurado → usa el default openai.
    expect(resolveAssistantModel("openai", "claude-sonnet-4-6")).toBe("gpt-4o-mini");
    // mock: da igual (el MockAIProvider ignora el modelo).
    expect(resolveAssistantModel("mock", "lo-que-sea")).toBe("lo-que-sea");
  });
});

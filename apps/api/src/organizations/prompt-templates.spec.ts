import { describe, expect, it } from "vitest";
import { templateVisibleForAgent } from "./settings.controller";

describe("plantillas de prompt asignadas a agentes", () => {
  const tplParaAna = { agentIds: ["agent-ana"] };
  const tplParaTodos = { agentIds: [] };
  const tplParaDos = { agentIds: ["agent-ana", "agent-luis"] };

  it("una plantilla asignada a un agente NO aparece en otro", () => {
    expect(templateVisibleForAgent(tplParaAna, "agent-ana")).toBe(true);
    expect(templateVisibleForAgent(tplParaAna, "agent-luis")).toBe(false);
  });

  it("[] = disponible para todos los agentes", () => {
    expect(templateVisibleForAgent(tplParaTodos, "agent-ana")).toBe(true);
    expect(templateVisibleForAgent(tplParaTodos, "agent-cualquiera")).toBe(true);
  });

  it("multi-asignación respeta la lista exacta", () => {
    expect(templateVisibleForAgent(tplParaDos, "agent-luis")).toBe(true);
    expect(templateVisibleForAgent(tplParaDos, "agent-otro")).toBe(false);
  });

  it("agentIds corrupto (no-array) se trata como todos (tolerante)", () => {
    expect(templateVisibleForAgent({ agentIds: null }, "agent-x")).toBe(true);
  });
});

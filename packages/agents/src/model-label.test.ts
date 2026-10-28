import { describe, expect, it } from "vitest";
import { MockAIProvider, RoutingAIProvider } from "./providers.js";
import { orchestrate, type AgentRuntime } from "./orchestrator.js";
import { computeCostUsd } from "./pricing.js";
import type { AIChatRequest, AIChatResponse, AIProvider } from "@conversia/types";

/**
 * Regresión del hallazgo prod 24-oct (Digital-Dent): ai_requests.cost_usd no calzaba con el
 * model registrado. Causa: con la llave OpenAI no disponible, el router responde los modelos
 * gpt-* con claude-haiku-4-5 (SAFE_MODEL) y cuesta a tarifa de Haiku, pero se GUARDABA la
 * etiqueta configurada ("gpt-4o-mini"/"gpt-4o"). Etiqueta y costo quedaban de modelos distintos
 * (mini salía 4-6× su tarifa; gpt-4o, menos que la suya). El fix: la respuesta REPORTA el modelo
 * y proveedor que realmente atendió, y el orquestador lo propaga para que se registre ESE.
 */

/** Anthropic de mentira: se comporta como el real tras el fix — reporta el modelo que recibió
 * (ya resuelto por el router) y su propio kind, y costea con ese modelo. */
function fakeAnthropic(seen: string[]): AIProvider {
  return {
    kind: "anthropic",
    chat: async (req: AIChatRequest): Promise<AIChatResponse> => {
      seen.push(req.model);
      return {
        text: "ok",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 1000, outputTokens: 100, costUsd: computeCostUsd(req.model, 1000, 100) },
        latencyMs: 1,
        model: req.model,
        provider: "anthropic",
      };
    },
    embed: async () => ({ vectors: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }),
  };
}

describe("etiqueta de modelo: el costo debe calzar con el modelo que RESPONDIÓ", () => {
  it("router: gpt-* configurado pero SOLO Anthropic disponible → responde Haiku y lo REPORTA (no gpt-*)", async () => {
    const seen: string[] = [];
    const router = new RoutingAIProvider({ anthropic: fakeAnthropic(seen), fallback: new MockAIProvider() });
    const resp = await router.chat({ model: "gpt-4o-mini", system: "", messages: [{ role: "user", content: "hola" }] });

    // Llamó a Anthropic con el modelo seguro, nunca con gpt-4o-mini (que a Anthropic da 404).
    expect(seen).toEqual(["claude-haiku-4-5"]);
    // La respuesta reporta el modelo y proveedor REALES (antes se perdían y se guardaba "gpt-4o-mini").
    expect(resp.model).toBe("claude-haiku-4-5");
    expect(resp.provider).toBe("anthropic");
    // El costo es el de Haiku, NO el de gpt-4o-mini (la causa del desfase de 5-6×).
    expect(resp.usage.costUsd).toBeCloseTo(computeCostUsd("claude-haiku-4-5", 1000, 100), 10);
    expect(resp.usage.costUsd).not.toBeCloseTo(computeCostUsd("gpt-4o-mini", 1000, 100), 10);
  });

  it("orchestrate: devuelve el modelo/proveedor que REALMENTE respondió, no agent.model", async () => {
    const agent: AgentRuntime = {
      agentId: "a",
      agentVersionId: "v",
      slug: "agendamiento",
      name: "Agenda",
      systemPrompt: "x",
      model: "gpt-4o-mini", // configurado como gpt-*, pero lo atiende Haiku
      maxTokens: 1500,
      maxToolRounds: 3,
      tools: [],
    };
    const router = new RoutingAIProvider({ anthropic: fakeAnthropic([]), fallback: new MockAIProvider() });
    const reg = { specsFor: () => [], execute: async () => ({ content: "ok", isError: false }) } as any;
    const res = await orchestrate(router, reg, { ctx: {} as any, agent, history: [{ role: "user", content: "hola" }], vars: {} });

    // Esto es lo que agent-turn guarda en ai_requests.model y manda a Créditos IA.
    expect(res.model).toBe("claude-haiku-4-5");
    expect(res.provider).toBe("anthropic");
  });

  it("un proveedor real reporta su modelo y kind (mismo patrón en Anthropic/OpenAI/Mock)", async () => {
    const r = await new MockAIProvider().chat({ model: "claude-haiku-4-5", system: "s", messages: [{ role: "user", content: "hola" }] });
    expect(r.model).toBe("claude-haiku-4-5");
    expect(r.provider).toBe("mock");
  });
});

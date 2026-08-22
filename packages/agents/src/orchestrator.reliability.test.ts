import { describe, expect, it } from "vitest";
import { orchestrate, type AgentRuntime } from "./orchestrator.js";
import type { AIChatRequest, AIChatResponse, AIProvider } from "@conversia/types";

// Registro falso: sin tools reales, ejecución no-op.
const fakeRegistry = {
  specsFor: () => [],
  execute: async () => ({ content: "ok", isError: false }),
} as any;

const agent: AgentRuntime = {
  agentId: "a",
  agentVersionId: "v",
  slug: "impl",
  name: "Impl",
  systemPrompt: "x",
  model: "claude-opus-4-8",
  maxTokens: 1500,
  maxToolRounds: 5,
  tools: [],
};

function provider(chat: (req: AIChatRequest, n: number) => AIChatResponse): AIProvider {
  let n = 0;
  return {
    kind: "mock",
    chat: async (req) => chat(req, ++n),
    embed: async () => ({ vectors: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }),
  };
}

const u = { inputTokens: 1, outputTokens: 1, costUsd: 0 };
const run = (ai: AIProvider, registry = fakeRegistry) =>
  orchestrate(ai, registry, { ctx: {} as any, agent, history: [{ role: "user", content: "hola" }], vars: {} });

describe("orchestrate — garantías de fiabilidad (cero silencios)", () => {
  it("reanuda una respuesta cortada por max_tokens SIN prefill (termina en turno de usuario)", async () => {
    const ai = provider((req, n) => {
      if (n === 1) return { text: "Autoriza el montaje y dicta el código TB-", toolCalls: [], stopReason: "max_tokens", usage: u, latencyMs: 1 };
      // La reanudación NO debe usar prefill: los mensajes deben terminar en 'user'.
      const last = req.messages[req.messages.length - 1];
      expect(last?.role).toBe("user");
      return { text: "3PF6-MUJZ. ¿Lo hacemos?", toolCalls: [], stopReason: "end_turn", usage: u, latencyMs: 1 };
    });
    const r = await run(ai);
    expect(r.reply).toContain("TB-3PF6-MUJZ");
    expect(r.reply).toContain("¿Lo hacemos?");
  });

  it("no deja silencio cuando el turno usa una tool sin texto: fuerza un cierre textual", async () => {
    const reg = { specsFor: () => [{ name: "addInternalNote" }], execute: async () => ({ content: "ok", isError: false }) } as any;
    const ai = provider((req, n) => {
      if (n === 1) return { text: "", toolCalls: [{ id: "t", name: "addInternalNote", input: {} }], stopReason: "tool_use", usage: u, latencyMs: 1 };
      const hasTools = (req.tools?.length ?? 0) > 0;
      if (hasTools) return { text: "", toolCalls: [], stopReason: "end_turn", usage: u, latencyMs: 1 };
      return { text: "Listo, anoté eso 🙌 ¿seguimos?", toolCalls: [], stopReason: "end_turn", usage: u, latencyMs: 1 };
    });
    const r = await run(ai, reg);
    expect(r.reply).toContain("anoté");
  });

  it("no deja silencio cuando el modelo responde vacío sin usar tools", async () => {
    const ai = provider((_req, n) => {
      if (n === 1) return { text: "", toolCalls: [], stopReason: "end_turn", usage: u, latencyMs: 1 };
      return { text: "Perdona, aquí estoy. ¿En qué te ayudo?", toolCalls: [], stopReason: "end_turn", usage: u, latencyMs: 1 };
    });
    const r = await run(ai);
    expect(r.reply).toContain("aquí estoy");
  });

  it("respeta el silencio intencional de una derivación a humano (no fuerza respuesta)", async () => {
    const reg = { specsFor: () => [{ name: "transferToHuman" }], execute: async () => ({ content: "ok", isError: false }) } as any;
    const ai = provider((_req, n) => {
      if (n === 1) return { text: "", toolCalls: [{ id: "h", name: "transferToHuman", input: { reason: "x" } }], stopReason: "tool_use", usage: u, latencyMs: 1 };
      return { text: "", toolCalls: [], stopReason: "end_turn", usage: u, latencyMs: 1 };
    });
    const r = await orchestrate(ai, reg, {
      ctx: {} as any,
      agent: { ...agent, tools: ["transferToHuman"] },
      history: [{ role: "user", content: "quiero un humano" }],
      vars: {},
    });
    expect(r.humanHandoff).toBe(true);
    expect(r.reply?.trim() || "").toBe("");
  });
});

import { describe, expect, it } from "vitest";
import { ResilientAIProvider } from "./resilient.js";
import type { AIChatResponse, AIProvider } from "@conversia/types";

const ok = (text: string): AIChatResponse => ({
  text,
  toolCalls: [],
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
  latencyMs: 1,
});

const noSleep = async () => {};

function provider(chat: AIProvider["chat"]): AIProvider {
  return { kind: "router", chat, embed: async () => ({ vectors: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }) };
}

describe("ResilientAIProvider", () => {
  it("reintenta y responde cuando el proveedor falla transitoriamente", async () => {
    let n = 0;
    const p = new ResilientAIProvider(
      provider(async () => {
        n++;
        if (n < 3) throw new Error("429 overloaded");
        return ok("listo");
      }),
      { maxAttempts: 3, timeoutMs: 1000, sleep: noSleep },
    );
    const r = await p.chat({ model: "claude-opus-4-8", messages: [] });
    expect(r.text).toBe("listo");
    expect(n).toBe(3);
  });

  it("cae al modelo de fallback si el principal agota sus intentos", async () => {
    const seen: string[] = [];
    const p = new ResilientAIProvider(
      provider(async (req) => {
        seen.push(req.model);
        if (req.model === "claude-opus-4-8") throw new Error("provider down");
        return ok("desde-fallback");
      }),
      { maxAttempts: 2, timeoutMs: 1000, fallbackModel: "claude-haiku-4-5", sleep: noSleep },
    );
    const r = await p.chat({ model: "claude-opus-4-8", messages: [] });
    expect(r.text).toBe("desde-fallback");
    expect(seen).toContain("claude-haiku-4-5");
    expect(seen.filter((m) => m === "claude-opus-4-8").length).toBe(2); // agotó los 2 intentos del principal
  });

  it("aplica timeout por llamada y, si todo cuelga, LANZA (para activar el modo degradado)", async () => {
    let calls = 0;
    const p = new ResilientAIProvider(
      provider(() => {
        calls++;
        return new Promise<AIChatResponse>(() => {}); // nunca resuelve
      }),
      { maxAttempts: 2, timeoutMs: 20, fallbackModel: "gpt-4o-mini", sleep: noSleep },
    );
    await expect(p.chat({ model: "claude-opus-4-8", messages: [] })).rejects.toThrow();
    expect(calls).toBe(4); // 2 intentos principal + 2 del fallback, todos por timeout
  });

  it("no reintenta de más cuando el primer intento tiene éxito", async () => {
    let n = 0;
    const p = new ResilientAIProvider(
      provider(async () => {
        n++;
        return ok("directo");
      }),
      { maxAttempts: 3, timeoutMs: 1000, fallbackModel: "claude-haiku-4-5", sleep: noSleep },
    );
    const r = await p.chat({ model: "claude-opus-4-8", messages: [] });
    expect(r.text).toBe("directo");
    expect(n).toBe(1);
  });
});

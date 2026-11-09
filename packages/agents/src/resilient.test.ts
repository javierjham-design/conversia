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

  it("un 400 NO se reintenta con el mismo modelo: la misma petición da el mismo error", async () => {
    /**
     * Producción, 7-nov-2026: un nombre de herramienta con ñ daba
     * `400 Invalid 'tools[10].function.name'` y el envoltorio gastaba SEIS llamadas —tres con
     * gpt-4o-mini y tres con gpt-4o— para terminar exactamente igual. Mientras tanto el dueño
     * miraba a Convi "pensando" ~45 s antes de recibir el mensaje de respaldo.
     * Un 4xx es culpa de la petición: repetirla manda los mismos bytes.
     */
    const seen: string[] = [];
    const p = new ResilientAIProvider(
      provider(async (req) => {
        seen.push(req.model);
        throw new Error("400 Invalid 'tools[10].function.name': string does not match pattern.");
      }),
      { maxAttempts: 3, timeoutMs: 1000, fallbackModel: "gpt-4o", sleep: noSleep },
    );
    await expect(p.chat({ model: "gpt-4o-mini", messages: [] })).rejects.toThrow(/tools\[10\]/);
    // UN intento por modelo, no tres: 2 llamadas en vez de 6.
    expect(seen).toEqual(["gpt-4o-mini", "gpt-4o"]);
  });

  it("pero el modelo de RESPALDO se sigue probando: el 4xx más común es 'ese modelo ya no existe'", async () => {
    // Es justo lo que el respaldo vino a resolver (#596). Si un 4xx cortara también el
    // cambio de modelo, un modelo retirado volvería a tumbar al asistente SIEMPRE.
    const seen: string[] = [];
    const p = new ResilientAIProvider(
      provider(async (req) => {
        seen.push(req.model);
        if (req.model === "modelo-retirado") throw new Error("404 The model does not exist");
        return ok("desde-el-respaldo");
      }),
      { maxAttempts: 3, timeoutMs: 1000, fallbackModel: "claude-haiku-4-5", sleep: noSleep },
    );
    const r = await p.chat({ model: "modelo-retirado", messages: [] });
    expect(r.text).toBe("desde-el-respaldo");
    expect(seen).toEqual(["modelo-retirado", "claude-haiku-4-5"]);
  });

  it("TuBot NO cambia: 429, 503 y timeout se siguen reintentando igual", async () => {
    // Este envoltorio es COMPARTIDO con los bots de WhatsApp en producción. Lo único que se
    // tocó es no insistir ante un 4xx permanente; lo transitorio sigue exactamente igual.
    for (const transitorio of ["429 rate limit", "503 service unavailable", "socket hang up"]) {
      let n = 0;
      const p = new ResilientAIProvider(
        provider(async () => {
          n++;
          if (n < 3) throw new Error(transitorio);
          return ok("listo");
        }),
        { maxAttempts: 3, timeoutMs: 1000, sleep: noSleep },
      );
      const r = await p.chat({ model: "claude-opus-4-8", messages: [] });
      expect(r.text, transitorio).toBe("listo");
      expect(n, transitorio).toBe(3);
    }
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

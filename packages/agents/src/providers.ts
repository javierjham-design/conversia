import Anthropic from "@anthropic-ai/sdk";
import type { AIChatRequest, AIChatResponse, AIProvider, AIToolCall, AIUsage } from "@conversia/types";
import { computeCostUsd } from "./pricing.js";

/**
 * Proveedor Anthropic (API oficial, SDK @anthropic-ai/sdk).
 * Sin parámetros de sampling: los modelos Opus 4.7+ los rechazan y el
 * comportamiento se controla por prompt según la guía vigente.
 */
export class AnthropicProvider implements AIProvider {
  readonly kind = "anthropic";
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async chat(req: AIChatRequest): Promise<AIChatResponse> {
    const started = Date.now();

    const messages: any[] = req.messages.map((m) => ({ role: m.role, content: m.content }));
    for (const entry of req.toolTranscript ?? []) {
      if (entry.kind === "assistant_tool_calls") {
        const content: any[] = [];
        if (entry.text) content.push({ type: "text", text: entry.text });
        for (const c of entry.calls) {
          content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
        }
        messages.push({ role: "assistant", content });
      } else {
        messages.push({
          role: "user",
          content: entry.results.map((r) => ({
            type: "tool_result",
            tool_use_id: r.toolCallId,
            content: r.content,
            is_error: r.isError ?? false,
          })),
        });
      }
    }

    const params: any = {
      model: req.model,
      max_tokens: req.maxTokens ?? 1024,
      system: req.system,
      messages,
    };
    if (req.tools?.length) {
      params.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputJsonSchema,
      }));
    }

    const resp: any = await this.client.messages.create(params);
    const latencyMs = Date.now() - started;

    let text: string | null = null;
    const toolCalls: AIToolCall[] = [];
    for (const block of resp.content ?? []) {
      if (block.type === "text") text = (text ?? "") + block.text;
      else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: block.name, input: block.input });
      }
    }

    const usage: AIUsage = {
      inputTokens: resp.usage?.input_tokens ?? 0,
      outputTokens: resp.usage?.output_tokens ?? 0,
      costUsd: computeCostUsd(req.model, resp.usage?.input_tokens ?? 0, resp.usage?.output_tokens ?? 0),
    };

    const stopMap: Record<string, AIChatResponse["stopReason"]> = {
      end_turn: "end_turn",
      tool_use: "tool_use",
      max_tokens: "max_tokens",
      refusal: "refusal",
    };

    return {
      text,
      toolCalls,
      stopReason: stopMap[resp.stop_reason] ?? "other",
      usage,
      latencyMs,
    };
  }

  async embed(): Promise<{ vectors: number[][]; usage: AIUsage }> {
    throw new Error(
      "Anthropic no ofrece embeddings: configurar EMBEDDINGS_PROVIDER=openai (u otro) para RAG vectorial",
    );
  }
}

/**
 * Proveedor mock determinista: permite desarrollar y testear el pipeline
 * completo (webhook → orquestador → respuesta → envío) sin credenciales.
 */
export class MockAIProvider implements AIProvider {
  readonly kind = "mock";

  async chat(req: AIChatRequest): Promise<AIChatResponse> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const hadToolResults = (req.toolTranscript ?? []).some((t) => t.kind === "tool_results");
    const text = hadToolResults
      ? "He revisado la información y te confirmo en cuanto tenga todo listo. (respuesta mock)"
      : `Hola 👋 Recibí tu mensaje: "${(lastUser?.content ?? "").slice(0, 120)}". Soy el asistente en modo mock; conecta ANTHROPIC_API_KEY para respuestas reales.`;
    return {
      text,
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      latencyMs: 5,
    };
  }

  async embed(texts: string[]): Promise<{ vectors: number[][]; usage: AIUsage }> {
    // Vectores pseudoaleatorios estables por contenido (solo para tests)
    const vectors = texts.map((t) => {
      const v = new Array(1536).fill(0);
      for (let i = 0; i < t.length; i++) v[(t.charCodeAt(i) * 31 + i) % 1536] += 1;
      const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
      return v.map((x) => x / norm);
    });
    return { vectors, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  }
}

export function createAIProvider(opts: { provider: string; anthropicApiKey?: string }): AIProvider {
  if (opts.provider === "anthropic" && opts.anthropicApiKey) {
    return new AnthropicProvider(opts.anthropicApiKey);
  }
  return new MockAIProvider();
}

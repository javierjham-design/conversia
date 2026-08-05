import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { AIChatMessage, AIChatRequest, AIChatResponse, AIProvider, AIToolCall, AIUsage } from "@conversia/types";
import { computeCostUsd } from "./pricing.js";

/**
 * Contenido de un mensaje para el proveedor: string si es solo texto, o bloques
 * multimodales (texto + imágenes) si el mensaje trae imágenes (visión). Pura.
 */
export function toMultimodalContent(m: AIChatMessage, format: "anthropic" | "openai"): unknown {
  if (!m.images?.length) return m.content;
  const parts: unknown[] = m.content ? [{ type: "text", text: m.content }] : [];
  for (const img of m.images) {
    parts.push(
      format === "anthropic"
        ? { type: "image", source: { type: "base64", media_type: img.mimeType, data: img.dataBase64 } }
        : { type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.dataBase64}` } },
    );
  }
  return parts;
}

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

    const messages: any[] = req.messages.map((m) => ({ role: m.role, content: toMultimodalContent(m, "anthropic") }));
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
 * Proveedor OpenAI (Chat Completions + function calling). Mapea el mismo
 * contrato AIProvider: modelos gpt-4o-mini/gpt-4o. También ofrece embeddings.
 */
export class OpenAIProvider implements AIProvider {
  readonly kind = "openai";
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async chat(req: AIChatRequest): Promise<AIChatResponse> {
    const started = Date.now();

    const messages: any[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    for (const m of req.messages) messages.push({ role: m.role, content: toMultimodalContent(m, "openai") });
    for (const entry of req.toolTranscript ?? []) {
      if (entry.kind === "assistant_tool_calls") {
        messages.push({
          role: "assistant",
          content: entry.text ?? null,
          tool_calls: entry.calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
          })),
        });
      } else {
        for (const r of entry.results) {
          messages.push({ role: "tool", tool_call_id: r.toolCallId, content: r.content });
        }
      }
    }

    const params: any = { model: req.model, max_tokens: req.maxTokens ?? 1024, messages };
    if (req.tools?.length) {
      params.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputJsonSchema },
      }));
    }

    const resp: any = await this.client.chat.completions.create(params);
    const latencyMs = Date.now() - started;
    const choice = resp.choices?.[0] ?? {};
    const msg = choice.message ?? {};

    const text: string | null = msg.content ?? null;
    const toolCalls: AIToolCall[] = [];
    for (const tc of msg.tool_calls ?? []) {
      let input: unknown = {};
      try {
        input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        input = {};
      }
      toolCalls.push({ id: tc.id, name: tc.function?.name, input });
    }

    const usage: AIUsage = {
      inputTokens: resp.usage?.prompt_tokens ?? 0,
      outputTokens: resp.usage?.completion_tokens ?? 0,
      costUsd: computeCostUsd(req.model, resp.usage?.prompt_tokens ?? 0, resp.usage?.completion_tokens ?? 0),
    };

    const stopMap: Record<string, AIChatResponse["stopReason"]> = {
      stop: "end_turn",
      tool_calls: "tool_use",
      length: "max_tokens",
      content_filter: "refusal",
    };

    return { text, toolCalls, stopReason: stopMap[choice.finish_reason] ?? "other", usage, latencyMs };
  }

  async embed(texts: string[], model = "text-embedding-3-small"): Promise<{ vectors: number[][]; usage: AIUsage }> {
    const resp: any = await this.client.embeddings.create({ model, input: texts });
    const vectors = (resp.data ?? []).map((d: any) => d.embedding as number[]);
    return { vectors, usage: { inputTokens: resp.usage?.prompt_tokens ?? 0, outputTokens: 0, costUsd: 0 } };
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

/**
 * Enruta cada request al proveedor correcto SEGÚN EL MODELO: `gpt-*`/`o1..` →
 * OpenAI, `claude-*` → Anthropic. Permite mezclar modelos por agente y migrar de
 * proveedor sin cambiar el call-site (`ai.chat(req)`).
 */
/** Modelo seguro por proveedor cuando el del modelo pedido no está disponible. */
const SAFE_MODEL = { openai: "gpt-4o-mini", anthropic: "claude-haiku-4-5" };

export class RoutingAIProvider implements AIProvider {
  readonly kind = "router";
  constructor(private providers: { anthropic?: AIProvider; openai?: AIProvider; fallback: AIProvider }) {}

  private route(model: string): { provider: AIProvider; model: string } {
    const wantsOpenai = /^(gpt-|o[1-9]|chatgpt|text-embedding)/i.test(model);
    const wantsAnthropic = /^claude/i.test(model);
    if (wantsOpenai && this.providers.openai) return { provider: this.providers.openai, model };
    if (wantsAnthropic && this.providers.anthropic) return { provider: this.providers.anthropic, model };
    // El proveedor del modelo pedido no está disponible: usa el que haya, pero con
    // un modelo compatible suyo (evita mandar "gpt-*" a Anthropic o viceversa).
    if (this.providers.openai) return { provider: this.providers.openai, model: SAFE_MODEL.openai };
    if (this.providers.anthropic) return { provider: this.providers.anthropic, model: SAFE_MODEL.anthropic };
    return { provider: this.providers.fallback, model };
  }

  chat(req: AIChatRequest): Promise<AIChatResponse> {
    const { provider, model } = this.route(req.model);
    return provider.chat(model === req.model ? req : { ...req, model });
  }
  embed(texts: string[], model?: string): Promise<{ vectors: number[][]; usage: AIUsage }> {
    // Embeddings sólo en OpenAI (Anthropic no ofrece); cae al fallback si no hay.
    return (this.providers.openai ?? this.providers.fallback).embed(texts, model);
  }
}

export function createAIProvider(opts: { provider: string; anthropicApiKey?: string; openaiApiKey?: string }): AIProvider {
  if (opts.provider === "openai" && opts.openaiApiKey) return new OpenAIProvider(opts.openaiApiKey);
  if (opts.provider === "anthropic" && opts.anthropicApiKey) return new AnthropicProvider(opts.anthropicApiKey);
  return new MockAIProvider();
}

/** Router con los proveedores disponibles según las llaves configuradas. */
export function createAIRouter(opts: { anthropicApiKey?: string; openaiApiKey?: string }): AIProvider {
  const openai = opts.openaiApiKey ? new OpenAIProvider(opts.openaiApiKey) : undefined;
  const anthropic = opts.anthropicApiKey ? new AnthropicProvider(opts.anthropicApiKey) : undefined;
  if (!openai && !anthropic) return new MockAIProvider();
  return new RoutingAIProvider({ openai, anthropic, fallback: new MockAIProvider() });
}

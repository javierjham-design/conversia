import type {
  AIChatMessage,
  AIChatRequest,
  AIProvider,
  AIToolCall,
  AIToolResult,
  AIUsage,
  ToolContext,
} from "@conversia/types";
import { ToolRegistry } from "./tools.js";
import { sanitizeVar } from "./sanitize.js";

export { sanitizeVar };

/** Configuración efectiva del agente (viene de agent_versions.config). */
export interface AgentRuntime {
  agentId: string;
  agentVersionId: string;
  slug: string;
  name: string;
  systemPrompt: string;
  model: string;
  maxTokens: number;
  maxToolRounds: number;
  tools: string[];
}

export interface OrchestrateInput {
  ctx: ToolContext;
  agent: AgentRuntime;
  /** Historial reciente ya ventaneado (memoria corta). */
  history: AIChatMessage[];
  /** Variables para renderizar el prompt: organization.name, clinic.city, … */
  vars: Record<string, string>;
}

export interface ToolEvent {
  name: string;
  input: unknown;
  output: string;
  isError: boolean;
}

export interface OrchestrateResult {
  reply: string | null;
  toolEvents: ToolEvent[];
  usage: AIUsage;
  latencyMs: number;
  stopReason: string;
  /** slug del agente al que se pidió transferir, si corresponde */
  transferToAgentSlug?: string;
  /** true si se escaló a humano (la IA debe silenciarse) */
  humanHandoff?: boolean;
}

/** Renderiza {{path.de.variable}} sanitizando cada valor interpolado. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => sanitizeVar(vars[key] ?? ""));
}

/**
 * Orquestador v0: ejecuta un turno del agente activo con loop de
 * herramientas acotado. La selección de agente (por canal/assignments) y la
 * persistencia ocurren en el runtime que lo invoca (worker).
 */
export async function orchestrate(
  ai: AIProvider,
  registry: ToolRegistry,
  input: OrchestrateInput,
): Promise<OrchestrateResult> {
  const { agent, ctx } = input;
  const system = renderTemplate(agent.systemPrompt, input.vars);
  const specs = registry.specsFor(agent.tools);

  const usage: AIUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const toolEvents: ToolEvent[] = [];
  const toolTranscript: NonNullable<AIChatRequest["toolTranscript"]> = [];
  let latencyMs = 0;
  let transferToAgentSlug: string | undefined;
  let humanHandoff = false;
  let finalText: string | null = null;
  let stopReason = "end_turn";

  for (let round = 0; round <= agent.maxToolRounds; round++) {
    const resp = await ai.chat({
      model: agent.model,
      system,
      messages: input.history,
      tools: specs,
      maxTokens: agent.maxTokens,
      toolTranscript,
    });
    usage.inputTokens += resp.usage.inputTokens;
    usage.outputTokens += resp.usage.outputTokens;
    usage.costUsd += resp.usage.costUsd;
    latencyMs += resp.latencyMs;
    stopReason = resp.stopReason;

    if (resp.stopReason !== "tool_use" || resp.toolCalls.length === 0) {
      finalText = resp.text;
      break;
    }

    const results: AIToolResult[] = [];
    for (const call of resp.toolCalls as AIToolCall[]) {
      if (call.name === "transferToAgent") {
        transferToAgentSlug = (call.input as any)?.agentSlug;
      }
      if (call.name === "transferToHuman") {
        humanHandoff = true;
      }
      const result = await registry.execute(call.name, call.input, ctx);
      toolEvents.push({ name: call.name, input: call.input, output: result.content, isError: result.isError });
      results.push({ toolCallId: call.id, content: result.content, isError: result.isError });
    }
    toolTranscript.push({ kind: "assistant_tool_calls", text: resp.text ?? undefined, calls: resp.toolCalls });
    toolTranscript.push({ kind: "tool_results", results });

    // Última vuelta: forzar cierre textual en la siguiente iteración
    if (round === agent.maxToolRounds) {
      finalText = resp.text;
    }
  }

  // Auto-continuación: si el modelo cortó por límite de tokens (max_tokens) en
  // medio de una respuesta de TEXTO, la reanudamos para no dejar el mensaje a la
  // mitad. Reenviamos el texto parcial como prefijo del asistente y concatenamos
  // lo que siga, hasta cerrar el turno o agotar el presupuesto de continuaciones.
  const MAX_CONTINUATIONS = 4;
  let continuations = 0;
  while (stopReason === "max_tokens" && finalText != null && continuations < MAX_CONTINUATIONS) {
    continuations++;
    // Prefijo del asistente = todo lo acumulado. Sin espacios al final: Anthropic
    // rechaza un mensaje de asistente que termine en whitespace.
    const prefix = finalText.replace(/\s+$/, "");
    const contTranscript = [
      ...toolTranscript,
      { kind: "assistant_tool_calls" as const, text: prefix, calls: [] },
    ];
    const resp = await ai.chat({
      model: agent.model,
      system,
      messages: input.history,
      tools: specs,
      maxTokens: agent.maxTokens,
      toolTranscript: contTranscript,
    });
    usage.inputTokens += resp.usage.inputTokens;
    usage.outputTokens += resp.usage.outputTokens;
    usage.costUsd += resp.usage.costUsd;
    latencyMs += resp.latencyMs;
    stopReason = resp.stopReason;
    finalText = prefix + (resp.text ?? "");
    // Si al continuar el modelo decide usar una herramienta, no la ejecutamos en
    // esta fase de cierre textual: devolvemos lo acumulado y cortamos.
    if (resp.stopReason !== "max_tokens") break;
  }

  return {
    reply: finalText,
    toolEvents,
    usage,
    latencyMs,
    stopReason,
    transferToAgentSlug,
    humanHandoff,
  };
}
